const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const zlib = require('zlib');
const os = require('os');

const DATA_FILE = path.join(__dirname, 'data', 'profiles.json');
const FAILOVER_LOG_FILE = path.join(__dirname, 'data', 'failover_history.json');
const AUTOFAILOVER_LOG_FILE = path.join(__dirname, 'data', 'autofailover_history.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let isUpdatingApp = false;

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

// Read application version from package.json
let appVersion = '2.0.1';
try {
  const pkgPath = path.join(__dirname, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) appVersion = pkg.version;
  }
} catch (e) {
  console.warn('Could not read package.json version:', e.message);
}

// In-memory service state & error cache
let lastServiceStatus = {
  status: 'unknown', // 'running' | 'stopped' | 'error' | 'unknown'
  output: '',
  error: '',
  timestamp: null,
  command: ''
};

// Default system routing 1: "Всё через VPN"
const SYSTEM_ROUTING_ALL_VPN = {
  id: 'routing_all_vpn',
  name: 'Всё через VPN',
  description: 'Весь интернет-трафик направляется через активное подключение',
  isSystem: true,
  content: JSON.stringify({
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        {
          type: 'field',
          ip: [
            'geoip:private'
          ],
          outboundTag: 'direct'
        }
      ]
    }
  }, null, 2),
  createdAt: '2026-01-01T00:00:00.000Z'
};

// Default system routing 2: "Всё через VPN кроме РФ"
const SYSTEM_ROUTING_EXCEPT_RU = {
  id: 'routing_except_ru',
  name: 'Всё через VPN кроме РФ',
  description: 'Весь трафик через VPN, кроме российских сайтов и IP-адресов (напрямую)',
  isSystem: true,
  content: JSON.stringify({
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        {
          type: 'field',
          inboundTag: [
            'redirect',
            'tproxy'
          ],
          outboundTag: 'block',
          network: 'udp',
          port: '135,137,138,139'
        },
        {
          type: 'field',
          inboundTag: [
            'redirect',
            'tproxy'
          ],
          outboundTag: 'direct',
          protocol: [
            'bittorrent'
          ]
        },
        {
          type: 'field',
          inboundTag: [
            'redirect',
            'tproxy'
          ],
          outboundTag: 'direct',
          domain: [
            'regexp:^([\\w\\-\\.]+\\.)ru$',
            'regexp:^([\\w\\-\\.]+\\.)su$',
            'regexp:^([\\w\\-\\.]+\\.)xn--p1ai$',
            'regexp:^([\\w\\-\\.]+\\.)xn--p1acf$',
            'regexp:^([\\w\\-\\.]+\\.)xn--80asehdb$',
            'regexp:^([\\w\\-\\.]+\\.)xn--c1avg$',
            'regexp:^([\\w\\-\\.]+\\.)xn--80aswg$',
            'regexp:^([\\w\\-\\.]+\\.)xn--80adxhks$',
            'regexp:^([\\w\\-\\.]+\\.)moscow$',
            'regexp:^([\\w\\-\\.]+\\.)xn--d1acj3b$',
            'ext:geosite_v2fly.dat:category-gov-ru',
            'ext:geosite_v2fly.dat:yandex',
            'ext:geosite_v2fly.dat:vk',
            'ext:geosite_v2fly.dat:steam'
          ]
        },
        {
          type: 'field',
          inboundTag: [
            'redirect',
            'tproxy'
          ],
          outboundTag: 'direct',
          ip: [
            'geoip:private',
            'ext:geoip_zkeenip.dat:ru'
          ]
        },
        {
          type: 'field',
          inboundTag: [
            'redirect',
            'tproxy'
          ],
          outboundTag: 'vless-reality',
          network: 'tcp,udp'
        }
      ]
    }
  }, null, 2),
  createdAt: '2026-01-01T00:00:00.000Z'
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

      // Look for routing file
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

// Strip single-line (//) and multi-line (/* */) comments and trailing commas from JSON string
function stripJsonComments(str) {
  if (!str) return '';
  const noComments = str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")|(\/\*[\s\S]*?\*\/)|(\/\/[^\r\n]*)/g, (match, stringToken, p2, multiComment, singleComment) => {
    if (stringToken) return stringToken;
    if (singleComment || multiComment) return '';
    return match;
  });
  return noComments.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonWithComments(str) {
  const stripped = stripJsonComments(str);
  return JSON.parse(stripped);
}

// Parse VLESS URL to Outbound JSON and metadata
function parseVlessUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Ссылка подключения не указана');
  }
  const cleanStr = urlStr.trim();
  if (!cleanStr.startsWith('vless://')) {
    throw new Error('Поддерживаются ссылки формата vless://');
  }

  const u = new URL(cleanStr);
  const id = u.username;
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10);
  if (!id || !address || !port) {
    throw new Error('Некорректная ссылка VLESS: отсутствуют обязательные параметры (UUID, адрес, порт)');
  }

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = '';
  try {
    name = decodeURIComponent(rawName).trim();
  } catch (e) {
    name = rawName.trim();
  }
  if (!name) {
    name = `VLESS - ${address}:${port}`;
  }

  const sp = u.searchParams;
  const type = (sp.get('type') || 'tcp').toLowerCase();
  const security = (sp.get('security') || 'none').toLowerCase();
  const encryption = sp.get('encryption') || 'none';
  const flow = sp.get('flow') || '';
  const pbk = sp.get('pbk') || '';
  const fp = sp.get('fp') || 'chrome';
  const sni = sp.get('sni') || '';
  const sid = sp.get('sid') || '';
  let spx = '/';
  try {
    spx = decodeURIComponent(sp.get('spx') || '/');
  } catch (e) {
    spx = sp.get('spx') || '/';
  }
  const serviceName = sp.get('serviceName') || sp.get('service_name') || '';

  // Stream settings
  const streamSettings = {
    network: type,
    security: security
  };

  if (security === 'reality') {
    streamSettings.realitySettings = {
      publicKey: pbk,
      fingerprint: fp,
      serverName: sni,
      shortId: sid,
      spiderX: spx
    };
  } else if (security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: sni,
      fingerprint: fp
    };
  }

  if (type === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: serviceName,
      multiMode: false
    };
  } else if (type === 'ws') {
    let wsPath = '/';
    try {
      wsPath = decodeURIComponent(sp.get('path') || '/');
    } catch (e) {
      wsPath = sp.get('path') || '/';
    }
    streamSettings.wsSettings = {
      path: wsPath,
      headers: {
        Host: sp.get('host') || sni || ''
      }
    };
  } else if (type === 'tcp') {
    const headerType = sp.get('headerType');
    if (headerType && headerType !== 'none') {
      streamSettings.tcpSettings = {
        header: {
          type: headerType
        }
      };
    }
  }

  const tag = security === 'reality' ? 'vless-reality' : (security !== 'none' ? `vless-${security}` : 'vless');

  const outboundJsonObj = {
    outbounds: [
      {
        tag: tag,
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: address,
              port: port,
              users: [
                {
                  id: id,
                  flow: flow,
                  encryption: encryption,
                  level: 0
                }
              ]
            }
          ]
        },
        streamSettings: streamSettings
      },
      {
        tag: 'direct',
        protocol: 'freedom'
      },
      {
        tag: 'block',
        protocol: 'blackhole',
        settings: {
          response: {
            type: 'http'
          }
        }
      }
    ]
  };

  return {
    name,
    serverAddress: address,
    serverPort: port,
    protocol: 'vless',
    security: security,
    sni: sni,
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Extract connection metadata from arbitrary outbound JSON
function extractOutboundMetadata(outboundContent) {
  let serverAddress = '';
  let serverPort = null;
  let protocol = 'vless';
  let security = 'none';
  let sni = '';

  try {
    const clean = stripJsonComments(outboundContent);
    const parsed = JSON.parse(clean);
    const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
    for (const ob of list) {
      if (!ob || ob.tag === 'direct' || ob.tag === 'block') continue;
      if (ob.protocol) protocol = ob.protocol;
      if (ob.settings) {
        if (ob.settings.vnext && ob.settings.vnext[0]) {
          serverAddress = ob.settings.vnext[0].address || '';
          serverPort = ob.settings.vnext[0].port || null;
        } else if (ob.settings.servers && ob.settings.servers[0]) {
          serverAddress = ob.settings.servers[0].address || '';
          serverPort = ob.settings.servers[0].port || null;
        }
      }
      if (ob.streamSettings) {
        if (ob.streamSettings.security) security = ob.streamSettings.security;
        if (ob.streamSettings.realitySettings && ob.streamSettings.realitySettings.serverName) {
          sni = ob.streamSettings.realitySettings.serverName;
        } else if (ob.streamSettings.tlsSettings && ob.streamSettings.tlsSettings.serverName) {
          sni = ob.streamSettings.tlsSettings.serverName;
        }
      }
      if (serverAddress) break;
    }
  } catch (e) {}

  return { serverAddress, serverPort, protocol, security, sni };
}

// Helper: Measure TCP handshake latency (ping in ms) to host:port
function measureTcpLatency(host, port, timeout = 3500) {
  return new Promise((resolve) => {
    if (!host || !port) {
      return resolve({ ok: false, error: 'Хост или порт не указаны' });
    }
    const cleanHost = String(host).trim().replace(/^\[|\]$/g, '');
    const numPort = parseInt(port, 10);
    if (!cleanHost || isNaN(numPort) || numPort <= 0 || numPort > 65535) {
      return resolve({ ok: false, error: 'Некорректный хост или порт' });
    }
    const t0 = Date.now();
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      if (!settled) {
        settled = true;
        const latency = Date.now() - t0;
        socket.destroy();
        resolve({ ok: true, latency });
      }
    });

    socket.on('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ ok: false, error: 'Таймаут соединения' });
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ ok: false, error: err.message || 'Недоступен' });
      }
    });

    try {
      socket.connect(numPort, cleanHost);
    } catch (e) {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: e.message || 'Ошибка сокета' });
      }
    }
  });
}

