const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const zlib = require('zlib');

const DATA_FILE = path.join(__dirname, 'data', 'profiles.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

// In-memory service state & error cache
let lastServiceStatus = {
  status: 'unknown', // 'running' | 'stopped' | 'error' | 'unknown'
  output: '',
  error: '',
  timestamp: null,
  command: ''
};

// Auto-detect existing xray/xkeen config paths on router
function detectConfigPaths() {
  const possibleDirs = [
    '/opt/etc/xray/configs',
    '/opt/etc/xray/config',
    '/opt/etc/xray',
    '/opt/etc/xkeen/configs',
    '/opt/etc/xkeen/config',
    '/opt/etc/xkeen',
    '/opt/etc/v2ray/configs',
    '/opt/etc/v2ray/config',
    '/opt/etc/v2ray'
  ];

  let detectedDir = '/opt/etc/xray/configs';
  for (const dir of possibleDirs) {
    if (fs.existsSync(dir)) {
      try {
        if (fs.statSync(dir).isDirectory()) {
          detectedDir = dir;
          break;
        }
      } catch (e) {}
    }
  }

  let outboundPath = path.join(detectedDir, '05_outbounds.json');
  let routingPath = path.join(detectedDir, '05_routing.json');

  if (fs.existsSync(detectedDir)) {
    try {
      const files = fs.readdirSync(detectedDir);

      // Look for outbound file
      const obFile = files.find(f => /outbounds?\.jsonc?$/i.test(f))
        || files.find(f => /0[34567]_outbounds?\.jsonc?$/i.test(f));
      if (obFile) {
        outboundPath = path.join(detectedDir, obFile);
      } else {
        for (const file of files) {
          if (!file.endsWith('.json') && !file.endsWith('.jsonc')) continue;
          try {
            const content = fs.readFileSync(path.join(detectedDir, file), 'utf8');
            if (content.includes('"outbounds"') || content.includes('"outbound"')) {
              outboundPath = path.join(detectedDir, file);
              break;
            }
          } catch (e) {}
        }
      }

      // Look for routing file (05_routing.json, 04_routing.json, 03_routing.json, routing.json, etc.)
      const rtFile = files.find(f => /0[234567]_routing\.jsonc?$/i.test(f))
        || files.find(f => /routing\.jsonc?$/i.test(f))
        || files.find(f => /routes?\.jsonc?$/i.test(f));
      if (rtFile) {
        routingPath = path.join(detectedDir, rtFile);
      } else {
        for (const file of files) {
          if (!file.endsWith('.json') && !file.endsWith('.jsonc')) continue;
          try {
            const content = fs.readFileSync(path.join(detectedDir, file), 'utf8');
            if (content.includes('"routing"') || (content.includes('"rules"') && !content.includes('"outbounds"'))) {
              routingPath = path.join(detectedDir, file);
              break;
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error('Error scanning config directory:', err);
    }
  }

  return { outboundPath, routingPath };
}

// Load data from file
function loadData() {
  const detected = detectConfigPaths();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(content);
      // Ensure defaults for new settings
      parsed.settings = {
        outboundPath: detected.outboundPath,
        routingPath: detected.routingPath,
        restartCommand: 'xkeen -restart',
        startCommand: 'xkeen -start',
        stopCommand: 'xkeen -stop',
        statusCommand: 'xkeen -status',
        activeProfileId: null,
        port: 3000,
        ...(parsed.settings || {})
      };

      let changed = false;

      // Auto-correct paths if stored paths do not exist on disk but detected paths do
      if (parsed.settings.outboundPath && !fs.existsSync(parsed.settings.outboundPath) && fs.existsSync(detected.outboundPath)) {
        parsed.settings.outboundPath = detected.outboundPath;
        changed = true;
      }
      if (parsed.settings.routingPath && !fs.existsSync(parsed.settings.routingPath) && fs.existsSync(detected.routingPath)) {
        parsed.settings.routingPath = detected.routingPath;
        changed = true;
      }

      // Auto-heal Default profile if its routingContent was dummy empty rules and real routing file exists
      if (Array.isArray(parsed.profiles)) {
        const defaultProf = parsed.profiles.find(p => p.name === 'Default');
        if (defaultProf && fs.existsSync(parsed.settings.routingPath)) {
          const cleanRouting = (defaultProf.routingContent || '').replace(/\s+/g, '');
          if (!cleanRouting || cleanRouting === '{"routing":{"rules":[]}}' || cleanRouting === '{"rules":[]}') {
            try {
              const realRouting = fs.readFileSync(parsed.settings.routingPath, 'utf8').trim();
              if (realRouting && realRouting.replace(/\s+/g, '') !== cleanRouting) {
                defaultProf.routingContent = realRouting;
                changed = true;
              }
            } catch (e) {}
          }
        }
      }

      if (changed) {
        saveData(parsed);
      }

      return parsed;
    }
  } catch (err) {
    console.error('Error reading profiles.json:', err);
  }
  return {
    settings: {
      outboundPath: detected.outboundPath,
      routingPath: detected.routingPath,
      restartCommand: 'xkeen -restart',
      startCommand: 'xkeen -start',
      stopCommand: 'xkeen -stop',
      statusCommand: 'xkeen -status',
      activeProfileId: null,
      port: 3000
    },
    profiles: []
  };
}

const initialData = loadData();
const PORT = process.env.PORT || (initialData.settings && initialData.settings.port) || 3000;

// Helper to execute shell command safely
function runShellCommand(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    if (!cmd || !cmd.trim()) {
      return resolve({ success: true, stdout: '', stderr: '', code: 0, error: null });
    }
    exec(cmd.trim(), { timeout }, (error, stdout, stderr) => {
      const outStr = stdout ? stdout.toString().trim() : '';
      const errStr = stderr ? stderr.toString().trim() : (error ? error.message : '');
      const code = error && error.code !== undefined ? error.code : (error ? 1 : 0);
      resolve({
        success: !error,
        code,
        stdout: outStr,
        stderr: errStr,
        error: error ? (error.message || errStr) : null
      });
    });
  });
}

// Evaluate service status from command output and exit code
function evaluateServiceStatus(res) {
  const combined = ((res.stdout || '') + ' ' + (res.stderr || '') + ' ' + (res.error || '')).toLowerCase();
  
  // Explicit failure / error keywords
  if (combined.includes('failed') || combined.includes('fatal') || combined.includes('panic') || combined.includes('syntax error') || combined.includes('invalid config') || combined.includes('cannot start') || combined.includes('ошибка')) {
    return 'error';
  }

  // Running indicators
  if (combined.includes('is running') || combined.includes(' running') || combined.includes('[ok] xray is running') || combined.includes('active (running)') || combined.includes('работает') || (combined.includes('запущен') && !combined.includes('не запущен') && !combined.includes('не работает'))) {
    return 'running';
  }

  // Stopped indicators (clean stop / not running)
  if (combined.includes('stopped') || combined.includes('not running') || combined.includes('is not running') || combined.includes('is dead') || combined.includes('inactive') || combined.includes('остановлен') || combined.includes('не запущен') || combined.includes('не работает')) {
    return 'stopped';
  }

  if (res.success && res.code === 0) {
    return 'running';
  }

  return 'error';
}

// Strip single-line (//) and multi-line (/* */) comments from JSON string
function stripJsonComments(str) {
  if (!str) return '';
  return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")|(\/\*[\s\S]*?\*\/)|(\/\/[^\r\n]*)/g, (match, stringToken, p2, multiComment, singleComment) => {
    if (stringToken) return stringToken;
    if (singleComment || multiComment) return '';
    return match;
  });
}

