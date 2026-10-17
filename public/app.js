// ==============================================================================
// XKeenSwitcher 2.0 - Frontend Application
// ==============================================================================

// Global Application State
let appData = {
  settings: {},
  connections: [],
  routings: [],
  activeConnectionId: null,
  version: '2.0.0'
};

let currentTab = 'connections'; // 'connections' | 'routings'
let currentSort = localStorage.getItem('xkeen_connections_sort') || 'default';
let selectedProtoFilters = new Set();
try {
  const savedProto = JSON.parse(localStorage.getItem('xkeen_connections_proto_filters') || '[]');
  if (Array.isArray(savedProto)) selectedProtoFilters = new Set(savedProto);
} catch (e) {}
if (selectedProtoFilters.size === 0) {
  const legacyProto = localStorage.getItem('xkeen_connections_proto_filter');
  if (legacyProto && legacyProto !== 'all') selectedProtoFilters.add(legacyProto);
}

let selectedNetFilters = new Set();
try {
  const savedNet = JSON.parse(localStorage.getItem('xkeen_connections_net_filters') || '[]');
  if (Array.isArray(savedNet)) selectedNetFilters = new Set(savedNet);
} catch (e) {}
if (selectedNetFilters.size === 0) {
  const legacyNet = localStorage.getItem('xkeen_connections_net_filter');
  if (legacyNet && legacyNet !== 'all') selectedNetFilters.add(legacyNet);
}
let groupRenderLimits = new Map();
let pingingConnectionIds = new Set();
let pingingGroupIds = new Set();
let updatingSubscriptionIds = new Set();
let isPingingFavorites = false;
let isPingingAll = false;
let revealedHiddenGroupIds = new Set();
let servicePollingTimer = null;
let lastServiceLog = '';

// DOM Elements
const connectionsGrid = document.getElementById('connections-grid');
const routingsGrid = document.getElementById('routings-grid');
const emptyConnectionsState = document.getElementById('empty-connections-state');
const connectionsCount = document.getElementById('connections-count');
const routingsCount = document.getElementById('routings-count');
const connectionsBadge = document.getElementById('connections-count-badge');
const routingsBadge = document.getElementById('routings-count-badge');
const serviceStatusBadge = document.getElementById('service-status-badge');
const serviceStatusText = document.getElementById('service-status-text');
const btnServiceStart = document.getElementById('btn-service-start');
const btnServiceStop = document.getElementById('btn-service-stop');
const btnServiceRestart = document.getElementById('btn-service-restart');
const toastContainer = document.getElementById('toast-container');

// Syntax Highlighting Editor Pair IDs
const editorIds = [
  { textId: 'conn-outbound-json', codeId: 'conn-outbound-code', statusId: 'conn-outbound-status' },
  { textId: 'edit-conn-outbound-json', codeId: 'edit-conn-outbound-code', statusId: 'edit-conn-outbound-status' },
  { textId: 'routing-content-json', codeId: 'routing-content-code', statusId: 'routing-content-status' }
];

// ==============================================================================
// INITIALIZATION
// ==============================================================================
function initApp() {
  setupCodeEditors();
  loadData();
  startServicePolling();
  initRoutingTextareaSync();

  // Setup connections sort and filter dropdowns from saved state
  updateSortDropdownUi();
  updateProtoDropdownUi();
  updateNetDropdownUi();

  // Setup live VLESS parser on input in add modal
  const urlInput = document.getElementById('input-vless-url');
  if (urlInput) {
    urlInput.addEventListener('input', () => {
      parseVlessUrlInput(false);
    });
    urlInput.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData)?.getData('text');
      if (pasted && (pasted.includes('[Interface]') || pasted.includes('[Peer]'))) {
        e.preventDefault();
        tryParseAndApplyWireguardText(pasted);
        return;
      }
      setTimeout(() => parseVlessUrlInput(false), 50);
    });
  }

  // Setup Drag & Drop for backup dropzone
  const dropzone = document.getElementById('backup-dropzone');
  if (dropzone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });
    dropzone.addEventListener('drop', (e) => {
      onBackupFileSelected(e);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Switch Main Navigation Tabs
function switchMainTab(tab) {
  currentTab = tab;
  document.getElementById('tab-btn-connections').classList.toggle('active', tab === 'connections');
  document.getElementById('tab-btn-routings').classList.toggle('active', tab === 'routings');
  document.getElementById('section-connections').classList.toggle('hidden', tab !== 'connections');
  document.getElementById('section-routings').classList.toggle('hidden', tab !== 'routings');
}

// ==============================================================================
// DATA FETCHING & RENDERING
// ==============================================================================
async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`Ошибка загрузки данных (${res.status})`);
    const data = await res.json();
    appData = data;

    if (data.version) {
      const verEl = document.getElementById('app-version-text');
      if (verEl) verEl.textContent = `v${data.version}`;
    }

    // Check for updates on GitHub in the background
    checkForUpdates(data.version);

    renderConnections();
    renderRoutings();
    populateRoutingSelects();
    populateGroupSelects();
    pollFailoverStatus();
    pollAutoFailoverStatus();
  } catch (err) {
    console.error('Error fetching data:', err);
    showToast('Не удалось загрузить данные с роутера (повтор через 2с)...', 'warning');
    setTimeout(loadData, 2000);
  }
}

// Sorting Handler
function onSortChange(val) {
  selectSortOption(val);
}

// Targeted DOM update for ping results without full-page re-render
function updateConnectionPingDom(connId) {
  const conn = (appData.connections || []).find(c => c.id === connId);
  const cardEls = document.querySelectorAll(`[id="card-conn-${connId}"]`);
  if (!cardEls || cardEls.length === 0) return;

  const isChecking = pingingConnectionIds.has(connId) || isPingingAll;

  let pingHtml = '';
  if (isChecking) {
    pingHtml = `<span class="ping-badge ping-loading"><span class="spin-icon">⏳</span> Проверка...</span>`;
  } else if (conn && conn.lastPingStatus === 'ok' && conn.lastPing !== null) {
    const isProxy = conn.lastPingType === 'proxy';
    const isIcmp = conn.lastPingType === 'icmp';
    const checkTitle = (isProxy ? 'Сквозной туннель подтверждён' : (isIcmp ? 'ICMP ping доступен' : 'TCP доступен')) +
      (conn.lastPingCheckedAt ? ` • Проверено: ${formatTime(conn.lastPingCheckedAt)}` : '');
    pingHtml = `<span class="ping-badge ping-ok" title="${escapeHtml(checkTitle)}">● ${conn.lastPing} ms</span>`;
  } else if (conn && conn.lastPingStatus === 'unreachable') {
    const errNote = conn.lastPingError ? `\nПричина: ${conn.lastPingError}` : '';
    const checkTitle = `Недоступен${errNote}` +
      (conn.lastPingCheckedAt ? ` • Проверено: ${formatTime(conn.lastPingCheckedAt)}` : '');
    pingHtml = `<span class="ping-badge ping-unreachable" title="${escapeHtml(checkTitle)}">● Недоступен</span>`;
  } else {
    pingHtml = `<span class="ping-badge ping-none">Не проверялся</span>`;
  }

  cardEls.forEach(card => {
    const statusWrap = card.querySelector('.ping-status-wrap');
    if (statusWrap) statusWrap.innerHTML = pingHtml;

    const pingBtn = card.querySelector('.btn-check-ping');
    if (pingBtn) {
      pingBtn.disabled = isChecking;
    }
  });

  // Update group availability counter in the group header
  if (conn && conn.groupId) {
    const groupCard = document.getElementById(`group-card-${conn.groupId}`);
    if (groupCard) {
      const gConns = (appData.connections || []).filter(c => (c.groupId || 'group_default') === conn.groupId);
      const avail = gConns.filter(c => c.lastPingStatus === 'ok' && c.lastPing !== null).length;
      const countBadge = groupCard.querySelector('.group-count-badge');
      if (countBadge) {
        countBadge.title = `Доступно: ${avail} из ${gConns.length} подключений`;
        countBadge.innerHTML = `<span class="count-available ${avail > 0 ? 'has-online' : 'no-online'}">● ${avail}</span> / <span class="count-total">${gConns.length}</span>`;
      }
    }
  }

  // Update Favorites counter if connection is favorite
  if (conn && conn.isFavorite) {
    const favBadge = document.querySelector('.favorites-divider .group-count');
    if (favBadge) {
      const favList = (appData.connections || []).filter(c => c.isFavorite);
      const favAvail = favList.filter(c => c.lastPingStatus === 'ok' && c.lastPing !== null).length;
      favBadge.title = `Доступно: ${favAvail} из ${favList.length} подключений`;
      favBadge.innerHTML = `<span class="count-available ${favAvail > 0 ? 'has-online' : 'no-online'}">● ${favAvail}</span> / <span class="count-total">${favList.length}</span>`;
    }
  }
}

// Sort connections: available first, then untested, then unreachable
function sortConnsAvailability(conns) {
  if (!Array.isArray(conns)) return [];
  const available = [];
  const untested = [];
  const unreachable = [];

  for (const c of conns) {
    if (c.lastPingStatus === 'ok' && c.lastPing !== null) {
      available.push(c);
    } else if (c.lastPingStatus === 'unreachable') {
      unreachable.push(c);
    } else {
      untested.push(c);
    }
  }

  return [...available, ...untested, ...unreachable];
}

// Toggle showing hidden unreachable connections for a specific group
function toggleShowHiddenForGroup(groupId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const scrollPos = window.scrollY;
  if (revealedHiddenGroupIds.has(groupId)) {
    revealedHiddenGroupIds.delete(groupId);
  } else {
    revealedHiddenGroupIds.add(groupId);
  }
  renderConnections();
  window.scrollTo({ top: scrollPos, behavior: 'instant' });
}

// Return sorted connections list based on currentSort
function getSortedConnections(connections, activeId) {
  if (!Array.isArray(connections)) return [];
  const list = [...connections];

  switch (currentSort) {
    case 'active':
      list.sort((a, b) => {
        const aActive = (a.id === activeId);
        const bActive = (b.id === activeId);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return 0;
      });
      break;

    case 'ping':
      if (isPingingAll) break;
      list.sort((a, b) => {
        const aHasPing = (a.lastPingStatus === 'ok' && typeof a.lastPing === 'number');
        const bHasPing = (b.lastPingStatus === 'ok' && typeof b.lastPing === 'number');

        if (aHasPing && bHasPing) {
          return a.lastPing - b.lastPing;
        }
        if (aHasPing && !bHasPing) return -1;
        if (!aHasPing && bHasPing) return 1;

        const aUnreachable = (a.lastPingStatus === 'unreachable');
        const bUnreachable = (b.lastPingStatus === 'unreachable');
        if (aUnreachable && !bUnreachable) return -1;
        if (!aUnreachable && bUnreachable) return 1;

        return 0;
      });
      break;

    case 'name_asc':
      list.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
      break;

    case 'name_desc':
      list.sort((a, b) => (b.name || '').localeCompare(a.name || '', undefined, { numeric: true, sensitivity: 'base' }));
      break;

    case 'newest':
      list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      break;

    case 'oldest':
      list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeA - timeB;
      });
      break;

    case 'default':
    default:
      break;
  }

  return list;
}

function formatNetworkName(net) {
  if (!net) return 'TCP';
  const n = String(net).trim().toLowerCase();
  switch (n) {
    case 'tcp': return 'TCP';
    case 'grpc': return 'gRPC';
    case 'ws':
    case 'websocket': return 'WebSocket';
    case 'xhttp':
    case 'xttp': return 'XHTTP';
    case 'splithttp': return 'SplitHTTP';
    case 'h2':
    case 'http': return 'HTTP/2';
    case 'mkcp':
    case 'kcp': return 'mKCP';
    case 'quic': return 'QUIC';
    case 'domainsocket':
    case 'ds': return 'DomainSocket';
    case 'wireguard': return 'WireGuard';
    case 'amneziawg':
    case 'awg': return 'AWG';
    case 'udp': return 'UDP';
    default: return n.toUpperCase();
  }
}

// Collapsible connection cards state & toggling
let expandedConnectionIds = new Set();

function toggleConnectionExpand(connId, ev) {
  if (ev) ev.stopPropagation();
  const cardEls = document.querySelectorAll(`[id="card-conn-${connId}"]`);
  const willExpand = !expandedConnectionIds.has(connId);
  if (willExpand) {
    expandedConnectionIds.add(connId);
  } else {
    expandedConnectionIds.delete(connId);
  }
  cardEls.forEach(card => {
    card.classList.toggle('is-expanded', willExpand);
    const expandBtn = card.querySelector('.btn-card-expand');
    if (expandBtn) {
      expandBtn.title = willExpand ? 'Свернуть детали' : 'Развернуть детали';
      expandBtn.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
    }
  });
}

function onCardHeaderClick(connId, ev) {
  if (ev && ev.target.closest('button, select, input, a, .btn-star, .btn-check-ping, .btn-activate, .conn-routing-select, .btn-card-expand')) {
    return;
  }
  toggleConnectionExpand(connId, ev);
}

// Render Connections Grid
function renderConnectionCardHtml(conn, activeId, isFavoriteSection = false, parentGroup = null, allRoutingsList = null) {
  const isActive = (conn.id === activeId);
  const isChecking = pingingConnectionIds.has(conn.id) || isPingingAll;
  const isAwgConn = conn.protocol === 'amneziawg' || conn.protocol === 'awg' || Boolean(conn.amneziaConfig);
  const isHy2Conn = conn.protocol === 'hysteria2' || conn.protocol === 'hy2';

  // Security & SNI
  let secBadgeHtml = '';
  if (isAwgConn || conn.security === 'Amnezia') {
    secBadgeHtml = `<span class="conn-badge badge-sec badge-sec-awg" title="Маскировка заголовков и junk-пакетов Amnezia">Amnezia</span>`;
  } else if (conn.security === 'reality') {
    secBadgeHtml = `<span class="conn-badge badge-sec">Reality</span>`;
    if (conn.sni) {
      secBadgeHtml += `<span class="conn-badge badge-sni" title="SNI / ServerName">${escapeHtml(conn.sni)}</span>`;
    }
  } else if (conn.security && conn.security !== 'none') {
    secBadgeHtml = `<span class="conn-badge badge-sec">${escapeHtml(conn.security.toUpperCase())}</span>`;
    if (conn.sni) {
      secBadgeHtml += `<span class="conn-badge badge-sni" title="SNI / ServerName">${escapeHtml(conn.sni)}</span>`;
    }
  } else {
    secBadgeHtml = `<span class="conn-badge badge-sec">None</span>`;
  }

  // Network / Transport
  let connNetwork = conn._cachedNet || conn.network;
  if (!connNetwork && conn.outboundContent) {
    try {
      const clean = stripComments(conn.outboundContent);
      const parsed = JSON.parse(clean);
      const oList = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
      const ob = oList.find(o => o && o.tag !== 'direct' && o.tag !== 'block');
      if (ob && ob.streamSettings && ob.streamSettings.network) {
        connNetwork = ob.streamSettings.network;
      }
    } catch (e) {}
  }
  if (!connNetwork) {
    connNetwork = (isAwgConn || conn.protocol === 'wireguard' ? 'udp' : 'tcp');
  }
  conn._cachedNet = connNetwork;
  const netFormatted = formatNetworkName(connNetwork);
  const netBadgeHtml = `<span class="conn-badge badge-net" title="Транспорт: ${escapeHtml(netFormatted)}">${escapeHtml(netFormatted)}</span>`;

  // Ping status display
  let pingHtml = '';
  if (isChecking) {
    pingHtml = `<span class="ping-badge ping-loading"><span class="spin-icon">⏳</span> Проверка...</span>`;
  } else if (conn.lastPingStatus === 'ok' && conn.lastPing !== null) {
    const isProxy = conn.lastPingType === 'proxy';
    const isIcmp = conn.lastPingType === 'icmp';
    const checkTitle = (isProxy ? 'Сквозной туннель подтверждён' : (isIcmp ? 'ICMP ping доступен' : 'TCP доступен')) +
      (conn.lastPingCheckedAt ? ` • Проверено: ${formatTime(conn.lastPingCheckedAt)}` : '');
    pingHtml = `<span class="ping-badge ping-ok" title="${escapeHtml(checkTitle)}">● ${conn.lastPing} ms</span>`;
  } else if (conn.lastPingStatus === 'unreachable') {
    const errNote = conn.lastPingError ? `\nПричина: ${conn.lastPingError}` : '';
    const checkTitle = `Недоступен${errNote}` +
      (conn.lastPingCheckedAt ? ` • Проверено: ${formatTime(conn.lastPingCheckedAt)}` : '');
    pingHtml = `<span class="ping-badge ping-unreachable" title="${escapeHtml(checkTitle)}">● Недоступен</span>`;
  } else {
    pingHtml = `<span class="ping-badge ping-none">Не проверялся</span>`;
  }

  // Routing selector options (reuse precomputed list or build on demand)
  const allRoutings = allRoutingsList || [
    ...(appData.routings || []).filter(r => !r.isSystem),
    ...(appData.routings || []).filter(r => r.isSystem)
  ];
  const routingOptionsHtml = allRoutings.map(r => {
    const sel = (r.id === conn.routingId) ? 'selected' : '';
    return `<option value="${r.id}" ${sel}>${escapeHtml(r.name)}</option>`;
  }).join('');

  const flag = getFlagEmoji(conn.countryCode);
  const countryTitle = conn.countryName ? `${conn.countryName} (${conn.countryCode})` : (conn.countryCode || '');
  const flagHtml = flag ? `<span class="conn-flag" title="${escapeHtml(countryTitle)}">${flag}</span>` : '';

  const isFav = Boolean(conn.isFavorite);

  const isWhitelist = (conn.targetList === 'whitelist');
  const targetBadgeHtml = `<span class="conn-badge badge-target-list ${isWhitelist ? 'target-whitelist' : 'target-blacklist'}" title="Назначение: ${isWhitelist ? 'Белые списки (БС)' : 'Черные списки (ЧС)'}">${isWhitelist ? 'БС' : 'ЧС'}</span>`;

  const rawProto = String(conn.protocol || 'vless').toLowerCase();
  let protoClass = 'badge-proto-other';
  let protoText = escapeHtml(rawProto.toUpperCase());
  let protoTitle = `Протокол: ${protoText}`;

  if (isAwgConn || rawProto === 'amneziawg' || rawProto === 'awg') {
    protoClass = 'badge-proto-awg';
    protoText = 'AWG';
    protoTitle = 'Протокол: AmneziaWG (ядро Mihomo)';
  } else if (isHy2Conn || rawProto === 'hysteria2' || rawProto === 'hy2') {
    protoClass = 'badge-proto-hy2';
    protoText = 'HY2';
    protoTitle = 'Протокол: Hysteria 2 (ядро Mihomo)';
  } else if (rawProto === 'vless') {
    protoClass = 'badge-proto-vless';
    protoText = 'VLESS';
    protoTitle = 'Протокол: VLESS';
  } else if (rawProto === 'vmess') {
    protoClass = 'badge-proto-vmess';
    protoText = 'VMESS';
    protoTitle = 'Протокол: VMess';
  } else if (rawProto === 'trojan') {
    protoClass = 'badge-proto-trojan';
    protoText = 'TROJAN';
    protoTitle = 'Протокол: Trojan';
  } else if (rawProto === 'shadowsocks' || rawProto === 'ss') {
    protoClass = 'badge-proto-ss';
    protoText = 'SS';
    protoTitle = 'Протокол: Shadowsocks';
  } else if (rawProto === 'wireguard' || rawProto === 'wg') {
    protoClass = 'badge-proto-wg';
    protoText = 'WG';
    protoTitle = 'Протокол: WireGuard';
  } else if (rawProto === 'tuic') {
    protoClass = 'badge-proto-tuic';
    protoText = 'TUIC';
    protoTitle = 'Протокол: TUIC';
  } else if (rawProto === 'socks' || rawProto === 'socks5') {
    protoClass = 'badge-proto-socks';
    protoText = 'SOCKS';
    protoTitle = 'Протокол: SOCKS5';
  } else if (rawProto === 'http' || rawProto === 'https') {
    protoClass = 'badge-proto-http';
    protoText = 'HTTP';
    protoTitle = 'Протокол: HTTP';
  }

  // Origin info when rendered in Favorites section
  let originFooterHtml = '';
  if (isFavoriteSection) {
    const originGroup = (appData.groups || []).find(g => g.id === (conn.groupId || 'group_default'));
    const grpName = originGroup ? originGroup.name : 'Общие';
    const isSub = originGroup ? Boolean(originGroup.isSubscription) : false;
    originFooterHtml = `
      <div class="conn-origin-footer" title="${isSub ? 'Подписка' : 'Группа'} источника">
        <span class="conn-origin-label">${isSub ? 'Подписка:' : 'Группа:'}</span>
        <span class="conn-origin-name">${escapeHtml(grpName)}</span>
      </div>
    `;
  }

  const isExpanded = expandedConnectionIds.has(conn.id);

  return `
    <div class="conn-card ${isActive ? 'active-conn' : ''} ${isFav ? 'is-favorite' : ''} ${isExpanded ? 'is-expanded' : ''}" id="card-conn-${conn.id}">
      <!-- CLOSED STATE VISIBLE HEADER -->
      <div class="conn-header-visible" onclick="onCardHeaderClick('${conn.id}', event)">
        <div class="conn-summary-main">
          <div class="conn-card-header">
            <div class="conn-title-wrap">
              <button type="button" class="btn-star ${isFav ? 'starred' : ''}" onclick="toggleFavoriteConnection('${conn.id}', event)" title="${isFav ? 'Убрать из избранного' : 'Добавить в избранное'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${isFav ? '#f59e0b' : 'none'}" stroke="${isFav ? '#f59e0b' : 'rgba(255,255,255,0.45)'}" stroke-width="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
              <h3 class="conn-title" title="${escapeHtml(conn.name)}">${flagHtml ? flagHtml + ' ' : ''}<span>${escapeHtml(conn.name)}</span></h3>
            </div>
          </div>

          <!-- BADGES ROW: TargetList 1st, Protocol 2nd, Host:Port 3rd -->
          <div class="conn-badges-row">
            ${targetBadgeHtml}
            <span class="conn-badge badge-proto ${protoClass}" title="${protoTitle}">${protoText}</span>
            <span class="conn-badge badge-host" title="Хост:Порт">${escapeHtml(conn.serverAddress || '-')}:${conn.serverPort || '-'}</span>
            ${netBadgeHtml}
            ${secBadgeHtml}
          </div>
        </div>

        <div class="conn-summary-controls">
          <!-- PING AVAILABILITY ROW (Result on left, Button on right) -->
          <div class="conn-ping-row">
            <div class="ping-status-wrap">
              ${pingHtml}
            </div>
            <button class="btn-check-ping" id="btn-ping-${conn.id}" onclick="checkConnectionPing('${conn.id}')" ${isChecking ? 'disabled' : ''} title="Проверить доступность подключения">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </button>
          </div>

          <!-- ACTIVATION BUTTON / ACTIVE BADGE (CENTERED IN SLOT) -->
          <div class="conn-activate-wrap">
            ${isActive ? `
              <span class="active-pill-badge"><span class="status-dot green"></span> Активно</span>
            ` : `
              <button class="btn btn-activate" onclick="activateConnection('${conn.id}')" title="Сделать активным подключением">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>Активировать</span>
              </button>
            `}
          </div>

          <!-- EXPAND / COLLAPSE BUTTON -->
          <button type="button" class="btn-card-expand" onclick="toggleConnectionExpand('${conn.id}', event)" title="${isExpanded ? 'Свернуть детали' : 'Развернуть детали'}" aria-expanded="${isExpanded ? 'true' : 'false'}">
            <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>
      </div>

      <!-- COLLAPSIBLE DETAILS BODY -->
      <div class="conn-collapsible-body">
        <div class="conn-collapsible-inner">
          <div class="conn-collapsible-row">
            <!-- ROUTING SELECTOR ROW -->
            <div class="conn-routing-row" title="Вариант маршрутизации для этого подключения">
              <span class="conn-routing-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                Роутинг:
              </span>
              <select class="conn-routing-select" onchange="changeConnectionRouting('${conn.id}', this.value)">
                ${routingOptionsHtml}
              </select>
            </div>

            <!-- ORIGIN GROUP (IF FAVORITES SECTION) -->
            ${originFooterHtml}

            <!-- ACTIONS TOOLBAR (RIGHT-ALIGNED) -->
            <div class="conn-footer-actions">
              <button class="btn btn-secondary btn-sm btn-icon" onclick="openMoveCopyModal('${conn.id}')" title="${(parentGroup?.isSubscription || (appData.groups || []).find(g => g.id === (conn.groupId || 'group_default'))?.isSubscription) ? 'Скопировать в другую группу' : 'Переместить или скопировать в другую группу'}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </button>
              <button class="btn btn-secondary btn-sm btn-icon" onclick="openQrModal('${conn.id}')" title="Показать QR-код VLESS">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M7 17h.01M17 17h.01M7 7h.01M17 7h.01"/></svg>
              </button>
              <button class="btn btn-secondary btn-sm btn-icon" onclick="openEditConnectionModal('${conn.id}')" title="Редактировать параметры и outbound.json">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              </button>
              <button class="btn btn-danger btn-sm btn-icon" onclick="deleteConnection('${conn.id}', '${escapeJs(conn.name)}')" title="Удалить подключение">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>

          <!-- COMMENT (BELOW, IF ANY) -->
          ${conn.description ? `
            <div class="conn-comment-row" title="Комментарий к подключению">
              <span class="conn-comment-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Комментарий:
              </span>
              <span class="conn-comment-text">${escapeHtml(conn.description)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

let collapsedGroupIds = new Set();
try {
  const saved = localStorage.getItem('xkeen_collapsed_groups');
  if (saved) {
    collapsedGroupIds = new Set(JSON.parse(saved));
  }
} catch (e) {}

function saveCollapsedGroups() {
  try {
    localStorage.setItem('xkeen_collapsed_groups', JSON.stringify([...collapsedGroupIds]));
  } catch (e) {}
}

function toggleGroupCollapse(groupId) {
  if (collapsedGroupIds.has(groupId)) {
    collapsedGroupIds.delete(groupId);
  } else {
    collapsedGroupIds.add(groupId);
  }
  saveCollapsedGroups();
  const card = document.getElementById(`group-card-${groupId}`);
  const body = document.getElementById(`group-body-${groupId}`);
  const isNowCollapsed = collapsedGroupIds.has(groupId);
  if (card && body) {
    card.classList.toggle('collapsed', isNowCollapsed);
    body.classList.toggle('hidden', isNowCollapsed);
    const arrow = card.querySelector('.group-toggle-arrow');
    if (arrow) arrow.classList.toggle('expanded', !isNowCollapsed);

    // If expanding a group whose cards were lazily omitted, render them
    const lazySubgrid = body.querySelector('.lazy-subgrid');
    if (!isNowCollapsed && lazySubgrid) {
      renderConnections();
    }
  } else {
    renderConnections();
  }
}

// Protocol and Transport Filter Helpers
function getConnectionProtocol(conn) {
  if (conn._cachedNormalizedProto) return conn._cachedNormalizedProto;
  const rawProto = String(conn.protocol || 'vless').toLowerCase();
  let proto = rawProto;
  if (conn.isAwg || rawProto === 'amneziawg' || rawProto === 'awg') proto = 'amneziawg';
  else if (conn.isHy2 || rawProto === 'hysteria2' || rawProto === 'hy2') proto = 'hysteria2';
  else if (rawProto === 'vless') proto = 'vless';
  else if (rawProto === 'vmess') proto = 'vmess';
  else if (rawProto === 'trojan') proto = 'trojan';
  else if (rawProto === 'shadowsocks' || rawProto === 'ss') proto = 'shadowsocks';
  else if (rawProto === 'wireguard' || rawProto === 'wg') proto = 'wireguard';
  else if (rawProto === 'tuic') proto = 'tuic';
  else if (rawProto === 'socks' || rawProto === 'socks5') proto = 'socks';
  else if (rawProto === 'http' || rawProto === 'https') proto = 'http';
  conn._cachedNormalizedProto = proto;
  return proto;
}

function getConnectionTransport(conn) {
  if (conn._cachedNet) return conn._cachedNet;
  let connNetwork = conn.network;
  if (!connNetwork && conn.outboundContent) {
    try {
      const clean = stripComments(conn.outboundContent);
      const parsed = JSON.parse(clean);
      const oList = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
      const ob = oList.find(o => o && o.tag !== 'direct' && o.tag !== 'block');
      if (ob && ob.streamSettings && ob.streamSettings.network) {
        connNetwork = ob.streamSettings.network;
      }
    } catch (e) {}
  }
  const isAwgConn = Boolean(conn.isAwg || conn.protocol === 'amneziawg' || conn.protocol === 'awg');
  const isHy2Conn = Boolean(conn.isHy2 || conn.protocol === 'hysteria2' || conn.protocol === 'hy2');
  if (!connNetwork) {
    if (isAwgConn || conn.protocol === 'wireguard' || conn.protocol === 'wg' || isHy2Conn || conn.protocol === 'tuic') {
      connNetwork = 'udp';
    } else {
      connNetwork = 'tcp';
    }
  }
  conn._cachedNet = String(connNetwork).toLowerCase();
  return conn._cachedNet;
}

// Dropdown Menu Management
function toggleCustomDropdown(wrapId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const isAlreadyOpen = wrap.classList.contains('open') || wrap.classList.contains('is-open');
  closeAllCustomDropdowns();
  if (!isAlreadyOpen) {
    wrap.classList.add('open', 'is-open');
    const btn = wrap.querySelector('.btn-dropdown');
    if (btn) btn.classList.add('open', 'is-open');
  }
}

function closeAllCustomDropdowns() {
  document.querySelectorAll('.custom-dropdown').forEach(el => {
    el.classList.remove('open', 'is-open');
    const btn = el.querySelector('.btn-dropdown');
    if (btn) btn.classList.remove('open', 'is-open');
  });
}

if (!window._customDropdownsInitialized) {
  window._customDropdownsInitialized = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown')) {
      closeAllCustomDropdowns();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomDropdowns();
    }
  });
}