// Helper: Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Resolve GeoIP (Country Code & Name) via free ip-api.com
function resolveGeoIp(host) {
  return new Promise((resolve) => {
    if (!host || typeof host !== 'string') return resolve(null);
    const cleanHost = host.trim().replace(/^\[|\]$/g, '');
    if (!cleanHost) return resolve(null);

    // Skip local / private addresses
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost.startsWith('192.168.') || cleanHost.startsWith('10.') || cleanHost.startsWith('172.16.')) {
      return resolve(null);
    }

    try {
      const url = `http://ip-api.com/json/${encodeURIComponent(cleanHost)}?fields=status,country,countryCode`;
      const req = http.get(url, { timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(body);
              if (parsed && parsed.status === 'success' && parsed.countryCode) {
                return resolve({
                  countryCode: String(parsed.countryCode).toUpperCase(),
                  countryName: parsed.country || ''
                });
              }
            }
          } catch (e) {}
          resolve(null);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.on('error', () => {
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

let isGeoIpSweeping = false;
async function sweepGeoIpForConnections() {
  if (isGeoIpSweeping) return;
  isGeoIpSweeping = true;
  try {
    const data = loadData();
    let updated = false;
    for (const conn of data.connections) {
      if (!conn.countryCode && conn.serverAddress) {
        const geo = await resolveGeoIp(conn.serverAddress);
        if (geo) {
          conn.countryCode = geo.countryCode;
          conn.countryName = geo.countryName;
          updated = true;
          console.log(`[GeoIP] Determined country for "${conn.name}" (${conn.serverAddress}) -> ${geo.countryName} (${geo.countryCode})`);
        }
        await sleep(300);
      }
    }
    if (updated) {
      saveData(data);
    }
  } catch (err) {
    console.error('[GeoIP] Error sweeping connections:', err);
  } finally {
    isGeoIpSweeping = false;
  }
}

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

// Helper to download a file with HTTP/HTTPS redirects support
function downloadFileWithRedirects(fileUrl, destPath, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Слишком много перенаправлений при скачивании файла'));
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(fileUrl);
    } catch (e) {
      return reject(new Error('Некорректный URL: ' + fileUrl));
    }
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      headers: {
        'User-Agent': 'XKeenSwitcher-Updater',
        'Accept': '*/*'
      },
      timeout: 30000
    };
    const req = client.get(fileUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, fileUrl).href;
        }
        res.resume();
        return downloadFileWithRedirects(redirectUrl, destPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Ошибка скачивания: HTTP ${res.statusCode} ${res.statusMessage || ''}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => resolve());
      });
      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch (e) {}
        reject(err);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Таймаут соединения при скачивании файла обновления'));
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });
}

// Helper to recursively copy directories with exclusion list
function copyDirRecursiveSync(srcDir, destDir, excludeNames = []) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeNames.includes(entry.name)) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath, excludeNames);
    } else if (entry.isSymbolicLink()) {
      try {
        const link = fs.readlinkSync(srcPath);
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        fs.symlinkSync(link, destPath);
      } catch (e) {}
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Evaluate service status from command output and exit code
function evaluateServiceStatus(res) {
  const combined = ((res.stdout || '') + ' ' + (res.stderr || '') + ' ' + (res.error || '')).toLowerCase();
  
  if (combined.includes('failed') || combined.includes('fatal') || combined.includes('panic') || combined.includes('syntax error') || combined.includes('invalid config') || combined.includes('cannot start') || combined.includes('ошибка')) {
    return 'error';
  }

  if (combined.includes('is running') || combined.includes(' running') || combined.includes('[ok] xray is running') || combined.includes('active (running)') || combined.includes('работает') || (combined.includes('запущен') && !combined.includes('не запущен') && !combined.includes('не работает'))) {
    return 'running';
  }

  if (combined.includes('stopped') || combined.includes('not running') || combined.includes('is not running') || combined.includes('is dead') || combined.includes('inactive') || combined.includes('остановлен') || combined.includes('не запущен') || combined.includes('не работает')) {
    return 'stopped';
  }

  if (res.success && res.code === 0) {
    return 'running';
  }

  return 'error';
}

// Write target file safely
function writeTargetFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// --- PURE JS ZIP CREATOR & PARSER ---
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

const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  CRC32_TABLE[i] = c;
}

function calculateCrc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}

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
    const isUtf8 = /[^\x00-\x7F]/.test(file.filename);
    const flag = isUtf8 ? 0x0800 : 0;
    const versionNeeded = 10;

    const lh = Buffer.alloc(30 + filenameBuf.length + size);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(versionNeeded, 4);
    lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(0, 8);
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
    ch.writeUInt16LE(0x0014, 4);
    ch.writeUInt16LE(versionNeeded, 6);
    ch.writeUInt16LE(flag, 8);
    ch.writeUInt16LE(0, 10);
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
    ch.writeUInt32LE(0x00000020, 38);
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

function parseZipBuffer(buf) {
  const entries = [];
  if (!Buffer.isBuffer(buf) || buf.length < 22) return entries;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdEntries = buf.readUInt16LE(eocdOffset + 10);
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

      if (filename.endsWith('/')) continue;

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
  }
  return entries;
}

// Load data from file with v1.0 migration and auto-detection
function loadData() {
  const detected = detectConfigPaths();
  let data = {
    settings: {
      outboundPath: detected.outboundPath,
      routingPath: detected.routingPath,
      restartCommand: 'xkeen -restart',
      startCommand: 'xkeen -start',
      stopCommand: 'xkeen -stop',
      statusCommand: 'xkeen -status',
      activeConnectionId: null,
      port: 3000,
      failover: {
        enabled: false,
        primaryConnectionId: '',
        backupConnectionId: '',
        checkIntervalSec: 25,
        failThreshold: 3,
        recoveryThreshold: 3,
        ruCheckHost: '77.88.8.8',
        ruCheckPort: 53,
        canaryUrl: 'http://cp.cloudflare.com/generate_204',
        state: 'normal',
        lastCheckAt: null,
        lastSwitchAt: null,
        consecutiveFails: 0,
        consecutiveSuccesses: 0,
        lastLog: 'Авто-переключение не настроено'
      },
      autoFailover: {
        enabled: false,
        strategy: 'lowest_ping',
        primaryMode: 'manual_active',
        preferredPrimaryId: '',
        specificPrimaryId: '',
        poolConnectionIds: [],
        checkIntervalSec: 20,
        failThreshold: 3,
        autoReturn: true,
        recoveryThreshold: 3,
        canaryUrl: 'http://cp.cloudflare.com/generate_204',
        state: 'normal',
        activeBackupId: null,
        lastCheckAt: null,
        lastSwitchAt: null,
        consecutiveFails: 0,
        consecutiveSuccesses: 0,
        lastLog: 'Авто-резерв не настроен'
      }
    },
    connections: [],
    routings: [
      { ...SYSTEM_ROUTING_ALL_VPN },
      { ...SYSTEM_ROUTING_EXCEPT_RU }
    ]
  };

  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(content);

      data.settings = {
        ...data.settings,
        ...(parsed.settings || {}),
        failover: {
          ...data.settings.failover,
          ...((parsed.settings && parsed.settings.failover) || {})
        },
        autoFailover: {
          ...data.settings.autoFailover,
          ...((parsed.settings && parsed.settings.autoFailover) || {})
        }
      };

      if (!data.settings.activeConnectionId && parsed.settings && parsed.settings.activeProfileId) {
        data.settings.activeConnectionId = parsed.settings.activeProfileId;
      }

      if (data.settings.outboundPath && !fs.existsSync(data.settings.outboundPath) && fs.existsSync(detected.outboundPath)) {
        data.settings.outboundPath = detected.outboundPath;
      }
      if (data.settings.routingPath && !fs.existsSync(data.settings.routingPath) && fs.existsSync(detected.routingPath)) {
        data.settings.routingPath = detected.routingPath;
      }

      // Load Routings
      if (Array.isArray(parsed.routings) && parsed.routings.length > 0) {
        data.routings = parsed.routings;
      }

      // Ensure system routing 1 "Всё через VPN" exists and is properly locked
      const sysRoutingIdx = data.routings.findIndex(r => r.id === 'routing_all_vpn' || r.name === 'Всё через VPN');
      let sysAllVpn;
      if (sysRoutingIdx === -1) {
        sysAllVpn = { ...SYSTEM_ROUTING_ALL_VPN };
      } else {
        data.routings[sysRoutingIdx].isSystem = true;
        data.routings[sysRoutingIdx].name = 'Всё через VPN';
        data.routings[sysRoutingIdx].id = 'routing_all_vpn';
        data.routings[sysRoutingIdx].content = SYSTEM_ROUTING_ALL_VPN.content;
        sysAllVpn = data.routings[sysRoutingIdx];
      }

      // Ensure system routing 2 "Всё через VPN кроме РФ" exists and is properly locked
      const sysExceptRuIdx = data.routings.findIndex(r => r.id === 'routing_except_ru' || r.name === 'Всё через VPN кроме РФ' || r.name === 'Все кроме РФ через VPN');
      let sysExceptRu;
      if (sysExceptRuIdx === -1) {
        sysExceptRu = { ...SYSTEM_ROUTING_EXCEPT_RU };
      } else {
        const oldId = data.routings[sysExceptRuIdx].id;
        data.routings[sysExceptRuIdx].isSystem = true;
        data.routings[sysExceptRuIdx].name = 'Всё через VPN кроме РФ';
        data.routings[sysExceptRuIdx].id = 'routing_except_ru';
        data.routings[sysExceptRuIdx].description = SYSTEM_ROUTING_EXCEPT_RU.description;
        data.routings[sysExceptRuIdx].content = SYSTEM_ROUTING_EXCEPT_RU.content;
        sysExceptRu = data.routings[sysExceptRuIdx];

        if (oldId && oldId !== 'routing_except_ru' && Array.isArray(parsed.connections)) {
          for (const conn of parsed.connections) {
            if (conn.routingId === oldId) {
              conn.routingId = 'routing_except_ru';
            }
          }
        }
      }

      // Order routings: User configs first, Protected/System configs under them
      const userRoutings = data.routings.filter(r => !r.isSystem && r.id !== 'routing_all_vpn' && r.id !== 'routing_except_ru');
      data.routings = [...userRoutings, sysAllVpn, sysExceptRu];

      // Load Connections
      if (Array.isArray(parsed.connections) && parsed.connections.length > 0) {
        data.connections = parsed.connections.map(c => {
          const meta = extractOutboundMetadata(c.outboundContent);
          return {
            id: c.id,
            name: c.name || 'Подключение',
            description: c.description || '',
            routingId: c.routingId || 'routing_all_vpn',
            outboundContent: c.outboundContent || '',
            serverAddress: c.serverAddress || meta.serverAddress || '',
            serverPort: c.serverPort || meta.serverPort || null,
            protocol: c.protocol || meta.protocol || 'vless',
            security: c.security || meta.security || 'none',
            sni: c.sni || meta.sni || '',
            countryCode: c.countryCode || null,
            countryName: c.countryName || null,
            lastPing: c.lastPing !== undefined ? c.lastPing : null,
            lastPingStatus: c.lastPingStatus || null,
            lastPingCheckedAt: c.lastPingCheckedAt || null,
            createdAt: c.createdAt || new Date().toISOString()
          };
        });
      }

      // Auto-recover connection if connections array is empty but outbound file exists
      if (data.connections.length === 0 && data.settings.outboundPath && fs.existsSync(data.settings.outboundPath)) {
        try {
          const content = fs.readFileSync(data.settings.outboundPath, 'utf8');
          if (content.trim()) {
            const meta = extractOutboundMetadata(content);
            if (meta.serverAddress) {
              const customRouting = data.routings.find(r => !r.isSystem);
              const connId = 'conn_aeza_swe';
              const autoConn = {
                id: connId,
                name: 'AEZA SWE',
                description: 'Автоматически импортировано из активной конфигурации Xray',
                routingId: customRouting ? customRouting.id : 'routing_all_vpn',
                outboundContent: content,
                serverAddress: meta.serverAddress,
                serverPort: meta.serverPort,
                protocol: meta.protocol || 'vless',
                security: meta.security || 'reality',
                sni: meta.sni || '',
                createdAt: new Date().toISOString()
              };
              data.connections.push(autoConn);
              data.settings.activeConnectionId = connId;
            }
          }
        } catch (autoErr) {
          console.error('Error auto-importing outbound config:', autoErr);
        }
      }

      return data;
    }
  } catch (err) {
    console.error('Error loading profiles.json:', err);
  }

  return data;
}