function parseJsonWithComments(str) {
  const stripped = stripJsonComments(str);
  return JSON.parse(stripped);
}

// Save data to file
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving profiles.json:', err);
    return false;
  }
}

// Write target file safely
function writeTargetFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// Helper to convert Date to MS-DOS date and time
function getDosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { dosDate, dosTime };
}

// Pure JavaScript CRC32 implementation (independent of Node.js version)
const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  }
  CRC32_TABLE[i] = c;
}

function calculateCrc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

// Create ZIP archive buffer in pure JS/Node
function createZipBuffer(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let currentOffset = 0;
  const { dosDate, dosTime } = getDosDateTime();

  files.forEach(file => {
    const filenameBuf = Buffer.from(file.filename, 'utf8');
    const dataBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = calculateCrc32(dataBuf);
    const size = dataBuf.length;
    // Check if filename contains non-ASCII characters
    const isUtf8 = /[^\x00-\x7F]/.test(file.filename);
    const flag = isUtf8 ? 0x0800 : 0;
    const versionNeeded = 10; // 1.0 (Store method)

    const lh = Buffer.alloc(30 + filenameBuf.length + size);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(versionNeeded, 4);
    lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(0, 8); // STORE
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(filenameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    filenameBuf.copy(lh, 30);
    dataBuf.copy(lh, 30 + filenameBuf.length);
    localHeaders.push(lh);

    const ch = Buffer.alloc(46 + filenameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0014, 4); // version made by: Host OS 0 (MS-DOS/FAT), Spec 2.0 (20)
    ch.writeUInt16LE(versionNeeded, 6); // version needed
    ch.writeUInt16LE(flag, 8);
    ch.writeUInt16LE(0, 10); // STORE
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(filenameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0x00000020, 38); // Standard MS-DOS Archive Attribute (0x20) for 100% Windows Explorer compatibility
    ch.writeUInt32LE(currentOffset, 42);
    filenameBuf.copy(ch, 46);
    centralHeaders.push(ch);

    currentOffset += lh.length;
  });

  const cdOffset = currentOffset;
  const cdBuffer = Buffer.concat(centralHeaders);
  const cdSize = cdBuffer.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuffer, eocd]);
}