// Sort Dropdown Option Select
const SORT_LABELS = {
  default: 'По умолчанию',
  active: 'Сначала активное',
  ping: 'По пингу',
  name_asc: 'Имя (А → Я)',
  name_desc: 'Имя (Я → А)',
  newest: 'Сначала новые',
  oldest: 'Сначала старые'
};

function selectSortOption(sortKey) {
  currentSort = sortKey || 'default';
  try {
    localStorage.setItem('xkeen_connections_sort', currentSort);
  } catch (e) {}
  updateSortDropdownUi();
  closeAllCustomDropdowns();
  renderConnections();
}

function updateSortDropdownUi() {
  const labelEl = document.getElementById('sort-dropdown-label');
  if (labelEl) {
    labelEl.textContent = SORT_LABELS[currentSort] || 'По умолчанию';
  }
  const btn = document.getElementById('btn-sort-dropdown');
  if (btn) {
    btn.classList.toggle('filter-active', currentSort !== 'default');
  }
  const menu = document.getElementById('dropdown-sort-menu');
  if (menu) {
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      const itemSort = item.getAttribute('data-sort');
      item.classList.toggle('active', itemSort === currentSort);
    });
  }
}

// Multi-select Protocol Filter Handlers
const PROTOCOL_DISPLAY_NAMES = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  shadowsocks: 'SS',
  hysteria2: 'HY2',
  amneziawg: 'AWG',
  wireguard: 'WG',
  tuic: 'TUIC',
  socks: 'SOCKS',
  http: 'HTTP'
};

