const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
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
let appVersion = '2.0.2';
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

  // Ensure dat symlinks for Xray and Mihomo if needed
  try {
    const xrayDatDir = '/opt/etc/xray/dat';
    if (fs.existsSync(xrayDatDir)) {
      if (!fs.existsSync(path.join(xrayDatDir, 'geoip.dat')) && fs.existsSync(path.join(xrayDatDir, 'geoip_v2fly.dat'))) {
        fs.symlinkSync(path.join(xrayDatDir, 'geoip_v2fly.dat'), path.join(xrayDatDir, 'geoip.dat'));
      }
      if (!fs.existsSync(path.join(xrayDatDir, 'geosite.dat')) && fs.existsSync(path.join(xrayDatDir, 'geosite_v2fly.dat'))) {
        fs.symlinkSync(path.join(xrayDatDir, 'geosite_v2fly.dat'), path.join(xrayDatDir, 'geosite.dat'));
      }
    }
    const mihomoDir = '/opt/etc/mihomo';
    if (fs.existsSync(mihomoDir) && fs.existsSync(path.join(xrayDatDir, 'geosite_v2fly.dat'))) {
      if (!fs.existsSync(path.join(mihomoDir, 'GeoSite.dat'))) {
        fs.symlinkSync(path.join(xrayDatDir, 'geosite_v2fly.dat'), path.join(mihomoDir, 'GeoSite.dat'));
      }
    }
  } catch (e) {}

  return { outboundPath, routingPath };
}