// Parse ZIP archive buffer in pure JS/Node
function parseZipBuffer(buf) {
  const entries = [];
  if (!Buffer.isBuffer(buf) || buf.length < 22) return entries;

  // 1. Try Central Directory parsing (Standard ZIP spec, handles Bit 3 / Data Descriptor)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    let cdOffset = buf.readUInt32LE(eocdOffset + 16);

    let count = 0;
    while (cdOffset + 46 <= buf.length && count < cdEntries) {
      const sig = buf.readUInt32LE(cdOffset);
      if (sig !== 0x02014b50) break;

      const compMethod = buf.readUInt16LE(cdOffset + 10);
      const compSize = buf.readUInt32LE(cdOffset + 20);
      const fnameLen = buf.readUInt16LE(cdOffset + 28);
      const extraLen = buf.readUInt16LE(cdOffset + 30);
      const commentLen = buf.readUInt16LE(cdOffset + 32);
      const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);

      if (cdOffset + 46 + fnameLen > buf.length) break;

      const filename = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + fnameLen);
      cdOffset += 46 + fnameLen + extraLen + commentLen;
      count++;

      if (filename.endsWith('/')) continue; // Skip directory entries

      // Read from Local Header
      if (localHeaderOffset + 30 <= buf.length) {
        const localSig = buf.readUInt32LE(localHeaderOffset);
        if (localSig === 0x04034b50) {
          const localFnameLen = buf.readUInt16LE(localHeaderOffset + 26);
          const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
          const dataStart = localHeaderOffset + 30 + localFnameLen + localExtraLen;
          const dataEnd = dataStart + compSize;

          if (dataEnd <= buf.length) {
            const rawData = buf.slice(dataStart, dataEnd);
            let strContent = '';
            if (compMethod === 0) {
              strContent = rawData.toString('utf8');
            } else if (compMethod === 8) {
              try {
                strContent = zlib.inflateRawSync(rawData).toString('utf8');
              } catch (e) {
                try {
                  strContent = zlib.inflateSync(rawData).toString('utf8');
                } catch (e2) {}
              }
            }
            entries.push({ filename, content: strContent });
          }
        }
      }
    }
    if (entries.length > 0) return entries;
  }

  // 2. Fallback: Scan Local Headers sequentially if EOCD not found
  let offset = 0;
  while (offset <= buf.length - 30) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      offset++;
      continue;
    }

    const compMethod = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const fnameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);

    if (offset + 30 + fnameLen > buf.length) break;

    const filename = buf.toString('utf8', offset + 30, offset + 30 + fnameLen);
    const dataStart = offset + 30 + fnameLen + extraLen;
    const dataEnd = dataStart + compSize;

    if (dataEnd > buf.length) break;

    const rawData = buf.slice(dataStart, dataEnd);
    let strContent = '';

    if (compMethod === 0) {
      strContent = rawData.toString('utf8');
    } else if (compMethod === 8) {
      try {
        strContent = zlib.inflateRawSync(rawData).toString('utf8');
      } catch (e) {
        try {
          strContent = zlib.inflateSync(rawData).toString('utf8');
        } catch (e2) {}
      }
    }

    if (!filename.endsWith('/')) {
      entries.push({ filename, content: strContent });
    }
    offset = dataEnd > offset ? dataEnd : offset + 1;
  }

  return entries;
}