function onProtoMultiFilterChange() {
  const checkboxes = document.querySelectorAll('.filter-proto-checkbox');
  selectedProtoFilters.clear();
  checkboxes.forEach(cb => {
    if (cb.checked) selectedProtoFilters.add(cb.value);
  });
  saveProtoFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function selectAllProtocols(selectAll) {
  const checkboxes = document.querySelectorAll('.filter-proto-checkbox');
  selectedProtoFilters.clear();
  checkboxes.forEach(cb => {
    cb.checked = selectAll;
    if (selectAll) selectedProtoFilters.add(cb.value);
  });
  saveProtoFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function saveProtoFilters() {
  try {
    localStorage.setItem('xkeen_connections_proto_filters', JSON.stringify(Array.from(selectedProtoFilters)));
  } catch (e) {}
}

// Multi-select Transport Filter Handlers
const TRANSPORT_DISPLAY_NAMES = {
  tcp: 'TCP',
  ws: 'WS',
  grpc: 'gRPC',
  xhttp: 'XHTTP',
  httpupgrade: 'HTTPUpgrade',
  quic: 'QUIC',
  h2: 'H2',
  udp: 'UDP'
};

function onNetMultiFilterChange() {
  const checkboxes = document.querySelectorAll('.filter-net-checkbox');
  selectedNetFilters.clear();
  checkboxes.forEach(cb => {
    if (cb.checked) selectedNetFilters.add(cb.value);
  });
  saveNetFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function selectAllTransports(selectAll) {
  const checkboxes = document.querySelectorAll('.filter-net-checkbox');
  selectedNetFilters.clear();
  checkboxes.forEach(cb => {
    cb.checked = selectAll;
    if (selectAll) selectedNetFilters.add(cb.value);
  });
  saveNetFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function saveNetFilters() {
  try {
    localStorage.setItem('xkeen_connections_net_filters', JSON.stringify(Array.from(selectedNetFilters)));
  } catch (e) {}
}

function updateFilterDropdownUi() {
  document.querySelectorAll('.filter-proto-checkbox').forEach(cb => {
    cb.checked = selectedProtoFilters.has(cb.value);
  });
  document.querySelectorAll('.filter-net-checkbox').forEach(cb => {
    cb.checked = selectedNetFilters.has(cb.value);
  });

  const btn = document.getElementById('btn-filter-dropdown');
  const labelEl = document.getElementById('filter-dropdown-label');
  const countBadge = document.getElementById('filter-selected-count');
  const totalCount = selectedProtoFilters.size + selectedNetFilters.size;

  if (labelEl) labelEl.textContent = 'Фильтры';

  if (totalCount === 0) {
    if (countBadge) {
      countBadge.textContent = '0';
      countBadge.classList.add('hidden');
    }
    if (btn) btn.classList.remove('filter-active');
  } else {
    if (countBadge) {
      countBadge.textContent = String(totalCount);
      countBadge.classList.remove('hidden');
    }
    if (btn) btn.classList.add('filter-active');
  }

  const btnReset = document.getElementById('btn-reset-filters');
  if (btnReset) {
    const isFilterActive = (totalCount > 0 || currentSort !== 'default');
    btnReset.classList.toggle('hidden', !isFilterActive);
  }
}

// Backward-compatibility wrappers
function updateProtoDropdownUi() {
  updateFilterDropdownUi();
}

function updateNetDropdownUi() {
  updateFilterDropdownUi();
}

function matchesSelectedProtocols(conn) {
  if (selectedProtoFilters.size === 0) return true;
  return selectedProtoFilters.has(getConnectionProtocol(conn));
}

function matchesSelectedTransports(conn) {
  if (selectedNetFilters.size === 0) return true;
  const net = getConnectionTransport(conn);
  for (const filterVal of selectedNetFilters) {
    if (filterVal === 'ws' && (net === 'ws' || net === 'websocket')) return true;
    if (filterVal === 'h2' && (net === 'h2' || net === 'http2')) return true;
    if (filterVal === 'xhttp' && (net === 'xhttp' || net === 'splithttp')) return true;
    if (net === filterVal) return true;
  }
  return false;
}

// Backward-compatibility wrappers
function matchesProtocolFilter(conn, filterVal) {
  if (!filterVal || filterVal === 'all') return true;
  return getConnectionProtocol(conn) === filterVal;
}

function matchesTransportFilter(conn, filterVal) {
  if (!filterVal || filterVal === 'all') return true;
  const net = getConnectionTransport(conn);
  if (filterVal === 'ws') return net === 'ws' || net === 'websocket';
  if (filterVal === 'h2') return net === 'h2' || net === 'http2';
  return net === filterVal;
}

function onProtoFilterChange(val) {
  selectedProtoFilters.clear();
  if (val && val !== 'all') selectedProtoFilters.add(val);
  saveProtoFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function onNetFilterChange(val) {
  selectedNetFilters.clear();
  if (val && val !== 'all') selectedNetFilters.add(val);
  saveNetFilters();
  updateFilterDropdownUi();
  renderConnections();
}

function resetConnectionsFilters() {
  selectedProtoFilters.clear();
  selectedNetFilters.clear();
  currentSort = 'default';
  try {
    localStorage.setItem('xkeen_connections_sort', 'default');
  } catch (e) {}
  saveProtoFilters();
  saveNetFilters();
  updateSortDropdownUi();
  updateFilterDropdownUi();
  renderConnections();
}

// Group Pagination Helpers
function showMoreGroupConns(groupId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const scrollPos = window.scrollY;
  const cur = groupRenderLimits.get(groupId) || 50;
  groupRenderLimits.set(groupId, cur + 50);
  renderConnections();
  window.scrollTo({ top: scrollPos, behavior: 'instant' });
}

function showAllGroupConns(groupId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const scrollPos = window.scrollY;
  groupRenderLimits.set(groupId, Infinity);
  renderConnections();
  window.scrollTo({ top: scrollPos, behavior: 'instant' });
}

function renderConnections() {
  if (!connectionsGrid) return;
  const rawList = appData.connections || [];
  const activeId = appData.settings ? appData.settings.activeConnectionId : null;
  const groups = (appData.groups && appData.groups.length > 0)
    ? appData.groups
    : [{ id: 'group_default', name: 'Общие' }];

  // Sync dropdown controls
  updateSortDropdownUi();
  updateProtoDropdownUi();
  updateNetDropdownUi();

  const isFilterActive = (selectedProtoFilters.size > 0 || selectedNetFilters.size > 0 || currentSort !== 'default');
  const btnReset = document.getElementById('btn-reset-filters');
  if (btnReset) btnReset.classList.toggle('hidden', !isFilterActive);

  // Precompute routings list once to avoid repeated array allocations
  const allRoutingsList = [
    ...(appData.routings || []).filter(r => !r.isSystem),
    ...(appData.routings || []).filter(r => r.isSystem)
  ];

  if (rawList.length === 0) {
    if (connectionsCount) connectionsCount.textContent = '0';
    if (connectionsBadge) connectionsBadge.textContent = '0';
    connectionsGrid.innerHTML = '';
    if (emptyConnectionsState) emptyConnectionsState.classList.remove('hidden');
    return;
  }

  if (emptyConnectionsState) emptyConnectionsState.classList.add('hidden');

  const list = getSortedConnections(rawList, activeId);
  const filteredList = (selectedProtoFilters.size > 0 || selectedNetFilters.size > 0)
    ? list.filter(c => matchesSelectedProtocols(c) && matchesSelectedTransports(c))
    : list;

  if (connectionsCount) {
    connectionsCount.textContent = isFilterActive ? `${filteredList.length} / ${rawList.length}` : rawList.length;
  }
  if (connectionsBadge) {
    connectionsBadge.textContent = filteredList.length;
  }

  const favorites = filteredList.filter(c => c.isFavorite);

  let html = '';

  // 1. Favorites section at top (if any)
  if (favorites.length > 0) {
    const favAvailable = favorites.filter(c => c.lastPingStatus === 'ok' && c.lastPing !== null).length;
    const isFavPinging = isPingingFavorites || (isPingingAll && favorites.some(c => pingingConnectionIds.has(c.id)));
    html += `
      <div class="favorites-container">
        <div class="section-group-divider favorites-divider">
          <div class="favorites-header-left">
            <span class="star-icon">⭐</span>
            <span>Избранные подключения</span>
            <span class="group-count" title="Доступно: ${favAvailable} из ${favorites.length} подключений"><span class="count-available ${favAvailable > 0 ? 'has-online' : 'no-online'}">● ${favAvailable}</span> / <span class="count-total">${favorites.length}</span></span>
          </div>
          <div class="favorites-actions" onclick="event.stopPropagation()">
            ${isFavPinging ? `
              <button class="btn-group-action btn-group-ping is-loading" disabled title="Выполняется проверка избранных подключений...">
                <span class="group-spinner-circle"></span>
              </button>
            ` : `
              <button class="btn-group-action btn-group-ping" id="btn-ping-favorites" onclick="pingFavoritesConnections(event)" title="Проверить доступность всех избранных подключений">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </button>
            `}
          </div>
        </div>
        <div class="connections-subgrid">
          ${sortConnsAvailability(favorites).map(c => renderConnectionCardHtml(c, activeId, true, null, allRoutingsList)).join('')}
        </div>
      </div>
    `;
  }

  // 2. Groups Accordions
  html += `<div class="groups-container">`;
  groups.forEach((g, gIdx) => {
    const unfilteredGroupConns = list.filter(c => (c.groupId || 'group_default') === g.id);
    const groupConns = filteredList.filter(c => (c.groupId || 'group_default') === g.id);
    const totalCount = unfilteredGroupConns.length;
    const availableCount = unfilteredGroupConns.filter(c => c.lastPingStatus === 'ok' && c.lastPing !== null).length;
    const isCollapsed = collapsedGroupIds.has(g.id);
    const isSub = Boolean(g.isSubscription);
    const isPingingGroup = pingingGroupIds.has(g.id) || (isPingingAll && unfilteredGroupConns.some(c => pingingConnectionIds.has(c.id)));
    const isUpdatingSub = updatingSubscriptionIds.has(g.id);

    const sortedGroupConns = sortConnsAvailability(groupConns);
    const shouldHideUnreachable = isSub && (g.hideUnreachable !== false);
    const isTemporarilyRevealed = revealedHiddenGroupIds.has(g.id);
    let displayedConns = sortedGroupConns;
    let hiddenUnreachableCount = 0;
    if (shouldHideUnreachable && !isTemporarilyRevealed) {
      displayedConns = sortedGroupConns.filter(c => {
        if (c.lastPingStatus === 'unreachable' && c.id !== activeId) {
          hiddenUnreachableCount++;
          return false;
        }
        return true;
      });
    } else if (shouldHideUnreachable && isTemporarilyRevealed) {
      hiddenUnreachableCount = sortedGroupConns.filter(c => c.lastPingStatus === 'unreachable' && c.id !== activeId).length;
    }

    const targetClass = (g.targetList === 'whitelist') ? 'bs' : ((g.targetList === 'blacklist') ? 'cs' : 'sm');
    const targetText = (g.targetList === 'whitelist') ? 'БС' : ((g.targetList === 'blacklist') ? 'ЧС' : 'СМ');
    const targetTitle = (g.targetList === 'whitelist') ? 'Белые списки (БС)' : ((g.targetList === 'blacklist') ? 'Черные списки (ЧС)' : 'Смешанная группа (СМ)');
    const groupTargetBadgeHtml = `<span class="group-target-badge ${targetClass}" title="Тип: ${targetTitle}">${targetText}</span>`;

    let subInfoHtml = '';
    if (isSub) {
      let trafficText = '';
      if (g.userInfo && (g.userInfo.download || g.userInfo.upload || g.userInfo.total)) {
        const used = (g.userInfo.download || 0) + (g.userInfo.upload || 0);
        const total = g.userInfo.total || 0;
        trafficText = total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : formatBytes(used);
      }
      let expireText = '';
      if (g.userInfo && g.userInfo.expire) {
        const expDate = new Date(g.userInfo.expire * 1000);
        expireText = expDate.toLocaleDateString();
      }

      subInfoHtml = `
        <span class="group-sub-badge" title="Группа создана из удаленной подписки">Подписка</span>
        ${trafficText ? `<span class="group-traffic-badge" title="Трафик подписки">📊 ${escapeHtml(trafficText)}</span>` : ''}
        ${expireText ? `<span class="group-expire-badge" title="Истекает">⏳ до ${escapeHtml(expireText)}</span>` : ''}
      `;
    }

    let hiddenNoticeHtml = '';
    if (hiddenUnreachableCount > 0) {
      const toggleLabel = isTemporarilyRevealed ? 'Скрыть обратно' : 'Показать';
      hiddenNoticeHtml = `
        <div class="group-hidden-notice">
          <span>Скрыто недоступных: <strong>${hiddenUnreachableCount}</strong></span>
          <button type="button" class="btn-group-show-hidden" onclick="toggleShowHiddenForGroup('${g.id}', event)">
            ${toggleLabel}
          </button>
        </div>
      `;
    }

    let bodyContentHtml = '';
    if (isCollapsed) {
      // Lazy render: skip building card DOM for collapsed groups to prevent UI lag on large lists
      bodyContentHtml = `<div class="connections-subgrid lazy-subgrid" id="subgrid-${g.id}"></div>`;
    } else if (displayedConns.length > 0) {
      const renderLimit = groupRenderLimits.get(g.id) || 50;
      const visibleConns = displayedConns.slice(0, renderLimit);
      const hasMore = displayedConns.length > renderLimit;

      let paginationHtml = '';
      if (hasMore) {
        paginationHtml = `
          <div class="subgrid-pagination-bar">
            <span class="pagination-info">Показано ${visibleConns.length} из ${displayedConns.length} подключений</span>
            <div class="pagination-buttons">
              <button type="button" class="btn btn-secondary btn-sm" onclick="showMoreGroupConns('${g.id}', event)">
                <span>Показать ещё (+50)</span>
              </button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="showAllGroupConns('${g.id}', event)">
                <span>Показать все (${displayedConns.length})</span>
              </button>
            </div>
          </div>
        `;
      }

      bodyContentHtml = `
        <div class="connections-subgrid" id="subgrid-${g.id}">
          ${visibleConns.map(c => renderConnectionCardHtml(c, activeId, false, g, allRoutingsList)).join('')}
        </div>
        ${paginationHtml}
      `;
    } else if (groupConns.length > 0) {
      const showBtnLabel = isTemporarilyRevealed ? 'Скрыть обратно' : ('Показать недоступные (' + hiddenUnreachableCount + ')');
      bodyContentHtml = `
        <div class="group-empty-state">
          <span>Все подключения (${totalCount}) недоступны и скрыты настройкой</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="toggleShowHiddenForGroup('${g.id}', event)">
            <span>${showBtnLabel}</span>
          </button>
        </div>
      `;
    } else if (unfilteredGroupConns.length > 0 && isFilterActive) {
      bodyContentHtml = `
        <div class="group-empty-state">
          <span>Нет подключений, соответствующих выбранным фильтрам (${unfilteredGroupConns.length} скрыто)</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="resetConnectionsFilters()">
            <span>Сбросить фильтры</span>
          </button>
        </div>
      `;
    } else {
      bodyContentHtml = `
        <div class="group-empty-state">
          <span>${isSub ? 'В этой подписке пока нет подключений' : 'В этой группе пока нет подключений'}</span>
          ${isSub ? `
            <button type="button" class="btn btn-secondary btn-sm" onclick="updateSubscription('${g.id}', event)">Загрузить ссылки</button>
          ` : `
            <button type="button" class="btn btn-secondary btn-sm" onclick="openAddConnectionModal('${g.id}')">Добавить подключение</button>
          `}
        </div>
      `;
    }

    const countBadgeTitle = isFilterActive
      ? `Отфильтровано: ${groupConns.length} из ${totalCount} (доступно: ${availableCount})`
      : `Доступно: ${availableCount} из ${totalCount} подключений`;
    const countBadgeContent = isFilterActive
      ? `<span class="count-available ${availableCount > 0 ? 'has-online' : 'no-online'}">● ${availableCount}</span> / <span class="count-total">${groupConns.length} (${totalCount})</span>`
      : `<span class="count-available ${availableCount > 0 ? 'has-online' : 'no-online'}">● ${availableCount}</span> / <span class="count-total">${totalCount}</span>`;

    html += `
      <div class="group-accordion-card ${isSub ? 'subscription-group-card' : ''} ${isCollapsed ? 'collapsed' : ''}" id="group-card-${g.id}">
        <div class="group-header" onclick="toggleGroupCollapse('${g.id}')">
          <div class="group-header-left">
            <span class="group-toggle-arrow ${isCollapsed ? '' : 'expanded'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
            <span class="group-icon">${isSub ? '🌐' : '📁'}</span>
            <span class="group-name">${escapeHtml(g.name)}</span>
            ${groupTargetBadgeHtml}
            ${subInfoHtml}
            ${isSub && g.autoUpdateHours > 0 ? `<span class="group-autoupdate-badge" title="Автообновление каждые ${g.autoUpdateHours} ч">🔄 ${g.autoUpdateHours}ч</span>` : ''}
            <span class="group-count-badge" title="${escapeHtml(countBadgeTitle)}">${countBadgeContent}</span>
          </div>
          <div class="group-actions" onclick="event.stopPropagation()">
            <!-- Group Move Up / Down -->
            <button class="btn-group-action btn-group-move" onclick="moveGroup('${g.id}', -1, event)" ${gIdx === 0 ? 'disabled' : ''} title="Переместить группу выше">▲</button>
            <button class="btn-group-action btn-group-move" onclick="moveGroup('${g.id}', 1, event)" ${gIdx === groups.length - 1 ? 'disabled' : ''} title="Переместить группу ниже">▼</button>

            <!-- Group Ping All -->
            ${isPingingGroup ? `
              <button class="btn-group-action btn-group-ping is-loading" disabled title="Выполняется проверка доступности подключений...">
                <span class="group-spinner-circle"></span>
              </button>
            ` : `
              <button class="btn-group-action btn-group-ping" id="btn-ping-group-${g.id}" onclick="pingGroupConnections('${g.id}', event)" title="Проверить доступность всех подключений этой группы">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </button>
            `}

            ${isSub ? `
              ${isUpdatingSub ? `
                <button class="btn-group-action btn-sub-refresh is-loading" disabled title="Обновление ссылок подписки...">
                  <span class="group-spinner-circle" style="border-top-color: #a855f7;"></span>
                </button>
              ` : `
                <button class="btn-group-action btn-sub-refresh" id="btn-refresh-sub-${g.id}" onclick="updateSubscription('${g.id}', event)" title="Обновить ссылки подписки из интернета">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
              `}
              <button class="btn-group-action" onclick="openEditSubscriptionModal('${g.id}', event)" title="Настройки подписки и назначение (ЧС/БС/СМ)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
              <button class="btn-group-action btn-group-delete" onclick="deleteSubscription('${g.id}', '${escapeJs(g.name)}', event)" title="Удалить подписку и все её подключения">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            ` : `
              <button class="btn-group-action" onclick="openAddConnectionModal('${g.id}')" title="Добавить подключение в эту группу">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <button class="btn-group-action" onclick="openRenameGroupModal('${g.id}', '${escapeJs(g.name)}')" title="Настройки группы">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
              ${g.id !== 'group_default' ? `
                <button class="btn-group-action btn-group-delete" onclick="deleteGroup('${g.id}', '${escapeJs(g.name)}')" title="Удалить группу (подключения переместятся в 'Общие')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              ` : ''}
            `}
          </div>
        </div>
        <div class="group-body ${isCollapsed ? 'hidden' : ''}" id="group-body-${g.id}">
          ${hiddenNoticeHtml}
          ${bodyContentHtml}
        </div>
      </div>
    `;
  });
  html += `</div>`;

  connectionsGrid.innerHTML = html;
}

// Render Routings Grid
function renderRoutings() {
  if (!routingsGrid) return;
  const rawList = appData.routings || [];
  const list = [
    ...rawList.filter(r => !r.isSystem),
    ...rawList.filter(r => r.isSystem)
  ];

  if (routingsCount) routingsCount.textContent = list.length;
  if (routingsBadge) routingsBadge.textContent = list.length;

  routingsGrid.innerHTML = list.map(routing => {
    const isDefBlacklist = (appData.settings?.defaultRoutingBlacklist === routing.id);
    const isDefWhitelist = (appData.settings?.defaultRoutingWhitelist === routing.id);

    return `
      <div class="routing-card glass-card ${routing.isSystem ? 'system-routing' : ''}">
        <div>
          <div class="routing-header">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <h3 class="routing-title">${escapeHtml(routing.name)}</h3>
              ${routing.isSystem ? `<span class="routing-system-badge">🔒 Защищен</span>` : ''}
            </div>
            <div class="routing-badges-row">
              ${isDefBlacklist ? `<span class="routing-default-badge badge-blacklist" title="Маршрутизация по умолчанию для Черных списков (ЧС)">ЧС по умолчанию</span>` : ''}
              ${isDefWhitelist ? `<span class="routing-default-badge badge-whitelist" title="Маршрутизация по умолчанию для Белых списков (БС)">БС по умолчанию</span>` : ''}
            </div>
          </div>

          <p class="routing-desc">${escapeHtml(routing.description || 'Без описания')}</p>

          ${routing.isSystem ? `
            <div class="routing-meta-row">
              <span class="import-zip-hint">Нельзя изменить или удалить</span>
            </div>
          ` : ''}
        </div>

        <div class="routing-card-footer">
          <div></div>
          <div class="conn-footer-actions">
            <button class="btn btn-secondary btn-sm btn-icon" onclick="openRoutingModal('${routing.id}')" title="${routing.isSystem ? 'Просмотр конфигурации JSON' : 'Редактировать routing.json'}">
              ${routing.isSystem ? `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              ` : `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              `}
            </button>

            ${!routing.isSystem ? `
              <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRouting('${routing.id}', '${escapeJs(routing.name)}')" title="Удалить маршрутизацию">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Populate routing select dropdowns in modals
function populateRoutingSelects() {
  const rawList = appData.routings || [];
  const list = [
    ...rawList.filter(r => !r.isSystem),
    ...rawList.filter(r => r.isSystem)
  ];
  const optionsHtml = list.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  const addSel = document.getElementById('conn-routing');
  if (addSel) addSel.innerHTML = optionsHtml;

  const editSel = document.getElementById('edit-conn-routing');
  if (editSel) editSel.innerHTML = optionsHtml;

  const batchSel = document.getElementById('batch-routing-select');
  if (batchSel) batchSel.innerHTML = optionsHtml;

  const subSel = document.getElementById('sub-routing');
  if (subSel) subSel.innerHTML = optionsHtml;

  const addSubSel = document.getElementById('add-sub-routing');
  if (addSubSel) addSubSel.innerHTML = optionsHtml;
}

// Populate group select dropdowns in modals
function populateGroupSelects(selectedGroupId = null) {
  const groups = (appData.groups && appData.groups.length > 0)
    ? appData.groups
    : [{ id: 'group_default', name: 'Общие' }];

  const allOptionsHtml = groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}${g.isSubscription ? ' (Подписка)' : ''}</option>`).join('');
  const nonSubGroups = groups.filter(g => !g.isSubscription);
  const nonSubOptionsHtml = (nonSubGroups.length > 0 ? nonSubGroups : groups).map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');

  const addGroupSel = document.getElementById('conn-group');
  if (addGroupSel) {
    const cur = selectedGroupId || addGroupSel.value || 'group_default';
    addGroupSel.innerHTML = nonSubOptionsHtml;
    addGroupSel.value = groups.some(g => !g.isSubscription && g.id === cur) ? cur : (nonSubGroups[0]?.id || 'group_default');
  }

  const editGroupSel = document.getElementById('edit-conn-group');
  if (editGroupSel) {
    const cur = selectedGroupId || editGroupSel.value || 'group_default';
    editGroupSel.innerHTML = allOptionsHtml;
    editGroupSel.value = groups.some(g => g.id === cur) ? cur : groups[0].id;
  }

  const batchGroupSel = document.getElementById('batch-group-select');
  if (batchGroupSel) {
    batchGroupSel.innerHTML = nonSubOptionsHtml;
  }

  const moveCopySel = document.getElementById('move-copy-target-group');
  if (moveCopySel) {
    moveCopySel.innerHTML = nonSubOptionsHtml;
  }
}

// ==============================================================================
// VLESS URL PARSER (CLIENT-SIDE)
// ==============================================================================
// Safely decode Base64 in browser supporting UTF-8 and URL-safe chars
function decodeBase64SafeClient(str) {
  if (!str || typeof str !== 'string') return '';
  let clean = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (clean.length % 4 !== 0) {
    clean += '=';
  }
  try {
    const binStr = window.atob(clean);
    const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    try {
      return decodeURIComponent(escape(window.atob(clean)));
    } catch (e2) {
      return '';
    }
  }
}

// Toggle Protocol Cheat Sheet
function toggleProtocolGuide() {
  const panel = document.getElementById('protocol-guide-panel');
  if (panel) panel.classList.toggle('hidden');
}

// Toggle JSON Templates dropdown menu
function toggleTemplateMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('dropdown-templates-menu');
  if (menu) menu.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('dropdown-templates-menu');
  if (menu && !menu.classList.contains('hidden')) {
    if (!e.target.closest('.dropdown-templates-wrap')) {
      menu.classList.add('hidden');
    }
  }
});

// JSON Outbound Templates
const OUTBOUND_TEMPLATES = {
  'vless-reality-tcp': {
    name: 'VLESS Reality (TCP)',
    protocol: 'vless',
    network: 'tcp',
    security: 'reality',
    outboundJson: {
      outbounds: [
        {
          tag: 'vless-reality',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: '1.2.3.4',
                port: 443,
                users: [
                  {
                    id: '00000000-0000-0000-0000-000000000000',
                    flow: 'xtls-rprx-vision',
                    encryption: 'none',
                    level: 0
                  }
                ]
              }
            ]
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              serverName: 'yahoo.com',
              fingerprint: 'chrome',
              publicKey: 'PASTE_PUBLIC_KEY_HERE',
              shortId: 'PASTE_SHORT_ID_HERE',
              spiderX: '/'
            }
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'vless-reality-grpc': {
    name: 'VLESS Reality (gRPC)',
    protocol: 'vless',
    network: 'grpc',
    security: 'reality',
    outboundJson: {
      outbounds: [
        {
          tag: 'vless-reality-grpc',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: '1.2.3.4',
                port: 443,
                users: [
                  {
                    id: '00000000-0000-0000-0000-000000000000',
                    encryption: 'none',
                    level: 0
                  }
                ]
              }
            ]
          },
          streamSettings: {
            network: 'grpc',
            security: 'reality',
            realitySettings: {
              serverName: 'dl.google.com',
              fingerprint: 'chrome',
              publicKey: 'PASTE_PUBLIC_KEY_HERE',
              shortId: 'PASTE_SHORT_ID_HERE',
              spiderX: '/'
            },
            grpcSettings: {
              serviceName: 'grpc-service',
              multiMode: false
            }
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'vless-ws-tls': {
    name: 'VLESS WebSocket (TLS)',
    protocol: 'vless',
    network: 'ws',
    security: 'tls',
    outboundJson: {
      outbounds: [
        {
          tag: 'vless-ws-tls',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: 'example.com',
                port: 443,
                users: [
                  {
                    id: '00000000-0000-0000-0000-000000000000',
                    encryption: 'none',
                    level: 0
                  }
                ]
              }
            ]
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            tlsSettings: {
              serverName: 'example.com',
              fingerprint: 'chrome'
            },
            wsSettings: {
              path: '/vless-ws',
              headers: {
                Host: 'example.com'
              }
            }
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'vmess-ws-tls': {
    name: 'VMess WebSocket (TLS)',
    protocol: 'vmess',
    network: 'ws',
    security: 'tls',
    outboundJson: {
      outbounds: [
        {
          tag: 'vmess-ws-tls',
          protocol: 'vmess',
          settings: {
            vnext: [
              {
                address: 'example.com',
                port: 443,
                users: [
                  {
                    id: '00000000-0000-0000-0000-000000000000',
                    alterId: 0,
                    security: 'auto',
                    level: 0
                  }
                ]
              }
            ]
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            tlsSettings: {
              serverName: 'example.com'
            },
            wsSettings: {
              path: '/vmess-ws',
              headers: {
                Host: 'example.com'
              }
            }
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'trojan-tls': {
    name: 'Trojan (TLS)',
    protocol: 'trojan',
    network: 'tcp',
    security: 'tls',
    outboundJson: {
      outbounds: [
        {
          tag: 'trojan-tls',
          protocol: 'trojan',
          settings: {
            servers: [
              {
                address: 'example.com',
                port: 443,
                password: 'YOUR_PASSWORD_HERE',
                level: 0
              }
            ]
          },
          streamSettings: {
            network: 'tcp',
            security: 'tls',
            tlsSettings: {
              serverName: 'example.com',
              fingerprint: 'chrome'
            }
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'shadowsocks': {
    name: 'Shadowsocks (AEAD)',
    protocol: 'shadowsocks',
    network: 'tcp',
    security: 'aes-256-gcm',
    outboundJson: {
      outbounds: [
        {
          tag: 'shadowsocks',
          protocol: 'shadowsocks',
          settings: {
            servers: [
              {
                address: '1.2.3.4',
                port: 8388,
                method: 'aes-256-gcm',
                password: 'YOUR_PASSWORD_HERE',
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
    }
  },
  'wireguard': {
    name: 'WireGuard',
    protocol: 'wireguard',
    network: 'udp',
    security: 'WG',
    outboundJson: {
      outbounds: [
        {
          tag: 'wireguard',
          protocol: 'wireguard',
          settings: {
            secretKey: 'PRIVATE_KEY_HERE',
            address: ['10.0.0.2/32'],
            peers: [
              {
                publicKey: 'SERVER_PUBLIC_KEY_HERE',
                endpoint: '1.2.3.4:51820',
                allowedIPs: ['0.0.0.0/0', '::/0']
              }
            ],
            mtu: 1420
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  },
  'amneziawg': {
    name: 'AmneziaWG (Mihomo)',
    protocol: 'wireguard',
    network: 'udp',
    security: 'Amnezia',
    outboundJson: {
      outbounds: [
        {
          tag: 'amneziawg',
          protocol: 'wireguard',
          settings: {
            secretKey: 'PRIVATE_KEY_HERE',
            address: ['10.0.0.2/32'],
            peers: [
              {
                publicKey: 'SERVER_PUBLIC_KEY_HERE',
                endpoint: '1.2.3.4:51820',
                allowedIPs: ['0.0.0.0/0', '::/0']
              }
            ],
            mtu: 1420
          }
        },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
      ]
    }
  }
};

function insertOutboundTemplate(tplKey) {
  const tpl = OUTBOUND_TEMPLATES[tplKey];
  if (!tpl) return;

  const jsonStr = JSON.stringify(tpl.outboundJson, null, 4);
  setEditorContent('conn-outbound-json', jsonStr);

  const nameInput = document.getElementById('conn-name');
  if (nameInput && (!nameInput.value || nameInput.value.startsWith('Шаблон'))) {
    nameInput.value = `Шаблон ${tpl.name}`;
  }

  // Update preview pills
  const hostEl = document.getElementById('preview-host');
  const portEl = document.getElementById('preview-port');
  const protoEl = document.getElementById('preview-proto');
  const netEl = document.getElementById('preview-net');
  const secEl = document.getElementById('preview-sec');
  const sniWrap = document.getElementById('preview-sni-wrap');

  if (hostEl) hostEl.textContent = '1.2.3.4';
  if (portEl) portEl.textContent = '443';
  if (protoEl) protoEl.textContent = tpl.protocol.toUpperCase();
  if (netEl) netEl.textContent = formatNetworkName(tpl.network);
  if (secEl) secEl.textContent = tpl.security;
  if (sniWrap) sniWrap.classList.add('hidden');
  document.getElementById('add-meta-preview').classList.remove('hidden');

  const menu = document.getElementById('dropdown-templates-menu');
  if (menu) menu.classList.add('hidden');

  showToast(`Вставлен шаблон: ${tpl.name}. Заполните ваши IP, порт и ключи!`, 'info');
}

let currentAddAmneziaConfig = null;

// Highlight detected protocol pill in add connection modal
function highlightDetectedProtocol(protoKey) {
  const container = document.getElementById('add-modal-proto-pills');
  if (!container) return;
  const pills = container.querySelectorAll('.proto-pill');

  if (!protoKey) {
    pills.forEach(pill => {
      pill.classList.remove('selected', 'dimmed');
    });
    return;
  }

  const normalized = String(protoKey).toLowerCase();
  let matchedProto = null;
  if (normalized === 'vless') matchedProto = 'vless';
  else if (normalized === 'vmess') matchedProto = 'vmess';
  else if (normalized === 'trojan') matchedProto = 'trojan';
  else if (normalized === 'shadowsocks' || normalized === 'ss') matchedProto = 'shadowsocks';
  else if (normalized === 'amneziawg' || normalized === 'awg' || normalized === 'vpn') matchedProto = 'amneziawg';
  else if (normalized === 'wireguard' || normalized === 'wg') matchedProto = 'wireguard';
  else if (normalized === 'hysteria2' || normalized === 'hy2') matchedProto = 'hysteria2';

  pills.forEach(pill => {
    if (matchedProto && pill.getAttribute('data-proto') === matchedProto) {
      pill.classList.add('selected');
      pill.classList.remove('dimmed');
    } else {
      pill.classList.remove('selected');
      if (matchedProto) {
        pill.classList.add('dimmed');
      } else {
        pill.classList.remove('dimmed');
      }
    }
  });
}

// Universal Client-side Proxy URL & Config Parser
async function parseProxyUrlInput(showNotice = true) {
  const input = document.getElementById('input-vless-url');
  if (!input || !input.value.trim()) {
    highlightDetectedProtocol(null);
    document.getElementById('add-meta-preview')?.classList.add('hidden');
    return;
  }

  const rawUrl = input.value.trim();
  currentAddAmneziaConfig = null;

  try {
    let result = null;

    // 1. Try server-side parser first for maximum compatibility across all protocols
    try {
      const res = await fetch('/api/connections/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl })
      });
      if (res.ok) {
        result = await res.json();
        currentAddAmneziaConfig = result.amneziaConfig || null;
      }
    } catch (apiErr) {}

    // 2. Client-side fallback if server is unreachable or returned error
    if (!result) {
      if (rawUrl.startsWith('vpn://') || (rawUrl.includes('[Interface]') && (rawUrl.includes('Jc') || rawUrl.includes('jc') || rawUrl.includes('H1') || rawUrl.includes('h1')))) {
        throw new Error('Ссылки Amnezia требуют связи с сервером');
      } else if (rawUrl.includes('[Interface]') || rawUrl.includes('[Peer]')) {
        result = parseWireguardConfigClient(rawUrl);
      } else if (rawUrl.startsWith('vless://')) {
        result = parseVlessClient(rawUrl);
      } else if (rawUrl.startsWith('vmess://')) {
        result = parseVmessClient(rawUrl);
      } else if (rawUrl.startsWith('trojan://')) {
        result = parseTrojanClient(rawUrl);
      } else if (rawUrl.startsWith('ss://')) {
        result = parseShadowsocksClient(rawUrl);
      } else if (rawUrl.startsWith('wireguard://') || rawUrl.startsWith('awg://')) {
        result = parseWireguardUrlClient(rawUrl);
      } else if (rawUrl.startsWith('hysteria2://') || rawUrl.startsWith('hy2://')) {
        result = parseHysteria2Client(rawUrl);
      } else {
        highlightDetectedProtocol(null);
        if (showNotice) showToast('Неизвестный протокол. Вставьте vless://, vmess://, vpn://, trojan://, ss://, wireguard://, awg:// или конфиг [Interface]', 'warning');
        return;
      }
    }

    if (!result) {
      highlightDetectedProtocol(null);
      return;
    }

    // Populate Fields
    const nameInput = document.getElementById('conn-name');
    if (nameInput && result.name) {
      nameInput.value = result.name;
    }
    document.getElementById('conn-desc').value = result.desc || '';
    setEditorContent('conn-outbound-json', result.outboundJson);

    // Show Preview Pills
    document.getElementById('preview-host').textContent = result.serverAddress || '-';
    document.getElementById('preview-port').textContent = result.serverPort || '-';
    const isAwg = result.protocol === 'amneziawg' || result.protocol === 'awg' || Boolean(result.amneziaConfig);
    const isHy2 = result.protocol === 'hysteria2' || result.protocol === 'hy2';
    document.getElementById('preview-proto').textContent = isAwg ? 'AWG' : (isHy2 ? 'HY2' : (result.protocol || 'VLESS').toUpperCase());
    const previewNetEl = document.getElementById('preview-net');
    if (previewNetEl) previewNetEl.textContent = formatNetworkName(result.network || (isAwg || isHy2 ? 'udp' : 'tcp'));
    document.getElementById('preview-sec').textContent = isAwg ? 'Amnezia' : (isHy2 ? 'TLS (QUIC)' : (result.security === 'reality' ? 'Reality' : (result.security || 'None')));
    const sniWrap = document.getElementById('preview-sni-wrap');
    if (result.sni) {
      document.getElementById('preview-sni').textContent = result.sni;
      sniWrap.classList.remove('hidden');
    } else {
      sniWrap.classList.add('hidden');
    }
    document.getElementById('add-meta-preview').classList.remove('hidden');

    // Highlight detected protocol pill in real-time
    highlightDetectedProtocol(isAwg ? 'amneziawg' : (isHy2 ? 'hysteria2' : result.protocol));

    let noticeText = `Ссылка ${result.protocol.toUpperCase()} успешно распознана!`;
    let toastType = 'success';
    if (isAwg) {
      noticeText = 'Ссылка Amnezia AWG успешно распознана! Для проксирования будет использовано ядро Mihomo.';
    } else if (isHy2) {
      if (result.hasPassword === false) {
        noticeText = 'Hysteria 2 распознана, но в ссылке нет пароля (перед @). Сервер отклонит подключение.';
        toastType = 'warning';
      } else {
        noticeText = 'Ссылка Hysteria 2 успешно распознана! Для проксирования будет использовано ядро Mihomo.';
      }
    }
    if (showNotice) showToast(noticeText, toastType);
  } catch (err) {
    if (showNotice) showToast('Ошибка разбора ссылки: ' + err.message, 'error');
  }
}

// Multi-layer URI decoder (handles nested encoding like %25F0 -> %F0 -> emoji)
function safeDecodeUriMulti(str) {
  if (!str) return '';
  let cur = String(str);
  for (let i = 0; i < 4; i++) {
    try {
      const decoded = decodeURIComponent(cur);
      if (decoded === cur) break;
      cur = decoded;
    } catch (e) {
      break;
    }
  }
  return cur;
}

// Backwards-compatible alias
function parseVlessUrlInput(showNotice = true) {
  return parseProxyUrlInput(showNotice);
}

// VLESS Client Parser
function parseVlessClient(rawUrl) {
  const u = new URL(rawUrl);
  const id = u.username;
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10);
  if (!id || !address || !port) {
    throw new Error('Некорректная ссылка: нет UUID, адреса или порта');
  }

  let name = safeDecodeUriMulti(u.hash ? u.hash.replace(/^#/, '') : '').trim();
  if (!name) name = `VLESS - ${address}:${port}`;

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
  try { spx = decodeURIComponent(sp.get('spx') || '/'); } catch(e) { spx = sp.get('spx') || '/'; }
  const serviceName = sp.get('serviceName') || sp.get('service_name') || '';

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
    try { wsPath = decodeURIComponent(sp.get('path') || '/'); } catch(e) { wsPath = sp.get('path') || '/'; }
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
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
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

// VMess Client Parser
function parseVmessClient(rawUrl) {
  const rest = rawUrl.replace(/^vmess:\/\//i, '').trim();
  let conf;
  if (rest.startsWith('{')) {
    conf = JSON.parse(rest);
  } else {
    const decoded = decodeBase64SafeClient(rest);
    try {
      conf = JSON.parse(decoded);
    } catch (e) {
      throw new Error('Ошибка декодирования VMess: ' + e.message);
    }
  }

  const address = (conf.add || conf.host || '').replace(/^\[|\]$/g, '');
  const port = parseInt(conf.port, 10);
  const id = conf.id || '';
  if (!address || !port || !id) throw new Error('В ссылке VMess нет адреса, порта или UUID');

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
      headers: { Host: conf.host || sni }
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

  const outboundJsonObj = {
    outbounds: [
      {
        tag: security === 'tls' ? 'vmess-tls' : 'vmess',
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

// Trojan Client Parser
function parseTrojanClient(rawUrl) {
  let str = (rawUrl || '').trim();
  if (str.startsWith('trojan://')) str = str.substring(9);

  let rawName = '';
  if (str.includes('#')) {
    const parts = str.split('#');
    str = parts[0];
    try { rawName = safeDecodeUriMulti(parts.slice(1).join('#')).trim(); } catch (e) { rawName = parts.slice(1).join('#').trim(); }
  }

  // Handle base64 encoded trojan body if present
  if (!str.includes('@') && !str.includes('?')) {
    try {
      const decoded = atob(str);
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
    throw new Error('Некорректная ссылка Trojan: не удалось извлечь пароль или адрес сервера');
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
      headers: { Host: sp.get('host') || sni }
    };
  } else if (type === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: sp.get('serviceName') || sp.get('service_name') || ''
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

// Shadowsocks Client Parser
function parseShadowsocksClient(rawUrl) {
  let hashPart = '';
  let urlWithoutHash = rawUrl;
  if (rawUrl.includes('#')) {
    const p = rawUrl.split('#');
    urlWithoutHash = p[0];
    hashPart = p.slice(1).join('#');
  }
  let name = safeDecodeUriMulti(hashPart).trim();

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
      const d = decodeBase64SafeClient(userPart);
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
    const decoded = decodeBase64SafeClient(rest.split('/')[0].split('?')[0]);
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

  if (!address || !port || !method) throw new Error('Не удалось извлечь адрес, порт или шифр Shadowsocks');
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
        streamSettings: { network: 'tcp' }
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

// WireGuard / AmneziaWG Config Text Parser
function parseWireguardConfigClient(confText) {
  let normalizedText = confText || '';
  if (!normalizedText.includes('\n') && (normalizedText.includes('[Interface]') || normalizedText.includes('[Peer]'))) {
    normalizedText = normalizedText
      .replace(/\s*(\[(?:Interface|Peer)\])\s*/gi, '\n$1\n')
      .replace(/\s*(PrivateKey|PublicKey|Address|DNS|MTU|Endpoint|AllowedIPs|PresharedKey|pre-shared-key|psk|Jc|Jmin|Jmax|S1|S2|S3|S4|H1|H2|H3|H4)\s*=/gi, '\n$1=');
  }

  const lines = normalizedText.split(/\r?\n/).map(l => l.trim());
  let currentSection = '';
  const iface = {};
  const peer = {};
  let commentName = '';

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';')) {
      const c = line.replace(/^[#;]\s*/, '').trim();
      if (c && !commentName && !c.toLowerCase().startsWith('interface') && !c.toLowerCase().startsWith('peer') && !c.includes('=')) {
        commentName = c;
      }
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.substring(0, eqIdx).trim().toLowerCase().replace(/-/g, '_');
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
    throw new Error('Отсутствуют PrivateKey, PublicKey или Endpoint');
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
  const name = commentName || `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${endpointHost}:${endpointPort}`;
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
    desc: isAwg ? 'AmneziaWG (нативно поддерживается в ядре Mihomo)' : 'WireGuard VPN',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4),
    amneziaConfig
  };
}

// WireGuard / AWG URL Parser
function parseWireguardUrlClient(rawUrl) {
  const u = new URL(rawUrl);
  const privateKey = decodeURIComponent(u.username);
  const endpointHost = (u.hostname || '').replace(/^\[|\]$/g, '');
  const endpointPort = parseInt(u.port, 10) || 51820;
  const sp = u.searchParams;
  const publicKey = sp.get('publickey') || sp.get('pubkey') || '';
  const address = sp.get('address') || sp.get('ip') || '10.0.0.2/32';

  if (!privateKey || !publicKey || !endpointHost) {
    throw new Error('Отсутствуют PrivateKey, PublicKey или хост');
  }

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = safeDecodeUriMulti(rawName).trim();
  const isAwg = rawUrl.startsWith('awg://') || Boolean(sp.get('jc') || sp.get('h1'));
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
              allowedIPs: ['0.0.0.0/0', '::/0']
            }
          ],
          mtu: parseInt(sp.get('mtu'), 10) || 1420
        }
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ]
  };

  return {
    name,
    serverAddress: endpointHost,
    serverPort: endpointPort,
    protocol: isAwg ? 'amneziawg' : 'wireguard',
    network: 'udp',
    security: isAwg ? 'Amnezia' : 'WG',
    sni: '',
    desc: isAwg ? 'AmneziaWG (нативно поддерживается в ядре Mihomo)' : 'WireGuard VPN',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// Hysteria 2 Client Parser
function parseHysteria2Client(rawUrl) {
  const u = new URL(rawUrl);
  let password = '';
  try { password = safeDecodeUriMulti(u.username); } catch (e) { password = u.username || ''; }
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10) || 443;
  if (!address || !port) throw new Error('Отсутствуют адрес или порт Hysteria2');

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = safeDecodeUriMulti(rawName).trim();
  if (!name) name = `Hysteria2 - ${address}:${port}`;

  const sp = u.searchParams;
  const sni = sp.get('sni') || sp.get('peer') || address;
  const alpn = sp.get('alpn') || 'h3';
  const hasPassword = Boolean(password && password.trim());

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
            serverName: sni,
            alpn: alpn.split(',').map(s => s.trim()).filter(Boolean)
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
    hasPassword,
    desc: 'Hysteria 2 (нативно поддерживается в ядре Mihomo)',
    outboundJson: JSON.stringify(outboundJsonObj, null, 4)
  };
}

// ==============================================================================
// CONNECTION ACTIONS
// ==============================================================================

// Open Add Modal (Tabs: connection, batch, subscription, group)
function openAddConnectionModal(defaultGroupId = '', initialTab = 'connection') {
  document.getElementById('form-add-connection').reset();
  document.getElementById('add-meta-preview').classList.add('hidden');
  highlightDetectedProtocol(null);
  currentAddAmneziaConfig = null;
  populateRoutingSelects();
  populateGroupSelects(defaultGroupId || 'group_default');

  const radioBlacklist = document.querySelector('input[name="conn-target-list"][value="blacklist"]');
  if (radioBlacklist) radioBlacklist.checked = true;

  const favCb = document.getElementById('conn-is-favorite');
  if (favCb) favCb.checked = true;

  const addSel = document.getElementById('conn-routing');
  if (addSel && appData.settings?.defaultRoutingBlacklist) {
    addSel.value = appData.settings.defaultRoutingBlacklist;
  }

  setEditorContent('conn-outbound-json', '{\n    "outbounds": []\n}');

  // Reset batch import form
  const batchForm = document.getElementById('form-batch-import');
  if (batchForm) batchForm.reset();
  const batchGroupSelect = document.getElementById('batch-group-select');
  if (batchGroupSelect && defaultGroupId) {
    batchGroupSelect.value = defaultGroupId;
  }

  // Reset subscription create form
  const subForm = document.getElementById('form-add-subscription');
  if (subForm) subForm.reset();
  const addSubRouting = document.getElementById('add-sub-routing');
  if (addSubRouting && appData.settings?.defaultRoutingBlacklist) {
    addSubRouting.value = appData.settings.defaultRoutingBlacklist;
  }
  const addSubHideUnreach = document.getElementById('add-sub-hide-unreachable');
  if (addSubHideUnreach) addSubHideUnreach.checked = true;
  const addSubAutoUpdate = document.getElementById('add-sub-autoupdate');
  if (addSubAutoUpdate) addSubAutoUpdate.value = '24';
  const addSubRadio = document.querySelector('input[name="add-sub-target-list"][value="mixed"]');
  if (addSubRadio) addSubRadio.checked = true;

  // Reset group create form
  const groupForm = document.getElementById('form-add-group');
  if (groupForm) groupForm.reset();
  const addGroupHideUnreach = document.getElementById('add-group-hide-unreachable');
  if (addGroupHideUnreach) addGroupHideUnreach.checked = true;
  const addGroupRadio = document.querySelector('input[name="add-group-target-list"][value="mixed"]');
  if (addGroupRadio) addGroupRadio.checked = true;

  switchAddModalTab(initialTab);
  openModal('modal-add-connection');

  setTimeout(() => {
    if (initialTab === 'connection') {
      const input = document.getElementById('input-vless-url');
      if (input) input.focus();
    } else if (initialTab === 'batch') {
      const input = document.getElementById('batch-import-text');
      if (input) input.focus();
    } else if (initialTab === 'subscription') {
      const input = document.getElementById('add-sub-url');
      if (input) input.focus();
    } else if (initialTab === 'group') {
      const input = document.getElementById('add-group-name');
      if (input) input.focus();
    }
  }, 100);
}

function switchAddModalTab(tabName) {
  const tabs = ['connection', 'batch', 'subscription', 'group'];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab-add-${t}`);
    const panel = document.getElementById(`panel-add-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
    if (panel) panel.classList.toggle('hidden', t !== tabName);
  });

  if (tabName === 'connection') {
    populateRoutingSelects();
    populateGroupSelects();
  } else if (tabName === 'batch') {
    populateRoutingSelects();
    populateGroupSelects();
    toggleBatchGroupMode();
    updateBatchImportCounter();
  } else if (tabName === 'subscription') {
    populateRoutingSelects();
    const addSubRouting = document.getElementById('add-sub-routing');
    if (addSubRouting && appData.settings?.defaultRoutingBlacklist) {
      addSubRouting.value = appData.settings.defaultRoutingBlacklist;
    }
    const nameInput = document.getElementById('add-sub-name');
    if (nameInput && !nameInput.value) {
      const subCount = (appData.groups || []).filter(g => g.isSubscription).length;
      nameInput.value = `Подписка ${subCount + 1}`;
    }
  } else if (tabName === 'group') {
    const nameInput = document.getElementById('add-group-name');
    if (nameInput && !nameInput.value) {
      nameInput.value = getNextDefaultGroupName();
    }
  }
}

async function onAddSubscriptionSubmit(e) {
  e.preventDefault();
  const url = document.getElementById('add-sub-url').value.trim();
  const name = document.getElementById('add-sub-name').value.trim();
  const targetList = document.querySelector('input[name="add-sub-target-list"]:checked')?.value || 'mixed';
  const routingId = document.getElementById('add-sub-routing').value;
  const hideUnreachable = Boolean(document.getElementById('add-sub-hide-unreachable')?.checked);
  const autoUpdateHours = parseInt(document.getElementById('add-sub-autoupdate')?.value, 10) || 0;
  const submitBtn = document.getElementById('btn-submit-add-sub');
  const submitText = document.getElementById('btn-submit-add-sub-text');

  if (!url) {
    showToast('Укажите URL подписки', 'warning');
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = 'Загрузка и парсинг...';

  try {
    const res = await fetch('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, subscriptionUrl: url, targetList, routingId, hideUnreachable, autoUpdateHours })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка загрузки подписки');

    showToast(data.message || 'Подписка успешно добавлена', 'success');
    if (data.errors && data.errors.length > 0) {
      console.warn('Предупреждения при загрузке подписки:', data.errors);
    }
    closeModal('modal-add-connection');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = 'Загрузить подписку';
  }
}

function onAddSubTargetListChange() {
  const targetList = document.querySelector('input[name="add-sub-target-list"]:checked')?.value || 'mixed';
  const defaultRouting = (targetList === 'whitelist')
    ? (appData.settings?.defaultRoutingWhitelist || 'routing_all_vpn')
    : (appData.settings?.defaultRoutingBlacklist || 'routing_all_vpn');
  const routingSel = document.getElementById('add-sub-routing');
  if (routingSel && defaultRouting) {
    routingSel.value = defaultRouting;
  }
}

async function onAddGroupSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('add-group-name').value.trim();
  const targetList = document.querySelector('input[name="add-group-target-list"]:checked')?.value || 'mixed';
  const hideUnreachable = Boolean(document.getElementById('add-group-hide-unreachable')?.checked);
  const submitBtn = document.getElementById('btn-submit-add-group');

  if (!name) {
    showToast('Укажите название группы', 'warning');
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, targetList, hideUnreachable })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка создания группы');

    showToast(data.message || 'Группа успешно создана', 'success');
    closeModal('modal-add-connection');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Submit Add Connection
async function onAddConnectionSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('conn-name').value.trim();
  const description = document.getElementById('conn-desc').value.trim();
  const groupId = document.getElementById('conn-group') ? document.getElementById('conn-group').value : 'group_default';
  const routingId = document.getElementById('conn-routing').value;
  const targetList = document.querySelector('input[name="conn-target-list"]:checked')?.value || 'blacklist';
  const isFavorite = Boolean(document.getElementById('conn-is-favorite')?.checked);
  const outboundContent = document.getElementById('conn-outbound-json').value.trim();

  if (!name || !outboundContent) {
    showToast('Укажите название и содержимое outbound.json', 'warning');
    return;
  }

  let parsedOutbounds = [];
  try {
    const cleanOutbound = stripComments(outboundContent);
    const parsedObj = JSON.parse(cleanOutbound);
    parsedOutbounds = Array.isArray(parsedObj.outbounds) ? parsedObj.outbounds : [parsedObj];
  } catch (e) {}

  const realOutbound = parsedOutbounds.find(o => o && o.tag !== 'direct' && o.tag !== 'block');
  if (!realOutbound || parsedOutbounds.length === 0) {
    showToast('Конфигурация outbound.json пуста или не содержит серверов прокси. Вставьте корректную ссылку подключения в поле выше.', 'warning');
    return;
  }

  try {
    const payload = { name, description, groupId, routingId, outboundContent, targetList, isFavorite };
    if (currentAddAmneziaConfig) {
      payload.amneziaConfig = currentAddAmneziaConfig;
      payload.protocol = 'amneziawg';
    }

    const res = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка при сохранении подключения');

    currentAddAmneziaConfig = null;
    showToast(data.message || 'Подключение успешно добавлено', 'success');
    closeModal('modal-add-connection');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Open Edit Connection Modal
function openEditConnectionModal(id) {
  const conn = appData.connections.find(c => c.id === id);
  if (!conn) return;

  document.getElementById('edit-conn-id').value = conn.id;
  document.getElementById('edit-conn-name').value = conn.name;
  document.getElementById('edit-conn-desc').value = conn.description || '';
  populateRoutingSelects();
  populateGroupSelects();
  const originGroup = (appData.groups || []).find(g => g.id === (conn.groupId || 'group_default'));
  const isFromSub = Boolean(originGroup?.isSubscription);
  const editGroupSel = document.getElementById('edit-conn-group');
  if (editGroupSel) {
    editGroupSel.value = conn.groupId || 'group_default';
    editGroupSel.disabled = isFromSub;
    editGroupSel.title = isFromSub ? 'Подключение входит в подписку. Перенос запрещен, доступно только копирование.' : '';
  }
  document.getElementById('edit-conn-routing').value = conn.routingId || 'routing_all_vpn';

  const targetRadio = document.querySelector(`input[name="edit-conn-target-list"][value="${conn.targetList || 'blacklist'}"]`);
  if (targetRadio) targetRadio.checked = true;

  // Preview pills
  const isAwg = (conn.protocol === 'amneziawg' || conn.protocol === 'awg' || Boolean(conn.amneziaConfig));
  document.getElementById('edit-preview-host').textContent = conn.serverAddress || '-';
  document.getElementById('edit-preview-port').textContent = conn.serverPort || '-';
  document.getElementById('edit-preview-proto').textContent = isAwg ? 'AWG' : (conn.protocol || 'VLESS').toUpperCase();
  const editNetEl = document.getElementById('edit-preview-net');
  if (editNetEl) {
    let editNet = conn.network;
    if (!editNet && conn.outboundContent) {
      try {
        const clean = stripComments(conn.outboundContent);
        const parsed = JSON.parse(clean);
        const oList = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
        const ob = oList.find(o => o && o.tag !== 'direct' && o.tag !== 'block');
        if (ob && ob.streamSettings && ob.streamSettings.network) {
          editNet = ob.streamSettings.network;
        }
      } catch (e) {}
    }
    editNetEl.textContent = formatNetworkName(editNet || (isAwg || conn.protocol === 'wireguard' ? 'udp' : 'tcp'));
  }
  document.getElementById('edit-preview-sec').textContent = isAwg ? 'Amnezia' : (conn.security || 'none');
  const sniWrap = document.getElementById('edit-preview-sni-wrap');
  if (conn.sni) {
    document.getElementById('edit-preview-sni').textContent = conn.sni;
    sniWrap.classList.remove('hidden');
  } else {
    sniWrap.classList.add('hidden');
  }

  setEditorContent('edit-conn-outbound-json', conn.outboundContent);
  openModal('modal-edit-connection');
}

// Submit Edit Connection
async function onEditConnectionSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('edit-conn-id').value;
  const name = document.getElementById('edit-conn-name').value.trim();
  const description = document.getElementById('edit-conn-desc').value.trim();
  const groupId = document.getElementById('edit-conn-group') ? document.getElementById('edit-conn-group').value : 'group_default';
  const routingId = document.getElementById('edit-conn-routing').value;
  const targetList = document.querySelector('input[name="edit-conn-target-list"]:checked')?.value || 'blacklist';
  const outboundContent = document.getElementById('edit-conn-outbound-json').value.trim();

  try {
    const res = await fetch(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, groupId, routingId, outboundContent, targetList })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка при сохранении подключения');

    showToast(data.message || 'Подключение сохранено', 'success');
    closeModal('modal-edit-connection');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// GROUP MANAGEMENT
// ==============================================================================

// Helper: Calculate default name for new group (e.g. "Group 1", "Group 2")
function getNextDefaultGroupName() {
  const groups = appData.groups || [];
  let index = 1;
  const existingNames = new Set(groups.map(g => (g.name || '').trim().toLowerCase()));
  while (existingNames.has(`group ${index}`.toLowerCase()) || existingNames.has(`группа ${index}`.toLowerCase())) {
    index++;
  }
  return `Group ${index}`;
}

// Open modal to create a new group
function openCreateGroupModal() {
  openAddConnectionModal('', 'group');
}

// Open modal to rename or edit an existing group
function openRenameGroupModal(groupId, currentName) {
  const idInput = document.getElementById('group-edit-id');
  const titleEl = document.getElementById('group-modal-title');
  const nameInput = document.getElementById('group-edit-name');
  if (idInput) idInput.value = groupId;
  if (titleEl) titleEl.textContent = 'Настройки группы';
  if (nameInput) nameInput.value = currentName || '';

  const grp = (appData.groups || []).find(g => g.id === groupId);
  const curTarget = grp?.targetList || 'mixed';
  const radio = document.querySelector(`input[name="group-edit-target-list"][value="${curTarget}"]`);
  if (radio) radio.checked = true;

  const hideUnreachEl = document.getElementById('group-edit-hide-unreachable');
  if (hideUnreachEl) hideUnreachEl.checked = (grp?.hideUnreachable !== false);

  openModal('modal-group-edit');
  setTimeout(() => {
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }, 100);
}

// Submit Create or Edit Group
async function onGroupEditSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('group-edit-id').value;
  const name = document.getElementById('group-edit-name').value.trim();
  const targetList = document.querySelector('input[name="group-edit-target-list"]:checked')?.value || 'mixed';
  const hideUnreachable = Boolean(document.getElementById('group-edit-hide-unreachable')?.checked);

  if (!name) {
    showToast('Укажите название группы', 'warning');
    return;
  }

  try {
    let res;
    if (id) {
      res = await fetch(`/api/groups/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, targetList, hideUnreachable })
      });
    } else {
      res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, targetList, hideUnreachable })
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения группы');

    showToast(data.message || 'Группа успешно сохранена', 'success');
    closeModal('modal-group-edit');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Move Group Up (-1) or Down (+1)
async function moveGroup(groupId, direction, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const groups = appData.groups || [];
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= groups.length) return;

  // Swap
  const temp = groups[idx];
  groups[idx] = groups[targetIdx];
  groups[targetIdx] = temp;

  renderConnections();

  try {
    const res = await fetch('/api/groups/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds: groups.map(g => g.id) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка изменения порядка групп');
    if (Array.isArray(data.groups)) {
      appData.groups = data.groups;
      renderConnections();
    }
  } catch (err) {
    showToast(err.message, 'error');
    await loadData();
  }
}

// Ping all favorite connections
async function pingFavoritesConnections(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (isPingingFavorites) return;

  const favList = (appData.connections || []).filter(c => c.isFavorite);
  if (favList.length === 0) {
    showToast('В избранном нет подключений для проверки', 'info');
    return;
  }

  isPingingFavorites = true;
  for (const conn of favList) {
    conn.lastPing = null;
    conn.lastPingStatus = null;
    conn.lastPingError = null;
  }
  renderConnections();
  showToast(`Проверка избранных подключений (${favList.length})...`, 'info');

  try {
    for (const conn of favList) {
      pingingConnectionIds.add(conn.id);
      updateConnectionPingDom(conn.id);
      try {
        const res = await fetch(`/api/connections/${conn.id}/ping`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          conn.lastPing = data.ping;
          conn.lastPingStatus = data.status;
          conn.lastPingError = data.error || null;
          conn.lastPingType = data.checkType || 'tcp';
          conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
          if (data.countryCode) conn.countryCode = data.countryCode;
          if (data.countryName) conn.countryName = data.countryName;
        } else {
          let errText = '';
          try { const d = await res.json(); errText = d.error || ''; } catch (e) {}
          conn.lastPing = null;
          conn.lastPingStatus = 'unreachable';
          conn.lastPingError = errText;
          conn.lastPingCheckedAt = new Date().toISOString();
        }
      } catch (e) {
        conn.lastPing = null;
        conn.lastPingStatus = 'unreachable';
        conn.lastPingError = e.message || 'Ошибка сети';
        conn.lastPingCheckedAt = new Date().toISOString();
      } finally {
        pingingConnectionIds.delete(conn.id);
        updateConnectionPingDom(conn.id);
      }
    }
    showToast('Проверка избранных подключений завершена', 'success');
  } catch (err) {
    showToast(`Ошибка проверки избранного: ${err.message}`, 'error');
  } finally {
    isPingingFavorites = false;
    renderConnections();
  }
}

// Ping all connections of a specific group
async function pingGroupConnections(groupId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (pingingGroupIds.has(groupId)) return;

  const groupConns = (appData.connections || []).filter(c => (c.groupId || 'group_default') === groupId);
  if (groupConns.length === 0) {
    showToast('В группе нет подключений для проверки', 'info');
    return;
  }

  pingingGroupIds.add(groupId);
  for (const conn of groupConns) {
    conn.lastPing = null;
    conn.lastPingStatus = null;
    conn.lastPingError = null;
  }
  renderConnections();
  showToast(`Проверка подключений группы (${groupConns.length})...`, 'info');

  try {
    for (const conn of groupConns) {
      pingingConnectionIds.add(conn.id);
      updateConnectionPingDom(conn.id);
      try {
        const res = await fetch(`/api/connections/${conn.id}/ping`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          conn.lastPing = data.ping;
          conn.lastPingStatus = data.status;
          conn.lastPingError = data.error || null;
          conn.lastPingType = data.checkType || 'tcp';
          conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
          if (data.countryCode) conn.countryCode = data.countryCode;
          if (data.countryName) conn.countryName = data.countryName;
        } else {
          let errText = '';
          try { const d = await res.json(); errText = d.error || ''; } catch (e) {}
          conn.lastPing = null;
          conn.lastPingStatus = 'unreachable';
          conn.lastPingError = errText;
          conn.lastPingCheckedAt = new Date().toISOString();
        }
      } catch (e) {
        conn.lastPing = null;
        conn.lastPingStatus = 'unreachable';
        conn.lastPingError = e.message || 'Ошибка сети';
        conn.lastPingCheckedAt = new Date().toISOString();
      } finally {
        pingingConnectionIds.delete(conn.id);
        updateConnectionPingDom(conn.id);
      }
    }
    showToast('Проверка группы завершена', 'success');
  } catch (err) {
    showToast(`Ошибка проверки группы: ${err.message}`, 'error');
  } finally {
    pingingGroupIds.delete(groupId);
    renderConnections();
  }
}

// Delete group (connections move to group_default)
async function deleteGroup(groupId, groupName) {
  if (groupId === 'group_default') {
    showToast('Нельзя удалить основную группу', 'warning');
    return;
  }

  const confirmed = confirm(`Удалить группу "${groupName}"?\nВсе подключения из неё будут перемещены в "Общие".`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/groups/${groupId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления группы');

    showToast(data.message || 'Группа удалена', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// SUBSCRIPTION ACTIONS
// ==============================================================================

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function openAddSubscriptionModal() {
  openAddConnectionModal('', 'subscription');
}

function openEditSubscriptionModal(groupId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const group = (appData.groups || []).find(g => g.id === groupId);
  if (!group) return;

  const form = document.getElementById('form-subscription');
  if (form) form.reset();

  document.getElementById('sub-id').value = group.id;
  document.getElementById('modal-sub-title').textContent = 'Редактирование подписки';
  document.getElementById('modal-sub-subtitle').textContent = 'Управление ссылкой, маршрутизацией и типом (ЧС / БС / СМ)';

  document.getElementById('sub-url').value = group.subscriptionUrl || '';
  document.getElementById('sub-name').value = group.name || '';

  const targetRadio = document.querySelector(`input[name="sub-target-list"][value="${group.targetList || 'mixed'}"]`);
  if (targetRadio) targetRadio.checked = true;

  const subHideUnreachEl = document.getElementById('sub-hide-unreachable');
  if (subHideUnreachEl) subHideUnreachEl.checked = (group.hideUnreachable !== false);

  const subAutoUpdateEl = document.getElementById('sub-autoupdate');
  if (subAutoUpdateEl) subAutoUpdateEl.value = String(group.autoUpdateHours ?? 0);

  populateRoutingSelects();
  const subRoutingSel = document.getElementById('sub-routing');
  if (subRoutingSel) {
    subRoutingSel.value = group.routingId || (group.targetList === 'whitelist' ? appData.settings?.defaultRoutingWhitelist : appData.settings?.defaultRoutingBlacklist);
  }

  const editOpts = document.getElementById('sub-edit-options');
  if (editOpts) editOpts.classList.remove('hidden');

  const syncNow = document.getElementById('sub-sync-now');
  if (syncNow) syncNow.checked = false;

  const applyRouting = document.getElementById('sub-apply-routing');
  if (applyRouting) applyRouting.checked = true;

  const submitText = document.getElementById('btn-submit-sub-text');
  if (submitText) submitText.textContent = 'Сохранить изменения';

  openModal('modal-subscription');
}

function onSubTargetListChange() {
  const targetList = document.querySelector('input[name="sub-target-list"]:checked')?.value || 'mixed';
  const defaultRouting = (targetList === 'whitelist')
    ? (appData.settings?.defaultRoutingWhitelist || 'routing_all_vpn')
    : (appData.settings?.defaultRoutingBlacklist || 'routing_except_ru');

  const sel = document.getElementById('sub-routing');
  if (sel && defaultRouting) {
    sel.value = defaultRouting;
  }
}

async function onSubscriptionSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('sub-id').value;
  const url = document.getElementById('sub-url').value.trim();
  const name = document.getElementById('sub-name').value.trim();
  const targetList = document.querySelector('input[name="sub-target-list"]:checked')?.value || 'mixed';
  const routingId = document.getElementById('sub-routing').value;
  const hideUnreachable = Boolean(document.getElementById('sub-hide-unreachable')?.checked);
  const autoUpdateHours = parseInt(document.getElementById('sub-autoupdate')?.value, 10) || 0;
  const submitBtn = document.getElementById('btn-submit-sub');
  const submitText = document.getElementById('btn-submit-sub-text');

  if (!url) {
    showToast('Укажите URL подписки', 'warning');
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = id ? 'Сохранение...' : 'Загрузка и парсинг...';

  try {
    if (id) {
      // Edit existing subscription
      const applyRoutingToConnections = document.getElementById('sub-apply-routing')?.checked || false;
      const syncNow = document.getElementById('sub-sync-now')?.checked || false;

      const res = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, subscriptionUrl: url, targetList, routingId, applyRoutingToConnections, hideUnreachable, autoUpdateHours })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения параметров подписки');

      if (syncNow) {
        showToast('Обновление ссылок из подписки...', 'info');
        const syncRes = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const syncData = await syncRes.json();
        if (!syncRes.ok) throw new Error(syncData.error || 'Ошибка синхронизации ссылок');
        showToast(syncData.message, 'success');
      } else {
        showToast(data.message || 'Подписка сохранена', 'success');
      }

      closeModal('modal-subscription');
      await loadData();
    } else {
      // Create new subscription
      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name, targetList, routingId, hideUnreachable, autoUpdateHours })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка загрузки подписки');

      showToast(data.message || 'Подписка успешно добавлена', 'success');
      if (data.errors && data.errors.length > 0) {
        console.warn('Предупреждения при загрузке подписки:', data.errors);
      }
      closeModal('modal-subscription');
      await loadData();
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = id ? 'Сохранить изменения' : 'Загрузить подписку';
  }
}

async function updateSubscription(groupId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (updatingSubscriptionIds.has(groupId)) return;

  updatingSubscriptionIds.add(groupId);
  renderConnections();

  try {
    showToast('Загрузка свежих ссылок из подписки...', 'info');
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(groupId)}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка обновления подписки');

    showToast(data.message || 'Подписка успешно обновлена', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    updatingSubscriptionIds.delete(groupId);
    renderConnections();
  }
}

async function deleteSubscription(groupId, subName, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const confirmed = confirm(`Удалить подписку "${subName}"?\nВсе входящие в неё подключения будут безвозвратно удалены.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(groupId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления подписки');

    showToast(data.message || 'Подписка удалена', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// MOVE & COPY CONNECTIONS BETWEEN GROUPS
// ==============================================================================

function openMoveCopyModal(connId) {
  const conn = (appData.connections || []).find(c => c.id === connId);
  if (!conn) return;

  const currentGroup = (appData.groups || []).find(g => g.id === (conn.groupId || 'group_default'));
  const isFromSubscription = Boolean(currentGroup?.isSubscription);

  document.getElementById('move-copy-conn-id').value = conn.id;
  document.getElementById('move-copy-conn-name').textContent = conn.name;
  populateGroupSelects();

  const titleEl = document.getElementById('move-copy-title');
  if (titleEl) {
    titleEl.textContent = isFromSubscription ? 'Копирование подключения из подписки' : 'Управление группой подключения';
  }

  const targetGroupSel = document.getElementById('move-copy-target-group');
  if (targetGroupSel) {
    const nonSubGroup = (appData.groups || []).find(g => !g.isSubscription);
    targetGroupSel.value = (isFromSubscription && nonSubGroup) ? nonSubGroup.id : (conn.groupId || 'group_default');
  }

  const radioMove = document.querySelector('input[name="move-copy-action"][value="move"]');
  const radioCopy = document.querySelector('input[name="move-copy-action"][value="copy"]');
  const subNotice = document.getElementById('move-copy-sub-notice');

  if (isFromSubscription) {
    if (radioMove) {
      radioMove.disabled = true;
      radioMove.checked = false;
      if (radioMove.parentElement) {
        radioMove.parentElement.style.opacity = '0.5';
        radioMove.parentElement.style.cursor = 'not-allowed';
        radioMove.parentElement.title = 'Перенос из подписок невозможен, только копирование';
      }
    }
    if (radioCopy) {
      radioCopy.checked = true;
    }
    if (subNotice) {
      subNotice.classList.remove('hidden');
    }
  } else {
    if (radioMove) {
      radioMove.disabled = false;
      radioMove.checked = true;
      if (radioMove.parentElement) {
        radioMove.parentElement.style.opacity = '1';
        radioMove.parentElement.style.cursor = 'pointer';
        radioMove.parentElement.title = '';
      }
    }
    if (subNotice) {
      subNotice.classList.add('hidden');
    }
  }

  const newNameInput = document.getElementById('move-copy-new-name');
  if (newNameInput) newNameInput.value = `${conn.name} (Копия)`;

  toggleMoveCopyAction();
  openModal('modal-move-copy');
}

function toggleMoveCopyAction() {
  const action = document.querySelector('input[name="move-copy-action"]:checked')?.value || 'move';
  const nameWrap = document.getElementById('move-copy-new-name-wrap');
  const submitBtn = document.getElementById('btn-move-copy-submit');
  if (action === 'copy') {
    if (nameWrap) nameWrap.classList.remove('hidden');
    if (submitBtn) submitBtn.textContent = 'Копировать';
  } else {
    if (nameWrap) nameWrap.classList.add('hidden');
    if (submitBtn) submitBtn.textContent = 'Переместить';
  }
}

async function onMoveCopySubmit(e) {
  e.preventDefault();
  const connId = document.getElementById('move-copy-conn-id').value;
  const action = document.querySelector('input[name="move-copy-action"]:checked')?.value || 'move';
  const targetGroupId = document.getElementById('move-copy-target-group').value;
  const newName = (document.getElementById('move-copy-new-name').value || '').trim();

  if (!connId || !targetGroupId) {
    showToast('Не выбрана целевая группа', 'warning');
    return;
  }

  const conn = (appData.connections || []).find(c => c.id === connId);
  const curGroup = (appData.groups || []).find(g => g.id === (conn?.groupId || 'group_default'));
  if (curGroup?.isSubscription && action === 'move') {
    showToast('Перенос подключений из подписок невозможен, только копирование', 'warning');
    return;
  }

  try {
    let res;
    if (action === 'copy') {
      res = await fetch(`/api/connections/${connId}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetGroupId, newName })
      });
    } else {
      res = await fetch(`/api/connections/${connId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetGroupId })
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка обработки подключения');

    showToast(data.message || (action === 'copy' ? 'Подключение скопировано' : 'Подключение перемещено'), 'success');
    closeModal('modal-move-copy');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// BATCH IMPORT CONNECTIONS
// ==============================================================================

function openBatchImportModal() {
  openAddConnectionModal('', 'batch');
}

function toggleBatchGroupMode() {
  const mode = document.querySelector('input[name="batch-group-choice"]:checked')?.value || 'new';
  const newWrap = document.getElementById('batch-group-new-wrap');
  const existWrap = document.getElementById('batch-group-existing-wrap');
  if (newWrap && existWrap) {
    newWrap.classList.toggle('hidden', mode !== 'new');
    existWrap.classList.toggle('hidden', mode !== 'existing');
  }
}

function updateBatchImportCounter() {
  const textarea = document.getElementById('batch-import-text');
  const counter = document.getElementById('batch-import-counter');
  const submitText = document.getElementById('btn-submit-batch-text');
  if (!textarea || !counter) return;

  const lines = textarea.value
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

  counter.textContent = `Найдено ссылок: ${lines.length}`;
  if (submitText) {
    submitText.textContent = lines.length > 0 ? `Импортировать (${lines.length})` : 'Импортировать';
  }
}

async function onBatchImportSubmit(e) {
  e.preventDefault();
  const text = document.getElementById('batch-import-text').value.trim();
  const routingId = document.getElementById('batch-routing-select').value;
  const targetList = document.querySelector('input[name="batch-target-list"]:checked')?.value || 'mixed';
  const mode = document.querySelector('input[name="batch-group-choice"]:checked')?.value || 'new';

  let groupName = '';
  let groupId = '';

  if (mode === 'new') {
    groupName = (document.getElementById('batch-group-new-name').value || '').trim();
    if (!groupName) groupName = getNextDefaultGroupName();
  } else {
    groupId = document.getElementById('batch-group-select').value;
  }

  if (!text) {
    showToast('Вставьте хотя бы одну ссылку', 'warning');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-batch-import');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/connections/batch-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, groupName, groupId, routingId, targetList })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка пакетного импорта');

    showToast(data.message || `Импортировано: ${data.count}`, 'success');
    if (data.errors && data.errors.length > 0) {
      console.warn('Предупреждения при импорте:', data.errors);
    }
    closeModal('modal-add-connection');
    closeModal('modal-batch-import');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Change Routing for Connection directly from card
async function changeConnectionRouting(connId, routingId) {
  try {
    const res = await fetch(`/api/connections/${connId}/set-routing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routingId })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка смены роутинга');

    showToast(data.message, 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
    await loadData();
  }
}