// Helper: Detect active proxy core from S05xkeen and binaries
function detectActiveProxyCore() {
  let activeCore = 'xray';
  const initdPath = '/opt/etc/init.d/S05xkeen';
  if (fs.existsSync(initdPath)) {
    try {
      const content = fs.readFileSync(initdPath, 'utf8');
      if (/name_client="mihomo"/.test(content)) {
        activeCore = 'mihomo';
      } else if (/name_client="xray"/.test(content)) {
        activeCore = 'xray';
      }
    } catch (e) {}
  }
  const hasXray = fs.existsSync('/opt/sbin/xray') || fs.existsSync('/opt/bin/xray');
  const hasMihomo = fs.existsSync('/opt/sbin/mihomo') || fs.existsSync('/opt/bin/mihomo');
  return {
    activeCore,
    hasXray,
    hasMihomo
  };
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

// Safely decode Base64 string with URL-safe replacement and padding
function decodeBase64Safe(str) {
  if (!str || typeof str !== 'string') return '';
  let clean = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (clean.length % 4 !== 0) {
    clean += '=';
  }
  try {
    return Buffer.from(clean, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

// Universal Proxy URL & Config parser: supports VLESS, VMess, Trojan, Shadowsocks, WireGuard/AmneziaWG, Hysteria2
function parseProxyUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Ссылка подключения или конфигурация не указана');
  }
  const cleanStr = urlStr.trim();

  // 1. WireGuard / AmneziaWG Config format ([Interface] ... [Peer])
  if (cleanStr.includes('[Interface]') || cleanStr.includes('[Peer]')) {
    return parseWireguardConfig(cleanStr);
  }

  // 2. VLESS
  if (cleanStr.startsWith('vless://')) {
    return parseVlessUrlInternal(cleanStr);
  }

  // 3. VMess
  if (cleanStr.startsWith('vmess://')) {
    return parseVmessUrl(cleanStr);
  }

  // 4. Trojan
  if (cleanStr.startsWith('trojan://')) {
    return parseTrojanUrl(cleanStr);
  }

  // 5. Shadowsocks
  if (cleanStr.startsWith('ss://')) {
    return parseShadowsocksUrl(cleanStr);
  }

  // 6. Amnezia VPN URL
  if (cleanStr.startsWith('vpn://')) {
    return parseAmneziaVpnUrl(cleanStr);
  }

  // 7. WireGuard / AmneziaWG URL
  if (cleanStr.startsWith('wireguard://') || cleanStr.startsWith('awg://')) {
    return parseWireguardUrl(cleanStr);
  }

  // 8. Hysteria 2
  if (cleanStr.startsWith('hysteria2://') || cleanStr.startsWith('hy2://')) {
    return parseHysteria2Url(cleanStr);
  }

  throw new Error('Неизвестный протокол. Поддерживаются: vless://, vmess://, vpn://, trojan://, ss://, wireguard://, awg://, hysteria2:// или файл конфига [Interface]');
}

// Backwards-compatible alias
function parseVlessUrl(urlStr) {
  return parseProxyUrl(urlStr);
}

// Parse VLESS URL to Outbound JSON and metadata
function parseVlessUrlInternal(cleanStr) {

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
    network: type,
    security: security,
    sni: sni,
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Parse VMess URL to Outbound JSON and metadata
function parseVmessUrl(cleanStr) {
  const rest = cleanStr.replace(/^vmess:\/\//i, '').trim();
  let conf;
  if (rest.startsWith('{')) {
    conf = JSON.parse(rest);
  } else {
    const decoded = decodeBase64Safe(rest);
    try {
      conf = JSON.parse(decoded);
    } catch (e) {
      throw new Error('Некорректная ссылка VMess: ошибка декодирования JSON: ' + e.message);
    }
  }

  const address = (conf.add || conf.host || '').replace(/^\[|\]$/g, '');
  const port = parseInt(conf.port, 10);
  const id = conf.id || '';
  if (!address || !port || !id) {
    throw new Error('Некорректная ссылка VMess: отсутствуют обязательные параметры (id, add, port)');
  }

  const name = (conf.ps || '').trim() || `VMess - ${address}:${port}`;
  const net = (conf.net || 'tcp').toLowerCase();
  const type = (conf.type || 'none').toLowerCase();
  const tls = (conf.tls || '').toLowerCase();
  const security = tls === 'tls' ? 'tls' : 'none';
  const aid = parseInt(conf.aid || 0, 10);
  const scy = conf.scy || 'auto';
  const sni = conf.sni || conf.host || address;

  const streamSettings = {
    network: net,
    security: security
  };

  if (security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: sni,
      fingerprint: conf.fp || 'chrome'
    };
    if (conf.alpn) {
      streamSettings.tlsSettings.alpn = String(conf.alpn).split(',').map(s => s.trim());
    }
  }

  if (net === 'ws') {
    streamSettings.wsSettings = {
      path: conf.path || '/',
      headers: {
        Host: conf.host || sni
      }
    };
  } else if (net === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: conf.path || conf.serviceName || '',
      multiMode: false
    };
  } else if (net === 'tcp' && type && type !== 'none') {
    streamSettings.tcpSettings = {
      header: { type: type }
    };
  }

  const tag = security === 'tls' ? 'vmess-tls' : 'vmess';

  const outboundJsonObj = {
    outbounds: [
      {
        tag: tag,
        protocol: 'vmess',
        settings: {
          vnext: [
            {
              address: address,
              port: port,
              users: [
                {
                  id: id,
                  alterId: aid,
                  security: scy,
                  level: 0
                }
              ]
            }
          ]
        },
        streamSettings: streamSettings
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name,
    serverAddress: address,
    serverPort: port,
    protocol: 'vmess',
    network: net,
    security: security,
    sni: sni,
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Parse Trojan URL to Outbound JSON and metadata
function parseTrojanUrl(cleanStr) {
  let str = cleanStr.trim();
  if (str.startsWith('trojan://')) str = str.substring(9);

  let rawName = '';
  if (str.includes('#')) {
    const parts = str.split('#');
    str = parts[0];
    try { rawName = decodeURIComponent(parts.slice(1).join('#')).trim(); } catch (e) { rawName = parts.slice(1).join('#').trim(); }
  }

  // Handle base64 encoded trojan body if present
  if (!str.includes('@') && !str.includes('?')) {
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8');
      if (decoded.includes('@')) {
        str = decoded;
      }
    } catch (e) {}
  }

  let searchStr = '';
  if (str.includes('?')) {
    const qParts = str.split('?');
    str = qParts[0];
    searchStr = qParts.slice(1).join('?');
  }

  const atIdx = str.lastIndexOf('@');
  if (atIdx === -1) {
    throw new Error('Некорректная ссылка Trojan: отсутствует разделитель @');
  }

  const userInfo = str.substring(0, atIdx);
  const hostPort = str.substring(atIdx + 1);

  let password = userInfo;
  if (userInfo.includes(':')) {
    const colonIdx = userInfo.indexOf(':');
    password = userInfo.substring(colonIdx + 1);
  }
  try { password = decodeURIComponent(password); } catch (e) {}

  let address = hostPort;
  let port = 443;
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon !== -1) {
    address = hostPort.substring(0, lastColon).replace(/^\[|\]$/g, '');
    port = parseInt(hostPort.substring(lastColon + 1), 10) || 443;
  } else {
    address = hostPort.replace(/^\[|\]$/g, '');
  }

  if (!password || !address || !port) {
    throw new Error('Некорректная ссылка Trojan: отсутствуют обязательные параметры (пароль, адрес, порт)');
  }

  let name = rawName || `Trojan - ${address}:${port}`;

  const sp = new URLSearchParams(searchStr);
  const type = (sp.get('type') || 'tcp').toLowerCase();
  const security = (sp.get('security') || 'tls').toLowerCase();
  const sni = sp.get('sni') || sp.get('peer') || address;
  const fp = sp.get('fp') || 'chrome';
  const flow = sp.get('flow') || '';
  const alpnStr = sp.get('alpn') || '';

  const streamSettings = {
    network: type,
    security: security
  };

  if (security === 'reality') {
    streamSettings.realitySettings = {
      publicKey: sp.get('pbk') || '',
      fingerprint: fp,
      serverName: sni,
      shortId: sp.get('sid') || '',
      spiderX: sp.get('spx') || '/'
    };
  } else if (security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: sni,
      fingerprint: fp,
      allowInsecure: (sp.get('allowInsecure') === '1' || sp.get('allowInsecure') === 'true' || sp.get('insecure') === '1')
    };
    if (alpnStr) {
      streamSettings.tlsSettings.alpn = alpnStr.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  if (type === 'ws') {
    streamSettings.wsSettings = {
      path: sp.get('path') || '/',
      headers: {
        Host: sp.get('host') || sni
      }
    };
  } else if (type === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: sp.get('serviceName') || sp.get('service_name') || '',
      multiMode: false
    };
  }

  const serverObj = {
    address: address,
    port: port,
    password: password,
    level: 0
  };
  if (flow) {
    serverObj.flow = flow;
  }

  const outboundJsonObj = {
    outbounds: [
      {
        tag: 'trojan',
        protocol: 'trojan',
        settings: {
          servers: [serverObj]
        },
        streamSettings: streamSettings
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name,
    serverAddress: address,
    serverPort: port,
    protocol: 'trojan',
    network: type,
    security: security,
    sni: sni,
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Parse Shadowsocks URL to Outbound JSON and metadata
function parseShadowsocksUrl(cleanStr) {
  let hashPart = '';
  let urlWithoutHash = cleanStr;
  if (cleanStr.includes('#')) {
    const p = cleanStr.split('#');
    urlWithoutHash = p[0];
    hashPart = p.slice(1).join('#');
  }
  let name = '';
  try { name = decodeURIComponent(hashPart).trim(); } catch (e) { name = hashPart.trim(); }

  const rest = urlWithoutHash.replace(/^ss:\/\//i, '').trim();
  let method = '';
  let password = '';
  let address = '';
  let port = null;

  if (rest.includes('@')) {
    const atIdx = rest.indexOf('@');
    const userPart = rest.substring(0, atIdx);
    const hostPortPart = rest.substring(atIdx + 1).split('/')[0].split('?')[0];

    let userDecoded = userPart;
    try {
      const d = decodeBase64Safe(userPart);
      if (d.includes(':')) userDecoded = d;
    } catch (e) {}

    const colIdx = userDecoded.indexOf(':');
    if (colIdx !== -1) {
      method = userDecoded.substring(0, colIdx);
      password = userDecoded.substring(colIdx + 1);
    }

    const lastCol = hostPortPart.lastIndexOf(':');
    if (lastCol !== -1) {
      address = hostPortPart.substring(0, lastCol).replace(/^\[|\]$/g, '');
      port = parseInt(hostPortPart.substring(lastCol + 1), 10);
    }
  } else {
    // Entire string is base64
    const decoded = decodeBase64Safe(rest.split('/')[0].split('?')[0]);
    if (decoded.includes('@')) {
      const atIdx = decoded.indexOf('@');
      const userPart = decoded.substring(0, atIdx);
      const hostPortPart = decoded.substring(atIdx + 1);
      const colIdx = userPart.indexOf(':');
      if (colIdx !== -1) {
        method = userPart.substring(0, colIdx);
        password = userPart.substring(colIdx + 1);
      }
      const lastCol = hostPortPart.lastIndexOf(':');
      if (lastCol !== -1) {
        address = hostPortPart.substring(0, lastCol).replace(/^\[|\]$/g, '');
        port = parseInt(hostPortPart.substring(lastCol + 1), 10);
      }
    }
  }

  if (!address || !port || !method) {
    throw new Error('Некорректная ссылка Shadowsocks: не удалось извлечь адрес, порт или метод шифрования');
  }

  if (!name) name = `Shadowsocks - ${address}:${port}`;

  const outboundJsonObj = {
    outbounds: [
      {
        tag: 'shadowsocks',
        protocol: 'shadowsocks',
        settings: {
          servers: [
            {
              address: address,
              port: port,
              method: method,
              password: password || '',
              level: 0
            }
          ]
        },
        streamSettings: {
          network: 'tcp'
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name,
    serverAddress: address,
    serverPort: port,
    protocol: 'shadowsocks',
    network: 'tcp',
    security: method,
    sni: '',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Parse WireGuard / AmneziaWG INI config text
function parseWireguardConfig(confText) {
  const lines = confText.split(/\r?\n/).map(l => l.trim());
  let currentSection = '';
  const iface = {};
  const peer = {};

  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.substring(0, eqIdx).trim().toLowerCase();
      const v = line.substring(eqIdx + 1).trim();
      if (currentSection === 'interface') iface[k] = v;
      else if (currentSection === 'peer') peer[k] = v;
    }
  }

  const privateKey = iface.privatekey || '';
  const address = iface.address || '10.0.0.2/32';
  const publicKey = peer.publickey || '';
  const endpoint = peer.endpoint || '';

  if (!privateKey || !publicKey || !endpoint) {
    throw new Error('Некорректный конфиг WireGuard: отсутствуют PrivateKey, PublicKey или Endpoint');
  }

  let endpointHost = '';
  let endpointPort = 51820;
  const lastCol = endpoint.lastIndexOf(':');
  if (lastCol !== -1) {
    endpointHost = endpoint.substring(0, lastCol).replace(/^\[|\]$/g, '');
    endpointPort = parseInt(endpoint.substring(lastCol + 1), 10) || 51820;
  } else {
    endpointHost = endpoint.replace(/^\[|\]$/g, '');
  }

  const isAwg = Boolean(iface.jc || iface.jmin || iface.jmax || iface.s1 || iface.h1);
  const name = `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${endpointHost}:${endpointPort}`;
  const cleanAddress = address.split(',')[0].trim();
  const psk = peer.presharedkey || peer.preshared_key || peer.psk || '';

  const outboundJsonObj = {
    outbounds: [
      {
        tag: isAwg ? 'amneziawg' : 'wireguard',
        protocol: 'wireguard',
        settings: {
          secretKey: privateKey,
          address: [cleanAddress],
          peers: [
            {
              publicKey: publicKey,
              endpoint: `${endpointHost}:${endpointPort}`,
              allowedIPs: ['0.0.0.0/0', '::/0'],
              preSharedKey: psk || undefined
            }
          ],
          mtu: parseInt(iface.mtu, 10) || 1420
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  let amneziaConfig = null;
  if (isAwg) {
    amneziaConfig = {
      client_ip: cleanAddress,
      client_priv_key: privateKey,
      server_pub_key: publicKey,
      psk: psk,
      version: parseInt(iface.protocol_version || '2', 10),
      jc: iface.jc !== undefined ? parseInt(iface.jc, 10) : undefined,
      jmin: iface.jmin !== undefined ? parseInt(iface.jmin, 10) : undefined,
      jmax: iface.jmax !== undefined ? parseInt(iface.jmax, 10) : undefined,
      s1: iface.s1 !== undefined ? parseInt(iface.s1, 10) : undefined,
      s2: iface.s2 !== undefined ? parseInt(iface.s2, 10) : undefined,
      s3: iface.s3 !== undefined ? parseInt(iface.s3, 10) : undefined,
      s4: iface.s4 !== undefined ? parseInt(iface.s4, 10) : undefined,
      h1: iface.h1 || undefined,
      h2: iface.h2 || undefined,
      h3: iface.h3 || undefined,
      h4: iface.h4 || undefined,
      i1: iface.i1 || undefined,
      i2: iface.i2 || undefined,
      i3: iface.i3 || undefined,
      i4: iface.i4 || undefined,
      i5: iface.i5 || undefined,
      dns: iface.dns ? iface.dns.split(',').map(s => s.trim()) : ['1.1.1.1', '1.0.0.1']
    };
  }

  return {
    name,
    serverAddress: endpointHost,
    serverPort: endpointPort,
    protocol: isAwg ? 'amneziawg' : 'wireguard',
    network: 'udp',
    security: isAwg ? 'Amnezia' : 'WG',
    sni: '',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4),
    amneziaConfig
  };
}

// Parse WireGuard URL (wireguard://... or awg://...)
function parseWireguardUrl(cleanStr) {
  const u = new URL(cleanStr);
  const privateKey = decodeURIComponent(u.username);
  const endpointHost = (u.hostname || '').replace(/^\[|\]$/g, '');
  const endpointPort = parseInt(u.port, 10) || 51820;
  const sp = u.searchParams;
  const publicKey = sp.get('publickey') || sp.get('pubkey') || '';
  const address = sp.get('address') || sp.get('ip') || '10.0.0.2/32';
  const psk = sp.get('psk') || sp.get('presharedkey') || sp.get('pre-shared-key') || '';

  if (!privateKey || !publicKey || !endpointHost) {
    throw new Error('Некорректная ссылка WireGuard: отсутствуют PrivateKey, PublicKey или хост');
  }

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = '';
  try { name = decodeURIComponent(rawName).trim(); } catch (e) { name = rawName.trim(); }
  const isAwg = cleanStr.startsWith('awg://') || Boolean(sp.get('jc') || sp.get('h1'));
  if (!name) name = `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${endpointHost}:${endpointPort}`;

  const outboundJsonObj = {
    outbounds: [
      {
        tag: isAwg ? 'amneziawg' : 'wireguard',
        protocol: 'wireguard',
        settings: {
          secretKey: privateKey,
          address: [address],
          peers: [
            {
              publicKey: publicKey,
              endpoint: `${endpointHost}:${endpointPort}`,
              allowedIPs: ['0.0.0.0/0', '::/0'],
              preSharedKey: psk || undefined
            }
          ],
          mtu: parseInt(sp.get('mtu'), 10) || 1420
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  let amneziaConfig = null;
  if (isAwg) {
    amneziaConfig = {
      client_ip: address,
      client_priv_key: privateKey,
      server_pub_key: publicKey,
      psk: psk,
      version: parseInt(sp.get('version') || '2', 10),
      jc: sp.get('jc') !== null ? parseInt(sp.get('jc'), 10) : undefined,
      jmin: sp.get('jmin') !== null ? parseInt(sp.get('jmin'), 10) : undefined,
      jmax: sp.get('jmax') !== null ? parseInt(sp.get('jmax'), 10) : undefined,
      s1: sp.get('s1') !== null ? parseInt(sp.get('s1'), 10) : undefined,
      s2: sp.get('s2') !== null ? parseInt(sp.get('s2'), 10) : undefined,
      s3: sp.get('s3') !== null ? parseInt(sp.get('s3'), 10) : undefined,
      s4: sp.get('s4') !== null ? parseInt(sp.get('s4'), 10) : undefined,
      h1: sp.get('h1') || undefined,
      h2: sp.get('h2') || undefined,
      h3: sp.get('h3') || undefined,
      h4: sp.get('h4') || undefined,
      i1: sp.get('i1') || undefined,
      dns: sp.get('dns') ? sp.get('dns').split(',').map(s => s.trim()) : ['1.1.1.1', '1.0.0.1']
    };
  }

  return {
    name,
    serverAddress: endpointHost,
    serverPort: endpointPort,
    protocol: isAwg ? 'amneziawg' : 'wireguard',
    network: 'udp',
    security: isAwg ? 'Amnezia' : 'WG',
    sni: '',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4),
    amneziaConfig
  };
}

// Parse Amnezia VPN URL (vpn://<base64-deflate-json>)
function parseAmneziaVpnUrl(cleanStr) {
  let raw = cleanStr.replace(/^vpn:\/\//i, '').trim();
  if (raw.includes('#')) raw = raw.split('#')[0];
  if (raw.includes('?')) raw = raw.split('?')[0];

  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch (e) {
    throw new Error('Некорректная Base64 строка в ссылке Amnezia vpn://');
  }

  if (buf.length < 5) {
    throw new Error('Некорректная ссылка vpn://: недостаточно данных');
  }

  // First 4 bytes are big-endian uint32 payload length prefix
  const payload = buf.subarray(4);
  let decompressed = null;

  try {
    decompressed = zlib.inflateSync(payload);
  } catch (err1) {
    try {
      decompressed = zlib.unzipSync(payload);
    } catch (err2) {
      try {
        decompressed = zlib.inflateRawSync(payload);
      } catch (err3) {
        throw new Error('Ошибка распаковки данных Amnezia vpn://: ' + err1.message);
      }
    }
  }

  const jsonStr = decompressed.toString('utf8');
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error('Некорректный JSON в данных Amnezia vpn://');
  }

  const containers = data.containers || [];
  const defaultContainer = data.defaultContainer || '';
  let targetContainer = containers.find(c => c.container === defaultContainer) || containers[0];
  if (!targetContainer && containers.length > 0) {
    targetContainer = containers[0];
  }

  if (!targetContainer) {
    throw new Error('В ссылке Amnezia vpn:// не найдены поддерживаемые контейнеры');
  }

  const awg = targetContainer.awg || targetContainer.wireguard;
  if (!awg) {
    throw new Error(`Контейнер ${targetContainer.container || 'неизвестный'} пока не поддерживается`);
  }

  let lastConfig = null;
  if (awg.last_config) {
    try {
      lastConfig = typeof awg.last_config === 'string' && awg.last_config.trim().startsWith('{')
        ? JSON.parse(awg.last_config)
        : null;
    } catch (e) {}
  }

  const host = awg.hostName || (lastConfig && lastConfig.hostName) || awg.server_ip || awg.ip || data.hostName || '';
  const port = parseInt(awg.port || (lastConfig && lastConfig.port), 10) || 51820;
  let clientIp = awg.client_ip || (lastConfig && lastConfig.client_ip) || '10.8.1.2';
  if (!clientIp.includes('/')) clientIp += '/32';
  const clientPrivKey = awg.client_priv_key || (lastConfig && lastConfig.client_priv_key) || '';
  const serverPubKey = awg.server_pub_key || (lastConfig && lastConfig.server_pub_key) || '';
  const psk = awg.psk_key || (lastConfig && lastConfig.psk_key) || '';

  const isAwg = Boolean(
    (targetContainer.container && targetContainer.container.includes('awg')) ||
    awg.Jc || awg.H1 || (lastConfig && (lastConfig.Jc || lastConfig.H1))
  );

  const connName = data.description || (host ? `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${host}` : `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${port}`);

  const amneziaParams = {
    client_ip: clientIp,
    client_priv_key: clientPrivKey,
    server_pub_key: serverPubKey,
    psk: psk,
    version: parseInt(awg.protocol_version || (lastConfig && lastConfig.protocol_version) || '2', 10),
    jc: (awg.Jc !== undefined ? parseInt(awg.Jc, 10) : (lastConfig && lastConfig.Jc !== undefined ? parseInt(lastConfig.Jc, 10) : 4)),
    jmin: (awg.Jmin !== undefined ? parseInt(awg.Jmin, 10) : (lastConfig && lastConfig.Jmin !== undefined ? parseInt(lastConfig.Jmin, 10) : 40)),
    jmax: (awg.Jmax !== undefined ? parseInt(awg.Jmax, 10) : (lastConfig && lastConfig.Jmax !== undefined ? parseInt(lastConfig.Jmax, 10) : 70)),
    s1: (awg.S1 !== undefined ? parseInt(awg.S1, 10) : (lastConfig && lastConfig.S1 !== undefined ? parseInt(lastConfig.S1, 10) : 15)),
    s2: (awg.S2 !== undefined ? parseInt(awg.S2, 10) : (lastConfig && lastConfig.S2 !== undefined ? parseInt(lastConfig.S2, 10) : 30)),
    s3: (awg.S3 !== undefined ? parseInt(awg.S3, 10) : (lastConfig && lastConfig.S3 !== undefined ? parseInt(lastConfig.S3, 10) : undefined)),
    s4: (awg.S4 !== undefined ? parseInt(awg.S4, 10) : (lastConfig && lastConfig.S4 !== undefined ? parseInt(lastConfig.S4, 10) : undefined)),
    h1: awg.H1 || (lastConfig && lastConfig.H1) || undefined,
    h2: awg.H2 || (lastConfig && lastConfig.H2) || undefined,
    h3: awg.H3 || (lastConfig && lastConfig.H3) || undefined,
    h4: awg.H4 || (lastConfig && lastConfig.H4) || undefined,
    i1: awg.I1 || (lastConfig && lastConfig.I1) || undefined,
    i2: awg.I2 || (lastConfig && lastConfig.I2) || undefined,
    i3: awg.I3 || (lastConfig && lastConfig.I3) || undefined,
    i4: awg.I4 || (lastConfig && lastConfig.I4) || undefined,
    i5: awg.I5 || (lastConfig && lastConfig.I5) || undefined,
    dns: [data.dns1 || '1.1.1.1', data.dns2 || '1.0.0.1'].filter(Boolean)
  };

  const outboundJsonObj = {
    outbounds: [
      {
        tag: isAwg ? 'amneziawg' : 'wireguard',
        protocol: 'wireguard',
        settings: {
          secretKey: clientPrivKey,
          address: [clientIp],
          peers: [
            {
              publicKey: serverPubKey,
              endpoint: `${host}:${port}`,
              allowedIPs: ['0.0.0.0/0', '::/0'],
              preSharedKey: psk || undefined
            }
          ],
          mtu: parseInt(awg.mtu || (lastConfig && lastConfig.mtu), 10) || 1376
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name: connName,
    serverAddress: host,
    serverPort: port,
    protocol: isAwg ? 'amneziawg' : 'wireguard',
    network: 'udp',
    security: isAwg ? 'Amnezia' : 'WG',
    sni: '',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4),
    amneziaConfig: amneziaParams
  };
}

// Generate Mihomo config.yaml for AmneziaWG connections
function generateMihomoConfig(conn, routing) {
  let am = conn.amneziaConfig || {};
  let host = conn.serverAddress || '';
  let port = conn.serverPort || 51820;
  let clientIp = (am.client_ip || '').split('/')[0];
  let clientPrivKey = am.client_priv_key || '';
  let serverPubKey = am.server_pub_key || '';
  let psk = am.psk || '';
  const connName = conn.name || 'AmneziaWG';

  // Fallback: extract from conn.outboundContent if keys are missing
  if ((!clientPrivKey || !serverPubKey || !clientIp) && conn.outboundContent) {
    try {
      const clean = stripJsonComments(conn.outboundContent);
      const parsed = JSON.parse(clean);
      const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
      const ob = list.find(o => o && (o.protocol === 'wireguard' || o.tag === 'amneziawg'));
      if (ob && ob.settings) {
        if (!clientPrivKey && ob.settings.secretKey) clientPrivKey = ob.settings.secretKey;
        if (!clientIp && Array.isArray(ob.settings.address) && ob.settings.address[0]) {
          clientIp = String(ob.settings.address[0]).split('/')[0];
        }
        if (Array.isArray(ob.settings.peers) && ob.settings.peers[0]) {
          const peer = ob.settings.peers[0];
          if (!serverPubKey && peer.publicKey) serverPubKey = peer.publicKey;
          if (!psk && (peer.preSharedKey || peer.presharedKey)) psk = peer.preSharedKey || peer.presharedKey;
          if ((!host || !port) && peer.endpoint) {
            const ep = String(peer.endpoint).trim();
            const lastColon = ep.lastIndexOf(':');
            if (lastColon !== -1) {
              if (!host) host = ep.substring(0, lastColon).replace(/^\[|\]$/g, '');
              if (!port) port = parseInt(ep.substring(lastColon + 1), 10) || 51820;
            }
          }
        }
      }
    } catch (e) {}
  }

  if (!clientIp) clientIp = '10.8.1.2';

  const awgOptionLines = [];
  awgOptionLines.push(`      version: ${am.version || 2}`);
  if (am.jc !== undefined) awgOptionLines.push(`      jc: ${am.jc}`);
  if (am.jmin !== undefined) awgOptionLines.push(`      jmin: ${am.jmin}`);
  if (am.jmax !== undefined) awgOptionLines.push(`      jmax: ${am.jmax}`);
  if (am.s1 !== undefined) awgOptionLines.push(`      s1: ${am.s1}`);
  if (am.s2 !== undefined) awgOptionLines.push(`      s2: ${am.s2}`);
  if (am.s3 !== undefined) awgOptionLines.push(`      s3: ${am.s3}`);
  if (am.s4 !== undefined) awgOptionLines.push(`      s4: ${am.s4}`);
  if (am.h1) awgOptionLines.push(`      h1: ${JSON.stringify(String(am.h1))}`);
  if (am.h2) awgOptionLines.push(`      h2: ${JSON.stringify(String(am.h2))}`);
  if (am.h3) awgOptionLines.push(`      h3: ${JSON.stringify(String(am.h3))}`);
  if (am.h4) awgOptionLines.push(`      h4: ${JSON.stringify(String(am.h4))}`);
  if (am.i1) awgOptionLines.push(`      i1: ${JSON.stringify(String(am.i1))}`);
  if (am.i2) awgOptionLines.push(`      i2: ${JSON.stringify(String(am.i2))}`);
  if (am.i3) awgOptionLines.push(`      i3: ${JSON.stringify(String(am.i3))}`);
  if (am.i4) awgOptionLines.push(`      i4: ${JSON.stringify(String(am.i4))}`);
  if (am.i5) awgOptionLines.push(`      i5: ${JSON.stringify(String(am.i5))}`);

  let rulesYaml = '  - GEOIP,private,DIRECT,no-resolve\n  - MATCH,PROXY';
  const routingId = routing ? routing.id : '';
  if (routingId === 'routing_except_ru') {
    rulesYaml = `  - GEOIP,private,DIRECT,no-resolve
  - GEOSITE,category-gov-ru,DIRECT
  - GEOSITE,yandex,DIRECT
  - GEOSITE,vk,DIRECT
  - GEOSITE,steam,DIRECT
  - GEOIP,ru,DIRECT
  - MATCH,PROXY`;
  }

  const yamlContent = `# Generated by XKeenSwitcher for ${connName}
mixed-port: 7890
tproxy-port: 1181
redir-port: 1182
routing-mark: 255
mode: rule
log-level: info
ipv6: false
allow-lan: true
unified-delay: true
tcp-concurrent: true

proxies:
  - name: ${JSON.stringify(connName)}
    type: wireguard
    server: ${host}
    port: ${port}
    ip: ${clientIp}
    public-key: ${JSON.stringify(serverPubKey)}
    private-key: ${JSON.stringify(clientPrivKey)}
${psk ? `    pre-shared-key: ${JSON.stringify(psk)}\n` : ''}    udp: true
    remote-dns-resolve: true
    dns:
      - 1.1.1.1
      - 1.0.0.1
    amnezia-wg-option:
${awgOptionLines.join('\n')}

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - ${JSON.stringify(connName)}

rules:
${rulesYaml}
`;

  return yamlContent;
}

// Parse Hysteria 2 URL (hysteria2://... or hy2://...)
function parseHysteria2Url(cleanStr) {
  const u = new URL(cleanStr);
  const password = decodeURIComponent(u.username);
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10) || 443;
  if (!address || !port) {
    throw new Error('Некорректная ссылка Hysteria2: отсутствуют адрес или порт');
  }

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = '';
  try { name = decodeURIComponent(rawName).trim(); } catch (e) { name = rawName.trim(); }
  if (!name) name = `Hysteria2 - ${address}:${port}`;

  const sp = u.searchParams;
  const sni = sp.get('sni') || address;

  const outboundJsonObj = {
    outbounds: [
      {
        tag: 'hysteria2',
        protocol: 'hysteria2',
        settings: {
          servers: [
            {
              address: address,
              port: port,
              password: password || ''
            }
          ]
        },
        streamSettings: {
          network: 'udp',
          security: 'tls',
          tlsSettings: {
            serverName: sni
          }
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name,
    serverAddress: address,
    serverPort: port,
    protocol: 'hysteria2',
    network: 'udp',
    security: 'tls',
    sni: sni,
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Extract connection metadata from arbitrary outbound JSON
function extractOutboundMetadata(outboundContent) {
  let serverAddress = '';
  let serverPort = null;
  let protocol = 'vless';
  let network = 'tcp';
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
        } else if (ob.settings.peers && ob.settings.peers[0] && ob.settings.peers[0].endpoint) {
          const ep = String(ob.settings.peers[0].endpoint).trim();
          const lastColon = ep.lastIndexOf(':');
          if (lastColon !== -1) {
            serverAddress = ep.substring(0, lastColon).replace(/^\[|\]$/g, '');
            serverPort = parseInt(ep.substring(lastColon + 1), 10) || null;
          } else {
            serverAddress = ep;
          }
        }
      }
      if (ob.streamSettings) {
        if (ob.streamSettings.network) network = ob.streamSettings.network;
        if (ob.streamSettings.security) security = ob.streamSettings.security;
        if (ob.streamSettings.realitySettings && ob.streamSettings.realitySettings.serverName) {
          sni = ob.streamSettings.realitySettings.serverName;
        } else if (ob.streamSettings.tlsSettings && ob.streamSettings.tlsSettings.serverName) {
          sni = ob.streamSettings.tlsSettings.serverName;
        }
      }
      if (ob.tag === 'amneziawg' || ob.protocol === 'amneziawg') {
        protocol = 'amneziawg';
        network = 'udp';
        security = 'Amnezia';
      } else if (protocol === 'wireguard') {
        network = 'udp';
        if (!security || security === 'none') security = 'WG';
      }
      if (serverAddress) break;
    }
  } catch (e) {}

  return { serverAddress, serverPort, protocol, network, security, sni };
}

// Parse subscription-userinfo header into object
function parseSubscriptionUserInfo(headerStr) {
  if (!headerStr) return null;
  const info = {};
  const items = String(headerStr).split(';');
  for (const item of items) {
    const [k, v] = item.split('=').map(s => s.trim().toLowerCase());
    if (k && v) {
      const num = parseInt(v, 10);
      if (!isNaN(num)) {
        info[k] = num;
      }
    }
  }
  return Object.keys(info).length > 0 ? info : null;
}

// Helper: Fetch remote subscription contents, handles redirects, Base64 decoding, user-agent
async function fetchSubscriptionContent(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Укажите URL подписки');
  }
  const cleanUrl = urlStr.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    throw new Error('URL подписки должен начинаться с http:// или https://');
  }

  let rawBody = '';
  let userInfo = null;
  let fetchSucceeded = false;

  // Try native fetch first
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'v2rayN/6.23 clash/1.0 v2ray/5.0'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const userInfoHeader = res.headers.get('subscription-userinfo');
      if (userInfoHeader) {
        userInfo = parseSubscriptionUserInfo(userInfoHeader);
      }
      rawBody = await res.text();
      fetchSucceeded = true;
    }
  } catch (e) {
    // Fall back to curl on router
  }

  if (!fetchSucceeded) {
    const curlEscaped = `'${cleanUrl.replace(/'/g, "'\\''")}'`;
    const curlRes = await runShellCommand(`curl -sSL -k -A "v2rayN/6.23" -D - --max-time 15 ${curlEscaped}`, 18000);
    if (!curlRes.success && !curlRes.stdout) {
      throw new Error('Не удалось загрузить подписку по указанному URL');
    }
    const stdout = curlRes.stdout || '';
    const parts = stdout.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
      rawBody = parts[parts.length - 1];
      const headersText = parts.slice(0, parts.length - 1).join('\n');
      const match = headersText.match(/subscription-userinfo:\s*([^\r\n]+)/i);
      if (match) {
        userInfo = parseSubscriptionUserInfo(match[1]);
      }
    } else {
      rawBody = stdout;
    }
  }

  if (!rawBody || !rawBody.trim()) {
    throw new Error('Ответ сервера подписки пуст');
  }

  let textContent = rawBody.trim();
  // Decode Base64 if needed
  if (!textContent.includes('://')) {
    try {
      const decoded = Buffer.from(textContent, 'base64').toString('utf8');
      if (decoded.includes('://')) {
        textContent = decoded;
      }
    } catch (e) {}
  }

  const lines = textContent.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

  return { lines, userInfo };
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

// Helper: Locate Xray binary on router / host system
let cachedXrayPath = undefined;
function findXrayPath() {
  if (cachedXrayPath !== undefined) return cachedXrayPath;
  const candidates = [
    '/opt/sbin/xray',
    '/opt/bin/xray',
    '/usr/sbin/xray',
    '/usr/bin/xray',
    '/usr/local/bin/xray'
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        cachedXrayPath = c;
        return c;
      }
    } catch (e) {}
  }
  try {
    const whichRes = execSync('which xray 2>/dev/null', { timeout: 1000 }).toString().trim();
    if (whichRes && fs.existsSync(whichRes)) {
      cachedXrayPath = whichRes;
      return whichRes;
    }
  } catch (e) {}

  cachedXrayPath = null;
  return null;
}

// Helper: Dynamically find an available TCP port on localhost for test instance
function getAvailableTestPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

// Concurrency limiter for isolated Xray proxy tests (max 2 concurrent processes on router)
let activeProxyChecks = 0;
const proxyCheckQueue = [];

function runWithProxyConcurrency(fn) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeProxyChecks++;
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeProxyChecks--;
        if (proxyCheckQueue.length > 0) {
          const next = proxyCheckQueue.shift();
          next();
        }
      }
    };

    if (activeProxyChecks < 2) {
      execute();
    } else {
      proxyCheckQueue.push(execute);
    }
  });
}

// Helper: Real proxy tunnel check via isolated ephemeral Xray instance
async function measureProxyHealth(outboundContent, options = {}) {
  const xrayBin = findXrayPath();
  if (!xrayBin) {
    return { ok: false, error: 'Исполняемый файл Xray не найден', skipProxy: true };
  }

  if (!outboundContent || typeof outboundContent !== 'string') {
    return { ok: false, error: 'Отсутствует конфигурация outbound', skipProxy: true };
  }

  let parsed;
  try {
    parsed = parseJsonWithComments(outboundContent);
  } catch (e) {
    return { ok: false, error: 'Некорректный синтаксис JSON outbound', skipProxy: true };
  }

  const outbounds = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
  if (!outbounds || outbounds.length === 0) {
    return { ok: false, error: 'В конфигурации нет секции outbounds', skipProxy: true };
  }

  return runWithProxyConcurrency(async () => {
    const timeout = options.timeout || 4000;
    const canaryUrl = options.canaryUrl || 'http://cp.cloudflare.com/generate_204';

    let testPort;
    try {
      testPort = await getAvailableTestPort();
    } catch (err) {
      return { ok: false, error: 'Не удалось выделить порт: ' + err.message };
    }

    const testConfigFile = path.join(
      os.tmpdir(),
      `xray-health-${Date.now()}-${Math.floor(Math.random() * 100000)}.json`
    );

    const testConfig = {
      log: { loglevel: 'none' },
      inbounds: [
        {
          tag: 'test-http-in',
          port: testPort,
          listen: '127.0.0.1',
          protocol: 'http'
        }
      ],
      outbounds: outbounds
    };

    try {
      fs.writeFileSync(testConfigFile, JSON.stringify(testConfig));
    } catch (err) {
      return { ok: false, error: 'Ошибка записи тестового конфига: ' + err.message };
    }

    let child;
    try {
      child = spawn(xrayBin, ['run', '-c', testConfigFile], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch (err) {
      try { fs.unlinkSync(testConfigFile); } catch (e) {}
      return { ok: false, error: 'Ошибка запуска Xray: ' + err.message };
    }

    const cleanup = () => {
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.unlinkSync(testConfigFile); } catch (e) {}
    };

    return new Promise((resolve) => {
      let settled = false;

      const finish = (res) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(res);
        }
      };

      child.on('error', (err) => {
        finish({ ok: false, error: 'Сбой процесса Xray: ' + err.message });
      });

      child.on('exit', (code) => {
        if (!settled && code !== 0 && code !== null) {
          finish({ ok: false, error: `Xray завершился с кодом ошибки ${code}` });
        }
      });

      // Short delay (250ms) to allow Xray to bind local HTTP inbound port
      setTimeout(() => {
        if (settled) return;

        let canaryParsed;
        try {
          canaryParsed = new URL(canaryUrl);
        } catch (e) {
          return finish({ ok: false, error: 'Некорректный Canary URL' });
        }

        const t0 = Date.now();
        const req = http.request(
          {
            host: '127.0.0.1',
            port: testPort,
            method: 'GET',
            path: canaryUrl,
            headers: { Host: canaryParsed.host },
            timeout: timeout
          },
          (res) => {
            const latency = Date.now() - t0;
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 400) {
              finish({ ok: true, latency, statusCode: res.statusCode });
            } else {
              finish({
                ok: false,
                latency: null,
                statusCode: res.statusCode,
                error: `Прокси вернул HTTP ${res.statusCode} (трафик сброшен сервером)`
              });
            }
          }
        );

        req.on('timeout', () => {
          req.destroy();
          finish({ ok: false, error: 'Таймаут сквозного ответа через туннель' });
        });

        req.on('error', (err) => {
          finish({ ok: false, error: 'Сбой соединения через прокси: ' + (err.message || 'ошибка сети') });
        });

        req.end();
      }, 250);
    });
  });
}

// Helper: Measure ICMP latency (ping)
function measureIcmpLatency(host, timeout = 3000) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: 'Хост не указан' });
    const cleanHost = String(host).trim().replace(/^\[|\]$/g, '');
    if (!cleanHost) return resolve({ ok: false, error: 'Хост не указан' });
    const isWin = os.platform() === 'win32';
    const countFlag = isWin ? '-n 1' : '-c 1';
    const timeoutFlag = isWin ? `-w ${timeout}` : `-W ${Math.ceil(timeout / 1000)}`;
    const cmd = `ping ${countFlag} ${timeoutFlag} ${cleanHost}`;

    exec(cmd, { timeout: timeout + 500 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: 'Узел не отвечает на ICMP ping' });
      const m = (stdout || '').match(/time[=<]([0-9\.]+)\s*ms/i);
      const latency = m ? Math.round(parseFloat(m[1])) : null;
      if (latency !== null) {
        resolve({ ok: true, latency });
      } else {
        resolve({ ok: false, error: 'Не удалось определить время ответа' });
      }
    });
  });
}