// Save data to file
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving data to profiles.json:', err);
    return false;
  }
}

// Internal: Activate connection files and execute restart command
async function activateConnectionInternal(connId, data, updateActiveState = true) {
  const conn = data.connections.find(c => c.id === connId);
  if (!conn) {
    throw new Error('Подключение не найдено');
  }

  let routing = data.routings.find(r => r.id === conn.routingId);
  if (!routing) {
    routing = data.routings.find(r => r.id === 'routing_all_vpn') || SYSTEM_ROUTING_ALL_VPN;
  }

  const { outboundPath, routingPath, restartCommand } = data.settings;
  const fileWriteStatus = { outbound: false, routing: false, error: null };
  let restartStatus = { executed: false, output: '', error: '' };

  try {
    writeTargetFile(outboundPath, conn.outboundContent);
    fileWriteStatus.outbound = true;

    writeTargetFile(routingPath, routing.content);
    fileWriteStatus.routing = true;
  } catch (err) {
    console.error('File write error during activation:', err);
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

  if (updateActiveState) {
    data.settings.activeConnectionId = connId;
    saveData(data);
  }

  return {
    conn,
    routing,
    fileWriteStatus,
    restartStatus,
    serviceStatus: lastServiceStatus
  };
}

// ==============================================================================
// FAILOVER WATCHDOG ENGINE (БЕЛЫЕ СПИСКИ / RECOVERY)
// ==============================================================================
let failoverTimer = null;
let failoverRunning = false;
let failoverCooldownUntil = 0;
let lastFailoverCheckTime = 0;

function checkCanary(urlStr = 'http://cp.cloudflare.com/generate_204', timeout = 3500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(u, { timeout }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ ok: true, statusCode: res.statusCode });
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'Таймаут соединения' });
      });
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message || 'Ошибка сети' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || 'Ошибка URL' });
    }
  });
}