// Toggle Favorite status for Connection
async function toggleFavoriteConnection(connId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const conn = (appData.connections || []).find(c => c.id === connId);
  if (!conn) return;

  const previousState = Boolean(conn.isFavorite);
  conn.isFavorite = !previousState;
  renderConnections();

  try {
    const res = await fetch(`/api/connections/${encodeURIComponent(connId)}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isFavorite: conn.isFavorite })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка обновления избранного');

    showToast(conn.isFavorite ? 'Добавлено в избранное' : 'Удалено из избранного', 'info');
  } catch (err) {
    conn.isFavorite = previousState;
    renderConnections();
    showToast('Не удалось обновить статус: ' + err.message, 'error');
  }
}



// Handlers for switching target list radio in add/edit modals
function onConnTargetListChange(mode) {
  const targetList = (mode === 'add')
    ? (document.querySelector('input[name="conn-target-list"]:checked')?.value || 'blacklist')
    : (document.querySelector('input[name="edit-conn-target-list"]:checked')?.value || 'blacklist');

  const defaultRouting = (targetList === 'whitelist')
    ? (appData.settings?.defaultRoutingWhitelist || 'routing_all_vpn')
    : (appData.settings?.defaultRoutingBlacklist || 'routing_except_ru');

  const routingSelectId = (mode === 'add') ? 'conn-routing' : 'edit-conn-routing';
  const sel = document.getElementById(routingSelectId);
  if (sel && defaultRouting) {
    sel.value = defaultRouting;
  }
}

// Handler for switching target list radio in batch import modal
function onBatchTargetListChange() {
  const targetList = document.querySelector('input[name="batch-target-list"]:checked')?.value || 'mixed';
  const defaultRouting = (targetList === 'whitelist')
    ? (appData.settings?.defaultRoutingWhitelist || 'routing_all_vpn')
    : (appData.settings?.defaultRoutingBlacklist || 'routing_except_ru');

  const sel = document.getElementById('batch-routing-select');
  if (sel && defaultRouting) {
    sel.value = defaultRouting;
  }
}

// Activate Connection
async function activateConnection(id) {
  try {
    showToast('Активация подключения и перезапуск XKeen...', 'info');
    const res = await fetch(`/api/connections/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка активации подключения');

    showToast(data.message || 'Подключение активировано!', 'success');
    await loadData();
    pollServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Delete Connection
async function deleteConnection(id, name) {
  if (!confirm(`Удалить подключение "${name}"?`)) return;

  try {
    const res = await fetch(`/api/connections/${id}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления подключения');

    showToast(data.message || 'Подключение удалено', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// QR CODE MODAL & VLESS URL GENERATOR
// ==============================================================================

// Reconstruct link (VLESS, VMess, Trojan, Shadowsocks, WireGuard) from connection object or outbound JSON
function getConnectionVlessUrl(conn) {
  if (conn.url && conn.url.includes('://')) {
    return conn.url;
  }
  if (!conn.outboundContent) return '';
  try {
    const clean = stripComments(conn.outboundContent);
    const parsed = JSON.parse(clean);
    const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
    const ob = list.find(o => o && o.tag !== 'direct' && o.tag !== 'block');
    if (!ob) return '';

    const proto = (ob.protocol || conn.protocol || 'vless').toLowerCase();

    // 1. VLESS
    if (proto === 'vless' && ob.settings && ob.settings.vnext && ob.settings.vnext[0]) {
      const vnext = ob.settings.vnext[0];
      const address = vnext.address;
      const port = vnext.port;
      const user = (vnext.users && vnext.users[0]) ? vnext.users[0] : {};
      const uuid = user.id || '';
      if (!uuid || !address || !port) return '';

      const ss = ob.streamSettings || {};
      const type = ss.network || 'tcp';
      const security = ss.security || 'none';
      const flow = user.flow || '';
      const encryption = user.encryption || 'none';

      const params = new URLSearchParams();
      params.set('type', type);
      params.set('security', security);
      if (flow) params.set('flow', flow);
      if (encryption && encryption !== 'none') params.set('encryption', encryption);

      if (security === 'reality' && ss.realitySettings) {
        const rs = ss.realitySettings;
        if (rs.publicKey) params.set('pbk', rs.publicKey);
        if (rs.fingerprint) params.set('fp', rs.fingerprint);
        if (rs.serverName) params.set('sni', rs.serverName);
        if (rs.shortId) params.set('sid', rs.shortId);
        if (rs.spiderX) params.set('spx', rs.spiderX);
      } else if (security === 'tls' && ss.tlsSettings) {
        const ts = ss.tlsSettings;
        if (ts.serverName) params.set('sni', ts.serverName);
        if (ts.fingerprint) params.set('fp', ts.fingerprint);
        if (ts.alpn && Array.isArray(ts.alpn)) params.set('alpn', ts.alpn.join(','));
      }

      if (type === 'ws' && ss.wsSettings) {
        if (ss.wsSettings.path) params.set('path', ss.wsSettings.path);
        if (ss.wsSettings.headers && ss.wsSettings.headers.Host) params.set('host', ss.wsSettings.headers.Host);
      } else if (type === 'grpc' && ss.grpcSettings) {
        if (ss.grpcSettings.serviceName) params.set('serviceName', ss.grpcSettings.serviceName);
      } else if (type === 'tcp' && ss.tcpSettings && ss.tcpSettings.header && ss.tcpSettings.header.type) {
        params.set('headerType', ss.tcpSettings.header.type);
      }

      const hashName = encodeURIComponent(conn.name || 'VLESS');
      return `vless://${uuid}@${address}:${port}?${params.toString()}#${hashName}`;
    }

    // 2. Trojan
    if (proto === 'trojan' && ob.settings && ob.settings.servers && ob.settings.servers[0]) {
      const srv = ob.settings.servers[0];
      const address = srv.address;
      const port = srv.port;
      const password = encodeURIComponent(srv.password || '');
      const ss = ob.streamSettings || {};
      const type = ss.network || 'tcp';
      const security = ss.security || 'tls';
      const params = new URLSearchParams();
      params.set('type', type);
      params.set('security', security);
      if (ss.tlsSettings && ss.tlsSettings.serverName) params.set('sni', ss.tlsSettings.serverName);
      const hashName = encodeURIComponent(conn.name || 'Trojan');
      return `trojan://${password}@${address}:${port}?${params.toString()}#${hashName}`;
    }

    // 3. Shadowsocks
    if (proto === 'shadowsocks' && ob.settings && ob.settings.servers && ob.settings.servers[0]) {
      const srv = ob.settings.servers[0];
      const address = srv.address;
      const port = srv.port;
      const method = srv.method || 'aes-256-gcm';
      const password = srv.password || '';
      const userBase64 = window.btoa(`${method}:${password}`);
      const hashName = encodeURIComponent(conn.name || 'Shadowsocks');
      return `ss://${userBase64}@${address}:${port}#${hashName}`;
    }

    // 4. VMess
    if (proto === 'vmess' && ob.settings && ob.settings.vnext && ob.settings.vnext[0]) {
      const vnext = ob.settings.vnext[0];
      const user = (vnext.users && vnext.users[0]) ? vnext.users[0] : {};
      const ss = ob.streamSettings || {};
      const vmessConf = {
        v: '2',
        ps: conn.name || 'VMess',
        add: vnext.address,
        port: vnext.port,
        id: user.id || '',
        aid: user.alterId || 0,
        scy: user.security || 'auto',
        net: ss.network || 'tcp',
        type: 'none',
        host: (ss.wsSettings && ss.wsSettings.headers) ? ss.wsSettings.headers.Host : '',
        path: (ss.wsSettings && ss.wsSettings.path) ? ss.wsSettings.path : '',
        tls: ss.security === 'tls' ? 'tls' : '',
        sni: (ss.tlsSettings && ss.tlsSettings.serverName) ? ss.tlsSettings.serverName : ''
      };
      const b64 = window.btoa(unescape(encodeURIComponent(JSON.stringify(vmessConf))));
      return `vmess://${b64}`;
    }

    return '';
  } catch (e) {
    console.error('Error generating proxy URL:', e);
    return '';
  }
}

// Open QR Code Modal for Connection
function openQrModal(id) {
  const conn = (appData.connections || []).find(c => c.id === id);
  if (!conn) return;

  const url = getConnectionVlessUrl(conn);
  if (!url) {
    showToast('Не удалось сформировать ссылку для этого подключения', 'warning');
    return;
  }

  const titleEl = document.getElementById('modal-qr-title');
  const urlInput = document.getElementById('modal-qr-url');
  const svgContainer = document.getElementById('modal-qr-svg');

  if (titleEl) titleEl.textContent = conn.name || 'QR-код подключения';
  if (urlInput) urlInput.value = url;

  if (svgContainer) {
    try {
      if (typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        svgContainer.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4 });
      } else {
        svgContainer.innerHTML = '<p class="text-muted">Модуль генерации QR не загружен</p>';
      }
    } catch (e) {
      console.error('QR Generation error:', e);
      svgContainer.innerHTML = '<p class="text-danger">Ошибка формирования QR-кода</p>';
    }
  }

  openModal('modal-qr');
}

// Copy QR VLESS URL to Clipboard
function copyQrUrl() {
  const urlInput = document.getElementById('modal-qr-url');
  if (!urlInput || !urlInput.value) {
    showToast('Ссылка пуста', 'warning');
    return;
  }

  const url = urlInput.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Ссылка VLESS скопирована в буфер обмена!', 'success');
    }).catch(() => {
      urlInput.select();
      document.execCommand('copy');
      showToast('Ссылка VLESS скопирована в буфер обмена!', 'success');
    });
  } else {
    urlInput.select();
    document.execCommand('copy');
    showToast('Ссылка VLESS скопирована в буфер обмена!', 'success');
  }
}