// Parse TAR archive buffer in pure JS/Node
function parseTarBuffer(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    if (header.every(b => b === 0)) break;

    let fname = header.toString('utf8', 0, 100).replace(/\0.*$/, '').trim();
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '').trim();
    if (prefix) {
      fname = prefix + '/' + fname;
    }

    const sizeOctal = header.toString('utf8', 124, 135).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (fname && (typeflag === '0' || typeflag === '\0' || typeflag === '' || typeflag === '5')) {
      if (!fname.endsWith('/') && typeflag !== '5' && dataEnd <= buf.length) {
        const content = buf.slice(dataStart, dataEnd).toString('utf8');
        entries.push({ filename: fname, content });
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Universal archive parser supporting ZIP, TAR, GZ, TGZ, and raw JSON
function parseArchiveBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return [];

  // Check if GZIP (.tar.gz / .tgz / .gz)
  let decompressedBuf = buf;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      decompressedBuf = zlib.gunzipSync(buf);
    } catch (e) {
      try {
        decompressedBuf = zlib.inflateSync(buf);
      } catch (e2) {}
    }
  }

  // Check if TAR file (magic "ustar" or valid checksum)
  if (decompressedBuf.length >= 512) {
    const magic = decompressedBuf.toString('utf8', 257, 262);
    const checksumStr = decompressedBuf.toString('utf8', 148, 156).trim();
    if (magic.startsWith('ustar') || (checksumStr.length > 0 && /^[0-7]+/.test(checksumStr))) {
      const tarEntries = parseTarBuffer(decompressedBuf);
      if (tarEntries.length > 0) return tarEntries;
    }
  }

  // Parse as ZIP
  const zipEntries = parseZipBuffer(decompressedBuf);
  if (zipEntries.length > 0) return zipEntries;

  // Fallback: Raw single JSON or text file
  const str = decompressedBuf.toString('utf8').trim();
  if (str.startsWith('{') || str.startsWith('[')) {
    return [{ filename: 'config.json', content: str }];
  }

  return [];
}