// Helper: Comprehensive connection health check (TCP handshake + real proxy tunnel test)
async function measureConnectionHealth(conn, options = {}) {
  if (!conn) {
    return { ok: false, error: 'Подключение не указано', status: 'unreachable', latency: null };
  }

  const timeout = options.timeout || 3500;
  const isUdp = conn.protocol === 'wireguard' || conn.protocol === 'amneziawg' || conn.network === 'udp';

  if (isUdp && conn.serverAddress) {
    const icmpRes = await measureIcmpLatency(conn.serverAddress, Math.min(timeout, 3000));
    if (icmpRes.ok) {
      return {
        ok: true,
        latency: icmpRes.latency,
        tcpLatency: icmpRes.latency,
        status: 'ok',
        checkType: 'icmp'
      };
    }
  }

  // Step 1: TCP handshake to destination host:port
  const tcpRes = await measureTcpLatency(conn.serverAddress, conn.serverPort, Math.min(timeout, 3000));
  if (!tcpRes.ok) {
    return {
      ok: false,
      latency: null,
      tcpLatency: null,
      status: 'unreachable',
      checkType: 'tcp_failed',
      error: tcpRes.error || 'Порт сервера недоступен'
    };
  }

  // Step 2: Real proxy check (if Xray is installed on router and outbound JSON is present)
  const xrayBin = findXrayPath();
  if (xrayBin && conn.outboundContent) {
    const proxyRes = await measureProxyHealth(conn.outboundContent, {
      timeout: timeout,
      canaryUrl: options.canaryUrl
    });

    if (proxyRes.ok) {
      return {
        ok: true,
        latency: proxyRes.latency,
        tcpLatency: tcpRes.latency,
        status: 'ok',
        checkType: 'proxy',
        statusCode: proxyRes.statusCode
      };
    } else if (proxyRes.skipProxy) {
      // If outbound could not be tested due to config formatting, fall back to TCP
      return {
        ok: true,
        latency: tcpRes.latency,
        tcpLatency: tcpRes.latency,
        status: 'ok',
        checkType: 'tcp',
        warning: proxyRes.error
      };
    } else {
      // Proxy failed: host TCP was alive, but tunnel rejected or dropped traffic!
      return {
        ok: false,
        latency: null,
        tcpLatency: tcpRes.latency,
        status: 'unreachable',
        checkType: 'proxy_failed',
        error: proxyRes.error || 'Прокси не пропускает трафик'
      };
    }
  }

  // Fallback to TCP ping if Xray binary is not installed in environment
  return {
    ok: true,
    latency: tcpRes.latency,
    tcpLatency: tcpRes.latency,
    status: 'ok',
    checkType: 'tcp'
  };
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
      defaultRoutingBlacklist: 'routing_except_ru',
      defaultRoutingWhitelist: 'routing_all_vpn',
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
    groups: [
      { id: 'group_default', name: 'Общие', createdAt: new Date().toISOString() }
    ],
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
      if (!data.settings.defaultRoutingBlacklist) {
        data.settings.defaultRoutingBlacklist = 'routing_except_ru';
      }
      if (!data.settings.defaultRoutingWhitelist) {
        data.settings.defaultRoutingWhitelist = 'routing_all_vpn';
      }

      // Load Groups
      if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
        data.groups = parsed.groups;
      }
      if (!data.groups.some(g => g.id === 'group_default')) {
        data.groups.unshift({ id: 'group_default', name: 'Общие', createdAt: new Date().toISOString() });
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
            groupId: (c.groupId && data.groups.some(g => g.id === c.groupId)) ? c.groupId : 'group_default',
            routingId: c.routingId || 'routing_all_vpn',
            outboundContent: c.outboundContent || '',
            serverAddress: c.serverAddress || meta.serverAddress || '',
            serverPort: c.serverPort || meta.serverPort || null,
            protocol: c.protocol || meta.protocol || 'vless',
            network: c.network || meta.network || 'tcp',
            security: c.security || meta.security || 'none',
            sni: c.sni || meta.sni || '',
            amneziaConfig: c.amneziaConfig || null,
            countryCode: c.countryCode || null,
            countryName: c.countryName || null,
            isFavorite: Boolean(c.isFavorite),
            targetList: (c.targetList === 'whitelist') ? 'whitelist' : 'blacklist',
            lastPing: c.lastPing !== undefined ? c.lastPing : null,
            lastPingStatus: c.lastPingStatus || null,
            lastPingError: c.lastPingError || null,
            lastPingType: c.lastPingType || null,
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
                network: meta.network || 'tcp',
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
  const isAwg = conn.protocol === 'amneziawg' || Boolean(conn.amneziaConfig);
  const coreInfo = detectActiveProxyCore();
  let coreSwitched = false;
  let targetCore = coreInfo.activeCore;

  const fileWriteStatus = { outbound: false, routing: false, mihomo: false, error: null };
  let restartStatus = { executed: false, output: '', error: '' };

  try {
    if (isAwg) {
      // 1. Generate & write Mihomo configuration for AmneziaWG
      const mihomoYaml = generateMihomoConfig(conn, routing);
      const mihomoConfigPath = '/opt/etc/mihomo/config.yaml';
      try {
        writeTargetFile(mihomoConfigPath, mihomoYaml);
        fileWriteStatus.mihomo = true;
      } catch (mErr) {
        console.error('Error writing mihomo config.yaml:', mErr);
      }

      // Ensure GeoSite.dat exists in mihomo directory
      try {
        if (!fs.existsSync('/opt/etc/mihomo/GeoSite.dat') && fs.existsSync('/opt/etc/xray/dat/geosite_v2fly.dat')) {
          fs.symlinkSync('/opt/etc/xray/dat/geosite_v2fly.dat', '/opt/etc/mihomo/GeoSite.dat');
        }
      } catch (e) {}

      // Also write Xray files as fallback
      writeTargetFile(outboundPath, conn.outboundContent);
      fileWriteStatus.outbound = true;
      writeTargetFile(routingPath, routing.content);
      fileWriteStatus.routing = true;

      // 2. Switch core to Mihomo if not already active
      if (coreInfo.activeCore !== 'mihomo' && coreInfo.hasMihomo) {
        await runShellCommand('xkeen -mihomo');
        coreSwitched = true;
        targetCore = 'mihomo';
      }
    } else {
      // Standard connection: write Xray files
      writeTargetFile(outboundPath, conn.outboundContent);
      fileWriteStatus.outbound = true;
      writeTargetFile(routingPath, routing.content);
      fileWriteStatus.routing = true;

      // Switch back to Xray if currently on Mihomo
      if (coreInfo.activeCore === 'mihomo' && coreInfo.hasXray) {
        await runShellCommand('xkeen -xray');
        coreSwitched = true;
        targetCore = 'xray';
      }
    }
  } catch (err) {
    console.error('File write error during activation:', err);
    fileWriteStatus.error = err.message;
  }

  const effectiveRestartCmd = restartCommand && restartCommand.trim()
    ? restartCommand.trim()
    : '/opt/etc/init.d/S05xkeen restart';

  const resCmd = await runShellCommand(effectiveRestartCmd);
  restartStatus.executed = true;
  restartStatus.output = resCmd.stdout;
  restartStatus.error = resCmd.stderr || resCmd.error || '';

  const computedStatus = evaluateServiceStatus(resCmd);
  const updatedCoreInfo = detectActiveProxyCore();
  lastServiceStatus = {
    status: computedStatus,
    core: updatedCoreInfo.activeCore,
    coresAvailable: {
      xray: updatedCoreInfo.hasXray,
      mihomo: updatedCoreInfo.hasMihomo
    },
    output: resCmd.stdout,
    error: resCmd.stderr || resCmd.error || '',
    code: resCmd.code,
    timestamp: new Date().toISOString(),
    command: effectiveRestartCmd
  };

  if (updateActiveState) {
    data.settings.activeConnectionId = connId;
    saveData(data);
  }

  return {
    conn,
    routing,
    fileWriteStatus,
    restartStatus,
    serviceStatus: lastServiceStatus,
    activeCore: updatedCoreInfo.activeCore,
    coreSwitched
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
      const primPing = await measureConnectionHealth(primaryConn, { timeout: 3500, canaryUrl: fo.canaryUrl });
      let healthy = primPing.ok;

      // If TCP socket opened but proxy check was skipped, also test Canary URL
      if (healthy && fo.canaryUrl && primPing.checkType !== 'proxy') {
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
      const primPing = await measureConnectionHealth(primaryConn, { timeout: 3500, canaryUrl: fo.canaryUrl });

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
      const primPing = await measureConnectionHealth(primaryConn, { timeout: 3000, canaryUrl: af.canaryUrl });
      let healthy = primPing.ok;

      // Если сокет ответил, но сквозной прокси не проверялся, контрольно проверяем сквозной запрос
      if (healthy && af.canaryUrl && primPing.checkType !== 'proxy') {
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

          // Опрос кандидатов с измерением реальной доступности туннеля
          const alive = [];
          for (const c of candidateConns) {
            const res = await measureConnectionHealth(c, { timeout: 2500, canaryUrl: af.canaryUrl });
            if (res.ok) {
              alive.push({ conn: c, latency: res.latency });
            }
          }

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
        const primPing = await measureConnectionHealth(primaryConn, { timeout: 3000, canaryUrl: af.canaryUrl });
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

  // POST /api/connections/parse-url (and /api/parse-link) - Parse proxy link (VLESS, AWG vpn://, WG, VMess, etc.)
  if ((urlParts === '/api/connections/parse-url' || urlParts === '/api/parse-link') && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { url } = body;
      if (!url) {
        return sendJson(res, 400, { error: 'Укажите ссылку подключения' });
      }
      const parsed = parseProxyUrl(url);
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
      let parsedFromUrl = null;

      if (url) {
        try {
          parsedFromUrl = parseProxyUrl(url);
          name = name || parsedFromUrl.name;
          if (!outboundContent) {
            outboundContent = parsedFromUrl.outboundJson;
          }
        } catch (uErr) {
          if (!outboundContent) throw uErr;
        }
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
      const targetList = (body.targetList === 'whitelist') ? 'whitelist' : 'blacklist';

      if (!routingId || !data.routings.some(r => r.id === routingId)) {
        routingId = (targetList === 'whitelist')
          ? (data.settings.defaultRoutingWhitelist || 'routing_all_vpn')
          : (data.settings.defaultRoutingBlacklist || 'routing_except_ru');
      }
      if (!routingId || !data.routings.some(r => r.id === routingId)) {
        routingId = data.routings[0] ? data.routings[0].id : 'routing_all_vpn';
      }

      const meta = extractOutboundMetadata(outboundContent);
      const effectiveAmneziaConfig = body.amneziaConfig || (parsedFromUrl ? parsedFromUrl.amneziaConfig : null) || null;
      const isAwg = meta.protocol === 'amneziawg' || (parsedFromUrl && parsedFromUrl.protocol === 'amneziawg') || Boolean(effectiveAmneziaConfig);

      const resolvedHost = (parsedFromUrl && parsedFromUrl.serverAddress) || meta.serverAddress;
      if (!resolvedHost && !effectiveAmneziaConfig) {
        return sendJson(res, 400, { error: 'Конфигурация outbound.json не содержит серверов прокси. Вставьте корректную ссылку подключения.' });
      }

      let countryCode = null;
      let countryName = null;
      const hostToGeo = resolvedHost;
      if (hostToGeo) {
        try {
          const geo = await resolveGeoIp(hostToGeo);
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
        serverAddress: (parsedFromUrl && parsedFromUrl.serverAddress) || meta.serverAddress,
        serverPort: (parsedFromUrl && parsedFromUrl.serverPort) || meta.serverPort,
        protocol: isAwg ? 'amneziawg' : meta.protocol,
        network: isAwg ? 'udp' : meta.network,
        security: isAwg ? 'Amnezia' : meta.security,
        sni: meta.sni,
        amneziaConfig: effectiveAmneziaConfig,
        countryCode: countryCode,
        countryName: countryName,
        groupId: (body.groupId && data.groups.some(g => g.id === body.groupId)) ? body.groupId : 'group_default',
        isFavorite: Boolean(body.isFavorite),
        targetList: targetList,
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

  // POST /api/connections/batch-import - Batch import connections from links
  if (urlParts === '/api/connections/batch-import' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { text, groupName, groupId, routingId, targetList: reqTargetList } = body;
      if (!text || typeof text !== 'string' || !text.trim()) {
        return sendJson(res, 400, { error: 'Вставьте хотя бы одну ссылку подключения' });
      }
      const data = loadData();

      // Resolve targetList and default routing
      const targetList = (reqTargetList === 'whitelist') ? 'whitelist' : 'blacklist';
      const defaultForTarget = (targetList === 'whitelist')
        ? (data.settings.defaultRoutingWhitelist || 'routing_all_vpn')
        : (data.settings.defaultRoutingBlacklist || 'routing_except_ru');

      const effectiveRoutingId = (routingId && data.routings.some(r => r.id === routingId))
        ? routingId
        : defaultForTarget;

      // Resolve or create target group
      let targetGroupId = groupId;
      if (!targetGroupId && groupName && groupName.trim()) {
        const trimmedName = groupName.trim();
        let existing = data.groups.find(g => g.name.toLowerCase() === trimmedName.toLowerCase());
        if (!existing) {
          existing = {
            id: 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            name: trimmedName,
            createdAt: new Date().toISOString()
          };
          data.groups.push(existing);
        }
        targetGroupId = existing.id;
      }
      if (!targetGroupId || !data.groups.some(g => g.id === targetGroupId)) {
        targetGroupId = 'group_default';
      }

      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
      if (lines.length === 0) {
        return sendJson(res, 400, { error: 'Не найдено ссылок для импорта' });
      }

      let importedCount = 0;
      const errors = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = parseProxyUrl(line);
          const meta = extractOutboundMetadata(parsed.outboundJson);
          const isAwg = parsed.protocol === 'amneziawg' || Boolean(parsed.amneziaConfig);

          const newConn = {
            id: 'conn_' + (Date.now() + i) + '_' + Math.random().toString(36).substr(2, 4),
            name: parsed.name,
            description: '',
            groupId: targetGroupId,
            routingId: effectiveRoutingId,
            outboundContent: parsed.outboundJson,
            serverAddress: parsed.serverAddress || meta.serverAddress,
            serverPort: parsed.serverPort || meta.serverPort,
            protocol: isAwg ? 'amneziawg' : (parsed.protocol || meta.protocol),
            network: isAwg ? 'udp' : (parsed.network || meta.network),
            security: isAwg ? 'Amnezia' : (parsed.security || meta.security),
            sni: parsed.sni || meta.sni,
            amneziaConfig: parsed.amneziaConfig || null,
            countryCode: null,
            countryName: null,
            isFavorite: false,
            targetList: targetList,
            lastPing: null,
            lastPingStatus: null,
            lastPingCheckedAt: null,
            createdAt: new Date().toISOString()
          };

          data.connections.push(newConn);
          importedCount++;
        } catch (err) {
          errors.push(`Строка ${i + 1}: ${err.message}`);
        }
      }

      if (importedCount > 0) {
        saveData(data);
        setTimeout(sweepGeoIpForConnections, 1000);
      }

      return sendJson(res, 200, {
        message: `Успешно импортировано: ${importedCount} из ${lines.length}`,
        count: importedCount,
        groupId: targetGroupId,
        group: data.groups.find(g => g.id === targetGroupId),
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка пакетного импорта' });
    }
  }

  // POST /api/connections/:id/favorite - Toggle or set favorite status
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/favorite') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/favorite', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);
    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }
    const body = await parseJsonBody(req).catch(() => ({}));
    if (typeof body.isFavorite !== 'undefined') {
      conn.isFavorite = Boolean(body.isFavorite);
    } else {
      conn.isFavorite = !conn.isFavorite;
    }
    conn.updatedAt = new Date().toISOString();
    saveData(data);
    return sendJson(res, 200, { message: 'Статус избранного обновлен', isFavorite: conn.isFavorite, connection: conn });
  }

  // POST /api/connections/:id/target-list - Toggle or set target list (blacklist/whitelist)
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/target-list') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/target-list', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);
    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }
    const body = await parseJsonBody(req).catch(() => ({}));
    if (body.targetList && (body.targetList === 'blacklist' || body.targetList === 'whitelist')) {
      conn.targetList = body.targetList;
    } else {
      conn.targetList = (conn.targetList === 'whitelist') ? 'blacklist' : 'whitelist';
    }
    conn.updatedAt = new Date().toISOString();
    saveData(data);
    return sendJson(res, 200, {
      message: `Назначение для "${conn.name}" изменено на ${conn.targetList === 'whitelist' ? 'Белые списки' : 'Черные списки'}`,
      targetList: conn.targetList,
      connection: conn
    });
  }

  // POST /api/connections/:id/move - Move connection to another group
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/move') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/move', '');
    try {
      const body = await parseJsonBody(req);
      const { targetGroupId } = body;
      const data = loadData();
      const conn = data.connections.find(c => c.id === id);
      if (!conn) return sendJson(res, 404, { error: 'Подключение не найдено' });
      if (!targetGroupId || !data.groups.some(g => g.id === targetGroupId)) {
        return sendJson(res, 400, { error: 'Целевая группа не найдена' });
      }
      conn.groupId = targetGroupId;
      conn.updatedAt = new Date().toISOString();
      saveData(data);
      return sendJson(res, 200, { message: 'Подключение перемещено', connection: conn });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка перемещения подключения' });
    }
  }

  // POST /api/connections/:id/copy - Duplicate connection to target group
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/copy') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/copy', '');
    try {
      const body = await parseJsonBody(req);
      const { targetGroupId, newName } = body;
      const data = loadData();
      const conn = data.connections.find(c => c.id === id);
      if (!conn) return sendJson(res, 404, { error: 'Подключение не найдено' });
      const destGroupId = targetGroupId && data.groups.some(g => g.id === targetGroupId) ? targetGroupId : (conn.groupId || 'group_default');

      const clonedConn = {
        ...conn,
        id: 'conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: (newName || (conn.name + ' (Копия)')).trim(),
        groupId: destGroupId,
        isFavorite: false,
        targetList: conn.targetList || 'blacklist',
        createdAt: new Date().toISOString()
      };
      delete clonedConn.updatedAt;
      data.connections.push(clonedConn);
      saveData(data);
      return sendJson(res, 201, { message: 'Подключение скопировано', connection: clonedConn });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка копирования подключения' });
    }
  }

  // PUT /api/connections/:id - Update connection
  if (urlParts.startsWith('/api/connections/') && !urlParts.includes('/activate') && !urlParts.includes('/ping') && !urlParts.includes('/set-routing') && !urlParts.includes('/favorite') && !urlParts.includes('/target-list') && !urlParts.includes('/move') && !urlParts.includes('/copy') && !urlParts.includes('/batch-import') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/connections/', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);

    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    try {
      const body = await parseJsonBody(req);
      const { name, description, groupId, routingId, outboundContent, isFavorite, targetList } = body;

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
      if (groupId && data.groups.some(g => g.id === groupId)) {
        conn.groupId = groupId;
      }
      if (typeof isFavorite !== 'undefined') {
        conn.isFavorite = Boolean(isFavorite);
      }
      if (routingId && data.routings.some(r => r.id === routingId)) {
        conn.routingId = routingId;
      }
      if (typeof targetList !== 'undefined') {
        conn.targetList = (targetList === 'whitelist') ? 'whitelist' : 'blacklist';
      }
      conn.outboundContent = outboundContent.trim();
      
      const meta = extractOutboundMetadata(conn.outboundContent);
      const hostChanged = (conn.serverAddress !== meta.serverAddress);
      conn.serverAddress = meta.serverAddress;
      conn.serverPort = meta.serverPort;
      conn.protocol = meta.protocol;
      conn.network = meta.network;
      conn.security = meta.security;
      conn.sni = meta.sni;

      if (body.amneziaConfig) {
        conn.amneziaConfig = body.amneziaConfig;
        conn.protocol = 'amneziawg';
        conn.network = 'udp';
        conn.security = 'Amnezia';
      } else if (conn.amneziaConfig && (meta.protocol === 'wireguard' || meta.protocol === 'amneziawg')) {
        conn.protocol = 'amneziawg';
        conn.network = 'udp';
        conn.security = 'Amnezia';
      }

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
          const pr = await measureConnectionHealth(conn, { timeout: 3500 });
          conn.lastPing = pr.ok ? pr.latency : null;
          conn.lastPingStatus = pr.ok ? 'ok' : 'unreachable';
          conn.lastPingError = pr.error || null;
          conn.lastPingType = pr.checkType || 'tcp';
          conn.lastPingCheckedAt = new Date().toISOString();
          pingResult = {
            ok: pr.ok,
            ping: conn.lastPing,
            status: conn.lastPingStatus,
            checkType: conn.lastPingType,
            error: conn.lastPingError,
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
      const pingRes = await measureConnectionHealth(conn, { timeout: 3500 });
      conn.lastPing = pingRes.ok ? pingRes.latency : null;
      conn.lastPingStatus = pingRes.ok ? 'ok' : 'unreachable';
      conn.lastPingError = pingRes.error || null;
      conn.lastPingType = pingRes.checkType || 'tcp';
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
          checkType: conn.lastPingType,
          error: conn.lastPingError,
          latencyStr: pingRes.ok ? `${conn.lastPing} ms` : 'Недоступен'
        }
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка активации подключения' });
    }
  }

  // POST /api/connections/:id/ping - Check single connection availability (TCP handshake + real proxy tunnel)
  if (urlParts.startsWith('/api/connections/') && urlParts.endsWith('/ping') && req.method === 'POST') {
    const id = urlParts.replace('/api/connections/', '').replace('/ping', '');
    const data = loadData();
    const conn = data.connections.find(c => c.id === id);

    if (!conn) {
      return sendJson(res, 404, { error: 'Подключение не найдено' });
    }

    try {
      const pingResult = await measureConnectionHealth(conn, { timeout: 3500 });

      conn.lastPing = pingResult.ok ? pingResult.latency : null;
      conn.lastPingStatus = pingResult.ok ? 'ok' : 'unreachable';
      conn.lastPingError = pingResult.error || null;
      conn.lastPingType = pingResult.checkType || 'tcp';
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
        checkType: conn.lastPingType,
        error: conn.lastPingError,
        latencyStr: pingResult.ok ? `${conn.lastPing} ms` : 'Недоступен',
        checkedAt: conn.lastPingCheckedAt,
        countryCode: conn.countryCode,
        countryName: conn.countryName
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка проверки доступности: ' + err.message });
    }
  }

  // POST /api/connections/ping-all - Check all connections with concurrency limiter without touching service
  if (urlParts === '/api/connections/ping-all' && req.method === 'POST') {
    const data = loadData();
    if (!data.connections || data.connections.length === 0) {
      return sendJson(res, 200, { results: [], message: 'Нет подключений для проверки' });
    }

    try {
      const results = [];
      for (const conn of data.connections) {
        const pingResult = await measureConnectionHealth(conn, { timeout: 3500 });
        conn.lastPing = pingResult.ok ? pingResult.latency : null;
        conn.lastPingStatus = pingResult.ok ? 'ok' : 'unreachable';
        conn.lastPingError = pingResult.error || null;
        conn.lastPingType = pingResult.checkType || 'tcp';
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

        results.push({
          id: conn.id,
          ok: pingResult.ok,
          ping: conn.lastPing,
          status: conn.lastPingStatus,
          checkType: conn.lastPingType,
          error: conn.lastPingError,
          latencyStr: pingResult.ok ? `${conn.lastPing} ms` : 'Недоступен',
          checkedAt: conn.lastPingCheckedAt,
          countryCode: conn.countryCode,
          countryName: conn.countryName
        });
      }

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

  // --- CONNECTION GROUPS ROUTES ---

  // GET /api/groups - List all groups
  if (urlParts === '/api/groups' && req.method === 'GET') {
    const data = loadData();
    return sendJson(res, 200, { groups: data.groups || [] });
  }

  // POST /api/groups - Create a new group
  if (urlParts === '/api/groups' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const name = (body.name || '').trim();
      if (!name) {
        return sendJson(res, 400, { error: 'Укажите название группы' });
      }
      const data = loadData();
      const newGroup = {
        id: 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: name,
        collapsed: false,
        createdAt: new Date().toISOString()
      };
      data.groups.push(newGroup);
      saveData(data);
      return sendJson(res, 201, { message: 'Группа успешно создана', group: newGroup, groups: data.groups });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка создания группы' });
    }
  }

  // PUT /api/groups/:id - Update or rename group
  if (urlParts.startsWith('/api/groups/') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/groups/', '');
    try {
      const body = await parseJsonBody(req);
      const data = loadData();
      const group = data.groups.find(g => g.id === id);
      if (!group) {
        return sendJson(res, 404, { error: 'Группа не найдена' });
      }
      if (body.name && body.name.trim()) {
        group.name = body.name.trim();
      }
      if (typeof body.collapsed !== 'undefined') {
        group.collapsed = Boolean(body.collapsed);
      }
      group.updatedAt = new Date().toISOString();
      saveData(data);
      return sendJson(res, 200, { message: 'Группа обновлена', group, groups: data.groups });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка обновления группы' });
    }
  }

  // DELETE /api/groups/:id - Delete group (moves its connections to group_default)
  if (urlParts.startsWith('/api/groups/') && req.method === 'DELETE') {
    const id = urlParts.replace('/api/groups/', '');
    if (id === 'group_default') {
      return sendJson(res, 400, { error: 'Нельзя удалить основную группу' });
    }
    const data = loadData();
    const groupIndex = data.groups.findIndex(g => g.id === id);
    if (groupIndex === -1) {
      return sendJson(res, 404, { error: 'Группа не найдена' });
    }

    let movedCount = 0;
    data.connections.forEach(c => {
      if (c.groupId === id) {
        c.groupId = 'group_default';
        movedCount++;
      }
    });

    data.groups.splice(groupIndex, 1);
    saveData(data);
    return sendJson(res, 200, {
      message: `Группа удалена. Перемещено подключений в "Общие": ${movedCount}`,
      groups: data.groups,
      movedCount
    });
  }

  // --- SUBSCRIPTIONS ROUTES ---

  // POST /api/subscriptions - Add a new subscription
  if (urlParts === '/api/subscriptions' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { url, name, targetList: reqTargetList, routingId } = body;

      if (!url || typeof url !== 'string' || !url.trim()) {
        return sendJson(res, 400, { error: 'Укажите URL подписки' });
      }

      const data = loadData();
      const targetList = (reqTargetList === 'whitelist') ? 'whitelist' : 'blacklist';
      const defaultRouting = (targetList === 'whitelist')
        ? (data.settings.defaultRoutingWhitelist || 'routing_all_vpn')
        : (data.settings.defaultRoutingBlacklist || 'routing_except_ru');

      const effectiveRoutingId = (routingId && data.routings.some(r => r.id === routingId))
        ? routingId
        : defaultRouting;

      const subName = (name && name.trim()) ? name.trim() : `Подписка ${data.groups.filter(g => g.isSubscription).length + 1}`;

      const { lines, userInfo } = await fetchSubscriptionContent(url.trim());

      const subGroup = {
        id: 'group_sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: subName,
        isSubscription: true,
        subscriptionUrl: url.trim(),
        targetList: targetList,
        routingId: effectiveRoutingId,
        lastUpdated: new Date().toISOString(),
        userInfo: userInfo || null,
        collapsed: false,
        createdAt: new Date().toISOString()
      };

      data.groups.push(subGroup);

      let importedCount = 0;
      const errors = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = parseVlessUrl(line);
          const meta = extractOutboundMetadata(parsed.outboundJson);

          const newConn = {
            id: 'conn_' + (Date.now() + i) + '_' + Math.random().toString(36).substr(2, 4),
            name: parsed.name,
            description: '',
            groupId: subGroup.id,
            routingId: effectiveRoutingId,
            outboundContent: parsed.outboundJson,
            serverAddress: parsed.serverAddress || meta.serverAddress,
            serverPort: parsed.serverPort || meta.serverPort,
            protocol: parsed.protocol || meta.protocol,
            network: parsed.network || meta.network,
            security: parsed.security || meta.security,
            sni: parsed.sni || meta.sni,
            countryCode: null,
            countryName: null,
            isFavorite: false,
            targetList: targetList,
            lastPing: null,
            lastPingStatus: null,
            lastPingCheckedAt: null,
            createdAt: new Date().toISOString()
          };

          data.connections.push(newConn);
          importedCount++;
        } catch (err) {
          errors.push(`Строка ${i + 1}: ${err.message}`);
        }
      }

      saveData(data);
      setTimeout(sweepGeoIpForConnections, 1000);

      return sendJson(res, 201, {
        message: `Подписка "${subName}" успешно добавлена. Загружено подключений: ${importedCount}`,
        group: subGroup,
        count: importedCount,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка загрузки подписки' });
    }
  }

  // POST /api/subscriptions/:id/update - Refresh / sync subscription
  if (urlParts.startsWith('/api/subscriptions/') && urlParts.endsWith('/update') && req.method === 'POST') {
    const id = urlParts.replace('/api/subscriptions/', '').replace('/update', '');
    try {
      const data = loadData();
      const group = data.groups.find(g => g.id === id);
      if (!group || !group.isSubscription) {
        return sendJson(res, 404, { error: 'Подписка не найдена' });
      }

      if (!group.subscriptionUrl) {
        return sendJson(res, 400, { error: 'У подписки не указан URL' });
      }

      const { lines, userInfo } = await fetchSubscriptionContent(group.subscriptionUrl);
      if (userInfo) {
        group.userInfo = userInfo;
      }
      group.lastUpdated = new Date().toISOString();

      const targetList = group.targetList || 'blacklist';
      const effectiveRoutingId = group.routingId || (targetList === 'whitelist' ? data.settings.defaultRoutingWhitelist : data.settings.defaultRoutingBlacklist);

      const existingConns = data.connections.filter(c => c.groupId === id);
      const matchedIds = new Set();
      let addedCount = 0;
      let updatedCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = parseVlessUrl(line);
          const meta = extractOutboundMetadata(parsed.outboundJson);
          const host = parsed.serverAddress || meta.serverAddress;
          const port = parsed.serverPort || meta.serverPort;

          let found = existingConns.find(c =>
            !matchedIds.has(c.id) &&
            c.serverAddress === host &&
            String(c.serverPort) === String(port) &&
            (c.sni === (parsed.sni || meta.sni) || c.name === parsed.name)
          );

          if (found) {
            matchedIds.add(found.id);
            found.name = parsed.name;
            found.outboundContent = parsed.outboundJson;
            found.serverAddress = host;
            found.serverPort = port;
            found.protocol = parsed.protocol || meta.protocol;
            found.network = parsed.network || meta.network;
            found.security = parsed.security || meta.security;
            found.sni = parsed.sni || meta.sni;
            found.targetList = targetList;
            found.updatedAt = new Date().toISOString();
            updatedCount++;
          } else {
            const newConn = {
              id: 'conn_' + (Date.now() + i) + '_' + Math.random().toString(36).substr(2, 4),
              name: parsed.name,
              description: '',
              groupId: id,
              routingId: effectiveRoutingId,
              outboundContent: parsed.outboundJson,
              serverAddress: host,
              serverPort: port,
              protocol: parsed.protocol || meta.protocol,
              network: parsed.network || meta.network,
              security: parsed.security || meta.security,
              sni: parsed.sni || meta.sni,
              countryCode: null,
              countryName: null,
              isFavorite: false,
              targetList: targetList,
              lastPing: null,
              lastPingStatus: null,
              lastPingCheckedAt: null,
              createdAt: new Date().toISOString()
            };
            data.connections.push(newConn);
            matchedIds.add(newConn.id);
            addedCount++;
          }
        } catch (err) {
          // ignore single line parse error
        }
      }

      let removedCount = 0;
      data.connections = data.connections.filter(c => {
        if (c.groupId === id && !matchedIds.has(c.id)) {
          if (c.id === data.settings.activeConnectionId) {
            return true;
          }
          removedCount++;
          return false;
        }
        return true;
      });

      const activeConn = data.connections.find(c => c.id === data.settings.activeConnectionId);
      if (activeConn && activeConn.groupId === id) {
        fs.writeFileSync(data.settings.outboundPath, activeConn.outboundContent, 'utf8');
      }

      saveData(data);
      setTimeout(sweepGeoIpForConnections, 1000);

      return sendJson(res, 200, {
        message: `Подписка "${group.name}" обновлена: +${addedCount} добавлено, ${updatedCount} обновлено, -${removedCount} удалено`,
        group,
        total: data.connections.filter(c => c.groupId === id).length,
        added: addedCount,
        updated: updatedCount,
        removed: removedCount
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка обновления подписки' });
    }
  }

  // PUT /api/subscriptions/:id - Update subscription settings (name, URL, targetList, routingId)
  if (urlParts.startsWith('/api/subscriptions/') && !urlParts.endsWith('/update') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/subscriptions/', '');
    try {
      const data = loadData();
      const group = data.groups.find(g => g.id === id);
      if (!group || !group.isSubscription) {
        return sendJson(res, 404, { error: 'Подписка не найдена' });
      }

      const body = await parseJsonBody(req);
      if (body.name && body.name.trim()) {
        group.name = body.name.trim();
      }
      if (body.subscriptionUrl && body.subscriptionUrl.trim()) {
        group.subscriptionUrl = body.subscriptionUrl.trim();
      }
      if (body.targetList && (body.targetList === 'blacklist' || body.targetList === 'whitelist')) {
        group.targetList = body.targetList;
        // Update targetList on ALL connections in this subscription group
        for (const conn of data.connections) {
          if (conn.groupId === id) {
            conn.targetList = group.targetList;
          }
        }
      }
      if (body.routingId && data.routings.some(r => r.id === body.routingId)) {
        group.routingId = body.routingId;
        if (body.applyRoutingToConnections) {
          for (const conn of data.connections) {
            if (conn.groupId === id) {
              conn.routingId = group.routingId;
            }
          }
        }
      }

      group.updatedAt = new Date().toISOString();
      saveData(data);

      return sendJson(res, 200, {
        message: `Параметры подписки "${group.name}" сохранены`,
        group
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Ошибка обновления подписки' });
    }
  }

  // DELETE /api/subscriptions/:id - Delete subscription group and all its connections
  if (urlParts.startsWith('/api/subscriptions/') && req.method === 'DELETE') {
    const id = urlParts.replace('/api/subscriptions/', '');
    const data = loadData();
    const groupIndex = data.groups.findIndex(g => g.id === id && g.isSubscription);
    if (groupIndex === -1) {
      return sendJson(res, 404, { error: 'Подписка не найдена' });
    }

    const subName = data.groups[groupIndex].name;
    let deletedConnsCount = 0;
    data.connections = data.connections.filter(c => {
      if (c.groupId === id) {
        if (c.id === data.settings.activeConnectionId) {
          data.settings.activeConnectionId = null;
        }
        deletedConnsCount++;
        return false;
      }
      return true;
    });

    data.groups.splice(groupIndex, 1);
    saveData(data);

    return sendJson(res, 200, {
      message: `Подписка "${subName}" и ${deletedConnsCount} подключений удалены`,
      groups: data.groups
    });
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

      if (body.isDefaultBlacklist) {
        data.settings.defaultRoutingBlacklist = newRouting.id;
      }
      if (body.isDefaultWhitelist) {
        data.settings.defaultRoutingWhitelist = newRouting.id;
      }

      saveData(data);

      return sendJson(res, 201, { message: 'Конфигурация маршрутизации создана', routing: newRouting });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Некорректный запрос' });
    }
  }

  // POST /api/routings/:id/set-default - Set default routing for blacklist or whitelist
  if (urlParts.startsWith('/api/routings/') && urlParts.endsWith('/set-default') && req.method === 'POST') {
    const id = urlParts.replace('/api/routings/', '').replace('/set-default', '');
    const data = loadData();
    const routing = data.routings.find(r => r.id === id);
    if (!routing) {
      return sendJson(res, 404, { error: 'Конфигурация маршрутизации не найдена' });
    }
    const body = await parseJsonBody(req).catch(() => ({}));
    const type = body.type; // 'blacklist' or 'whitelist'
    if (type !== 'blacklist' && type !== 'whitelist') {
      return sendJson(res, 400, { error: 'Укажите тип: blacklist или whitelist' });
    }

    if (type === 'blacklist') {
      data.settings.defaultRoutingBlacklist = id;
    } else {
      data.settings.defaultRoutingWhitelist = id;
    }

    saveData(data);
    return sendJson(res, 200, {
      message: `Маршрутизация "${routing.name}" назначена по умолчанию для ${type === 'whitelist' ? 'Белых списков (БС)' : 'Черных списков (ЧС)'}`,
      defaultRoutingBlacklist: data.settings.defaultRoutingBlacklist,
      defaultRoutingWhitelist: data.settings.defaultRoutingWhitelist
    });
  }

  // PUT /api/routings/:id (forbidden for isSystem)
  if (urlParts.startsWith('/api/routings/') && !urlParts.endsWith('/set-default') && (req.method === 'PUT' || (req.method === 'POST' && req.headers['x-http-method-override'] === 'PUT'))) {
    const id = urlParts.replace('/api/routings/', '');
    const data = loadData();
    const routing = data.routings.find(r => r.id === id);

    if (!routing) {
      return sendJson(res, 404, { error: 'Конфигурация маршрутизации не найдена' });
    }

    if (routing.isSystem) {
      try {
        const body = await parseJsonBody(req);
        let updated = false;
        if (typeof body.isDefaultBlacklist !== 'undefined') {
          if (Boolean(body.isDefaultBlacklist)) {
            data.settings.defaultRoutingBlacklist = id;
          } else if (data.settings.defaultRoutingBlacklist === id) {
            data.settings.defaultRoutingBlacklist = '';
          }
          updated = true;
        }
        if (typeof body.isDefaultWhitelist !== 'undefined') {
          if (Boolean(body.isDefaultWhitelist)) {
            data.settings.defaultRoutingWhitelist = id;
          } else if (data.settings.defaultRoutingWhitelist === id) {
            data.settings.defaultRoutingWhitelist = '';
          }
          updated = true;
        }
        if (updated) {
          saveData(data);
          return sendJson(res, 200, { message: 'Настройки маршрутизации по умолчанию сохранены', routing });
        }
        return sendJson(res, 403, { error: `Системный роутинг "${routing.name}" защищен от редактирования` });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
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

      if (typeof body.isDefaultBlacklist !== 'undefined') {
        if (Boolean(body.isDefaultBlacklist)) {
          data.settings.defaultRoutingBlacklist = id;
        } else if (data.settings.defaultRoutingBlacklist === id) {
          data.settings.defaultRoutingBlacklist = '';
        }
      }
      if (typeof body.isDefaultWhitelist !== 'undefined') {
        if (Boolean(body.isDefaultWhitelist)) {
          data.settings.defaultRoutingWhitelist = id;
        } else if (data.settings.defaultRoutingWhitelist === id) {
          data.settings.defaultRoutingWhitelist = '';
        }
      }

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

    if (data.settings.defaultRoutingBlacklist === id) {
      data.settings.defaultRoutingBlacklist = 'routing_except_ru';
    }
    if (data.settings.defaultRoutingWhitelist === id) {
      data.settings.defaultRoutingWhitelist = 'routing_all_vpn';
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
          network: c.network || meta.network || 'tcp',
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

  // Helper: Detect active proxy core from S05xkeen and binaries
  function detectActiveProxyCore() {
    let activeCore = 'xray';
    const initdPath = '/opt/etc/init.d/S05xkeen';
    if (fs.existsSync(initdPath)) {
      try {
        const content = fs.readFileSync(initdPath, 'utf8');
        if (/name_client="mihomo"/.test(content)) {
          activeCore = 'mihomo';
        } else if (/name_client="xray"/.test(content)) {
          activeCore = 'xray';
        }
      } catch (e) {}
    }
    const hasXray = fs.existsSync('/opt/sbin/xray') || fs.existsSync('/opt/bin/xray');
    const hasMihomo = fs.existsSync('/opt/sbin/mihomo') || fs.existsSync('/opt/bin/mihomo');
    return {
      activeCore,
      hasXray,
      hasMihomo
    };
  }

  // GET /api/service/status
  if (urlParts === '/api/service/status' && req.method === 'GET') {
    const data = loadData();
    const cmd = data.settings.statusCommand || 'xkeen -status';
    const result = await runShellCommand(cmd);
    const computedStatus = evaluateServiceStatus(result);
    const coreInfo = detectActiveProxyCore();

    lastServiceStatus = {
      status: computedStatus,
      core: coreInfo.activeCore,
      coresAvailable: {
        xray: coreInfo.hasXray,
        mihomo: coreInfo.hasMihomo
      },
      output: result.stdout || '',
      error: result.stderr || result.error || '',
      code: result.code,
      timestamp: new Date().toISOString(),
      command: cmd
    };
    return sendJson(res, 200, lastServiceStatus);
  }

  // POST /api/service/switch-core - Switch between Xray and Mihomo
  if (urlParts === '/api/service/switch-core' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const targetCore = (body.core || '').toLowerCase().trim();
      if (targetCore !== 'xray' && targetCore !== 'mihomo') {
        return sendJson(res, 400, { error: 'Недопустимое ядро. Допустимы: xray, mihomo' });
      }

      const coreInfo = detectActiveProxyCore();
      if (targetCore === 'mihomo' && !coreInfo.hasMihomo) {
        return sendJson(res, 400, { error: 'Ядро Mihomo не установлено на роутере' });
      }
      if (targetCore === 'xray' && !coreInfo.hasXray) {
        return sendJson(res, 400, { error: 'Ядро Xray не установлено на роутере' });
      }

      const switchCmd = targetCore === 'mihomo' ? 'xkeen -mihomo' : 'xkeen -xray';
      const switchRes = await runShellCommand(switchCmd);

      // Restart service to apply core switch
      await runShellCommand('xkeen -restart');
      const statusRes = await runShellCommand('xkeen -status');
      const computedStatus = evaluateServiceStatus(statusRes);
      const updatedCoreInfo = detectActiveProxyCore();

      lastServiceStatus = {
        status: computedStatus,
        core: updatedCoreInfo.activeCore,
        coresAvailable: {
          xray: updatedCoreInfo.hasXray,
          mihomo: updatedCoreInfo.hasMihomo
        },
        output: statusRes.stdout || '',
        error: statusRes.stderr || statusRes.error || '',
        code: statusRes.code,
        timestamp: new Date().toISOString(),
        command: 'xkeen -status'
      };

      return sendJson(res, 200, {
        message: `Ядро XKeen успешно переключено на ${targetCore === 'mihomo' ? 'Mihomo' : 'Xray'}`,
        activeCore: updatedCoreInfo.activeCore,
        status: computedStatus,
        switchOutput: switchRes.stdout || '',
        serviceOutput: statusRes.stdout || ''
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка переключения ядра: ' + err.message });
    }
  }

  // POST /api/service/test-config - Run xtest or mtest
  if (urlParts === '/api/service/test-config' && req.method === 'POST') {
    try {
      const coreInfo = detectActiveProxyCore();
      const testCmd = coreInfo.activeCore === 'mihomo' ? 'xkeen -mtest' : 'xkeen -xtest';
      const result = await runShellCommand(testCmd);
      const isOk = result.code === 0 && !result.error;
      return sendJson(res, 200, {
        ok: isOk,
        core: coreInfo.activeCore,
        command: testCmd,
        output: result.stdout || '',
        error: result.stderr || result.error || ''
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка проверки конфигурации: ' + err.message });
    }
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