// ==============================================================================
// AVAILABILITY & PING CHECKS
// ==============================================================================

// Check single connection ping
async function checkConnectionPing(id) {
  if (pingingConnectionIds.has(id) || isPingingAll) return;
  pingingConnectionIds.add(id);
  renderConnections();

  try {
    const res = await fetch(`/api/connections/${id}/ping`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка проверки');

    const conn = appData.connections.find(c => c.id === id);
    if (conn) {
      conn.lastPing = data.ping;
      conn.lastPingStatus = data.status;
      conn.lastPingError = data.error || null;
      conn.lastPingType = data.checkType || 'tcp';
      conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
      if (data.countryCode) conn.countryCode = data.countryCode;
      if (data.countryName) conn.countryName = data.countryName;
    }

    if (data.status === 'ok') {
      const proxyNote = data.checkType === 'proxy' ? ' (туннель подтверждён)' : '';
      showToast(`Подключение доступно! Пинг: ${data.latencyStr}${proxyNote}`, 'success');
    } else {
      const reason = data.error ? `: ${data.error}` : '';
      showToast(`Подключение недоступно${reason}`, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    pingingConnectionIds.delete(id);
    updateConnectionPingDom(id);
    if (currentSort === 'ping') {
      renderConnections();
    }
  }
}

// Check all connections ping sequentially one by one
async function checkAllPing() {
  if (isPingingAll) return;
  const list = appData.connections || [];
  if (list.length === 0) {
    showToast('Нет подключений для проверки', 'info');
    return;
  }

  const btn = document.getElementById('btn-ping-all');
  const btnText = document.getElementById('btn-ping-all-text');

  isPingingAll = true;
  if (btn) btn.disabled = true;

  for (const conn of list) {
    conn.lastPing = null;
    conn.lastPingStatus = null;
    conn.lastPingError = null;
  }
  renderConnections();

  try {
    for (let i = 0; i < list.length; i++) {
      const conn = list[i];
      if (btnText) btnText.innerHTML = `<span class="spin-icon">⏳</span> Проверка ${i + 1}/${list.length}...`;
      pingingConnectionIds.add(conn.id);
      updateConnectionPingDom(conn.id);

      try {
        const res = await fetch(`/api/connections/${conn.id}/ping`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          conn.lastPing = data.ping;
          conn.lastPingStatus = data.status;
          conn.lastPingError = data.error || null;
          conn.lastPingType = data.checkType || 'tcp';
          conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
          if (data.countryCode) conn.countryCode = data.countryCode;
          if (data.countryName) conn.countryName = data.countryName;
        } else {
          let errText = '';
          try { const d = await res.json(); errText = d.error || ''; } catch (e) {}
          conn.lastPing = null;
          conn.lastPingStatus = 'unreachable';
          conn.lastPingError = errText;
          conn.lastPingCheckedAt = new Date().toISOString();
        }
      } catch (e) {
        conn.lastPing = null;
        conn.lastPingStatus = 'unreachable';
        conn.lastPingError = e.message || 'Ошибка сети';
        conn.lastPingCheckedAt = new Date().toISOString();
      } finally {
        pingingConnectionIds.delete(conn.id);
        updateConnectionPingDom(conn.id);
      }
    }

    showToast('Проверка всех подключений завершена!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    isPingingAll = false;
    pingingConnectionIds.clear();
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Проверить все';
    renderConnections();
  }
}

// Synchronize textarea heights in routing lists
let routingSyncInitialized = false;
function initRoutingTextareaSync() {
  const pairs = [
    ['builder-custom-proxy-domains', 'builder-custom-proxy-ips'],
    ['builder-custom-direct-domains', 'builder-custom-direct-ips'],
    ['builder-custom-block-domains', 'builder-custom-block-ips']
  ];

  let foundAny = false;

  pairs.forEach(([id1, id2]) => {
    const el1 = document.getElementById(id1);
    const el2 = document.getElementById(id2);
    if (!el1 || !el2) return;
    foundAny = true;

    if (el1.dataset.syncBound === 'true') return;
    el1.dataset.syncBound = 'true';
    el2.dataset.syncBound = 'true';

    let activeEl = null;

    const onStart = (el) => { activeEl = el; };
    el1.addEventListener('pointerdown', () => onStart(el1));
    el2.addEventListener('pointerdown', () => onStart(el2));
    el1.addEventListener('mousedown', () => onStart(el1));
    el2.addEventListener('mousedown', () => onStart(el2));
    window.addEventListener('pointerup', () => { activeEl = null; });
    window.addEventListener('mouseup', () => { activeEl = null; });

    let isSyncing = false;
    const syncHeights = (source, target) => {
      if (isSyncing) return;
      const h = source.offsetHeight;
      if (h > 20 && Math.abs(target.offsetHeight - h) > 1) {
        isSyncing = true;
        target.style.height = `${h}px`;
        requestAnimationFrame(() => {
          isSyncing = false;
        });
      }
    };

    if (window.ResizeObserver) {
      const ro = new ResizeObserver((entries) => {
        if (isSyncing) return;
        for (const entry of entries) {
          if (entry.target === el1 && (activeEl === el1 || !activeEl)) {
            syncHeights(el1, el2);
          } else if (entry.target === el2 && (activeEl === el2 || !activeEl)) {
            syncHeights(el2, el1);
          }
        }
      });
      ro.observe(el1);
      ro.observe(el2);
    }
  });

  document.querySelectorAll('.routing-list-details').forEach(det => {
    if (det.dataset.syncBound === 'true') return;
    det.dataset.syncBound = 'true';
    det.addEventListener('toggle', () => {
      if (det.open) {
        const textareas = det.querySelectorAll('.routing-textarea');
        if (textareas.length >= 2) {
          const h = Math.max(textareas[0].offsetHeight, textareas[1].offsetHeight);
          if (h > 20) {
            textareas[0].style.height = `${h}px`;
            textareas[1].style.height = `${h}px`;
          }
        }
      }
    });
  });

  if (foundAny) {
    routingSyncInitialized = true;
  }
}

// Update pill label active classes on radio change
function updatePillStyles(radioInput) {
  if (!radioInput) return;
  const group = radioInput.closest('.routing-pill-group');
  if (!group) return;
  const labels = group.querySelectorAll('.routing-pill-label');
  labels.forEach(lbl => {
    lbl.classList.remove('active-direct', 'active-proxy', 'active-block');
    const input = lbl.querySelector('input[type="radio"]');
    if (input && input.checked) {
      if (input.value === 'direct') lbl.classList.add('active-direct');
      else if (input.value === 'proxy') lbl.classList.add('active-proxy');
      else if (input.value === 'block') lbl.classList.add('active-block');
    }
  });
}

// Switch between Visual Builder and Raw JSON mode
function switchRoutingMode(mode) {
  const hiddenMode = document.getElementById('routing-mode');
  if (hiddenMode) hiddenMode.value = mode;

  const tabBuilder = document.getElementById('tab-routing-builder');
  const tabJson = document.getElementById('tab-routing-json');
  const sectionBuilder = document.getElementById('routing-builder-section');
  const sectionJson = document.getElementById('routing-json-section');
  const formatBtn = document.getElementById('btn-format-routing');

  if (mode === 'builder') {
    if (tabBuilder) tabBuilder.classList.add('active');
    if (tabJson) tabJson.classList.remove('active');
    if (sectionBuilder) sectionBuilder.classList.remove('hidden');
    if (sectionJson) sectionJson.classList.add('hidden');
    if (formatBtn) formatBtn.classList.add('hidden');
  } else {
    if (tabBuilder) tabBuilder.classList.remove('active');
    if (tabJson) tabJson.classList.add('active');
    if (sectionBuilder) sectionBuilder.classList.add('hidden');
    if (sectionJson) sectionJson.classList.remove('hidden');
    if (formatBtn) formatBtn.classList.remove('hidden');

    // Auto-compile current builder settings to JSON editor when switching to Expert mode
    const currentJson = document.getElementById('routing-content-json')?.value || '';
    if (!currentJson.trim() || hiddenMode?.dataset?.dirty !== 'true') {
      const compiled = generateBuilderJson();
      if (compiled) {
        setEditorContent('routing-content-json', compiled);
      }
    }
  }
}

// Clean domains and IPs from comments (# or // or ;), preserving valid rules
function extractCleanTargets(arr) {
  if (!Array.isArray(arr)) return [];
  const res = [];
  for (const raw of arr) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (s.startsWith('#') || s.startsWith('//') || s.startsWith(';') || s.startsWith('!')) continue;
    const clean = s.split(/#|\/\/|;/)[0].trim();
    if (clean) res.push(clean);
  }
  return res;
}

// Collect current builder configuration from form inputs
function collectBuilderConfig() {
  const bittorrent = document.querySelector('input[name="builder-bittorrent"]:checked')?.value || 'direct';
  const quic = document.querySelector('input[name="builder-quic"]:checked')?.value || 'block';
  const voip = document.querySelector('input[name="builder-voip"]:checked')?.value || 'direct';
  const defaultAction = document.querySelector('input[name="builder-default-action"]:checked')?.value || 'proxy';

  const bypassRu = Boolean(document.getElementById('builder-bypass-ru')?.checked);
  const bypassPrivate = Boolean(document.getElementById('builder-bypass-private')?.checked);
  const blockNetbios = Boolean(document.getElementById('builder-block-netbios')?.checked);
  const blockAds = Boolean(document.getElementById('builder-block-ads')?.checked);
  const geositeExtraProxy = Boolean(document.getElementById('builder-geosite-extra-proxy')?.checked);
  const geoAutoUpdate = Boolean(document.getElementById('builder-geo-autoupdate')?.checked);

  const parseLines = (id) => {
    const val = document.getElementById(id)?.value || '';
    return val.split('\n').map(s => s.trimEnd()).filter(s => s.trim().length > 0);
  };

  return {
    defaultAction,
    bittorrent,
    quic,
    voip,
    bypassRu,
    bypassPrivate,
    blockNetbios,
    blockAds,
    geositeExtraProxy,
    geoAutoUpdate,
    customProxyDomains: parseLines('builder-custom-proxy-domains'),
    customProxyIps: parseLines('builder-custom-proxy-ips'),
    customDirectDomains: parseLines('builder-custom-direct-domains'),
    customDirectIps: parseLines('builder-custom-direct-ips'),
    customBlockDomains: parseLines('builder-custom-block-domains'),
    customBlockIps: parseLines('builder-custom-block-ips')
  };
}

// Compile builder config into Xray JSON
function generateBuilderJson(cfg) {
  if (!cfg) cfg = collectBuilderConfig();
  const rules = [];
  const inbounds = ['redirect', 'tproxy'];
  const proxyTag = 'vless-reality';

  if (cfg.blockNetbios) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', network: 'udp', port: '135,137,138,139' });
  }
  if (cfg.blockAds) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', domain: ['geosite:category-ads-all'] });
  }
  const cleanBlockDomains = extractCleanTargets(cfg.customBlockDomains);
  if (cleanBlockDomains.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', domain: cleanBlockDomains });
  }
  const cleanBlockIps = extractCleanTargets(cfg.customBlockIps);
  if (cleanBlockIps.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', ip: cleanBlockIps });
  }
  if (cfg.quic === 'block') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', network: 'udp', port: '443' });
  } else if (cfg.quic === 'direct') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'direct', network: 'udp', port: '443' });
  } else if (cfg.quic === 'proxy') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: proxyTag, network: 'udp', port: '443' });
  }
  if (cfg.bittorrent === 'block') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'block', protocol: ['bittorrent'] });
  } else if (cfg.bittorrent === 'direct') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'direct', protocol: ['bittorrent'] });
  } else if (cfg.bittorrent === 'proxy') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: proxyTag, protocol: ['bittorrent'] });
  }
  if (cfg.voip === 'direct') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'direct', network: 'udp', port: '3478,3479,5349,19302-19309' });
  } else if (cfg.voip === 'proxy') {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: proxyTag, network: 'udp', port: '3478,3479,5349,19302-19309' });
  }
  const cleanDirectDomains = extractCleanTargets(cfg.customDirectDomains);
  if (cleanDirectDomains.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'direct', domain: cleanDirectDomains });
  }
  const cleanDirectIps = extractCleanTargets(cfg.customDirectIps);
  if (cleanDirectIps.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: 'direct', ip: cleanDirectIps });
  }
  if (cfg.bypassRu) {
    rules.push({
      type: 'field',
      inboundTag: inbounds,
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
    });
    rules.push({
      type: 'field',
      inboundTag: inbounds,
      outboundTag: 'direct',
      ip: ['geoip:private', 'ext:geoip_zkeenip.dat:ru']
    });
  } else if (cfg.bypassPrivate) {
    rules.push({
      type: 'field',
      inboundTag: inbounds,
      outboundTag: 'direct',
      ip: ['geoip:private']
    });
  }
  const cleanProxyDomains = extractCleanTargets(cfg.customProxyDomains);
  if (cleanProxyDomains.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: proxyTag, domain: cleanProxyDomains });
  }
  const cleanProxyIps = extractCleanTargets(cfg.customProxyIps);
  if (cleanProxyIps.length > 0) {
    rules.push({ type: 'field', inboundTag: inbounds, outboundTag: proxyTag, ip: cleanProxyIps });
  }
  if (cfg.geositeExtraProxy) {
    rules.push({
      type: 'field',
      inboundTag: inbounds,
      outboundTag: proxyTag,
      domain: [
        'geosite:google',
        'geosite:telegram',
        'geosite:twitter',
        'geosite:meta',
        'geosite:discord',
        'geosite:openai'
      ]
    });
  }
  rules.push({
    type: 'field',
    inboundTag: inbounds,
    outboundTag: cfg.defaultAction === 'direct' ? 'direct' : proxyTag,
    network: 'tcp,udp'
  });

  return JSON.stringify({
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules
    }
  }, null, 2);
}

// Populate Visual Builder form inputs
function populateBuilderForm(cfg = {}) {
  const setRadio = (name, val) => {
    const radio = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (radio) {
      radio.checked = true;
      updatePillStyles(radio);
    }
  };

  setRadio('builder-bittorrent', cfg.bittorrent || 'direct');
  setRadio('builder-quic', cfg.quic || 'block');
  setRadio('builder-voip', cfg.voip || 'direct');
  setRadio('builder-default-action', cfg.defaultAction || 'proxy');

  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(val);
  };

  setCheck('builder-bypass-ru', cfg.bypassRu !== undefined ? cfg.bypassRu : true);
  setCheck('builder-bypass-private', cfg.bypassPrivate !== undefined ? cfg.bypassPrivate : true);
  setCheck('builder-block-netbios', cfg.blockNetbios !== undefined ? cfg.blockNetbios : true);
  setCheck('builder-block-ads', cfg.blockAds !== undefined ? cfg.blockAds : false);
  setCheck('builder-geo-autoupdate', cfg.geoAutoUpdate !== undefined ? cfg.geoAutoUpdate : true);
  setCheck('builder-geosite-extra-proxy', cfg.geositeExtraProxy !== undefined ? cfg.geositeExtraProxy : false);

  const setText = (id, arr) => {
    const el = document.getElementById(id);
    if (el) el.value = Array.isArray(arr) ? arr.join('\n') : '';
  };

  setText('builder-custom-proxy-domains', cfg.customProxyDomains);
  setText('builder-custom-proxy-ips', cfg.customProxyIps);
  setText('builder-custom-direct-domains', cfg.customDirectDomains);
  setText('builder-custom-direct-ips', cfg.customDirectIps);
  setText('builder-custom-block-domains', cfg.customBlockDomains);
  setText('builder-custom-block-ips', cfg.customBlockIps);
}

// Check status of geosite.dat and geoip.dat
async function checkGeodataStatus() {
  try {
    const res = await fetch('/api/geodata/status');
    if (!res.ok) return;
    const data = await res.json();
    const siteBadge = document.getElementById('geodata-badge-geosite');
    const ipBadge = document.getElementById('geodata-badge-geoip');
    const updateBadge = document.getElementById('geodata-badge-updated');

    if (siteBadge) {
      if (data.geosite && data.geosite.exists) {
        siteBadge.innerHTML = `GeoSite: <strong style="color: #4ade80;">OK (${formatBytes(data.geosite.size)})</strong>`;
      } else {
        siteBadge.innerHTML = `GeoSite: <strong style="color: #f87171;">Отсутствует</strong>`;
      }
    }

    if (ipBadge) {
      if (data.geoip && data.geoip.exists) {
        ipBadge.innerHTML = `GeoIP: <strong style="color: #4ade80;">OK (${formatBytes(data.geoip.size)})</strong>`;
      } else {
        ipBadge.innerHTML = `GeoIP: <strong style="color: #f87171;">Отсутствует</strong>`;
      }
    }

    if (updateBadge) {
      if (data.lastUpdated) {
        const d = new Date(data.lastUpdated);
        updateBadge.innerHTML = `Обновлено: <strong>${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>`;
      } else {
        updateBadge.innerHTML = `Обновлено: <strong>Никогда</strong>`;
      }
    }
  } catch (err) {
    console.error('Ошибка проверки статуса geodata:', err);
  }
}