function loadFailoverHistory() {
  try {
    if (fs.existsSync(FAILOVER_LOG_FILE)) {
      const content = fs.readFileSync(FAILOVER_LOG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('[Failover] Error reading history:', e.message);
  }
  return [];
}

function appendFailoverHistory(entry) {
  try {
    const list = loadFailoverHistory();
    const newRecord = {
      id: 'fo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toISOString(),
      ...entry
    };
    list.unshift(newRecord);
    const trimmed = list.slice(0, 100);
    fs.writeFileSync(FAILOVER_LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    return newRecord;
  } catch (e) {
    console.error('[Failover] Error saving history:', e.message);
  }
}

function clearFailoverHistory() {
  try {
    fs.writeFileSync(FAILOVER_LOG_FILE, JSON.stringify([], null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[Failover] Error clearing history:', e.message);
    return false;
  }
}

function startFailoverWatchdog() {
  if (failoverTimer) clearInterval(failoverTimer);
  failoverTimer = setInterval(failoverTick, 5000);
  console.log('[Failover] Фоновый монитор БС запущен');
}

async function failoverTick() {
  if (failoverRunning) return;

  const data = loadData();
  const fo = data.settings && data.settings.failover;
  if (!fo || !fo.enabled) return;
  if (!fo.primaryConnectionId || !fo.backupConnectionId) {
    fo.enabled = false;
    fo.lastLog = 'Режим БС отключен: не заданы основное или резервное подключения';
    saveData(data);
    return;
  }

  const primaryConn = data.connections.find(c => c.id === fo.primaryConnectionId);
  const backupConn = data.connections.find(c => c.id === fo.backupConnectionId);

  if (!primaryConn || !backupConn) {
    fo.enabled = false;
    fo.lastLog = 'Режим БС отключен: выбранные подключения не найдены в списке';
    saveData(data);
    return;
  }

  const now = Date.now();
  if (now < failoverCooldownUntil) {
    return;
  }

  const intervalMs = Math.max(10, (fo.checkIntervalSec || 25)) * 1000;
  if (now - lastFailoverCheckTime < intervalMs) {
    return;
  }

  lastFailoverCheckTime = now;
  failoverRunning = true;

  try {
    const currentActiveId = data.settings.activeConnectionId;

    // Step 1: Check Russian internet link liveness
    const ruHost = (fo.ruCheckHost || '77.88.8.8').trim();
    const ruPort = parseInt(fo.ruCheckPort, 10) || 53;
    const ruPing = await measureTcpLatency(ruHost, ruPort, 2000);

    fo.lastCheckAt = new Date().toISOString();

    if (!ruPing.ok) {
      fo.state = 'suspended';
      fo.lastLog = `Провайдер недоступен (Рунет ${ruHost}:${ruPort} не отвечает). Переключения заблокированы.`;
      saveData(data);
      return;
    }

    // Step 2: State-based checks
    const isCurrentlyOnBackup = (currentActiveId === fo.backupConnectionId);

    if (!isCurrentlyOnBackup) {
      // Normal state (Primary active): check if Primary VLESS / foreign internet works
      const primPing = await measureTcpLatency(primaryConn.serverAddress, primaryConn.serverPort, 3500);
      let healthy = primPing.ok;

      // If TCP socket opened, also test Canary URL
      if (healthy && fo.canaryUrl) {
        const canaryRes = await checkCanary(fo.canaryUrl, 3500);
        healthy = canaryRes.ok;
      }

      if (!healthy) {
        fo.consecutiveFails = (fo.consecutiveFails || 0) + 1;
        fo.consecutiveSuccesses = 0;
        fo.lastLog = `Основной VLESS не отвечает (${fo.consecutiveFails}/${fo.failThreshold || 3})`;

        if (fo.consecutiveFails >= (fo.failThreshold || 3)) {
          console.log(`[Failover] Activating backup connection: ${backupConn.name}`);
          fo.state = 'backup';
          fo.consecutiveFails = 0;
          fo.lastSwitchAt = new Date().toISOString();
          fo.lastLog = `Блокировка БС! Переключено на "${backupConn.name}"`;

          appendFailoverHistory({
            event: 'switch_to_backup',
            title: 'Переключение на БС (Резерв)',
            fromName: primaryConn.name,
            toName: backupConn.name,
            reason: `Зафиксировано сбоев проверок подряд: ${fo.failThreshold || 3}. Домашний интернет в РФ доступен.`
          });

          await activateConnectionInternal(fo.backupConnectionId, data, true);
          failoverCooldownUntil = Date.now() + 60000;
        }
      } else {
        fo.state = 'normal';
        fo.consecutiveFails = 0;
        fo.lastLog = `Основное подключение стабильно (${primPing.latency} ms)`;
      }
    } else {
      // Backup state: probe if Primary connection is unblocked
      const primPing = await measureTcpLatency(primaryConn.serverAddress, primaryConn.serverPort, 3500);

      if (primPing.ok) {
        fo.consecutiveSuccesses = (fo.consecutiveSuccesses || 0) + 1;
        fo.lastLog = `Основной сервер отвечает (${fo.consecutiveSuccesses}/${fo.recoveryThreshold || 3}, пинг ${primPing.latency} ms)`;

        if (fo.consecutiveSuccesses >= (fo.recoveryThreshold || 3)) {
          console.log(`[Failover] Primary unblocked! Switching back to: ${primaryConn.name}`);
          fo.state = 'normal';
          fo.consecutiveSuccesses = 0;
          fo.lastSwitchAt = new Date().toISOString();
          fo.lastLog = `БС отключены! Возврат на основной профиль "${primaryConn.name}"`;

          appendFailoverHistory({
            event: 'switch_to_primary',
            title: 'Возврат на основной VLESS',
            fromName: backupConn.name,
            toName: primaryConn.name,
            reason: `Основной сервер ответил успешно ${fo.recoveryThreshold || 3} раз(а) подряд (блокировка зарубежных серверов снята).`
          });

          await activateConnectionInternal(fo.primaryConnectionId, data, true);
          failoverCooldownUntil = Date.now() + 60000;
        }
      } else {
        fo.consecutiveSuccesses = 0;
        fo.state = 'backup';
        fo.lastLog = `Режим БС активен. Основной VLESS пока недоступен`;
      }
    }

    saveData(data);
  } catch (err) {
    console.error('[Failover] Error in watchdog tick:', err);
  } finally {
    failoverRunning = false;
  }
}

// ==============================================================================
// AUTO-FAILOVER WATCHDOG ENGINE (ОБЩЕЕ РЕЗЕРВИРОВАНИЕ ПОДКЛЮЧЕНИЙ)
// ==============================================================================
let autoFailoverTimer = null;
let autoFailoverRunning = false;
let autoFailoverCooldownUntil = 0;
let lastAutoFailoverCheckTime = 0;

function loadAutoFailoverHistory() {
  try {
    if (fs.existsSync(AUTOFAILOVER_LOG_FILE)) {
      const content = fs.readFileSync(AUTOFAILOVER_LOG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('[AutoFailover] Error reading history:', e.message);
  }
  return [];
}

function appendAutoFailoverHistory(entry) {
  try {
    const list = loadAutoFailoverHistory();
    const newRecord = {
      id: 'af_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toISOString(),
      ...entry
    };
    list.unshift(newRecord);
    const trimmed = list.slice(0, 100);
    fs.writeFileSync(AUTOFAILOVER_LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    return newRecord;
  } catch (e) {
    console.error('[AutoFailover] Error saving history:', e.message);
  }
}

function clearAutoFailoverHistory() {
  try {
    fs.writeFileSync(AUTOFAILOVER_LOG_FILE, JSON.stringify([], null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[AutoFailover] Error clearing history:', e.message);
    return false;
  }
}

function startAutoFailoverWatchdog() {
  if (autoFailoverTimer) clearInterval(autoFailoverTimer);
  autoFailoverTimer = setInterval(autoFailoverTick, 5000);
  console.log('[AutoFailover] Фоновый монитор авто-резерва запущен');
}

async function autoFailoverTick() {
  if (autoFailoverRunning) return;

  const data = loadData();
  const af = data.settings && data.settings.autoFailover;
  if (!af || !af.enabled) return;

  // Если активен режим Белых Списков (ТСПУ глушит зарубежный трафик), авто-резерв приостанавливается
  const fo = data.settings && data.settings.failover;
  if (fo && fo.enabled && fo.state === 'backup') {
    af.state = 'suspended';
    af.lastLog = 'Режим БС активен. Авто-резерв приостановлен.';
    saveData(data);
    return;
  }

  const now = Date.now();
  if (now < autoFailoverCooldownUntil) {
    return;
  }

  const intervalMs = Math.max(10, (af.checkIntervalSec || 20)) * 1000;
  if (now - lastAutoFailoverCheckTime < intervalMs) {
    return;
  }

  lastAutoFailoverCheckTime = now;
  autoFailoverRunning = true;

  try {
    // 1. Определение основного (желаемого) подключения
    let primaryId = (af.primaryMode === 'specific_id' && af.specificPrimaryId)
      ? af.specificPrimaryId
      : (af.preferredPrimaryId || data.settings.activeConnectionId);

    if (!af.preferredPrimaryId && primaryId) {
      af.preferredPrimaryId = primaryId;
    }

    const primaryConn = data.connections.find(c => c.id === primaryId);
    if (!primaryConn) {
      af.lastLog = 'Ошибка: основное подключение не найдено';
      saveData(data);
      return;
    }

    const currentActiveId = data.settings.activeConnectionId;
    const isCurrentlyOnBackup = (af.state === 'backup' && af.activeBackupId && currentActiveId === af.activeBackupId);

    af.lastCheckAt = new Date().toISOString();

    if (!isCurrentlyOnBackup) {
      // Штатный режим: проверяем основное/текущее подключение
      const primPing = await measureTcpLatency(primaryConn.serverAddress, primaryConn.serverPort, 3000);
      let healthy = primPing.ok;

      // Если сокет ответил, контрольно проверяем сквозной запрос
      if (healthy && af.canaryUrl) {
        const canaryRes = await checkCanary(af.canaryUrl, 3000);
        healthy = canaryRes.ok;
      }

      if (!healthy) {
        af.consecutiveFails = (af.consecutiveFails || 0) + 1;
        af.consecutiveSuccesses = 0;
        af.lastLog = `Основное подключение не отвечает (${af.consecutiveFails}/${af.failThreshold || 3})`;

        if (af.consecutiveFails >= (af.failThreshold || 3)) {
          // Поиск кандидатов из пула
          let poolIds = (Array.isArray(af.poolConnectionIds) && af.poolConnectionIds.length > 0)
            ? af.poolConnectionIds
            : data.connections.map(c => c.id);

          const candidateConns = data.connections.filter(c => c.id !== primaryId && poolIds.includes(c.id));
          if (candidateConns.length === 0) {
            af.lastLog = 'Сбой основного, но в пуле резерва нет других подключений';
            saveData(data);
            return;
          }

          // Параллельный опрос всех кандидатов по TCP
          const probePromises = candidateConns.map(async (c) => {
            const res = await measureTcpLatency(c.serverAddress, c.serverPort, 2500);
            return { conn: c, ok: res.ok, latency: res.latency };
          });
          const results = await Promise.all(probePromises);
          const alive = results.filter(r => r.ok);

          if (alive.length === 0) {
            af.lastLog = `Сбой основного! Все серверы из пула (${candidateConns.length}) также недоступны`;
            saveData(data);
            return;
          }

          let selected;
          if (af.strategy === 'priority_order') {
            selected = alive[0]; // Первый живой по порядку в пуле
          } else {
            alive.sort((a, b) => a.latency - b.latency);
            selected = alive[0]; // Минимальный пинг
          }

          const backupConn = selected.conn;
          console.log(`[AutoFailover] Switching to backup: "${backupConn.name}" (${selected.latency} ms)`);
          af.state = 'backup';
          af.activeBackupId = backupConn.id;
          af.consecutiveFails = 0;
          af.consecutiveSuccesses = 0;
          af.lastSwitchAt = new Date().toISOString();
          af.lastLog = `Сбой основного! Включен резерв "${backupConn.name}" (${selected.latency} ms)`;

          appendAutoFailoverHistory({
            event: 'switch_to_backup',
            title: 'Переключение на резерв',
            fromName: primaryConn.name,
            toName: backupConn.name,
            reason: `Основное подключение не отвечает (${af.failThreshold || 3} сбоя подряд). Выбран резерв "${backupConn.name}" (пинг: ${selected.latency} ms, стратегия: ${af.strategy === 'priority_order' ? 'по порядку' : 'наименьший пинг'}).`
          });

          await activateConnectionInternal(backupConn.id, data, true);
          autoFailoverCooldownUntil = Date.now() + 60000;
        }
      } else {
        af.state = 'normal';
        af.consecutiveFails = 0;
        af.activeBackupId = null;
        af.lastLog = `Основное подключение "${primaryConn.name}" стабильно (${primPing.latency} ms)`;
      }
    } else {
      // Режим резерва: проверяем восстановление основного подключения
      if (af.autoReturn) {
        const primPing = await measureTcpLatency(primaryConn.serverAddress, primaryConn.serverPort, 3000);
        if (primPing.ok) {
          af.consecutiveSuccesses = (af.consecutiveSuccesses || 0) + 1;
          af.lastLog = `Основной сервер "${primaryConn.name}" отвечает (${af.consecutiveSuccesses}/${af.recoveryThreshold || 3}, пинг ${primPing.latency} ms)`;

          if (af.consecutiveSuccesses >= (af.recoveryThreshold || 3)) {
            console.log(`[AutoFailover] Primary recovered! Switching back to: ${primaryConn.name}`);
            af.state = 'normal';
            af.activeBackupId = null;
            af.consecutiveSuccesses = 0;
            af.lastSwitchAt = new Date().toISOString();
            af.lastLog = `Основной сервер восстановился! Возврат на "${primaryConn.name}"`;

            const currentConn = data.connections.find(c => c.id === currentActiveId);
            appendAutoFailoverHistory({
              event: 'switch_to_primary',
              title: 'Возврат на основное подключение',
              fromName: currentConn ? currentConn.name : 'Резерв',
              toName: primaryConn.name,
              reason: `Основной сервер стабильно ответил ${af.recoveryThreshold || 3} раз(а) подряд (пинг: ${primPing.latency} ms).`
            });

            await activateConnectionInternal(primaryId, data, true);
            autoFailoverCooldownUntil = Date.now() + 60000;
          }
        } else {
          af.consecutiveSuccesses = 0;
          const currentConn = data.connections.find(c => c.id === currentActiveId);
          af.lastLog = `Резерв "${currentConn ? currentConn.name : 'Резерв'}" активен. Основной пока недоступен.`;
        }
      } else {
        const currentConn = data.connections.find(c => c.id === currentActiveId);
        af.lastLog = `Резерв "${currentConn ? currentConn.name : 'Резерв'}" активен (автовозврат отключен).`;
      }
    }

    saveData(data);
  } catch (err) {
    console.error('[AutoFailover] Error in watchdog tick:', err);
  } finally {
    autoFailoverRunning = false;
  }
}

// MIME types for static server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

// Helper: send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-HTTP-Method-Override'
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

// Initialize data and port
const initialData = loadData();
const PORT = process.env.PORT || (initialData.settings && initialData.settings.port) || 3000;

// Create HTTP Server
const server = http.createServer(async (req, res) => {
  const urlParts = req.url.split('?')[0];

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-HTTP-Method-Override'
    });
    return res.end();
  }

  // --- API ROUTES ---

  // GET /api/data
  if (urlParts === '/api/data' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, { ...data, version: appVersion });
  }

  // GET /api/version
  if (urlParts === '/api/version' && req.method === 'GET') {
    return sendJson(res, 200, { version: appVersion });
  }

  // POST /api/app/update - Update application to new version from GitHub
  if (urlParts === '/api/app/update' && req.method === 'POST') {
    if (isUpdatingApp) {
      return sendJson(res, 409, { error: 'Процесс обновления уже запущен. Пожалуйста, подождите.' });
    }

    isUpdatingApp = true;
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const requestedTag = body.tag || (body.version ? (body.version.startsWith('v') ? body.version : 'v' + body.version) : null);
      const tarballUrlFromBody = body.tarball_url;

      // 1. Создание резервной копии профилей и настроек
      if (fs.existsSync(DATA_FILE)) {
        try {
          const dataDir = path.dirname(DATA_FILE);
          const bakPath = path.join(dataDir, 'profiles.json.bak_before_update');
          const bakTimed = path.join(dataDir, `profiles.json.bak_${Date.now()}`);
          fs.copyFileSync(DATA_FILE, bakPath);
          fs.copyFileSync(DATA_FILE, bakTimed);
          console.log('[Updater] Резервная копия базы сохранена в', bakPath);
        } catch (bakErr) {
          console.warn('[Updater] Не удалось создать бэкап profiles.json:', bakErr.message);
        }
      }

      // 2. Определение URL для загрузки
      let downloadUrl = tarballUrlFromBody;
      if (!downloadUrl) {
        if (requestedTag && requestedTag !== 'latest') {
          downloadUrl = `https://github.com/sergey1900/XKeenSwitcher/archive/refs/tags/${requestedTag}.tar.gz`;
        } else {
          downloadUrl = 'https://github.com/sergey1900/XKeenSwitcher/archive/refs/heads/main.tar.gz';
        }
      }

      console.log(`[Updater] Запуск обновления до ${requestedTag || 'последней версии'}. URL: ${downloadUrl}`);

      // 3. Подготовка временной директории
      const baseTmp = fs.existsSync('/opt/tmp') ? '/opt/tmp' : os.tmpdir();
      const updateTmpDir = path.join(baseTmp, `xkeen-update-${Date.now()}`);
      fs.mkdirSync(updateTmpDir, { recursive: true });
      const archiveFile = path.join(updateTmpDir, 'release.tar.gz');

      // 4. Скачивание архива (curl с fallback на https)
      let downloaded = false;
      const curlRes = await runShellCommand(`curl -f -s -L --connect-timeout 10 --max-time 60 "${downloadUrl}" -o "${archiveFile}"`, 65000);
      if (curlRes.success && fs.existsSync(archiveFile) && fs.statSync(archiveFile).size > 1000) {
        downloaded = true;
        console.log(`[Updater] Архив успешно скачан через curl (${fs.statSync(archiveFile).size} байт)`);
      } else {
        console.log('[Updater] Загрузка через curl не удалась или файл пуст, пробуем через Node.js https...');
        try {
          await downloadFileWithRedirects(downloadUrl, archiveFile);
          if (fs.existsSync(archiveFile) && fs.statSync(archiveFile).size > 1000) {
            downloaded = true;
            console.log(`[Updater] Архив успешно скачан через https (${fs.statSync(archiveFile).size} байт)`);
          }
        } catch (dlErr) {
          console.error('[Updater] Ошибка скачивания через https:', dlErr.message);
        }
      }

      if (!downloaded || !fs.existsSync(archiveFile) || fs.statSync(archiveFile).size < 1000) {
        try { fs.rmSync(updateTmpDir, { recursive: true, force: true }); } catch (e) {}
        isUpdatingApp = false;
        return sendJson(res, 500, { error: `Не удалось загрузить архив обновления с GitHub (${downloadUrl}). Проверьте подключение к интернету на роутере.` });
      }

      // 5. Распаковка архива
      console.log('[Updater] Распаковка архива обновления...');
      const extractRes = await runShellCommand(`tar -xzf "${archiveFile}" -C "${updateTmpDir}"`, 30000);
      if (extractRes.code !== 0) {
        try { fs.rmSync(updateTmpDir, { recursive: true, force: true }); } catch (e) {}
        isUpdatingApp = false;
        return sendJson(res, 500, { error: `Ошибка распаковки архива обновления: ${extractRes.stderr || extractRes.error}` });
      }

      // 6. Поиск распакованной директории с исходным кодом
      let extractedRoot = '';
      const dirEntries = fs.readdirSync(updateTmpDir);
      for (const entry of dirEntries) {
        const full = path.join(updateTmpDir, entry);
        if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'server.js'))) {
          extractedRoot = full;
          break;
        }
      }
      if (!extractedRoot && fs.existsSync(path.join(updateTmpDir, 'server.js'))) {
        extractedRoot = updateTmpDir;
      }

      if (!extractedRoot || !fs.existsSync(path.join(extractedRoot, 'server.js')) || !fs.existsSync(path.join(extractedRoot, 'package.json'))) {
        try { fs.rmSync(updateTmpDir, { recursive: true, force: true }); } catch (e) {}
        isUpdatingApp = false;
        return sendJson(res, 500, { error: 'В архиве обновления не обнаружены необходимые файлы приложения (server.js, package.json).' });
      }

      // 7. Безопасная установка файлов в текущую директорию приложения (__dirname)
      // Исключаем папку 'data', чтобы ни при каких обстоятельствах не затереть пользовательские настройки и профили
      console.log(`[Updater] Копирование обновлённых файлов из ${extractedRoot} в ${__dirname}...`);
      copyDirRecursiveSync(extractedRoot, __dirname, ['data', '.git', '.github', '.system_generated', 'node_modules']);

      // 8. Считывание новой версии
      let newInstalledVersion = requestedTag || '2.0.0';
      try {
        const newPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        if (newPkg.version) {
          newInstalledVersion = newPkg.version;
          appVersion = newPkg.version;
        }
      } catch (e) {}

      // 9. Очистка временных файлов архива
      try {
        fs.rmSync(updateTmpDir, { recursive: true, force: true });
      } catch (e) {
        runShellCommand(`rm -rf "${updateTmpDir}"`, 5000).catch(() => {});
      }

      console.log(`[Updater] Обновление до ${newInstalledVersion} установлено. Перезапуск веб-сервера...`);

      // 10. Отложенный перезапуск веб-сервера
      const initScript = '/opt/etc/init.d/S99xkeen-switcher';
      if (fs.existsSync(initScript)) {
        const restartCmd = `sh -c "sleep 1.5 && ${initScript} restart >/dev/null 2>&1 &"`;
        exec(restartCmd);
      } else {
        const nodeBin = process.execPath || process.argv[0] || 'node';
        const scriptPath = path.join(__dirname, 'server.js');
        const restartCmd = `sh -c "sleep 1.5 && kill -9 ${process.pid} && '${nodeBin}' '${scriptPath}' >/dev/null 2>&1 &"`;
        exec(restartCmd);
      }

      isUpdatingApp = false;
      return sendJson(res, 200, {
        success: true,
        message: `Обновление до ${newInstalledVersion} успешно установлено! Сервер перезапускается...`,
        version: newInstalledVersion
      });
    } catch (err) {
      console.error('[Updater] Критическая ошибка при обновлении:', err);
      isUpdatingApp = false;
      return sendJson(res, 500, { error: `Критический сбой при обновлении: ${err.message}` });
    }
  }

  // GET /api/failover - Get current failover status and settings
  if (urlParts === '/api/failover' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, {
      failover: data.settings.failover || {},
      activeConnectionId: data.settings.activeConnectionId
    });
  }

  // POST /api/failover/settings - Update failover settings
  if (urlParts === '/api/failover/settings' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const data = loadData();
      const enabled = Boolean(body.enabled);
      const primaryConnectionId = body.primaryConnectionId || '';
      const backupConnectionId = body.backupConnectionId || '';

      if (enabled) {
        if (!primaryConnectionId || !data.connections.some(c => c.id === primaryConnectionId)) {
          return sendJson(res, 400, { error: 'Не выбрано основное подключение!' });
        }
        if (!backupConnectionId || !data.connections.some(c => c.id === backupConnectionId)) {
          return sendJson(res, 400, { error: 'Не выбрано резервное подключение (для Белых Списков)!' });
        }
        if (primaryConnectionId === backupConnectionId) {
          return sendJson(res, 400, { error: 'Основное и резервное подключения должны отличаться!' });
        }
      }

      data.settings.failover = {
        ...(data.settings.failover || {}),
        enabled,
        primaryConnectionId,
        backupConnectionId,
        checkIntervalSec: Math.max(10, parseInt(body.checkIntervalSec, 10) || 25),
        failThreshold: Math.max(1, parseInt(body.failThreshold, 10) || 3),
        recoveryThreshold: Math.max(1, parseInt(body.recoveryThreshold, 10) || 3),
        ruCheckHost: (body.ruCheckHost || '77.88.8.8').trim(),
        ruCheckPort: parseInt(body.ruCheckPort, 10) || 53,
        canaryUrl: (body.canaryUrl || 'http://cp.cloudflare.com/generate_204').trim(),
        consecutiveFails: 0,
        consecutiveSuccesses: 0,
        lastLog: enabled ? 'Настройки обновлены. Авто-мониторинг активен.' : 'Авто-переключение отключено.'
      };

      saveData(data);
      failoverCooldownUntil = Date.now() + 15000; // 15s pause after saving settings

      return sendJson(res, 200, {
        message: 'Настройки авто-переключения сохранены',
        failover: data.settings.failover
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка сохранения настроек' });
    }
  }

  // POST /api/failover/toggle - Quick toggle enable/disable
  if (urlParts === '/api/failover/toggle' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const data = loadData();
      const enabled = Boolean(body.enabled);

      if (!data.settings.failover) {
        data.settings.failover = {};
      }

      if (enabled) {
        const fo = data.settings.failover;
        let primaryId = fo.primaryConnectionId;
        if (body.primaryConnectionId !== undefined) {
          primaryId = body.primaryConnectionId;
        } else if (!primaryId) {
          primaryId = data.settings.activeConnectionId;
        }

        let backupId = fo.backupConnectionId;
        if (body.backupConnectionId !== undefined) {
          backupId = body.backupConnectionId;
        }

        const primaryExists = data.connections.some(c => c.id === primaryId);
        const backupExists = data.connections.some(c => c.id === backupId);

        if (!primaryId || !primaryExists) {
          return sendJson(res, 400, {
            error: 'Не выбрано основное подключение! Выберите его перед включением БС.'
          });
        }
        if (!backupId || !backupExists) {
          return sendJson(res, 400, {
            error: 'Не выбрано резервное подключение для Белых Списков! Выберите его перед включением.'
          });
        }
        if (primaryId === backupId) {
          return sendJson(res, 400, {
            error: 'Основное и резервное подключения не должны совпадать!'
          });
        }

        data.settings.failover.primaryConnectionId = primaryId;
        data.settings.failover.backupConnectionId = backupId;
      }

      data.settings.failover.enabled = enabled;
      data.settings.failover.lastLog = enabled
        ? 'Мониторинг БС включен'
        : 'Мониторинг БС отключен';

      saveData(data);
      failoverCooldownUntil = Date.now() + 3000;

      return sendJson(res, 200, {
        message: enabled ? 'Режим БС включен' : 'Режим БС отключен',
        enabled,
        failover: data.settings.failover
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка переключения' });
    }
  }

  // GET /api/failover/history - Get failover switch history
  if (urlParts === '/api/failover/history' && req.method === 'GET') {
    const history = loadFailoverHistory();
    return sendJson(res, 200, { history });
  }

  // POST /api/failover/history/clear - Clear failover switch history
  if (urlParts === '/api/failover/history/clear' && req.method === 'POST') {
    const success = clearFailoverHistory();
    return sendJson(res, 200, { success, message: 'Журнал переключений очищен' });
  }

  // GET /api/autofailover - Get current auto-failover status and settings
  if (urlParts === '/api/autofailover' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, {
      autoFailover: data.settings.autoFailover || {},
      activeConnectionId: data.settings.activeConnectionId
    });
  }

  // POST /api/autofailover/settings - Update auto-failover settings
  if (urlParts === '/api/autofailover/settings' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const data = loadData();

      data.settings.autoFailover = {
        ...(data.settings.autoFailover || {}),
        enabled: Boolean(body.enabled),
        strategy: body.strategy === 'priority_order' ? 'priority_order' : 'lowest_ping',
        primaryMode: body.primaryMode === 'specific_id' ? 'specific_id' : 'manual_active',
        specificPrimaryId: body.specificPrimaryId || '',
        preferredPrimaryId: body.preferredPrimaryId || data.settings.activeConnectionId || '',
        poolConnectionIds: Array.isArray(body.poolConnectionIds) ? body.poolConnectionIds : [],
        checkIntervalSec: Math.max(10, parseInt(body.checkIntervalSec, 10) || 20),
        failThreshold: Math.max(1, parseInt(body.failThreshold, 10) || 3),
        autoReturn: body.autoReturn !== undefined ? Boolean(body.autoReturn) : true,
        recoveryThreshold: Math.max(1, parseInt(body.recoveryThreshold, 10) || 3),
        canaryUrl: (body.canaryUrl || 'http://cp.cloudflare.com/generate_204').trim(),
        consecutiveFails: 0,
        consecutiveSuccesses: 0,
        lastLog: body.enabled ? 'Настройки обновлены. Авто-резерв активен.' : 'Авто-резерв отключен.'
      };

      saveData(data);
      autoFailoverCooldownUntil = Date.now() + 15000; // 15s pause after saving settings

      return sendJson(res, 200, {
        message: 'Настройки авто-резерва сохранены',
        autoFailover: data.settings.autoFailover
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка сохранения настроек' });
    }
  }

  // POST /api/autofailover/toggle - Quick toggle enable/disable
  if (urlParts === '/api/autofailover/toggle' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const data = loadData();
      const enabled = Boolean(body.enabled);

      if (!data.settings.autoFailover) {
        data.settings.autoFailover = {};
      }

      data.settings.autoFailover.enabled = enabled;
      data.settings.autoFailover.lastLog = enabled
        ? 'Авто-переключение включено'
        : 'Авто-переключение отключено';

      // Auto-populate pool if empty
      if (!Array.isArray(data.settings.autoFailover.poolConnectionIds) || data.settings.autoFailover.poolConnectionIds.length === 0) {
        data.settings.autoFailover.poolConnectionIds = data.connections.map(c => c.id);
      }

      saveData(data);
      autoFailoverCooldownUntil = Date.now() + 3000;

      return sendJson(res, 200, {
        message: enabled ? 'Авто-переключение включено' : 'Авто-переключение отключено',
        enabled,
        autoFailover: data.settings.autoFailover
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка переключения' });
    }
  }

  // GET /api/autofailover/history - Get auto-failover switch history
  if (urlParts === '/api/autofailover/history' && req.method === 'GET') {
    const history = loadAutoFailoverHistory();
    return sendJson(res, 200, { history });
  }

  // POST /api/autofailover/history/clear - Clear auto-failover switch history
  if (urlParts === '/api/autofailover/history/clear' && req.method === 'POST') {
    const success = clearAutoFailoverHistory();
    return sendJson(res, 200, { success, message: 'Журнал авто-резерва очищен' });
  }

  // POST /api/connections/parse-url - Parse VLESS link
  if (urlParts === '/api/connections/parse-url' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { url } = body;
      if (!url) {
        return sendJson(res, 400, { error: 'Укажите ссылку подключения' });
      }
      const parsed = parseVlessUrl(url);
      return sendJson(res, 200, parsed);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка парсинга ссылки' });
    }
  }

  // GET /api/connections - List all connections
  if (urlParts === '/api/connections' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, {
      connections: data.connections,
      activeConnectionId: data.settings.activeConnectionId
    });
  }

  // POST /api/connections - Add connection
  if (urlParts === '/api/connections' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      let { name, description, routingId, outboundContent, url } = body;

      if (url && !outboundContent) {
        const parsedFromUrl = parseVlessUrl(url);
        name = name || parsedFromUrl.name;
        outboundContent = parsedFromUrl.outboundJson;
      }

      if (!name || !outboundContent) {
        return sendJson(res, 400, { error: 'Заполните название и содержимое outbound.json' });
      }

      try {
        parseJsonWithComments(outboundContent);
      } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в outbound.json: ' + e.message });
      }

      const data = loadData();

      if (!routingId || !data.routings.some(r => r.id === routingId)) {
        routingId = 'routing_all_vpn';
      }

      const meta = extractOutboundMetadata(outboundContent);
      let countryCode = null;
      let countryName = null;
      if (meta.serverAddress) {
        try {
          const geo = await resolveGeoIp(meta.serverAddress);
          if (geo) {
            countryCode = geo.countryCode;
            countryName = geo.countryName;
          }
        } catch (e) {}
      }

      const newConnection = {
        id: 'conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: name.trim(),
        description: (description || '').trim(),
        routingId: routingId,
        outboundContent: outboundContent.trim(),
        serverAddress: meta.serverAddress,
        serverPort: meta.serverPort,
        protocol: meta.protocol,
        security: meta.security,
        sni: meta.sni,
        countryCode: countryCode,
        countryName: countryName,
        lastPing: null,
        lastPingStatus: null,
        lastPingCheckedAt: null,
        createdAt: new Date().toISOString()
      };

      data.connections.push(newConnection);
      saveData(data);

      return sendJson(res, 201, { message: 'Подключение успешно добавлено', connection: newConnection });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Некорректный запрос' });
    }
  }

  // PUT /api/connections/:id - Update connection
  if (urlParts.startsWith('/api/connections/') && !urlParts.includes('/activate') && !urlParts.includes('/ping') && !urlParts.includes('/set-routing') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/connections/', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);

    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    try {
      const body = await parseJsonBody(req);
      const { name, description, routingId, outboundContent } = body;

      if (!name || !outboundContent) {
        return sendJson(res, 400, { error: 'Заполните название и содержимое outbound.json' });
      }

      try {
        parseJsonWithComments(outboundContent);
      } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в outbound.json: ' + e.message });
      }

      conn.name = name.trim();
      conn.description = (description || '').trim();
      if (routingId && data.routings.some(r => r.id === routingId)) {
        conn.routingId = routingId;
      }
      conn.outboundContent = outboundContent.trim();
      
      const meta = extractOutboundMetadata(conn.outboundContent);
      const hostChanged = (conn.serverAddress !== meta.serverAddress);
      conn.serverAddress = meta.serverAddress;
      conn.serverPort = meta.serverPort;
      conn.protocol = meta.protocol;
      conn.security = meta.security;
      conn.sni = meta.sni;
      conn.updatedAt = new Date().toISOString();

      if (hostChanged || !conn.countryCode) {
        try {
          const geo = await resolveGeoIp(meta.serverAddress);
          if (geo) {
            conn.countryCode = geo.countryCode;
            conn.countryName = geo.countryName;
          }
        } catch (e) {}
      }

      let activationDetails = null;
      if (data.settings.activeConnectionId === id) {
        activationDetails = await activateConnectionInternal(id, data, true);
      } else {
        saveData(data);
      }

      return sendJson(res, 200, {
        message: 'Подключение успешно обновлено',
        connection: conn,
        activationDetails
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Некорректный запрос' });
    }
  }

  // POST /api/connections/:id/set-routing - Change routing (with ping check if active)
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/set-routing') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/set-routing', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);

    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    try {
      const body = await parseJsonBody(req);
      const { routingId } = body;
      const targetRouting = data.routings.find(r => r.id === routingId);
      if (!targetRouting) {
        return sendJson(res, 400, { error: 'Выбранный роутинг не найден' });
      }

      conn.routingId = routingId;
      let msg = `Маршрутизация для "${conn.name}" изменена на "${targetRouting.name}"`;
      let pingResult = null;

      if (data.settings.activeConnectionId === id) {
        const { routingPath, restartCommand } = data.settings;
        writeTargetFile(routingPath, targetRouting.content);
        if (restartCommand && restartCommand.trim()) {
          const resCmd = await runShellCommand(restartCommand.trim());
          const computedStatus = evaluateServiceStatus(resCmd);
          lastServiceStatus = {
            status: computedStatus,
            output: resCmd.stdout,
            error: resCmd.stderr || resCmd.error || '',
            code: resCmd.code,
            timestamp: new Date().toISOString(),
            command: restartCommand.trim()
          };
          msg += ' (Служба XKeen перезапущена)';

          // Test ping of active connection with new routing
          await sleep(1200);
          const pr = await measureTcpLatency(conn.serverAddress, conn.serverPort, 3500);
          conn.lastPing = pr.ok ? pr.latency : null;
          conn.lastPingStatus = pr.ok ? 'ok' : 'unreachable';
          conn.lastPingCheckedAt = new Date().toISOString();
          pingResult = {
            ok: pr.ok,
            ping: conn.lastPing,
            status: conn.lastPingStatus,
            latencyStr: pr.ok ? `${conn.lastPing} ms` : 'Недоступен'
          };
        }
      }

      saveData(data);
      return sendJson(res, 200, {
        message: msg,
        connection: conn,
        routing: targetRouting,
        serviceStatus: lastServiceStatus,
        pingResult
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка обновления роутинга' });
    }
  }

  // DELETE /api/connections/:id - Delete connection
  if (urlParts.startsWith('/api/connections/') && !urlParts.includes('/activate') && !urlParts.includes('/ping') && req.method === 'DELETE') {
    const id = urlParts.replace('/api/connections/', '');
    const data = loadData();
    const index = data.connections.findIndex(c => c.id === id);

    if (index === -1) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    data.connections.splice(index, 1);
    if (data.settings.activeConnectionId === id) {
      data.settings.activeConnectionId = null;
    }

    // Clean up Failover (БС) references
    if (data.settings.failover) {
      if (data.settings.failover.primaryConnectionId === id) {
        data.settings.failover.primaryConnectionId = '';
        data.settings.failover.enabled = false;
        data.settings.failover.lastLog = 'Основное подключение удалено. Режим БС отключен.';
      }
      if (data.settings.failover.backupConnectionId === id) {
        data.settings.failover.backupConnectionId = '';
        data.settings.failover.enabled = false;
        data.settings.failover.lastLog = 'Резервное подключение удалено. Режим БС отключен.';
      }
    }

    // Clean up Auto-Failover references
    if (data.settings.autoFailover) {
      if (data.settings.autoFailover.specificPrimaryId === id) {
        data.settings.autoFailover.specificPrimaryId = '';
      }
      if (data.settings.autoFailover.preferredPrimaryId === id) {
        data.settings.autoFailover.preferredPrimaryId = '';
      }
      if (Array.isArray(data.settings.autoFailover.poolConnectionIds)) {
        data.settings.autoFailover.poolConnectionIds = data.settings.autoFailover.poolConnectionIds.filter(pid => pid !== id);
      }
    }

    saveData(data);
    return sendJson(res, 200, { message: 'Подключение удалено' });
  }

  // POST /api/connections/:id/activate - Activate connection with immediate ping check
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/activate') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/activate', '');
    const data = loadData();

    try {
      const result = await activateConnectionInternal(id, data, true);

      // Wait a moment for Xray to bind and establish tunnel
      await sleep(1200);

      // Measure connectivity right away
      const conn = result.conn;
      const pingRes = await measureTcpLatency(conn.serverAddress, conn.serverPort, 3500);
      conn.lastPing = pingRes.ok ? pingRes.latency : null;
      conn.lastPingStatus = pingRes.ok ? 'ok' : 'unreachable';
      conn.lastPingCheckedAt = new Date().toISOString();

      // Update failover state if manual activation occurs
      if (data.settings.failover && data.settings.failover.enabled) {
        if (id === data.settings.failover.primaryConnectionId) {
          data.settings.failover.state = 'normal';
          data.settings.failover.consecutiveFails = 0;
          data.settings.failover.lastLog = `Вручную активирован основной профиль "${result.conn.name}"`;
        } else if (id === data.settings.failover.backupConnectionId) {
          data.settings.failover.state = 'backup';
          data.settings.failover.consecutiveSuccesses = 0;
          data.settings.failover.lastLog = `Вручную активирован резервный (БС) профиль "${result.conn.name}"`;
        } else {
          data.settings.failover.lastLog = `Вручную активирован сторонний профиль "${result.conn.name}"`;
        }
        failoverCooldownUntil = Date.now() + 60000; // 60s cooldown
      }

      // Update autoFailover state if manual activation occurs
      if (data.settings.autoFailover && data.settings.autoFailover.enabled) {
        const af = data.settings.autoFailover;
        if (af.primaryMode === 'manual_active') {
          af.preferredPrimaryId = id;
          af.state = 'normal';
          af.activeBackupId = null;
          af.consecutiveFails = 0;
          af.consecutiveSuccesses = 0;
          af.lastLog = `Вручную активирован профиль "${result.conn.name}". Установлен как основной.`;
        } else if (af.primaryMode === 'specific_id') {
          if (id === af.specificPrimaryId) {
            af.state = 'normal';
            af.activeBackupId = null;
            af.consecutiveFails = 0;
            af.consecutiveSuccesses = 0;
            af.lastLog = `Вручную активирован основной профиль "${result.conn.name}"`;
          } else {
            af.lastLog = `Вручную активирован профиль "${result.conn.name}"`;
          }
        }
        autoFailoverCooldownUntil = Date.now() + 60000; // 60s cooldown
      }

      saveData(data);

      return sendJson(res, 200, {
        message: `Подключение "${result.conn.name}" активировано!`,
        activeConnectionId: id,
        connectionName: result.conn.name,
        routingName: result.routing.name,
        fileWriteStatus: result.fileWriteStatus,
        restartStatus: result.restartStatus,
        serviceStatus: result.serviceStatus,
        pingResult: {
          ok: pingRes.ok,
          ping: conn.lastPing,
          status: conn.lastPingStatus,
          latencyStr: pingRes.ok ? `${conn.lastPing} ms` : 'Недоступен'
        }
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка активации подключения' });
    }
  }

  // POST /api/connections/:id/ping - Check single connection availability directly via TCP
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/ping') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/ping', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);

    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    try {
      const pingResult = await measureTcpLatency(conn.serverAddress, conn.serverPort, 3500);

      conn.lastPing = pingResult.ok ? pingResult.latency : null;
      conn.lastPingStatus = pingResult.ok ? 'ok' : 'unreachable';
      conn.lastPingCheckedAt = new Date().toISOString();

      if (!conn.countryCode && conn.serverAddress) {
        try {
          const geo = await resolveGeoIp(conn.serverAddress);
          if (geo) {
            conn.countryCode = geo.countryCode;
            conn.countryName = geo.countryName;
          }
        } catch (e) {}
      }

      saveData(data);

      return sendJson(res, 200, {
        id: conn.id,
        ok: pingResult.ok,
        ping: conn.lastPing,
        status: conn.lastPingStatus,
        latencyStr: pingResult.ok ? `${conn.lastPing} ms` : 'Недоступен',
        checkedAt: conn.lastPingCheckedAt,
        countryCode: conn.countryCode,
        countryName: conn.countryName
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка проверки доступности: ' + err.message });
    }
  }

  // POST /api/connections/ping-all - Check all connections concurrently without touching service
  if (urlParts === '/api/connections/ping-all' && req.method === 'POST') {
    const data = loadData();
    if (!data.connections || data.connections.length === 0) {
      return sendJson(res, 200, { results: [], message: 'Нет подключений для проверки' });
    }

    try {
      const pingPromises = data.connections.map(async (conn) => {
        const pingResult = await measureTcpLatency(conn.serverAddress, conn.serverPort, 3500);
        conn.lastPing = pingResult.ok ? pingResult.latency : null;
        conn.lastPingStatus = pingResult.ok ? 'ok' : 'unreachable';
        conn.lastPingCheckedAt = new Date().toISOString();

        if (!conn.countryCode && conn.serverAddress) {
          try {
            const geo = await resolveGeoIp(conn.serverAddress);
            if (geo) {
              conn.countryCode = geo.countryCode;
              conn.countryName = geo.countryName;
            }
          } catch (e) {}
        }

        return {
          id: conn.id,
          ok: pingResult.ok,
          ping: conn.lastPing,
          status: conn.lastPingStatus,
          latencyStr: pingResult.ok ? `${conn.lastPing} ms` : 'Недоступен',
          checkedAt: conn.lastPingCheckedAt,
          countryCode: conn.countryCode,
          countryName: conn.countryName
        };
      });

      const results = await Promise.all(pingPromises);
      saveData(data);

      return sendJson(res, 200, {
        results,
        activeConnectionId: data.settings.activeConnectionId,
        message: `Проверено подключений: ${results.length}.`
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка при массовой проверке доступности: ' + err.message });
    }
  }

  // POST /api/connections/resolve-geoip - Background sweep GeoIP
  if (urlParts === '/api/connections/resolve-geoip' && req.method === 'POST') {
    sweepGeoIpForConnections();
    return sendJson(res, 200, { message: 'Фоновое определение стран запущено' });
  }

  // --- ROUTING CONFIGURATION ROUTES ---

  // GET /api/routings
  if (urlParts === '/api/routings' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, { routings: data.routings });
  }

  // POST /api/routings
  if (urlParts === '/api/routings' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { name, description, content } = body;

      if (!name || !content) {
        return sendJson(res, 400, { error: 'Заполните название и содержимое routing.json' });
      }

      try {
        parseJsonWithComments(content);
      } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в routing.json: ' + e.message });
      }

      const data = loadData();
      const newRouting = {
        id: 'routing_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: name.trim(),
        description: (description || '').trim(),
        isSystem: false,
        content: content.trim(),
        createdAt: new Date().toISOString()
      };

      const firstSysIdx = data.routings.findIndex(r => r.isSystem);
      if (firstSysIdx !== -1) {
        data.routings.splice(firstSysIdx, 0, newRouting);
      } else {
        data.routings.push(newRouting);
      }
      saveData(data);

      return sendJson(res, 201, { message: 'Конфигурация маршрутизации создана', routing: newRouting });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Некорректный запрос' });
    }
  }

  // PUT /api/routings/:id (forbidden for isSystem)
  if (urlParts.startsWith('/api/routings/') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/routings/', '');
    const data = loadData();
    const routing = data.routings.find(r => r.id === id);

    if (!routing) {
      return sendJson(res, 404, { error: 'Конфигурация маршрутизации не найдена' });
    }

    if (routing.isSystem) {
      return sendJson(res, 403, { error: `Системный роутинг "${routing.name}" защищен от редактирования` });
    }

    try {
      const body = await parseJsonBody(req);
      const { name, description, content } = body;

      if (!name || !content) {
        return sendJson(res, 400, { error: 'Заполните название и содержимое routing.json' });
      }

      try {
        parseJsonWithComments(content);
      } catch (e) {
        return sendJson(res, 400, { error: 'Синтаксическая ошибка в routing.json: ' + e.message });
      }

      routing.name = name.trim();
      routing.description = (description || '').trim();
      routing.content = content.trim();
      routing.updatedAt = new Date().toISOString();

      const activeConn = data.connections.find(c => c.id === data.settings.activeConnectionId);
      if (activeConn && activeConn.routingId === id) {
        const { routingPath, restartCommand } = data.settings;
        writeTargetFile(routingPath, routing.content);
        if (restartCommand && restartCommand.trim()) {
          const resCmd = await runShellCommand(restartCommand.trim());
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
      return sendJson(res, 200, { message: 'Конфигурация маршрутизации сохранена', routing });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Некорректный запрос' });
    }
  }

  // DELETE /api/routings/:id (forbidden for isSystem)
  if (urlParts.startsWith('/api/routings/') && req.method === 'DELETE') {
    const id = urlParts.replace('/api/routings/', '');
    const data = loadData();
    const index = data.routings.findIndex(r => r.id === id);

    if (index === -1) {
      return sendJson(res, 404, { error: 'Конфигурация маршрутизации не найдена' });
    }

    const routing = data.routings[index];
    if (routing.isSystem) {
      return sendJson(res, 403, { error: `Системный роутинг "${routing.name}" защищен от удаления` });
    }

    for (const conn of data.connections) {
      if (conn.routingId === id) {
        conn.routingId = 'routing_all_vpn';
      }
    }

    data.routings.splice(index, 1);
    saveData(data);
    return sendJson(res, 200, { message: 'Конфигурация маршрутизации удалена' });
  }

  // --- BACKUP & RESTORE ROUTES ---

  // GET /api/backup/export - Download full ZIP backup of settings, connections, and routings
  if (urlParts === '/api/backup/export' && req.method === 'GET') {
    const data = loadData();
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const backupPayload = {
      app: 'XKeenSwitcher',
      version: appVersion,
      exportedAt: new Date().toISOString(),
      settings: data.settings,
      connections: data.connections,
      routings: data.routings
    };

    const files = [
      { filename: 'backup.json', content: JSON.stringify(backupPayload, null, 2) },
      {
        filename: 'README.txt',
        content: `XKeenSwitcher 2.0 Резервная копия\nСоздана: ${new Date().toLocaleString()}\nПодключений: ${data.connections.length}\nРоутингов: ${data.routings.length}\nВерсия: ${appVersion}\n`
      }
    ];

    // Also include individual config files for easy inspection
    data.connections.forEach((c, idx) => {
      const safeName = (c.name || 'conn').replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '_');
      files.push({
        filename: `connections/${idx + 1}_${safeName}.json`,
        content: c.outboundContent
      });
    });

    data.routings.forEach((r, idx) => {
      const safeName = (r.name || 'routing').replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '_');
      files.push({
        filename: `routings/${idx + 1}_${safeName}.json`,
        content: r.content
      });
    });

    const zipBuffer = createZipBuffer(files);
    const downloadName = `xkeen-backup-${nowStr}.zip`;

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Content-Length': zipBuffer.length
    });
    return res.end(zipBuffer);
  }

  // POST /api/backup/restore - Restore settings, connections, and routings from uploaded ZIP or JSON
  if (urlParts === '/api/backup/restore' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      let restoreData = null;

      if (body.zipBase64) {
        const zipBuf = Buffer.from(body.zipBase64, 'base64');
        const entries = parseZipBuffer(zipBuf);

        // Find backup.json
        const backupEntry = entries.find(e => /^backup\.json$/i.test(path.basename(e.filename)));
        if (backupEntry && backupEntry.content) {
          try { restoreData = JSON.parse(backupEntry.content); } catch (e) {}
        }

        if (!restoreData) {
          // Look for profiles.json or any json with connections/routings/profiles
          for (const ent of entries) {
            try {
              const parsed = JSON.parse(ent.content);
              if (parsed.connections || parsed.profiles || parsed.routings) {
                restoreData = parsed;
                break;
              }
            } catch (e) {}
          }
        }

        if (!restoreData) {
          // Assemble from connections/ and routings/ entries in ZIP
          const assembledConns = [];
          const assembledRoutings = [];
          for (const ent of entries) {
            if (/\bconnections\/.*\.json$/i.test(ent.filename) && ent.content) {
              const name = path.basename(ent.filename, path.extname(ent.filename)).replace(/^\d+_/, '').replace(/_/g, ' ');
              assembledConns.push({ name: name, outboundContent: ent.content });
            } else if (/\broutings\/.*\.json$/i.test(ent.filename) && ent.content) {
              const name = path.basename(ent.filename, path.extname(ent.filename)).replace(/^\d+_/, '').replace(/_/g, ' ');
              assembledRoutings.push({ name: name, content: ent.content });
            }
          }
          if (assembledConns.length > 0 || assembledRoutings.length > 0) {
            restoreData = { connections: assembledConns, routings: assembledRoutings };
          }
        }
      } else if (body.backupData) {
        restoreData = body.backupData;
      } else if (body.connections || body.profiles || body.routings) {
        restoreData = body;
      } else if (Array.isArray(body)) {
        restoreData = { connections: body };
      }

      if (!restoreData) {
        return sendJson(res, 400, { error: 'Не удалось извлечь данные резервной копии из файла. Убедитесь, что загружаемый файл является ZIP-архивом резервной копии или JSON-файлом.' });
      }

      const currentData = loadData();
      let restoredConnections = [];
      let restoredRoutings = [];

      // Restore Routings
      if (Array.isArray(restoreData.routings)) {
        restoredRoutings = restoreData.routings.map(r => ({
          id: r.id || ('routing_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
          name: r.name || 'Маршрутизация',
          description: r.description || '',
          isSystem: Boolean(r.isSystem || r.id === 'routing_all_vpn' || r.id === 'routing_except_ru' || r.name === 'Всё через VPN' || r.name === 'Всё через VPN кроме РФ' || r.name === 'Все кроме РФ через VPN'),
          content: r.content || '',
          createdAt: r.createdAt || new Date().toISOString()
        }));
      }

      // Always guarantee system routing 1 exists
      const sysIdx = restoredRoutings.findIndex(r => r.id === 'routing_all_vpn' || r.name === 'Всё через VPN');
      if (sysIdx === -1) {
        restoredRoutings.unshift({ ...SYSTEM_ROUTING_ALL_VPN });
      } else {
        restoredRoutings[sysIdx] = { ...SYSTEM_ROUTING_ALL_VPN };
      }

      // Always guarantee system routing 2 exists
      const sysExceptRuIdx = restoredRoutings.findIndex(r => r.id === 'routing_except_ru' || r.name === 'Всё через VPN кроме РФ' || r.name === 'Все кроме РФ через VPN');
      if (sysExceptRuIdx === -1) {
        restoredRoutings.splice(1, 0, { ...SYSTEM_ROUTING_EXCEPT_RU });
      } else {
        restoredRoutings[sysExceptRuIdx] = { ...SYSTEM_ROUTING_EXCEPT_RU };
      }

      // Restore Connections (or migrate from profiles)
      const rawConnList = Array.isArray(restoreData.connections) ? restoreData.connections
        : (Array.isArray(restoreData.profiles) ? restoreData.profiles : []);

      restoredConnections = rawConnList.map(c => {
        const meta = extractOutboundMetadata(c.outboundContent || '');
        let targetRoutingId = c.routingId || 'routing_all_vpn';
        if (!restoredRoutings.some(r => r.id === targetRoutingId)) {
          targetRoutingId = 'routing_all_vpn';
        }
        return {
          id: c.id || ('conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
          name: c.name || 'Подключение',
          description: c.description || '',
          routingId: targetRoutingId,
          outboundContent: c.outboundContent || '',
          serverAddress: c.serverAddress || meta.serverAddress || '',
          serverPort: c.serverPort || meta.serverPort || null,
          protocol: c.protocol || meta.protocol || 'vless',
          security: c.security || meta.security || 'none',
          sni: c.sni || meta.sni || '',
          lastPing: null,
          lastPingStatus: null,
          lastPingCheckedAt: null,
          createdAt: c.createdAt || new Date().toISOString()
        };
      });

      // Restore Settings
      const newSettings = {
        ...currentData.settings,
        ...(restoreData.settings || {})
      };

      // Validate activeConnectionId
      if (newSettings.activeConnectionId && !restoredConnections.some(c => c.id === newSettings.activeConnectionId)) {
        newSettings.activeConnectionId = restoredConnections.length > 0 ? restoredConnections[0].id : null;
      }

      const mergedData = {
        settings: newSettings,
        connections: restoredConnections,
        routings: restoredRoutings
      };

      saveData(mergedData);

      // Re-apply active connection files if exists
      if (mergedData.settings.activeConnectionId) {
        try {
          await activateConnectionInternal(mergedData.settings.activeConnectionId, mergedData, true);
        } catch (e) {}
      }

      return sendJson(res, 200, {
        success: true,
        message: `Резервная копия успешно восстановлена: ${restoredConnections.length} подключений, ${restoredRoutings.length} роутингов`,
        counts: {
          connections: restoredConnections.length,
          routings: restoredRoutings.length
        }
      });
    } catch (err) {
      console.error('Error restoring backup:', err);
      return sendJson(res, 400, { error: 'Ошибка восстановления резервной копии: ' + err.message });
    }
  }

  // --- SERVICE CONTROL ROUTES ---

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

  // GET /api/settings - Get current settings
  if (urlParts === '/api/settings' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, { settings: data.settings });
  }

  // POST /api/settings - Update settings
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
  const safePath = path.normalize(urlParts === '/' ? '/index.html' : urlParts).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
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
      res.end(content);
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`===================================================`);
  console.log(`🚀 XKeenSwitcher 2.0 запущен на http://${HOST}:${PORT}`);
  console.log(`===================================================`);
  startFailoverWatchdog();
  startAutoFailoverWatchdog();
  setTimeout(sweepGeoIpForConnections, 2000);
});