// MIME types for static server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Helper: send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Helper: parse request body JSON
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Create HTTP Server
const server = http.createServer(async (req, res) => {
  const urlParts = req.url.split('?')[0];

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // --- API ROUTES ---

  // GET /api/profiles
  if (urlParts === '/api/profiles' && req.method === 'GET') {
    return sendJson(res, 200, loadData());
  }

  // POST /api/profiles - Add profile
  if (urlParts === '/api/profiles' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { name, description, outboundContent, routingContent } = body;

      if (!name || !outboundContent || !routingContent) {
        return sendJson(res, 400, { error: 'Заполните название и оба файла (outbound.json и routing.json)' });
      }

      // Syntax checks (supporting // and /* */ comments)
      try { parseJsonWithComments(outboundContent); } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в outbound.json: ' + e.message });
      }
      try { parseJsonWithComments(routingContent); } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в routing.json: ' + e.message });
      }

      const data = loadData();
      const newProfile = {
        id: 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: name.trim(),
        description: (description || '').trim(),
        outboundContent: outboundContent.trim(),
        routingContent: routingContent.trim(),
        createdAt: new Date().toISOString()
      };

      data.profiles.push(newProfile);
      saveData(data);

      return sendJson(res, 201, { message: 'Профиль успешно добавлен', profile: newProfile });
    } catch (err) {
      return sendJson(res, 400, { error: 'Некорректный запрос' });
    }
  }

  // DELETE /api/profiles/:id
  if (urlParts.startsWith('/api/profiles/') && req.method === 'DELETE') {
    const id = urlParts.replace('/api/profiles/', '');
    const data = loadData();
    const index = data.profiles.findIndex(p => p.id === id);

    if (index === -1) {
      return sendJson(res, 404, { error: 'Профиль не найден' });
    }

    data.profiles.splice(index, 1);
    if (data.settings.activeProfileId === id) {
      data.settings.activeProfileId = null;
    }

    saveData(data);
    return sendJson(res, 200, { message: 'Профиль успешно удален' });
  }

  // POST /api/profiles/:id/activate
  if (urlParts.startsWith('/api/profiles/') && urlParts.endsWith('/activate') && req.method === 'POST') {
    const id = urlParts.replace('/api/profiles/', '').replace('/activate', '');
    const data = loadData();
    const profile = data.profiles.find(p => p.id === id);

    if (!profile) {
      return sendJson(res, 404, { error: 'Профиль не найден' });
    }

    const { outboundPath, routingPath, restartCommand } = data.settings;
    let fileWriteStatus = { outbound: false, routing: false, error: null };
    let restartStatus = { executed: false, output: '', error: '' };

    try {
      writeTargetFile(outboundPath, profile.outboundContent);
      fileWriteStatus.outbound = true;

      writeTargetFile(routingPath, profile.routingContent);
      fileWriteStatus.routing = true;
    } catch (err) {
      console.error('File write error:', err);
      fileWriteStatus.error = err.message;
    }

    if (restartCommand && restartCommand.trim()) {
      const resCmd = await runShellCommand(restartCommand.trim());
      restartStatus.executed = true;
      restartStatus.output = resCmd.stdout;
      restartStatus.error = resCmd.stderr || resCmd.error || '';
      
      const computedStatus = evaluateServiceStatus(resCmd);
      lastServiceStatus = {
        status: computedStatus,
        output: resCmd.stdout,
        error: resCmd.stderr || resCmd.error || '',
        code: resCmd.code,
        timestamp: new Date().toISOString(),
        command: restartCommand.trim()
      };
    }

    data.settings.activeProfileId = id;
    saveData(data);

    return sendJson(res, 200, {
      message: `Профиль "${profile.name}" активирован!`,
      activeProfileId: id,
      fileWriteStatus,
      restartStatus,
      serviceStatus: lastServiceStatus,
      targetPaths: { outboundPath, routingPath }
    });
  }

  // PUT /api/profiles/:id - Update profile
  if (urlParts.startsWith('/api/profiles/') && !urlParts.endsWith('/activate') && !urlParts.endsWith('/download') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/profiles/', '');
    const data = loadData();
    const profile = data.profiles.find(p => p.id === id);

    if (!profile) {
      return sendJson(res, 404, { error: 'Профиль не найден' });
    }

    try {
      const body = await parseJsonBody(req);
      const { name, description, outboundContent, routingContent } = body;

      if (!name || !outboundContent || !routingContent) {
        return sendJson(res, 400, { error: 'Заполните название и оба файла (outbound.json и routing.json)' });
      }

      // Syntax checks (supporting // and /* */ comments)
      try { parseJsonWithComments(outboundContent); } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в outbound.json: ' + e.message });
      }
      try { parseJsonWithComments(routingContent); } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в routing.json: ' + e.message });
      }

      profile.name = name.trim();
      profile.description = (description || '').trim();
      profile.outboundContent = outboundContent.trim();
      profile.routingContent = routingContent.trim();
      profile.updatedAt = new Date().toISOString();

      // If active profile was updated, update target files and restart service
      let restartStatus = { executed: false, output: '', error: '' };
      let fileWriteStatus = { outbound: false, routing: false, error: null };

      if (data.settings.activeProfileId === id) {
        const { outboundPath, routingPath, restartCommand } = data.settings;
        try {
          writeTargetFile(outboundPath, profile.outboundContent);
          fileWriteStatus.outbound = true;

          writeTargetFile(routingPath, profile.routingContent);
          fileWriteStatus.routing = true;
        } catch (err) {
          console.error('Error updating active profile target files:', err);
          fileWriteStatus.error = err.message;
        }

        if (restartCommand && restartCommand.trim()) {
          const resCmd = await runShellCommand(restartCommand.trim());
          restartStatus.executed = true;
          restartStatus.output = resCmd.stdout;
          restartStatus.error = resCmd.stderr || resCmd.error || '';

          const computedStatus = evaluateServiceStatus(resCmd);
          lastServiceStatus = {
            status: computedStatus,
            output: resCmd.stdout,
            error: resCmd.stderr || resCmd.error || '',
            code: resCmd.code,
            timestamp: new Date().toISOString(),
            command: restartCommand.trim()
          };
        }
      }

      saveData(data);

      let msg = 'Профиль успешно сохранен!';
      if (restartStatus.executed) {
        msg += restartStatus.error ? ` (Ошибка перезапуска: ${restartStatus.error})` : ' (Служба XKeen перезапущена)';
      }

      return sendJson(res, 200, {
        message: msg,
        profile,
        fileWriteStatus,
        restartStatus,
        serviceStatus: lastServiceStatus
      });
    } catch (err) {
      return sendJson(res, 400, { error: 'Некорректный запрос' });
    }
  }

  // GET /api/service/status
  if (urlParts === '/api/service/status' && req.method === 'GET') {
    const data = loadData();
    const cmd = data.settings.statusCommand || 'xkeen -status';
    const result = await runShellCommand(cmd);
    const computedStatus = evaluateServiceStatus(result);

    lastServiceStatus = {
      status: computedStatus,
      output: result.stdout || '',
      error: result.stderr || result.error || '',
      code: result.code,
      timestamp: new Date().toISOString(),
      command: cmd
    };
    return sendJson(res, 200, lastServiceStatus);
  }

  // POST /api/service/restart
  if (urlParts === '/api/service/restart' && req.method === 'POST') {
    const data = loadData();
    const cmd = data.settings.restartCommand || 'xkeen -restart';
    const result = await runShellCommand(cmd);
    const computedStatus = evaluateServiceStatus(result);

    lastServiceStatus = {
      status: computedStatus,
      output: result.stdout || '',
      error: result.stderr || result.error || '',
      code: result.code,
      timestamp: new Date().toISOString(),
      command: cmd
    };

    const isOk = computedStatus === 'running' || (result.success && !result.error);
    return sendJson(res, isOk ? 200 : 500, {
      message: isOk ? 'Служба XKeen успешно перезапущена' : 'Ошибка при перезапуске службы XKeen',
      ...lastServiceStatus
    });
  }

  // POST /api/service/start
  if (urlParts === '/api/service/start' && req.method === 'POST') {
    const data = loadData();
    const cmd = data.settings.startCommand || 'xkeen -start';
    const result = await runShellCommand(cmd);
    const computedStatus = evaluateServiceStatus(result);

    lastServiceStatus = {
      status: computedStatus,
      output: result.stdout || '',
      error: result.stderr || result.error || '',
      code: result.code,
      timestamp: new Date().toISOString(),
      command: cmd
    };

    const isOk = computedStatus === 'running' || (result.success && !result.error);
    return sendJson(res, isOk ? 200 : 500, {
      message: isOk ? 'Служба XKeen успешно запущена' : 'Ошибка при запуске службы XKeen',
      ...lastServiceStatus
    });
  }

  // POST /api/service/stop
  if (urlParts === '/api/service/stop' && req.method === 'POST') {
    const data = loadData();
    const cmd = data.settings.stopCommand || 'xkeen -stop';
    const result = await runShellCommand(cmd);
    const computedStatus = evaluateServiceStatus(result);

    lastServiceStatus = {
      status: computedStatus === 'running' ? 'stopped' : computedStatus,
      output: result.stdout || '',
      error: result.stderr || result.error || '',
      code: result.code,
      timestamp: new Date().toISOString(),
      command: cmd
    };

    return sendJson(res, 200, {
      message: 'Команда остановки службы XKeen выполнена',
      ...lastServiceStatus
    });
  }

  // GET /api/profiles/:id/download - Download ZIP archive
  if (urlParts.startsWith('/api/profiles/') && urlParts.endsWith('/download') && req.method === 'GET') {
    const id = urlParts.replace('/api/profiles/', '').replace('/download', '');
    const data = loadData();
    const profile = data.profiles.find(p => p.id === id);

    if (!profile) {
      return sendJson(res, 404, { error: 'Профиль не найден' });
    }

    const zipBuffer = createZipBuffer([
      { filename: 'outbound.json', content: profile.outboundContent },
      { filename: 'routing.json', content: profile.routingContent },
      { filename: 'info.json', content: JSON.stringify({ name: profile.name, description: profile.description || '' }, null, 2) }
    ]);

    const asciiName = profile.name.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'profile';
    const utf8Name = encodeURIComponent(profile.name || 'profile');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${utf8Name}.zip`,
      'Content-Length': zipBuffer.length
    });
    return res.end(zipBuffer);
  }

  // POST /api/parse-zip - Parse uploaded archive for profile creation
  if (urlParts === '/api/parse-zip' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { zipBase64, filename } = body;
      if (!zipBase64) {
        return sendJson(res, 400, { error: 'Файл архива не передан' });
      }

      const archiveBuf = Buffer.from(zipBase64, 'base64');
      const entries = parseArchiveBuffer(archiveBuf);

      if (!entries.length) {
        return sendJson(res, 400, { error: 'Не удалось извлечь файлы из архива' });
      }

      let name = '';
      let description = '';
      let outboundContent = '';
      let routingContent = '';

      // Check info.json / profile.json
      const infoEntry = entries.find(e => /^info\.json$/i.test(path.basename(e.filename)) || /^profile\.json$/i.test(path.basename(e.filename)));
      if (infoEntry && infoEntry.content) {
        try {
          const parsedInfo = JSON.parse(infoEntry.content);
          if (parsedInfo.name) name = parsedInfo.name;
          if (parsedInfo.description) description = parsedInfo.description;
        } catch (e) {}
      }

      // Check description.txt / info.txt / readme.txt
      if (!description) {
        const descEntry = entries.find(e => /^(description|info|readme)\.txt$/i.test(path.basename(e.filename)));
        if (descEntry) {
          description = descEntry.content.trim();
        }
      }

      // Fallback name to archive filename if not set
      if (!name && filename) {
        const base = path.basename(filename, path.extname(filename)).replace(/\.tar$/i, '');
        name = base.replace(/[^a-zA-Z0-9_\-\s\u0400-\u04FF]/g, ' ').trim();
      }

      // Find outboundContent (matches outbound, outbounds, 05_outbounds, etc.)
      const outboundEntry = entries.find(e => /(outbound|outbounds|05_outbounds)/i.test(path.basename(e.filename)) && /\.jsonc?$/i.test(e.filename))
        || entries.find(e => /\.jsonc?$/i.test(e.filename) && (e.content.includes('"outbounds"') || e.content.includes('"outbound"')));
      if (outboundEntry) {
        outboundContent = outboundEntry.content;
      }

      // Find routingContent (matches routing, route, routes, 03_routing, 04_routing, etc.)
      const routingEntry = entries.find(e => /(routing|routes?|03_routing|04_routing)/i.test(path.basename(e.filename)) && /\.jsonc?$/i.test(e.filename))
        || entries.find(e => /\.jsonc?$/i.test(e.filename) && (e.content.includes('"routing"') || e.content.includes('"rules"')));
      if (routingEntry) {
        routingContent = routingEntry.content;
      }

      // Fallback for JSON files if not matched by name: first json is outbound, second is routing
      const jsonEntries = entries.filter(e => /\.jsonc?$/i.test(e.filename) && !/^(info|profile)\.json$/i.test(path.basename(e.filename)));
      if (!outboundContent && jsonEntries.length > 0) {
        outboundContent = jsonEntries[0].content;
      }
      if (!routingContent && jsonEntries.length > 1) {
        routingContent = jsonEntries[1].content;
      }
      if (!outboundContent && jsonEntries.length === 1) {
        outboundContent = jsonEntries[0].content;
      }

      return sendJson(res, 200, {
        name: name || '',
        description: description || '',
        outboundContent: outboundContent || '',
        routingContent: routingContent || ''
      });
    } catch (err) {
      console.error('Error parsing archive:', err);
      return sendJson(res, 400, { error: 'Ошибка обработки архива' });
    }
  }

  // POST /api/settings
  if (urlParts === '/api/settings' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { outboundPath, routingPath, restartCommand, startCommand, stopCommand, statusCommand, port } = body;
      const data = loadData();

      let portChanged = false;
      let oldPort = data.settings.port || 3000;

      if (port !== undefined && port !== null && port !== '') {
        const p = parseInt(port, 10);
        if (!isNaN(p) && p > 0 && p <= 65535) {
          if (oldPort !== p) {
            portChanged = true;
          }
          data.settings.port = p;
        } else {
          return sendJson(res, 400, { error: 'Некорректный номер порта (от 1 до 65535)' });
        }
      }

      if (outboundPath) data.settings.outboundPath = outboundPath.trim();
      if (routingPath) data.settings.routingPath = routingPath.trim();
      if (restartCommand !== undefined) data.settings.restartCommand = restartCommand.trim();
      if (startCommand !== undefined) data.settings.startCommand = startCommand.trim();
      if (stopCommand !== undefined) data.settings.stopCommand = stopCommand.trim();
      if (statusCommand !== undefined) data.settings.statusCommand = statusCommand.trim();

      saveData(data);

      let message = 'Настройки сохранены';
      if (portChanged) {
        message = `Настройки сохранены! Порт панели изменен с ${oldPort} на ${data.settings.port}. Перезапуск сервера...`;
      }

      sendJson(res, 200, { message, settings: data.settings, portChanged, newPort: data.settings.port });

      if (portChanged) {
        console.log(`[Settings] Panel port changed to ${data.settings.port}. Exiting process for restart...`);
        setTimeout(() => {
          process.exit(0);
        }, 1000);
      }
      return;
    } catch (err) {
      return sendJson(res, 400, { error: 'Некорректные данные' });
    }
  }

  // --- STATIC FILE SERVER ---
  let filePath = path.join(PUBLIC_DIR, urlParts === '/' ? 'index.html' : urlParts);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`===================================================`);
  console.log(`🚀 XKeenSwitcher запущен на http://${HOST}:${PORT}`);
  console.log(`===================================================`);
});