// Download latest geosite.dat and geoip.dat manually
async function updateGeodataNow(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const btn = document.getElementById('btn-update-geodata');
  const btnText = document.getElementById('btn-update-geodata-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Загрузка...';

  try {
    const res = await fetch('/api/geodata/update', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка загрузки баз');
    showToast('Базы GeoSite и GeoIP успешно обновлены!', 'success');
    await checkGeodataStatus();
  } catch (err) {
    showToast(`Ошибка обновления баз: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Обновить базы сейчас';
  }
}

// Open Add Routing Modal
function openAddRoutingModal() {
  document.getElementById('routing-id').value = '';
  document.getElementById('modal-routing-title').textContent = 'Новая конфигурация маршрутизации';
  document.getElementById('modal-routing-badge').textContent = '';
  document.getElementById('modal-routing-badge').className = 'card-badge';
  document.getElementById('routing-name').value = '';
  document.getElementById('routing-name').readOnly = false;
  document.getElementById('routing-desc').value = '';
  document.getElementById('routing-desc').readOnly = false;
  document.getElementById('btn-save-routing').classList.remove('hidden');

  const chkBlacklist = document.getElementById('routing-default-blacklist');
  const chkWhitelist = document.getElementById('routing-default-whitelist');
  if (chkBlacklist) {
    chkBlacklist.checked = false;
    chkBlacklist.disabled = false;
  }
  if (chkWhitelist) {
    chkWhitelist.checked = false;
    chkWhitelist.disabled = false;
  }

  // Set default builder options (BitTorrent direct, QUIC block, VoIP direct, Bypass RU on, GeoSite extra off, GeoAutoUpdate on)
  populateBuilderForm({
    defaultAction: 'proxy',
    bittorrent: 'direct',
    quic: 'block',
    voip: 'direct',
    bypassRu: true,
    bypassPrivate: true,
    blockNetbios: true,
    blockAds: false,
    geositeExtraProxy: false,
    geoAutoUpdate: true
  });

  const hiddenMode = document.getElementById('routing-mode');
  if (hiddenMode) hiddenMode.dataset.dirty = 'false';

  switchRoutingMode('builder');
  const initialJson = generateBuilderJson();
  setEditorContent('routing-content-json', initialJson);

  openModal('modal-routing');
  checkGeodataStatus();
  setTimeout(initRoutingTextareaSync, 50);
}

// Open Edit / View Routing Modal
function openRoutingModal(id) {
  const routing = appData.routings.find(r => r.id === id);
  if (!routing) return;

  document.getElementById('routing-id').value = routing.id;
  document.getElementById('modal-routing-title').textContent = routing.isSystem ? 'Системная маршрутизация' : 'Редактирование маршрутизации';
  
  const badge = document.getElementById('modal-routing-badge');
  if (routing.isSystem) {
    badge.className = 'card-badge badge-active';
    badge.textContent = '🔒 Нельзя изменить';
  } else {
    badge.className = 'card-badge';
    badge.textContent = '';
  }

  const nameInput = document.getElementById('routing-name');
  nameInput.value = routing.name;
  nameInput.readOnly = Boolean(routing.isSystem);

  const descInput = document.getElementById('routing-desc');
  descInput.value = routing.description || '';
  descInput.readOnly = Boolean(routing.isSystem);

  const isDefBlacklist = (appData.settings?.defaultRoutingBlacklist === routing.id);
  const isDefWhitelist = (appData.settings?.defaultRoutingWhitelist === routing.id);
  const chkBlacklist = document.getElementById('routing-default-blacklist');
  const chkWhitelist = document.getElementById('routing-default-whitelist');
  if (chkBlacklist) {
    chkBlacklist.checked = isDefBlacklist;
    chkBlacklist.disabled = false;
  }
  if (chkWhitelist) {
    chkWhitelist.checked = isDefWhitelist;
    chkWhitelist.disabled = false;
  }

  const saveBtn = document.getElementById('btn-save-routing');
  if (routing.isSystem) {
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Сохранить по умолчанию';
  } else {
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Сохранить маршрутизацию';
  }

  // Populate Builder or JSON Editor
  if (routing.builderConfig) {
    populateBuilderForm(routing.builderConfig);
    switchRoutingMode('builder');
  } else {
    switchRoutingMode('raw');
  }

  setEditorContent('routing-content-json', routing.content);
  openModal('modal-routing');
  checkGeodataStatus();
  setTimeout(initRoutingTextareaSync, 50);
}

// Submit Add or Edit Routing
async function onRoutingSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('routing-id').value;
  const name = document.getElementById('routing-name').value.trim();
  const description = document.getElementById('routing-desc').value.trim();
  const mode = document.getElementById('routing-mode')?.value || 'builder';
  const isDefaultBlacklist = Boolean(document.getElementById('routing-default-blacklist')?.checked);
  const isDefaultWhitelist = Boolean(document.getElementById('routing-default-whitelist')?.checked);

  let builderConfig = null;
  let content = '';

  if (mode === 'builder') {
    builderConfig = collectBuilderConfig();
    content = generateBuilderJson(builderConfig);
  } else {
    content = document.getElementById('routing-content-json').value.trim();
  }

  if (!name) {
    showToast('Укажите название маршрутизации', 'warning');
    return;
  }
  if (mode === 'raw' && !content) {
    showToast('Укажите содержимое routing.json', 'warning');
    return;
  }

  try {
    let url = '/api/routings';
    let method = 'POST';
    if (id) {
      url = `/api/routings/${id}`;
      method = 'PUT';
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, mode, builderConfig, content, isDefaultBlacklist, isDefaultWhitelist })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения маршрутизации');

    showToast(data.message || 'Маршрутизация сохранена', 'success');
    closeModal('modal-routing');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Delete Routing
async function deleteRouting(id, name) {
  if (!confirm(`Удалить конфигурацию маршрутизации "${name}"? Все подключения, использовавшие ее, переключатся на "Всё через VPN".`)) return;

  try {
    const res = await fetch(`/api/routings/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления');

    showToast(data.message || 'Маршрутизация удалена', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// SERVICE CONTROLS & STATUS
// ==============================================================================
async function pollServiceStatus() {
  try {
    const res = await fetch('/api/service/status');
    if (!res.ok) return;
    const statusData = await res.json();
    updateServiceStatusUI(statusData);
  } catch (e) {}
}

function updateServiceStatusUI(data) {
  if (!serviceStatusBadge || !serviceStatusText) return;
  lastServiceLog = data.output || data.error || 'Нет данных';

  serviceStatusBadge.className = 'service-status-badge';
  if (data.status === 'running') {
    serviceStatusBadge.classList.add('status-running');
    serviceStatusText.textContent = 'Работает';
    if (btnServiceStart) btnServiceStart.classList.add('hidden');
    if (btnServiceStop) btnServiceStop.classList.remove('hidden');
  } else if (data.status === 'stopped') {
    serviceStatusBadge.classList.add('status-stopped');
    serviceStatusText.textContent = 'Остановлен';
    if (btnServiceStart) btnServiceStart.classList.remove('hidden');
    if (btnServiceStop) btnServiceStop.classList.add('hidden');
  } else if (data.status === 'error') {
    serviceStatusBadge.classList.add('status-error');
    serviceStatusText.textContent = 'Ошибка';
  } else {
    serviceStatusBadge.classList.add('status-loading');
    serviceStatusText.textContent = 'Неизвестно';
  }

  // Update Core status badge
  const coreStatusText = document.getElementById('core-status-text');
  const coreStatusBadge = document.getElementById('core-status-badge');
  if (coreStatusText && data.core) {
    const isMihomo = (data.core === 'mihomo');
    coreStatusText.textContent = isMihomo ? 'Ядро: Mihomo' : 'Ядро: Xray';
    if (coreStatusBadge) {
      coreStatusBadge.classList.toggle('core-mihomo', isMihomo);
      coreStatusBadge.classList.toggle('core-xray', !isMihomo);
    }
  }

  updateCoreTabUI(data);
}

function updateCoreTabUI(data) {
  if (!data || !data.core) return;
  const isMihomo = (data.core === 'mihomo');
  const activeTitle = document.getElementById('core-active-title');
  if (activeTitle) {
    activeTitle.textContent = isMihomo ? 'Mihomo Meta (Запущено)' : 'Xray Core (Запущено)';
  }

  const cardXray = document.getElementById('card-core-xray');
  const cardMihomo = document.getElementById('card-core-mihomo');
  if (cardXray) cardXray.classList.toggle('active-core-card', !isMihomo);
  if (cardMihomo) cardMihomo.classList.toggle('active-core-card', isMihomo);

  const btnSwitchXray = document.getElementById('btn-switch-to-xray');
  const btnSwitchMihomo = document.getElementById('btn-switch-to-mihomo');
  if (btnSwitchXray) {
    btnSwitchXray.disabled = !isMihomo;
    btnSwitchXray.textContent = !isMihomo ? 'Текущее ядро' : 'Активировать Xray';
  }
  if (btnSwitchMihomo) {
    btnSwitchMihomo.disabled = isMihomo;
    btnSwitchMihomo.textContent = isMihomo ? 'Текущее ядро' : 'Активировать Mihomo';
  }
}

async function switchProxyCoreUI(targetCore) {
  const coreLabel = (targetCore === 'mihomo' ? 'Mihomo Meta' : 'Xray Core');
  const confirmed = confirm(`Переключить ядро проксирования XKeen на ${coreLabel}?\nСлужба XKeen будет перезапущена с новым ядром.`);
  if (!confirmed) return;

  showToast(`Переключение ядра на ${coreLabel}...`, 'info');
  try {
    const res = await fetch('/api/service/switch-core', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core: targetCore })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Ошибка смены ядра');

    showToast(result.message || 'Ядро успешно переключено', 'success');
    await pollServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function testProxyCoreConfigUI(coreName) {
  const terminal = document.getElementById('core-test-terminal');
  const logEl = document.getElementById('core-test-log');
  const titleEl = document.getElementById('core-test-title');
  if (terminal) terminal.classList.remove('hidden');
  if (logEl) logEl.textContent = 'Выполняется проверка конфигурации...';
  if (titleEl) titleEl.textContent = `Проверка конфигурации ${coreName === 'mihomo' ? 'Mihomo (xkeen -mtest)' : 'Xray (xkeen -xtest)'}...`;

  try {
    const res = await fetch('/api/service/test-config', { method: 'POST' });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Ошибка выполнения теста');

    const output = (result.output || '') + (result.error ? '\n' + result.error : '');
    if (logEl) logEl.textContent = output.trim() || 'Команда завершилась без вывода';
    if (result.ok) {
      showToast(`Конфигурация ${result.core.toUpperCase()} корректна!`, 'success');
    } else {
      showToast(`Обнаружены ошибки в конфигурации ${result.core.toUpperCase()}`, 'warning');
    }
  } catch (err) {
    if (logEl) logEl.textContent = 'Ошибка: ' + err.message;
    showToast(err.message, 'error');
  }
}

function startServicePolling() {
  pollServiceStatus();
  pollFailoverStatus();
  pollAutoFailoverStatus();
  if (servicePollingTimer) clearInterval(servicePollingTimer);
  servicePollingTimer = setInterval(() => {
    pollServiceStatus();
    pollFailoverStatus();
    pollAutoFailoverStatus();
    if (!appData.connections || appData.connections.length === 0) {
      loadData();
    }
  }, 8000);
}

async function controlService(action) {
  const btn = document.getElementById(`btn-service-${action}`);
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin-icon">⏳</span> <span>Выполнение...</span>';
  }

  try {
    const res = await fetch(`/api/service/${action}`, { method: 'POST' });
    const data = await res.json();
    updateServiceStatusUI(data);

    if (res.ok) {
      showToast(data.message || `Команда ${action} выполнена`, 'success');
    } else {
      showToast(data.message || `Ошибка выполнения команды ${action}`, 'error');
    }
  } catch (err) {
    showToast(`Ошибка связи с сервером: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

function onStatusBadgeClick() {
  document.getElementById('service-modal-log').textContent = lastServiceLog || 'Лог пуст';
  openModal('service-status-modal');
}

function copyServiceLog() {
  navigator.clipboard.writeText(lastServiceLog || '').then(() => {
    showToast('Лог службы скопирован в буфер обмена', 'success');
  }).catch(() => {
    showToast('Не удалось скопировать лог', 'warning');
  });
}

// ==============================================================================
// BACKUP & RESTORE
// ==============================================================================
let selectedBackupFile = null;

function downloadBackupZip() {
  window.location.href = '/api/backup/export';
  showToast('Загрузка резервной копии началась...', 'info');
}

function openBackupModal() {
  selectedBackupFile = null;
  const dropzoneText = document.getElementById('backup-dropzone-text');
  const btnExecute = document.getElementById('btn-execute-restore');
  const fileInput = document.getElementById('backup-file-input');
  if (fileInput) fileInput.value = '';
  if (dropzoneText) dropzoneText.innerHTML = 'Нажмите для выбора <strong>.zip</strong> или <strong>.json</strong> или перетащите файл';
  if (btnExecute) btnExecute.classList.add('hidden');
  openModal('modal-backup');
}

function onBackupFileSelected(e) {
  const file = (e.target && e.target.files && e.target.files[0]) || (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  if (!file) return;
  selectedBackupFile = file;

  const dropzoneText = document.getElementById('backup-dropzone-text');
  const btnExecute = document.getElementById('btn-execute-restore');
  if (dropzoneText) {
    dropzoneText.innerHTML = `Выбран файл: <strong>${escapeHtml(file.name)}</strong> (${(file.size / 1024).toFixed(1)} КБ)`;
  }
  if (btnExecute) btnExecute.classList.remove('hidden');
}

async function executeBackupRestore() {
  if (!selectedBackupFile) {
    showToast('Выберите файл резервной копии (.zip или .json)', 'warning');
    return;
  }

  const btnExecute = document.getElementById('btn-execute-restore');
  const origHtml = btnExecute ? btnExecute.innerHTML : '';
  if (btnExecute) {
    btnExecute.disabled = true;
    btnExecute.innerHTML = '<span class="spin-icon">⏳</span> <span>Восстановление...</span>';
  }

  try {
    const isZip = selectedBackupFile.name.toLowerCase().endsWith('.zip');
    let payload = {};

    if (isZip) {
      const arrayBuffer = await selectedBackupFile.arrayBuffer();
      const base64 = bufferToBase64(arrayBuffer);
      payload = { zipBase64: base64 };
    } else {
      const text = await selectedBackupFile.text();
      let json = null;
      try {
        json = JSON.parse(stripComments(text));
      } catch (pe) {
        throw new Error('Некорректный синтаксис JSON в файле резервной копии');
      }
      payload = { backupData: json };
    }

    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка восстановления из резервной копии');

    showToast(data.message || 'Резервная копия успешно восстановлена!', 'success');
    closeModal('settings-modal');
    await loadData();
    pollServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnExecute) {
      btnExecute.disabled = false;
      btnExecute.innerHTML = origHtml;
    }
  }
}

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// ==============================================================================
// SETTINGS
// ==============================================================================
function switchSettingsTab(tab) {
  const isGeneral = (tab === 'general');
  const isCore = (tab === 'core');
  const isAutoFailover = (tab === 'autofailover');
  const isFailover = (tab === 'failover');
  const isBackup = (tab === 'backup');

  const btnGeneral = document.getElementById('tab-btn-settings-general');
  const btnCore = document.getElementById('tab-btn-settings-core');
  const btnAutoFailover = document.getElementById('tab-btn-settings-autofailover');
  const btnBackup = document.getElementById('tab-btn-settings-backup');
  const btnFailover = document.getElementById('tab-btn-settings-failover');

  const contentGeneral = document.getElementById('settings-tab-content-general');
  const contentCore = document.getElementById('settings-tab-content-core');
  const contentAutoFailover = document.getElementById('settings-tab-content-autofailover');
  const contentBackup = document.getElementById('settings-tab-content-backup');
  const contentFailover = document.getElementById('settings-tab-content-failover');

  if (btnGeneral) btnGeneral.classList.toggle('active', isGeneral);
  if (btnCore) btnCore.classList.toggle('active', isCore);
  if (btnAutoFailover) btnAutoFailover.classList.toggle('active', isAutoFailover);
  if (btnBackup) btnBackup.classList.toggle('active', isBackup);
  if (btnFailover) btnFailover.classList.toggle('active', isFailover);

  if (contentGeneral) contentGeneral.classList.toggle('hidden', !isGeneral);
  if (contentCore) contentCore.classList.toggle('hidden', !isCore);
  if (contentAutoFailover) contentAutoFailover.classList.toggle('hidden', !isAutoFailover);
  if (contentBackup) contentBackup.classList.toggle('hidden', !isBackup);
  if (contentFailover) contentFailover.classList.toggle('hidden', !isFailover);

  if (isAutoFailover) {
    populateAutoFailoverForm();
  }

  if (isFailover) {
    populateFailoverForm();
  }

  if (!isBackup) {
    selectedBackupFile = null;
    const dropzoneText = document.getElementById('backup-dropzone-text');
    const btnExecute = document.getElementById('btn-execute-restore');
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) fileInput.value = '';
    if (dropzoneText) dropzoneText.innerHTML = 'Нажмите для выбора <strong>.zip</strong> или <strong>.json</strong> или перетащите файл';
    if (btnExecute) btnExecute.classList.add('hidden');
  }
}

function openCoreSettingsTab() {
  openSettingsModal();
  switchSettingsTab('core');
}

function openBackupModal() {
  openSettingsModal();
  switchSettingsTab('backup');
}

function openFailoverSettings() {
  openSettingsModal();
  switchSettingsTab('failover');
}

function openSettingsModal() {
  const s = appData.settings || {};
  document.getElementById('setting-outbound-path').value = s.outboundPath || '';
  document.getElementById('setting-routing-path').value = s.routingPath || '';
  document.getElementById('setting-restart-cmd').value = s.restartCommand || '';
  document.getElementById('setting-start-cmd').value = s.startCommand || '';
  document.getElementById('setting-stop-cmd').value = s.stopCommand || '';
  document.getElementById('setting-status-cmd').value = s.statusCommand || '';
  document.getElementById('setting-panel-port').value = s.port || 3000;
  const pingTimeoutEl = document.getElementById('setting-ping-timeout');
  if (pingTimeoutEl) pingTimeoutEl.value = s.pingTimeout || 3500;
  switchSettingsTab('general');
  openModal('settings-modal');
}

async function onSettingsSubmit(e) {
  e.preventDefault();
  const outboundPath = document.getElementById('setting-outbound-path').value.trim();
  const routingPath = document.getElementById('setting-routing-path').value.trim();
  const restartCommand = document.getElementById('setting-restart-cmd').value.trim();
  const startCommand = document.getElementById('setting-start-cmd').value.trim();
  const stopCommand = document.getElementById('setting-stop-cmd').value.trim();
  const statusCommand = document.getElementById('setting-status-cmd').value.trim();
  const port = parseInt(document.getElementById('setting-panel-port').value, 10);
  const pingTimeoutEl = document.getElementById('setting-ping-timeout');
  const pingTimeout = pingTimeoutEl ? (parseInt(pingTimeoutEl.value, 10) || 3500) : 3500;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outboundPath, routingPath, restartCommand, startCommand, stopCommand, statusCommand, port, pingTimeout })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения настроек');

    showToast(data.message || 'Настройки сохранены', 'success');
    closeModal('settings-modal');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==============================================================================
// FAILOVER (БЕЛЫЕ СПИСКИ) LOGIC
// ==============================================================================
let failoverState = null;

async function pollFailoverStatus() {
  try {
    const res = await fetch('/api/failover');
    if (!res.ok) return;
    const data = await res.json();
    failoverState = data;
    renderFailoverStatus(data);
  } catch (err) {
    console.debug('Failed to poll failover status:', err);
  }
}

function renderFailoverStatus(fo) {
  if (!fo) fo = failoverState;
  const badge = document.getElementById('failover-status-badge');
  const statusText = document.getElementById('failover-status-text');

  if (!badge || !statusText) return;

  if (!fo || !fo.enabled || !fo.primaryConnectionId || (!fo.backupConnectionId && (!fo.backupPoolConnectionIds || fo.backupPoolConnectionIds.length === 0))) {
    badge.classList.add('hidden');
  } else {
    badge.classList.remove('hidden');
    badge.className = 'failover-badge';

    if (fo.state === 'backup') {
      badge.classList.add('fo-backup');
      statusText.textContent = 'БС: Активен';
      badge.title = 'Режим Белых Списков АКТИВЕН (резервный профиль). Нажмите для настроек.';
    } else if (fo.state === 'suspended') {
      badge.classList.add('fo-suspended');
      statusText.textContent = 'БС: Пауза';
      badge.title = 'Пауза проверок после ручного переключения. Нажмите для настроек.';
    } else {
      badge.classList.add('fo-normal');
      statusText.textContent = 'БС: Авто (ОК)';
      badge.title = 'Основной VLESS работает штатно. Мониторинг БС активен. Нажмите для настроек.';
    }
  }

  updateFailoverLiveCard(fo);
}

function updateFailoverLiveCard(fo) {
  if (!fo) fo = failoverState;
  if (!fo) return;

  const stateBadge = document.getElementById('fo-state-badge');
  const statusLog = document.getElementById('fo-status-log');
  const lastCheckText = document.getElementById('fo-last-check-text');
  const failsText = document.getElementById('fo-fails-text');
  const successesText = document.getElementById('fo-successes-text');

  if (stateBadge) {
    stateBadge.className = 'fo-state-badge';
    if (!fo.enabled) {
      stateBadge.classList.add('disabled');
      stateBadge.textContent = 'Отключен';
    } else if (!fo.primaryConnectionId || !fo.backupConnectionId) {
      stateBadge.classList.add('disabled');
      stateBadge.textContent = 'Не настроен';
    } else if (fo.state === 'backup') {
      stateBadge.classList.add('backup');
      stateBadge.textContent = 'Режим БС (Резерв)';
    } else if (fo.state === 'suspended') {
      stateBadge.classList.add('suspended');
      stateBadge.textContent = 'Приостановлен (пауза)';
    } else {
      stateBadge.classList.add('normal');
      stateBadge.textContent = 'Штатный (Основной)';
    }
  }

  if (statusLog) {
    statusLog.textContent = fo.lastLog || 'Нет событий';
  }

  if (lastCheckText) {
    lastCheckText.textContent = fo.lastCheckAt ? formatTime(fo.lastCheckAt) : '-';
  }

  if (failsText) {
    failsText.textContent = `${fo.consecutiveFails || 0} / ${fo.failThreshold || 3}`;
  }

  if (successesText) {
    successesText.textContent = `${fo.consecutiveSuccesses || 0} / ${fo.recoveryThreshold || 3}`;
  }
}

function formatDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString([], {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (e) {
    return isoStr;
  }
}

async function loadFailoverHistoryUI() {
  const listEl = document.getElementById('fo-history-list');
  const countEl = document.getElementById('fo-history-count');
  if (!listEl) return;

  try {
    const res = await fetch('/api/failover/history');
    if (!res.ok) throw new Error('Ошибка загрузки журнала');
    const data = await res.json();
    const history = (data && Array.isArray(data.history)) ? data.history : [];

    if (countEl) {
      countEl.textContent = `${history.length}`;
    }

    if (history.length === 0) {
      listEl.innerHTML = '<div class="fo-history-empty">Автоматических переключений еще не зафиксировано.<br><small style="opacity:0.7">События смены профилей будут отображаться здесь.</small></div>';
      return;
    }

    listEl.innerHTML = history.map(item => {
      const isBackup = (item.event === 'switch_to_backup');
      const badgeClass = isBackup ? 'backup' : 'primary';
      const itemClass = isBackup ? 'fo-item-backup' : 'fo-item-primary';
      const badgeText = isBackup ? '⚡ Переход на БС' : '↩ Возврат на основной';

      return `
        <div class="fo-history-item ${itemClass}">
          <div class="fo-item-top">
            <span class="fo-item-badge ${badgeClass}">${badgeText}</span>
            <span class="fo-item-time">${formatDateTime(item.timestamp)}</span>
          </div>
          <div class="fo-item-direction">
            <span>${escapeHtml(item.fromName || 'Неизвестно')}</span>
            <span class="fo-arrow">➔</span>
            <strong>${escapeHtml(item.toName || 'Неизвестно')}</strong>
          </div>
          <div class="fo-item-reason">${escapeHtml(item.reason || '')}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<div class="fo-history-empty" style="color:#ef4444">Не удалось загрузить журнал: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function clearFailoverHistoryUI() {
  if (!confirm('Вы действительно хотите полностью очистить журнал автопереключений?')) {
    return;
  }

  try {
    const res = await fetch('/api/failover/history/clear', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка очистки журнала');

    showToast(data.message || 'Журнал переключений очищен', 'success');
    await loadFailoverHistoryUI();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function buildFailoverOptions(connections, groups, isBackupSelect = false) {
  let html = '<option value="">-- Выберите профиль или группу/подписку --</option>';

  // 1. Подписки
  const subs = (groups || []).filter(g => g.isSubscription);
  if (subs.length > 0) {
    html += '<optgroup label="🌐 Подписки целиком (с автотестом узлов перед переключением)">';
    subs.forEach(s => {
      const count = connections.filter(c => c.groupId === s.id).length;
      const typeStr = s.targetList === 'whitelist' ? ' [БС]' : (s.targetList === 'blacklist' ? ' [ЧС]' : ' [СМ]');
      html += `<option value="sub:${escapeHtml(s.id)}">🌐 Подписка «${escapeHtml(s.name)}»${typeStr} (${count} серв.)</option>`;
    });
    html += '</optgroup>';
  }

  // 2. Группы
  const nonSubs = (groups || []).filter(g => !g.isSubscription);
  if (nonSubs.length > 0) {
    html += '<optgroup label="📂 Группы подключений целиком">';
    nonSubs.forEach(g => {
      const count = connections.filter(c => c.groupId === g.id).length;
      html += `<option value="group:${escapeHtml(g.id)}">📂 Группа «${escapeHtml(g.name)}» (${count} серв.)</option>`;
    });
    html += '</optgroup>';
  }

  // 3. Одиночные подключения (Белые списки)
  const wlConns = connections.filter(c => c.targetList === 'whitelist');
  if (wlConns.length > 0) {
    html += `<optgroup label="⚡ Одиночные профили (Белые списки${isBackupSelect ? ' — рекомендуются для резерва' : ''})">`;
    wlConns.forEach(c => {
      const isAct = (c.id === appData.activeConnectionId) ? ' [Активно]' : '';
      const flag = getFlagEmoji(c.countryCode);
      const flagPrefix = flag ? `${flag} ` : '';
      const pingStr = c.lastPing ? ` • ${c.lastPing} ms` : '';
      html += `<option value="${escapeHtml(c.id)}">${flagPrefix}${escapeHtml(c.name)}${isAct}${pingStr} (${escapeHtml(c.serverAddress || '')})</option>`;
    });
    html += '</optgroup>';
  }

  // 4. Одиночные подключения (Черные списки / СМ)
  const otherConns = connections.filter(c => c.targetList !== 'whitelist');
  if (otherConns.length > 0) {
    html += '<optgroup label="⚡ Одиночные профили (Черные списки / СМ)">';
    otherConns.forEach(c => {
      const isAct = (c.id === appData.activeConnectionId) ? ' [Активно]' : '';
      const flag = getFlagEmoji(c.countryCode);
      const flagPrefix = flag ? `${flag} ` : '';
      const pingStr = c.lastPing ? ` • ${c.lastPing} ms` : '';
      html += `<option value="${escapeHtml(c.id)}">${flagPrefix}${escapeHtml(c.name)}${isAct}${pingStr} (${escapeHtml(c.serverAddress || '')})</option>`;
    });
    html += '</optgroup>';
  }

  return html;
}

async function populateFailoverForm() {
  const primarySelect = document.getElementById('fo-primary-conn');
  if (!primarySelect) return;

  const connections = (appData && appData.connections) || [];
  const groups = (appData && appData.groups) || [];

  primarySelect.innerHTML = buildFailoverOptions(connections, groups, false);

  try {
    const res = await fetch('/api/failover');
    if (res.ok) {
      failoverState = await res.json();
    }
  } catch (e) {}

  const fo = (failoverState && failoverState.failover) || failoverState || {};

  const enabledInput = document.getElementById('fo-enabled');
  if (enabledInput) {
    enabledInput.checked = !!fo.enabled;
    updateFailoverToggleUI(!!fo.enabled);
  }

  // Strategy
  const strategySelect = document.getElementById('fo-strategy');
  if (strategySelect) {
    strategySelect.value = fo.strategy || 'lowest_ping';
  }

  // Primary
  if (fo.primaryConnectionId) {
    primarySelect.value = fo.primaryConnectionId;
  } else if (appData && appData.activeConnectionId) {
    primarySelect.value = appData.activeConnectionId;
  }

  // Pool container for Failover (Белые списки)
  const poolContainer = document.getElementById('fo-pool-container');
  if (poolContainer) {
    let savedPool = [];
    if (Array.isArray(fo.backupPoolConnectionIds) && fo.backupPoolConnectionIds.length > 0) {
      savedPool = fo.backupPoolConnectionIds;
    } else if (fo.backupConnectionId) {
      savedPool = [fo.backupConnectionId];
    }
    poolContainer.innerHTML = buildPoolListHtml('fo', savedPool);
    initPoolFilterBs('fo');
  }

  const intervalInput = document.getElementById('fo-interval');
  if (intervalInput) intervalInput.value = fo.checkIntervalSec || 25;

  const failThreshInput = document.getElementById('fo-fail-threshold');
  if (failThreshInput) failThreshInput.value = fo.failThreshold || 3;

  const recThreshInput = document.getElementById('fo-recovery-threshold');
  if (recThreshInput) recThreshInput.value = fo.recoveryThreshold || 3;

  const ruHostInput = document.getElementById('fo-ru-host');
  if (ruHostInput) ruHostInput.value = fo.ruCheckHost || '77.88.8.8';

  const canaryUrlInput = document.getElementById('fo-canary-url');
  if (canaryUrlInput) canaryUrlInput.value = fo.canaryUrl || 'http://cp.cloudflare.com/generate_204';

  updateFailoverLiveCard(fo);
  loadFailoverHistoryUI();
}

function updateFailoverToggleUI(enabled) {
  const foCard = document.getElementById('fo-status-panel');
  if (foCard) {
    foCard.style.opacity = enabled ? '1' : '0.6';
  }
}

function onFailoverToggleChange() {
  const isEnabled = document.getElementById('fo-enabled')?.checked;
  updateFailoverToggleUI(isEnabled);
}

async function onFailoverToggleClick() {
  const toggle = document.getElementById('fo-enabled');
  if (!toggle) return;
  const enabled = toggle.checked;

  const primarySelect = document.getElementById('fo-primary-conn');
  const primaryConnId = (primarySelect && primarySelect.value) || (failoverState && failoverState.primaryConnectionId) || (appData && appData.activeConnectionId) || '';

  const poolCheckboxes = document.querySelectorAll('#fo-pool-container input[type="checkbox"]:checked');
  let backupPool = Array.from(poolCheckboxes).map(cb => cb.value);
  if (backupPool.length === 0 && failoverState && Array.isArray(failoverState.backupPoolConnectionIds) && failoverState.backupPoolConnectionIds.length > 0) {
    backupPool = failoverState.backupPoolConnectionIds;
  }
  if (backupPool.length === 0 && failoverState && failoverState.backupConnectionId) {
    backupPool = [failoverState.backupConnectionId];
  }

  if (enabled) {
    if (backupPool.length === 0 || !primaryConnId) {
      toggle.checked = false;
      updateFailoverToggleUI(false);

      if (backupPool.length === 0) {
        showToast('Не выбраны резервные подключения (для Белых Списков)!', 'warning');
      } else {
        showToast('Не выбрано основное подключение!', 'warning');
      }
      return;
    }
  }

  updateFailoverToggleUI(enabled);

  try {
    const res = await fetch('/api/failover/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        primaryConnectionId: primaryConnId,
        backupPoolConnectionIds: backupPool
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || 'Ошибка переключения');
    failoverState = data.failover;
    renderFailoverStatus(failoverState);
    showToast(data.message || (enabled ? 'Failover БС включен' : 'Failover БС отключен'), 'success');
  } catch (err) {
    showToast('Не удалось переключить Failover: ' + err.message, 'error');
    toggle.checked = !enabled;
    updateFailoverToggleUI(!enabled);
  }
}

async function onFailoverPrimarySelectChange() {
  const toggle = document.getElementById('fo-enabled');
  if (!toggle || !toggle.checked) return;

  const primarySelect = document.getElementById('fo-primary-conn');
  const primaryConnId = primarySelect ? primarySelect.value : '';

  if (!primaryConnId) {
    toggle.checked = false;
    updateFailoverToggleUI(false);
    try {
      await fetch('/api/failover/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });
      if (failoverState) failoverState.enabled = false;
      renderFailoverStatus(failoverState);
      showToast('Основное подключение не задано. Режим БС автоматически отключен.', 'warning');
    } catch (e) {}
  }
}

async function onFailoverConnSelectChange() {
  await onFailoverPrimarySelectChange();
}

async function onFailoverFormSubmit(e) {
  e.preventDefault();

  const enabled = document.getElementById('fo-enabled').checked;
  const primaryConnectionId = document.getElementById('fo-primary-conn').value;
  const strategy = document.getElementById('fo-strategy') ? document.getElementById('fo-strategy').value : 'lowest_ping';

  const poolCheckboxes = document.querySelectorAll('#fo-pool-container input[type="checkbox"]:checked');
  const backupPoolConnectionIds = Array.from(poolCheckboxes).map(cb => cb.value);

  const checkIntervalSec = parseInt(document.getElementById('fo-interval').value, 10) || 25;
  const failThreshold = parseInt(document.getElementById('fo-fail-threshold').value, 10) || 3;
  const recoveryThreshold = parseInt(document.getElementById('fo-recovery-threshold').value, 10) || 3;
  const ruHostInput = document.getElementById('fo-ru-host');
  const ruCheckHost = (ruHostInput ? ruHostInput.value : '').trim() || '77.88.8.8';
  const canaryUrlInput = document.getElementById('fo-canary-url');
  const canaryUrl = (canaryUrlInput ? canaryUrlInput.value : '').trim() || 'http://cp.cloudflare.com/generate_204';

  if (enabled) {
    if (!primaryConnectionId) {
      showToast('Выберите основное подключение (обычный режим)', 'warning');
      return;
    }
    if (backupPoolConnectionIds.length === 0) {
      showToast('Выберите хотя бы одно резервное подключение (для Белых Списков)', 'warning');
      return;
    }
  }

  const btnSave = document.getElementById('btn-save-failover');
  const origText = btnSave ? btnSave.innerHTML : '';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<span class="spin-icon">⏳</span> <span>Сохранение...</span>';
  }

  try {
    const res = await fetch('/api/failover/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        strategy,
        primaryConnectionId,
        backupPoolConnectionIds,
        checkIntervalSec,
        failThreshold,
        recoveryThreshold,
        ruCheckHost,
        ruCheckPort: 53,
        canaryUrl
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Ошибка сохранения настроек');
    }

    failoverState = data.failover;
    renderFailoverStatus(failoverState);
    showToast(data.message || 'Настройки режима БС сохранены', 'success');
    closeModal('settings-modal');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = origText;
    }
  }
}

// ==============================================================================
// AUTO-FAILOVER (АВТОРЕЗЕРВ ПОДКЛЮЧЕНИЙ) LOGIC
// ==============================================================================
let autoFailoverState = null;

function openAutoFailoverSettings() {
  openSettingsModal();
  switchSettingsTab('autofailover');
}

async function pollAutoFailoverStatus() {
  try {
    const res = await fetch('/api/autofailover');
    if (!res.ok) return;
    const data = await res.json();
    autoFailoverState = data.autoFailover || {};
    renderAutoFailoverStatus(autoFailoverState);
  } catch (err) {
    console.debug('Failed to poll autofailover status:', err);
  }
}

function renderAutoFailoverStatus(af) {
  if (!af) af = autoFailoverState;
  const badge = document.getElementById('autofailover-status-badge');
  const statusText = document.getElementById('autofailover-status-text');

  if (badge && statusText) {
    if (!af || !af.enabled) {
      badge.classList.add('hidden');
    } else if (af.state === 'backup') {
      badge.classList.remove('hidden');
      badge.className = 'failover-badge fo-backup';
      const conns = (appData && appData.connections) || [];
      const backupConn = conns.find(c => c.id === af.activeBackupId);
      statusText.textContent = backupConn ? `Авто: ${backupConn.name}` : 'Авто: Резерв';
    } else if (af.state === 'suspended') {
      badge.classList.remove('hidden');
      badge.className = 'failover-badge fo-suspended';
      statusText.textContent = 'Авто: Пауза';
    } else {
      badge.classList.add('hidden');
    }
  }

  updateAutoFailoverLiveCard(af);
}

function updateAutoFailoverLiveCard(af) {
  if (!af) af = autoFailoverState;
  if (!af) return;

  const stateBadge = document.getElementById('af-state-badge');
  const statusLog = document.getElementById('af-status-log');
  const lastCheckText = document.getElementById('af-last-check-text');
  const failsText = document.getElementById('af-fails-text');
  const successesText = document.getElementById('af-successes-text');

  if (stateBadge) {
    stateBadge.className = 'fo-state-badge';
    if (!af.enabled) {
      stateBadge.classList.add('disabled');
      stateBadge.textContent = 'Отключен';
    } else if (af.state === 'backup') {
      stateBadge.classList.add('backup');
      stateBadge.textContent = 'Резерв активен';
    } else if (af.state === 'suspended') {
      stateBadge.classList.add('suspended');
      stateBadge.textContent = 'Приостановлен';
    } else {
      stateBadge.classList.add('normal');
      stateBadge.textContent = 'Штатный (Основной)';
    }
  }

  if (statusLog) {
    statusLog.textContent = af.lastLog || 'Нет событий';
  }

  if (lastCheckText) {
    lastCheckText.textContent = af.lastCheckAt ? formatTime(af.lastCheckAt) : '-';
  }

  if (failsText) {
    failsText.textContent = `${af.consecutiveFails || 0} / ${af.failThreshold || 3}`;
  }

  if (successesText) {
    successesText.textContent = `${af.consecutiveSuccesses || 0} / ${af.recoveryThreshold || 3}`;
  }
}

async function loadAutoFailoverHistoryUI() {
  const listEl = document.getElementById('af-history-list');
  const countEl = document.getElementById('af-history-count');
  if (!listEl) return;

  try {
    const res = await fetch('/api/autofailover/history');
    if (!res.ok) throw new Error('Ошибка загрузки журнала');
    const data = await res.json();
    const history = (data && Array.isArray(data.history)) ? data.history : [];

    if (countEl) {
      countEl.textContent = `${history.length}`;
    }

    if (history.length === 0) {
      listEl.innerHTML = '<div class="fo-history-empty">Автоматических переключений еще не зафиксировано.<br><small style="opacity:0.7">События резервирования будут отображаться здесь.</small></div>';
      return;
    }

    listEl.innerHTML = history.map(item => {
      const isBackup = (item.event === 'switch_to_backup');
      const badgeClass = isBackup ? 'backup' : 'primary';
      const itemClass = isBackup ? 'fo-item-backup' : 'fo-item-primary';
      const badgeText = isBackup ? '⚡ Включен резерв' : '↩ Возврат на основной';

      return `
        <div class="fo-history-item ${itemClass}">
          <div class="fo-item-top">
            <span class="fo-item-badge ${badgeClass}">${badgeText}</span>
            <span class="fo-item-time">${formatDateTime(item.timestamp)}</span>
          </div>
          <div class="fo-item-direction">
            <span>${escapeHtml(item.fromName || 'Неизвестно')}</span>
            <span class="fo-arrow">➔</span>
            <strong>${escapeHtml(item.toName || 'Неизвестно')}</strong>
          </div>
          <div class="fo-item-reason">${escapeHtml(item.reason || '')}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<div class="fo-history-empty" style="color:#ef4444">Не удалось загрузить журнал: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function clearAutoFailoverHistoryUI() {
  if (!confirm('Вы действительно хотите полностью очистить журнал авто-резерва?')) {
    return;
  }

  try {
    const res = await fetch('/api/autofailover/history/clear', { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'Журнал авто-резерва очищен', 'success');
    await loadAutoFailoverHistoryUI();
  } catch (err) {
    showToast('Не удалось очистить журнал', 'error');
  }
}

async function populateAutoFailoverForm() {
  try {
    const res = await fetch('/api/autofailover');
    if (res.ok) {
      const data = await res.json();
      autoFailoverState = data.autoFailover || {};
    }
  } catch (e) {}

  const af = autoFailoverState || {};
  const conns = (appData && appData.connections) || [];

  // Toggle
  const toggle = document.getElementById('af-enabled');
  if (toggle) {
    toggle.checked = Boolean(af.enabled);
    updateAutoFailoverToggleUI(Boolean(af.enabled));
  }

  // Strategy
  const strategySelect = document.getElementById('af-strategy');
  if (strategySelect) {
    strategySelect.value = af.strategy || 'lowest_ping';
  }

  // Primary mode
  const modeSelect = document.getElementById('af-primary-mode');
  if (modeSelect) {
    modeSelect.value = af.primaryMode || 'manual_active';
    onAutoFailoverPrimaryModeChange();
  }

  // Specific primary dropdown
  const specificPrimarySelect = document.getElementById('af-specific-primary-conn');
  if (specificPrimarySelect) {
    specificPrimarySelect.innerHTML = conns.map(c => {
      const flag = getFlagEmoji(c.countryCode);
      const flagPrefix = flag ? `${flag} ` : '';
      const isAct = (c.id === appData.activeConnectionId) ? ' [Активно]' : '';
      return `<option value="${escapeHtml(c.id)}">${flagPrefix}${escapeHtml(c.name)}${isAct} (${escapeHtml(c.serverAddress)}:${c.serverPort})</option>`;
    }).join('');

    if (af.specificPrimaryId) {
      specificPrimarySelect.value = af.specificPrimaryId;
    }
  }

  // Pool container (organized by Group / Subscription)
  const poolContainer = document.getElementById('af-pool-container');
  if (poolContainer) {
    const savedPool = Array.isArray(af.poolConnectionIds) && af.poolConnectionIds.length > 0
      ? af.poolConnectionIds
      : conns.map(c => c.id);
    poolContainer.innerHTML = buildPoolListHtml('af', savedPool);
    initPoolFilterBs('af');
  }

  // Auto Return
  const autoReturnToggle = document.getElementById('af-auto-return');
  if (autoReturnToggle) {
    autoReturnToggle.checked = af.autoReturn !== undefined ? Boolean(af.autoReturn) : true;
  }

  // Advanced fields
  const intervalInput = document.getElementById('af-interval');
  if (intervalInput) intervalInput.value = af.checkIntervalSec || 20;

  const failThreshInput = document.getElementById('af-fail-threshold');
  if (failThreshInput) failThreshInput.value = af.failThreshold || 3;

  const recThreshInput = document.getElementById('af-recovery-threshold');
  if (recThreshInput) recThreshInput.value = af.recoveryThreshold || 3;

  const canaryInput = document.getElementById('af-canary-url');
  if (canaryInput) canaryInput.value = af.canaryUrl || 'http://cp.cloudflare.com/generate_204';

  updateAutoFailoverLiveCard(af);
  loadAutoFailoverHistoryUI();
}

function buildPoolListHtml(prefix, savedPool) {
  const conns = (appData && appData.connections) || [];
  const groups = (appData && appData.groups) || [];
  if (!Array.isArray(savedPool)) savedPool = [];
  let poolHtml = '';

  groups.forEach(g => {
    const isGroupWl = (g.targetList === 'whitelist');
    const gConns = conns.filter(c => c.groupId === g.id);
    if (gConns.length === 0) return;

    const groupTargetVal = g.isSubscription ? `sub:${g.id}` : `group:${g.id}`;
    const isGroupChecked = savedPool.includes(groupTargetVal) || (gConns.length > 0 && gConns.every(c => savedPool.includes(c.id)));

    const wlCount = gConns.filter(c => c.targetList === 'whitelist' || isGroupWl).length;
    const hasWl = isGroupWl || (wlCount > 0);

    const connsHtml = gConns.map(c => {
      const isWl = (c.targetList === 'whitelist') || isGroupWl;
      const isChecked = savedPool.includes(c.id) || savedPool.includes(groupTargetVal);
      const flag = getFlagEmoji(c.countryCode);
      const flagHtml = flag ? `<span class="conn-flag">${flag}</span>` : '';
      const pingText = c.lastPing ? `${c.lastPing} ms` : (c.lastPingStatus === 'unreachable' ? 'Недоступен' : '–');
      const pingClass = c.lastPing ? 'ok' : '';

      const targetBadge = (c.targetList === 'whitelist')
        ? '<span class="group-target-badge bs pool-target-badge" title="Белые списки">БС</span>'
        : (c.targetList === 'blacklist'
          ? '<span class="group-target-badge cs pool-target-badge" title="Черные списки">ЧС</span>'
          : (c.targetList === 'mixed'
            ? '<span class="group-target-badge sm pool-target-badge" title="Смешанное">СМ</span>'
            : ''));

      return `
        <div class="pool-conn-item" data-is-whitelist="${isWl ? '1' : '0'}" onclick="togglePoolConnItem('${prefix}', '${c.id}')">
          <div class="pool-conn-left">
            <input type="checkbox" class="pool-conn-checkbox" data-group-id="${g.id}" id="${prefix}-pool-conn-${c.id}" value="${c.id}" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation()">
            <label class="pool-conn-name" for="${prefix}-pool-conn-${c.id}" onclick="event.stopPropagation()">
              ${flagHtml}
              <span>${escapeHtml(c.name)}</span>
              ${targetBadge}
            </label>
          </div>
          <div class="pool-conn-right">
            <span class="pool-conn-host">${escapeHtml(c.serverAddress)}</span>
            <span class="pool-conn-ping ${pingClass}">${pingText}</span>
          </div>
        </div>
      `;
    }).join('');

    const groupTargetBadge = isGroupWl
      ? '<span class="group-target-badge bs" style="font-size:0.65rem; padding:1px 5px; margin-left:6px;" title="Группа: Белые списки">БС</span>'
      : (g.targetList === 'blacklist'
        ? '<span class="group-target-badge cs" style="font-size:0.65rem; padding:1px 5px; margin-left:6px;" title="Группа: Черные списки">ЧС</span>'
        : (g.targetList === 'mixed'
          ? '<span class="group-target-badge sm" style="font-size:0.65rem; padding:1px 5px; margin-left:6px;" title="Смешанная группа">СМ</span>'
          : ''));

    poolHtml += `
      <div class="pool-group-block collapsed" id="${prefix}-pool-group-block-${g.id}" data-group-id="${g.id}" data-has-whitelist="${hasWl ? '1' : '0'}" data-is-whitelist="${isGroupWl ? '1' : '0'}">
        <div class="pool-group-header" onclick="togglePoolGroupCollapse('${prefix}', '${g.id}', event)">
          <div class="pool-group-left">
            <span class="pool-group-arrow collapsed" id="${prefix}-pool-group-arrow-${g.id}">▼</span>
            <input type="checkbox" class="pool-group-checkbox" id="${prefix}-pool-group-${g.id}" value="${groupTargetVal}" ${isGroupChecked ? 'checked' : ''} onchange="onPoolGroupCheckboxChange('${prefix}', '${g.id}', event)" onclick="event.stopPropagation()">
            <label class="pool-group-label" for="${prefix}-pool-group-${g.id}" onclick="event.stopPropagation()">
              <span class="pool-group-icon">${g.isSubscription ? '🌐' : '📂'}</span>
              <strong>${escapeHtml(g.name)}</strong>
              ${groupTargetBadge}
              <span class="pool-group-count pool-count-all">(${gConns.length} серв.)</span>
              <span class="pool-group-count pool-count-bs" style="display:none; color:#38bdf8;">(${wlCount} БС)</span>
            </label>
          </div>
          <div class="pool-group-actions" onclick="event.stopPropagation()">
            <button type="button" class="btn-text-action" onclick="toggleGroupPoolConns('${prefix}', '${g.id}', true)">Все</button>
            <span style="opacity:0.3;">|</span>
            <button type="button" class="btn-text-action" onclick="toggleGroupPoolConns('${prefix}', '${g.id}', false)">Снять</button>
          </div>
        </div>
        <div class="pool-group-items hidden" id="${prefix}-pool-group-items-${g.id}">
          ${connsHtml}
        </div>
      </div>
    `;
  });

  return poolHtml;
}

function initPoolFilterBs(prefix) {
  const checkbox = document.getElementById(`${prefix}-filter-bs`);
  const textEl = document.getElementById(`${prefix}-filter-bs-text`);
  const labelEl = document.getElementById(`${prefix}-filter-bs-label`);

  const conns = (appData && appData.connections) || [];
  const groups = (appData && appData.groups) || [];
  const bsCount = conns.filter(c => {
    const g = groups.find(grp => grp.id === c.groupId);
    return c.targetList === 'whitelist' || (g && g.targetList === 'whitelist');
  }).length;

  if (textEl) {
    textEl.textContent = `🛡️ Только БС (${bsCount})`;
  }

  const savedState = localStorage.getItem(`xkeen_${prefix}_filter_bs`);
  if (checkbox) {
    if (savedState !== null) {
      checkbox.checked = (savedState === '1');
    }
    if (labelEl) {
      labelEl.classList.toggle('active', checkbox.checked);
    }
    onPoolFilterBsChange(prefix, false);
  }
}

function onPoolFilterBsChange(prefix, save = true) {
  const checkbox = document.getElementById(`${prefix}-filter-bs`);
  const labelEl = document.getElementById(`${prefix}-filter-bs-label`);
  const isOnlyBs = !!(checkbox && checkbox.checked);

  if (labelEl) {
    labelEl.classList.toggle('active', isOnlyBs);
  }
  if (save) {
    localStorage.setItem(`xkeen_${prefix}_filter_bs`, isOnlyBs ? '1' : '0');
  }

  const container = document.getElementById(`${prefix}-pool-container`);
  if (!container) return;

  container.classList.toggle('filter-only-bs', isOnlyBs);

  container.querySelectorAll('.pool-count-all').forEach(el => {
    el.style.display = isOnlyBs ? 'none' : 'inline';
  });
  container.querySelectorAll('.pool-count-bs').forEach(el => {
    el.style.display = isOnlyBs ? 'inline' : 'none';
  });

  const emptyNoticeId = `${prefix}-pool-empty-notice`;
  let emptyNotice = document.getElementById(emptyNoticeId);
  const visibleGroups = container.querySelectorAll(isOnlyBs ? '.pool-group-block[data-has-whitelist="1"]' : '.pool-group-block');

  if (visibleGroups.length === 0) {
    if (!emptyNotice) {
      emptyNotice = document.createElement('div');
      emptyNotice.id = emptyNoticeId;
      emptyNotice.className = 'pool-empty-notice';
      emptyNotice.style.cssText = 'padding:24px 16px; text-align:center; color:var(--text-muted); font-size:0.88rem;';
      emptyNotice.innerHTML = '🛡️ Нет подключений или групп с отметкой <strong>«Белые списки (БС)»</strong>.<br><small style="opacity:0.75; display:block; margin-top:6px;">Снимите фильтр «Только БС» или укажите тип «БС» в карточке подключения.</small>';
      container.appendChild(emptyNotice);
    } else {
      emptyNotice.style.display = 'block';
    }
  } else if (emptyNotice) {
    emptyNotice.style.display = 'none';
  }
}

function togglePoolConnItem(prefixOrConnId, connId) {
  let p = 'af';
  let cid = prefixOrConnId;
  if (connId !== undefined) {
    p = prefixOrConnId;
    cid = connId;
  }
  const cb = document.getElementById(`${p}-pool-conn-${cid}`);
  if (cb) {
    cb.checked = !cb.checked;
  }
}

function togglePoolGroupCollapse(prefixOrGroupId, groupIdOrEvent, event) {
  let p = 'af';
  let gid = prefixOrGroupId;
  let ev = groupIdOrEvent;
  if (event !== undefined || typeof groupIdOrEvent === 'string') {
    p = prefixOrGroupId;
    gid = groupIdOrEvent;
    ev = event;
  }
  if (ev && ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON')) {
    return;
  }
  const block = document.getElementById(`${p}-pool-group-block-${gid}`);
  const items = document.getElementById(`${p}-pool-group-items-${gid}`);
  const arrow = document.getElementById(`${p}-pool-group-arrow-${gid}`);
  if (!items) return;
  const isHidden = items.classList.contains('hidden');
  if (isHidden) {
    items.classList.remove('hidden');
    if (block) block.classList.remove('collapsed');
    if (arrow) {
      arrow.classList.remove('collapsed');
      arrow.classList.add('expanded');
    }
  } else {
    items.classList.add('hidden');
    if (block) block.classList.add('collapsed');
    if (arrow) {
      arrow.classList.add('collapsed');
      arrow.classList.remove('expanded');
    }
  }
}

function toggleAllPoolGroupsCollapse(prefixOrCollapse, collapse) {
  let p = 'af';
  let col = prefixOrCollapse;
  if (collapse !== undefined) {
    p = prefixOrCollapse;
    col = collapse;
  }
  const container = document.getElementById(`${p}-pool-container`);
  if (!container) return;
  const blocks = container.querySelectorAll('.pool-group-block');
  blocks.forEach(block => {
    const gid = block.dataset.groupId;
    const items = document.getElementById(`${p}-pool-group-items-${gid}`);
    const arrow = document.getElementById(`${p}-pool-group-arrow-${gid}`);
    if (items) {
      if (col) {
        items.classList.add('hidden');
      } else {
        items.classList.remove('hidden');
      }
    }
    if (block) {
      if (col) {
        block.classList.add('collapsed');
      } else {
        block.classList.remove('collapsed');
      }
    }
    if (arrow) {
      if (col) {
        arrow.classList.add('collapsed');
        arrow.classList.remove('expanded');
      } else {
        arrow.classList.remove('collapsed');
        arrow.classList.add('expanded');
      }
    }
  });
}

function onPoolGroupCheckboxChange(prefixOrGroupId, groupIdOrEvent, event) {
  let p = 'af';
  let gid = prefixOrGroupId;
  let ev = groupIdOrEvent;
  if (event !== undefined || typeof groupIdOrEvent === 'string') {
    p = prefixOrGroupId;
    gid = groupIdOrEvent;
    ev = event;
  }
  const isChecked = ev && ev.target ? ev.target.checked : false;
  const container = document.getElementById(`${p}-pool-container`);
  const isOnlyBs = container && container.classList.contains('filter-only-bs');
  const selector = isOnlyBs
    ? `#${p}-pool-group-items-${gid} .pool-conn-item[data-is-whitelist="1"] .pool-conn-checkbox`
    : `#${p}-pool-group-items-${gid} .pool-conn-checkbox`;
  const childCbs = document.querySelectorAll(selector);
  childCbs.forEach(cb => { cb.checked = isChecked; });
}

function toggleGroupPoolConns(prefixOrGroupId, groupIdOrSelect, select) {
  let p = 'af';
  let gid = prefixOrGroupId;
  let sel = groupIdOrSelect;
  if (select !== undefined || typeof groupIdOrSelect === 'string') {
    p = prefixOrGroupId;
    gid = groupIdOrSelect;
    sel = select;
  }
  const groupCb = document.getElementById(`${p}-pool-group-${gid}`);
  if (groupCb) groupCb.checked = !!sel;
  const container = document.getElementById(`${p}-pool-container`);
  const isOnlyBs = container && container.classList.contains('filter-only-bs');
  const selector = isOnlyBs
    ? `#${p}-pool-group-items-${gid} .pool-conn-item[data-is-whitelist="1"] .pool-conn-checkbox`
    : `#${p}-pool-group-items-${gid} .pool-conn-checkbox`;
  const childCbs = document.querySelectorAll(selector);
  childCbs.forEach(cb => { cb.checked = !!sel; });
}

function toggleAllPool(prefixOrSelect, select) {
  let p = 'af';
  let sel = prefixOrSelect;
  if (select !== undefined) {
    p = prefixOrSelect;
    sel = select;
  }
  const container = document.getElementById(`${p}-pool-container`);
  if (!container) return;
  const isOnlyBs = container.classList.contains('filter-only-bs');
  if (isOnlyBs) {
    container.querySelectorAll('.pool-conn-item[data-is-whitelist="1"] .pool-conn-checkbox').forEach(cb => { cb.checked = !!sel; });
    container.querySelectorAll('.pool-group-block[data-has-whitelist="1"] .pool-group-checkbox').forEach(cb => { cb.checked = !!sel; });
  } else {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = !!sel; });
  }
}

function toggleAllFoPool(select) { toggleAllPool('fo', select); }
function toggleAllFoPoolGroupsCollapse(collapse) { toggleAllPoolGroupsCollapse('fo', collapse); }

function updateAutoFailoverToggleUI(enabled) {
  const panel = document.getElementById('af-status-panel');
  if (panel) {
    panel.style.opacity = enabled ? '1' : '0.6';
  }
}

function onAutoFailoverToggleChange() {
  const enabled = document.getElementById('af-enabled')?.checked;
  updateAutoFailoverToggleUI(enabled);
}

async function onAutoFailoverToggleClick() {
  const toggle = document.getElementById('af-enabled');
  if (!toggle) return;
  const enabled = toggle.checked;
  updateAutoFailoverToggleUI(enabled);

  try {
    const res = await fetch('/api/autofailover/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Ошибка переключения');
    autoFailoverState = data.autoFailover;
    renderAutoFailoverStatus(autoFailoverState);
    showToast(data.message || (enabled ? 'Авто-переключение включено' : 'Авто-переключение отключено'), 'success');
  } catch (err) {
    showToast('Не удалось переключить авто-резерв: ' + err.message, 'error');
    toggle.checked = !enabled;
    updateAutoFailoverToggleUI(!enabled);
  }
}

function onAutoFailoverPrimaryModeChange() {
  const mode = document.getElementById('af-primary-mode').value;
  const wrap = document.getElementById('af-specific-primary-wrap');
  if (wrap) {
    wrap.classList.toggle('hidden', mode !== 'specific_id');
  }
}

async function onAutoFailoverFormSubmit(e) {
  e.preventDefault();

  const enabled = document.getElementById('af-enabled').checked;
  const strategy = document.getElementById('af-strategy').value;
  const primaryMode = document.getElementById('af-primary-mode').value;
  const specificPrimaryId = document.getElementById('af-specific-primary-conn').value;
  const autoReturn = document.getElementById('af-auto-return').checked;

  const poolCheckboxes = document.querySelectorAll('#af-pool-container input[type="checkbox"]:checked');
  const poolConnectionIds = Array.from(poolCheckboxes).map(cb => cb.value);

  if (enabled && poolConnectionIds.length === 0) {
    showToast('Выберите хотя бы одно подключение в пул резерва', 'warning');
    return;
  }

  const checkIntervalSec = parseInt(document.getElementById('af-interval').value, 10) || 20;
  const failThreshold = parseInt(document.getElementById('af-fail-threshold').value, 10) || 3;
  const recoveryThreshold = parseInt(document.getElementById('af-recovery-threshold').value, 10) || 3;
  const canaryUrl = (document.getElementById('af-canary-url').value || 'http://cp.cloudflare.com/generate_204').trim();

  const btnSave = document.getElementById('btn-save-autofailover');
  const origText = btnSave ? btnSave.innerHTML : '';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<span class="spin-icon">⏳</span> <span>Сохранение...</span>';
  }

  try {
    const res = await fetch('/api/autofailover/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        strategy,
        primaryMode,
        specificPrimaryId,
        poolConnectionIds,
        autoReturn,
        checkIntervalSec,
        failThreshold,
        recoveryThreshold,
        canaryUrl
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Ошибка сохранения настроек');
    }

    autoFailoverState = data.autoFailover;
    renderAutoFailoverStatus(autoFailoverState);
    showToast(data.message || 'Настройки авто-резерва сохранены', 'success');
    closeModal('settings-modal');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = origText;
    }
  }
}

// ==============================================================================
// SYNTAX HIGHLIGHTING & CODE EDITORS
// ==============================================================================

function tryParseAndApplyWireguardText(rawText) {
  try {
    const parsed = parseWireguardConfigClient(rawText);
    if (!parsed) return false;
    const nameInput = document.getElementById('conn-name');
    if (nameInput && (!nameInput.value.trim() || nameInput.value.startsWith('Мой сервер') || nameInput.value.startsWith('Подключение'))) {
      nameInput.value = parsed.name;
    }
    const descInput = document.getElementById('conn-desc');
    if (descInput && !descInput.value.trim()) {
      descInput.value = parsed.desc || '';
    }
    const urlInput = document.getElementById('input-vless-url');
    if (urlInput) {
      urlInput.value = `WireGuard: ${parsed.serverAddress}:${parsed.serverPort}`;
    }
    if (parsed.amneziaConfig) {
      currentAddAmneziaConfig = parsed.amneziaConfig;
    }
    setEditorContent('conn-outbound-json', parsed.outboundJson);

    // Preview badges
    document.getElementById('preview-host').textContent = parsed.serverAddress || '-';
    document.getElementById('preview-port').textContent = parsed.serverPort || '-';
    const isAwg = parsed.protocol === 'amneziawg' || Boolean(parsed.amneziaConfig);
    document.getElementById('preview-proto').textContent = isAwg ? 'AWG' : 'WG';
    const previewNetEl = document.getElementById('preview-net');
    if (previewNetEl) previewNetEl.textContent = 'UDP';
    document.getElementById('preview-sec').textContent = isAwg ? 'Amnezia' : 'WG';
    document.getElementById('add-meta-preview').classList.remove('hidden');
    highlightDetectedProtocol(isAwg ? 'amneziawg' : 'wireguard');

    showToast('Конфигурация WireGuard успешно распознана и преобразована!', 'success');
    return true;
  } catch (err) {
    showToast('Ошибка разбора конфига WireGuard: ' + err.message, 'error');
    return false;
  }
}

function setupCodeEditors() {
  editorIds.forEach(({ textId, codeId, statusId }) => {
    const textarea = document.getElementById(textId);
    const code = document.getElementById(codeId);
    if (!textarea || !code) return;

    const checkAndConvertWireguard = (val) => {
      if (!val || typeof val !== 'string') return false;
      const trimmed = val.trim();
      if ((trimmed.startsWith('[Interface]') || trimmed.startsWith('[Peer]') || (trimmed.includes('[Interface]') && trimmed.includes('[Peer]'))) && !trimmed.startsWith('{')) {
        try {
          const parsed = parseWireguardConfigClient(trimmed);
          if (parsed && parsed.outboundJson) {
            setEditorContent(textId, parsed.outboundJson);
            if (textId === 'conn-outbound-json') {
              const nameInput = document.getElementById('conn-name');
              if (nameInput && (!nameInput.value.trim() || nameInput.value.startsWith('Мой сервер') || nameInput.value.startsWith('Подключение'))) {
                nameInput.value = parsed.name;
              }
              const descInput = document.getElementById('conn-desc');
              if (descInput && !descInput.value.trim()) {
                descInput.value = parsed.desc || '';
              }
              if (parsed.amneziaConfig) {
                currentAddAmneziaConfig = parsed.amneziaConfig;
              }
              document.getElementById('preview-host').textContent = parsed.serverAddress || '-';
              document.getElementById('preview-port').textContent = parsed.serverPort || '-';
              const isAwg = parsed.protocol === 'amneziawg' || Boolean(parsed.amneziaConfig);
              document.getElementById('preview-proto').textContent = isAwg ? 'AWG' : 'WG';
              const previewNetEl = document.getElementById('preview-net');
              if (previewNetEl) previewNetEl.textContent = 'UDP';
              document.getElementById('preview-sec').textContent = isAwg ? 'Amnezia' : 'WG';
              document.getElementById('add-meta-preview').classList.remove('hidden');
            }
            showToast('Конфигурация WireGuard автоматически преобразована в outbound.json!', 'success');
            return true;
          }
        } catch (e) {}
      }
      return false;
    };

    const update = () => {
      if (checkAndConvertWireguard(textarea.value)) return;
      code.innerHTML = highlightJson(textarea.value);
      validateEditorJson(textarea.value, statusId);
    };

    textarea.addEventListener('input', update);
    textarea.addEventListener('paste', () => {
      setTimeout(() => {
        checkAndConvertWireguard(textarea.value);
      }, 30);
    });
    textarea.addEventListener('scroll', () => {
      code.parentElement.scrollTop = textarea.scrollTop;
      code.parentElement.scrollLeft = textarea.scrollLeft;
    });

    // Handle Ctrl+F / Cmd+F key in textarea to open search
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openEditorSearch(textId);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        update();
      }
    });
  });
}

function setEditorContent(textId, value) {
  const textarea = document.getElementById(textId);
  if (!textarea) return;
  textarea.value = value;
  const pair = editorIds.find(p => p.textId === textId);
  if (pair) {
    const code = document.getElementById(pair.codeId);
    if (code) code.innerHTML = highlightJson(value);
    validateEditorJson(value, pair.statusId);
  }
}

function formatEditorField(textId, statusId) {
  const textarea = document.getElementById(textId);
  if (!textarea) return;

  try {
    const clean = stripComments(textarea.value);
    const parsed = JSON.parse(clean);
    const formatted = JSON.stringify(parsed, null, 2);
    setEditorContent(textId, formatted);
    showToast('JSON успешно отформатирован', 'success');
  } catch (err) {
    showToast('Ошибка синтаксиса JSON: ' + err.message, 'error');
  }
}

function copyEditorContent(textId) {
  const textarea = document.getElementById(textId);
  if (!textarea || !textarea.value) {
    showToast('Поле пустое', 'warning');
    return;
  }

  navigator.clipboard.writeText(textarea.value).then(() => {
    showToast('Содержимое скопировано в буфер обмена!', 'success');
  }).catch(() => {
    showToast('Не удалось скопировать в буфер', 'warning');
  });
}

// ==============================================================================
// CODE EDITOR SEARCH
// ==============================================================================
const editorSearchStates = {};

function openEditorSearch(textId) {
  const panel = document.getElementById(`search-panel-${textId}`);
  const input = document.getElementById(`search-input-${textId}`);
  const textarea = document.getElementById(textId);
  if (!panel || !input || !textarea) return;

  panel.classList.remove('hidden');

  // Prepopulate with selected text if single line and reasonable length
  const selStart = textarea.selectionStart;
  const selEnd = textarea.selectionEnd;
  if (selEnd > selStart && (selEnd - selStart) < 80) {
    const selected = textarea.value.substring(selStart, selEnd);
    if (!selected.includes('\n')) {
      input.value = selected;
    }
  }

  input.focus();
  input.select();
  onEditorSearchInput(textId);
}

function closeEditorSearch(textId) {
  const panel = document.getElementById(`search-panel-${textId}`);
  if (panel) panel.classList.add('hidden');
  const textarea = document.getElementById(textId);
  if (textarea) textarea.focus();
}

function toggleEditorSearch(textId) {
  const panel = document.getElementById(`search-panel-${textId}`);
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    openEditorSearch(textId);
  } else {
    closeEditorSearch(textId);
  }
}

function onEditorSearchInput(textId) {
  const input = document.getElementById(`search-input-${textId}`);
  const counter = document.getElementById(`search-counter-${textId}`);
  const textarea = document.getElementById(textId);
  if (!input || !textarea) return;

  const query = input.value;
  if (!query) {
    editorSearchStates[textId] = { query: '', matches: [], currentIndex: -1 };
    if (counter) counter.textContent = '';
    return;
  }

  const text = textarea.value;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches = [];
  let idx = 0;
  while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
    matches.push({ start: idx, end: idx + query.length });
    idx += query.length || 1;
  }

  let currentIdx = -1;
  if (matches.length > 0) {
    const curStart = textarea.selectionStart;
    currentIdx = matches.findIndex(m => m.start >= curStart);
    if (currentIdx === -1) currentIdx = 0;
  }

  editorSearchStates[textId] = { query, matches, currentIndex: currentIdx };
  updateSearchDisplay(textId);
}

function navEditorSearch(textId, direction) {
  const state = editorSearchStates[textId];
  if (!state || !state.matches || state.matches.length === 0) return;

  let newIndex = state.currentIndex + direction;
  if (newIndex >= state.matches.length) newIndex = 0;
  if (newIndex < 0) newIndex = state.matches.length - 1;
  state.currentIndex = newIndex;

  updateSearchDisplay(textId);
}

function updateSearchDisplay(textId) {
  const state = editorSearchStates[textId];
  const counter = document.getElementById(`search-counter-${textId}`);
  const textarea = document.getElementById(textId);
  if (!state || !textarea) return;

  if (state.matches.length === 0) {
    if (counter) counter.textContent = state.query ? '0 / 0' : '';
    return;
  }

  if (counter) {
    counter.textContent = `${state.currentIndex + 1} / ${state.matches.length}`;
  }

  const match = state.matches[state.currentIndex];
  if (match) {
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);

    const textBefore = textarea.value.substring(0, match.start);
    const lineNum = textBefore.split('\n').length - 1;
    const lineHeight = 19;
    const targetScroll = Math.max(0, (lineNum - 3) * lineHeight);
    textarea.scrollTop = targetScroll;

    const pair = editorIds.find(p => p.textId === textId);
    if (pair) {
      const codeEl = document.getElementById(pair.codeId);
      if (codeEl && codeEl.parentElement) {
        codeEl.parentElement.scrollTop = targetScroll;
      }
    }
  }
}

function onEditorSearchKeydown(textId, event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeEditorSearch(textId);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    navEditorSearch(textId, event.shiftKey ? -1 : 1);
  }
}

function validateEditorJson(str, statusId) {
  const statusEl = document.getElementById(statusId);
  if (!statusEl) return;

  if (!str.trim()) {
    statusEl.textContent = '';
    return;
  }

  try {
    JSON.parse(stripComments(str));
    statusEl.textContent = 'JSON корректен';
    statusEl.className = 'json-status status-valid';
  } catch (e) {
    statusEl.textContent = 'Ошибка синтаксиса';
    statusEl.className = 'json-status status-invalid';
  }
}

function highlightJson(jsonStr) {
  if (!jsonStr) return '';
  let escaped = jsonStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const highlighted = escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}\[\],:])/g,
    (match) => {
      if (match.startsWith('//') || match.startsWith('/*')) {
        return `<span class="code-comment">${match}</span>`;
      }
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          return `<span class="code-key">${match.slice(0, -1)}</span><span class="code-punct">:</span>`;
        }
        return `<span class="code-string">${match}</span>`;
      }
      if (/true|false/.test(match)) {
        return `<span class="code-boolean">${match}</span>`;
      }
      if (/null/.test(match)) {
        return `<span class="code-null">${match}</span>`;
      }
      if (/[{}\[\],:]/.test(match)) {
        return `<span class="code-punct">${match}</span>`;
      }
      return `<span class="code-number">${match}</span>`;
    }
  );

  return jsonStr.endsWith('\n') ? highlighted + '\n' : highlighted;
}

function stripComments(str) {
  if (!str) return '';
  const noComments = str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")|(\/\*[\s\S]*?\*\/)|(\/\/[^\r\n]*)/g, (match, strToken) => {
    if (strToken) return strToken;
    return '';
  });
  return noComments.replace(/,\s*([}\]])/g, '$1');
}

// ==============================================================================
// MODAL HELPERS
// ==============================================================================
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('hidden');
    el.querySelectorAll('.editor-search-panel').forEach(p => p.classList.add('hidden'));
  }
}

let modalMouseDownTarget = null;
window.addEventListener('mousedown', (e) => {
  modalMouseDownTarget = e.target;
});

window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay') && modalMouseDownTarget === e.target) {
    closeModal(e.target.id);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const visibleModals = document.querySelectorAll('.modal-overlay:not(.hidden)');
    if (visibleModals.length > 0) {
      const topModal = visibleModals[visibleModals.length - 1];
      closeModal(topModal.id);
    }
  }
});

// ==============================================================================
// TOAST NOTIFICATIONS & UTILITIES
// ==============================================================================
function showToast(message, type = 'info', duration = 3500) {
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '';
  }
}

function getFlagEmoji(countryCode) {
  if (!countryCode || typeof countryCode !== 'string' || countryCode.trim().length !== 2) return '';
  const clean = countryCode.trim().toUpperCase();
  const codePoints = clean
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// ==============================================================================
// GITHUB UPDATE CHECK & AUTO-UPDATER
// ==============================================================================
let updateCheckRan = false;
let latestReleaseInfo = null;
let currentAppVersion = '2.0.2';
let isUpdateInProgress = false;
let updatePollTimer = null;

async function checkForUpdates(currentVersion) {
  if (updateCheckRan) return;
  updateCheckRan = true;
  if (currentVersion) currentAppVersion = String(currentVersion).trim();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://api.github.com/repos/sergey1900/XKeenSwitcher/releases/latest', {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return;

    const release = await res.json();
    if (!release || !release.tag_name) return;

    const latestTag = release.tag_name;
    const curVer = currentAppVersion || '2.0.0';

    if (isNewerVersion(latestTag, curVer)) {
      latestReleaseInfo = release;
      const group = document.getElementById('app-update-group');
      const badge = document.getElementById('app-update-badge');
      const text = document.getElementById('app-update-text');

      const displayVer = latestTag.startsWith('v') ? latestTag : `v${latestTag}`;
      if (text) text.textContent = `Доступна ${displayVer}`;
      if (badge && release.html_url) {
        badge.href = release.html_url;
      }

      if (group) {
        group.classList.remove('hidden');
      } else if (badge) {
        badge.classList.remove('hidden');
      }
    }
  } catch (e) {
    console.debug('Update check skipped or timed out:', e.message);
  }
}

function openAppUpdateModal() {
  if (!latestReleaseInfo) {
    showToast('Информация о новой версии не найдена', 'warning');
    return;
  }

  const curVerEl = document.getElementById('update-modal-cur-ver');
  const targetVerEl = document.getElementById('update-modal-target-ver');
  const tag = latestReleaseInfo.tag_name;
  const displayTag = tag.startsWith('v') ? tag : `v${tag}`;
  const displayCur = currentAppVersion.startsWith('v') ? currentAppVersion : `v${currentAppVersion}`;

  if (curVerEl) curVerEl.textContent = displayCur;
  if (targetVerEl) targetVerEl.textContent = displayTag;

  // Release notes preview
  const notesContainer = document.getElementById('update-release-notes');
  const notesBody = document.getElementById('update-release-body');
  if (notesContainer && notesBody) {
    if (latestReleaseInfo.body && latestReleaseInfo.body.trim()) {
      let text = latestReleaseInfo.body.trim();
      if (text.length > 500) {
        text = text.substring(0, 500) + '...';
      }
      notesBody.textContent = text;
      notesContainer.classList.remove('hidden');
    } else {
      notesContainer.classList.add('hidden');
    }
  }

  resetUpdateSteps();

  const errBox = document.getElementById('update-error-box');
  if (errBox) errBox.classList.add('hidden');

  const footer = document.getElementById('update-modal-footer');
  if (footer) {
    footer.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancel-update" onclick="closeAppUpdateModal()">Отмена</button>
      <button type="button" class="btn btn-primary btn-update-confirm" id="btn-confirm-update" onclick="startAppUpdate()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Начать обновление
      </button>
    `;
  }

  openModal('modal-app-update');
}

function closeAppUpdateModal() {
  if (isUpdateInProgress) {
    showToast('Обновление в процессе, пожалуйста, дождитесь завершения!', 'warning');
    return;
  }
  closeModal('modal-app-update');
}

function resetUpdateSteps() {
  const steps = [
    { id: 'up-step-backup', icon: '1', desc: 'Сохранение profiles.json и настроек' },
    { id: 'up-step-download', icon: '2', desc: 'Скачивание архива с исходным кодом' },
    { id: 'up-step-extract', icon: '3', desc: 'Распаковка и замена файлов' },
    { id: 'up-step-restart', icon: '4', desc: 'Ожидание запуска новой версии службы...' }
  ];

  for (const s of steps) {
    const el = document.getElementById(s.id);
    const statusEl = document.getElementById(`${s.id}-status`);
    if (el) {
      el.className = 'progress-step';
      const iconEl = el.querySelector('.step-icon');
      if (iconEl) iconEl.textContent = s.icon;
      const descEl = el.querySelector('.step-desc');
      if (descEl) descEl.textContent = s.desc;
    }
    if (statusEl) {
      statusEl.innerHTML = '⏳';
    }
  }
}

function setUpdateStepState(stepId, state, statusText, newDesc) {
  const el = document.getElementById(stepId);
  const statusEl = document.getElementById(`${stepId}-status`);
  if (!el) return;

  el.classList.remove('step-active', 'step-done', 'step-failed');
  if (state === 'active') {
    el.classList.add('step-active');
    if (statusEl) statusEl.innerHTML = '<span class="spin-icon">🔄</span>';
  } else if (state === 'done') {
    el.classList.add('step-done');
    if (statusEl) statusEl.innerHTML = '<span style="color: #22c55e; font-weight: bold;">✓</span>';
  } else if (state === 'failed') {
    el.classList.add('step-failed');
    if (statusEl) statusEl.innerHTML = '<span style="color: #ef4444; font-weight: bold;">✕</span>';
  }

  if (newDesc) {
    const descEl = el.querySelector('.step-desc');
    if (descEl) descEl.textContent = newDesc;
  }
  if (statusText && statusEl) {
    statusEl.innerHTML = statusText;
  }
}

async function startAppUpdate() {
  if (isUpdateInProgress) return;
  isUpdateInProgress = true;

  const btnConfirm = document.getElementById('btn-confirm-update');
  const btnCancel = document.getElementById('btn-cancel-update');
  const btnClose = document.getElementById('btn-close-app-update');
  if (btnConfirm) btnConfirm.disabled = true;
  if (btnCancel) btnCancel.disabled = true;
  if (btnClose) btnClose.style.display = 'none';

  const errBox = document.getElementById('update-error-box');
  const errMsg = document.getElementById('update-error-msg');
  if (errBox) errBox.classList.add('hidden');

  // Step 1: Backup
  setUpdateStepState('up-step-backup', 'active');
  await new Promise(r => setTimeout(r, 400));
  setUpdateStepState('up-step-backup', 'done', null, 'Резервная копия данных успешно создана');

  // Step 2: Download
  setUpdateStepState('up-step-download', 'active', null, 'Загрузка архива с GitHub...');

  try {
    const payload = {
      tag: latestReleaseInfo ? latestReleaseInfo.tag_name : '',
      version: latestReleaseInfo ? latestReleaseInfo.tag_name : '',
      tarball_url: latestReleaseInfo ? latestReleaseInfo.tarball_url : ''
    };

    const res = await fetch('/api/app/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      throw new Error(data.error || `Ошибка сервера (${res.status})`);
    }

    setUpdateStepState('up-step-download', 'done', null, 'Архив успешно скачан');
    setUpdateStepState('up-step-extract', 'done', null, 'Файлы приложения обновлены');

    // Step 4: Restart
    setUpdateStepState('up-step-restart', 'active', null, 'Перезапуск сервера... Проверка доступности');

    pollServerAfterUpdate(data.version || (latestReleaseInfo && latestReleaseInfo.tag_name) || '');
  } catch (err) {
    console.error('Update error:', err);
    isUpdateInProgress = false;

    const step2 = document.getElementById('up-step-download');
    if (step2 && step2.classList.contains('step-active')) {
      setUpdateStepState('up-step-download', 'failed', null, 'Не удалось загрузить архив с GitHub');
    } else {
      setUpdateStepState('up-step-extract', 'failed', null, 'Ошибка при распаковке или установке');
    }

    if (errBox && errMsg) {
      errMsg.textContent = err.message || 'Неизвестная ошибка при обновлении';
      errBox.classList.remove('hidden');
    }

    if (btnClose) btnClose.style.display = '';
    const footer = document.getElementById('update-modal-footer');
    if (footer) {
      footer.innerHTML = `
        <button type="button" class="btn btn-secondary" onclick="closeAppUpdateModal()">Закрыть</button>
        <button type="button" class="btn btn-primary" onclick="startAppUpdate()">Повторить попытку</button>
      `;
    }
  }
}

function pollServerAfterUpdate(expectedVersion) {
  let attempts = 0;
  const maxAttempts = 35;

  if (updatePollTimer) clearInterval(updatePollTimer);

  updatePollTimer = setInterval(async () => {
    attempts++;
    const descEl = document.querySelector('#up-step-restart .step-desc');
    if (descEl) {
      descEl.textContent = `Ожидание запуска службы... (попытка ${attempts}/${maxAttempts})`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('/api/version?t=' + Date.now(), {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        clearInterval(updatePollTimer);
        updatePollTimer = null;
        isUpdateInProgress = false;

        const newVer = data.version || expectedVersion || 'новая';
        const displayVer = newVer.startsWith('v') ? newVer : `v${newVer}`;

        setUpdateStepState('up-step-restart', 'done', null, `Служба запущена! Версия: ${displayVer}`);
        showToast(`Приложение успешно обновлено до ${displayVer}! Перезагрузка страницы...`, 'success', 4000);

        const footer = document.getElementById('update-modal-footer');
        if (footer) {
          footer.innerHTML = `
            <button type="button" class="btn btn-primary" onclick="window.location.reload(true)">
              Перезагрузить страницу сейчас
            </button>
          `;
        }

        setTimeout(() => {
          window.location.reload(true);
        }, 1800);
      }
    } catch (e) {
      // Server is restarting, continue polling
    }

    if (attempts >= maxAttempts) {
      clearInterval(updatePollTimer);
      updatePollTimer = null;
      isUpdateInProgress = false;

      const btnClose = document.getElementById('btn-close-app-update');
      if (btnClose) btnClose.style.display = '';

      setUpdateStepState('up-step-restart', 'failed', null, 'Сервер не ответил вовремя');
      const errBox = document.getElementById('update-error-box');
      const errMsg = document.getElementById('update-error-msg');
      if (errBox && errMsg) {
        errMsg.textContent = 'Сервер перезапускается дольше обычного. Пожалуйста, подождите немного и обновите страницу в браузере вручную (F5).';
        errBox.classList.remove('hidden');
      }

      const footer = document.getElementById('update-modal-footer');
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="btn btn-primary" onclick="window.location.reload(true)">Обновить страницу</button>
          <button type="button" class="btn btn-secondary" onclick="closeAppUpdateModal()">Закрыть</button>
        `;
      }
    }
  }, 1400);
}

function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const cleanR = String(remote).trim().replace(/^v/i, '');
  const cleanL = String(local).trim().replace(/^v/i, '');

  const rParts = cleanR.split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const lParts = cleanL.split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const maxLen = Math.max(rParts.length, lParts.length);

  for (let i = 0; i < maxLen; i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}
