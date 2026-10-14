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
let pingingConnectionIds = new Set();
let isPingingAll = false;
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

// ==============================================================================
// INITIALIZATION
// ==============================================================================
document.addEventListener('DOMContentLoaded', () => {
  setupCodeEditors();
  loadData();
  startServicePolling();

  // Setup live VLESS parser on input in add modal
  const urlInput = document.getElementById('input-vless-url');
  if (urlInput) {
    urlInput.addEventListener('input', () => {
      parseVlessUrlInput(false);
    });
    urlInput.addEventListener('paste', () => {
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
});

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
    showToast('Не удалось загрузить данные с роутера', 'error');
  }
}

// Sorting Handler
function onSortChange(val) {
  currentSort = val;
  try {
    localStorage.setItem('xkeen_connections_sort', val);
  } catch (e) {}
  renderConnections();
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
    case 'udp': return 'UDP';
    default: return n.toUpperCase();
  }
}

// Render Connections Grid
function renderConnectionCardHtml(conn, activeId) {
  const isActive = (conn.id === activeId);
  const isChecking = pingingConnectionIds.has(conn.id) || isPingingAll;

  // Security & SNI
  let secBadgeHtml = '';
  if (conn.security === 'reality') {
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
  const netFormatted = formatNetworkName(connNetwork || (conn.protocol === 'wireguard' ? 'udp' : 'tcp'));
  const netBadgeHtml = `<span class="conn-badge badge-net" title="Транспорт: ${escapeHtml(netFormatted)}">${escapeHtml(netFormatted)}</span>`;

  // Ping status display
  let pingHtml = '';
  if (isChecking) {
    pingHtml = `<span class="ping-badge ping-loading"><span class="spin-icon">⏳</span> Проверка...</span>`;
  } else if (conn.lastPingStatus === 'ok' && conn.lastPing !== null) {
    const isProxy = conn.lastPingType === 'proxy';
    const checkTitle = (isProxy ? 'Сквозной туннель подтверждён' : 'TCP доступен') +
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

  // Routing selector options (user configs first, protected configs under them)
  const allRoutings = [
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

  return `
    <div class="conn-card glass-card ${isActive ? 'active-conn' : ''} ${isFav ? 'is-favorite' : ''}" id="card-conn-${conn.id}">
      <div>
        <div class="conn-card-header">
          <div class="conn-title-wrap">
            <button type="button" class="btn-star ${isFav ? 'starred' : ''}" onclick="toggleFavoriteConnection('${conn.id}', event)" title="${isFav ? 'Убрать из избранного' : 'Добавить в избранное'}">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="${isFav ? '#f59e0b' : 'none'}" stroke="${isFav ? '#f59e0b' : 'rgba(255,255,255,0.45)'}" stroke-width="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>
            <h3 class="conn-title">${flagHtml ? flagHtml + ' ' : ''}<span>${escapeHtml(conn.name)}</span></h3>
          </div>
          ${isActive ? `<span class="active-pill-badge"><span class="status-dot"></span> Активно</span>` : ''}
        </div>

        <!-- BADGES ROW -->
        <div class="conn-badges-row">
          ${targetBadgeHtml}
          <span class="conn-badge badge-host" title="Хост:Порт">${escapeHtml(conn.serverAddress || '-')}:${conn.serverPort || '-'}</span>
          <span class="conn-badge badge-proto" title="Протокол">${escapeHtml((conn.protocol || 'vless').toUpperCase())}</span>
          ${netBadgeHtml}
          ${secBadgeHtml}
        </div>

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

        <!-- PING AVAILABILITY ROW -->
        <div class="conn-ping-row">
          <div class="ping-status-wrap">
            ${pingHtml}
          </div>
          <button class="btn-check-ping" onclick="checkConnectionPing('${conn.id}')" ${isChecking ? 'disabled' : ''} title="Проверить доступность подключения">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            <span>Проверить</span>
          </button>
        </div>

        <!-- COMMENT (IF ANY) -->
        ${conn.description ? `<div class="conn-comment">${escapeHtml(conn.description)}</div>` : ''}
      </div>

      <!-- FOOTER ACTIONS -->
      <div class="conn-card-footer">
        <div>
          ${!isActive ? `
            <button class="btn btn-activate" onclick="activateConnection('${conn.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>Активировать</span>
            </button>
          ` : ''}
        </div>

        <div class="conn-footer-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openMoveCopyModal('${conn.id}')" title="Переместить или скопировать в другую группу">
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
  if (card && body) {
    const isNowCollapsed = collapsedGroupIds.has(groupId);
    card.classList.toggle('collapsed', isNowCollapsed);
    body.classList.toggle('hidden', isNowCollapsed);
    const arrow = card.querySelector('.group-toggle-arrow');
    if (arrow) arrow.classList.toggle('expanded', !isNowCollapsed);
  }
}

function renderConnections() {
  if (!connectionsGrid) return;
  const rawList = appData.connections || [];
  const activeId = appData.settings ? appData.settings.activeConnectionId : null;
  const groups = (appData.groups && appData.groups.length > 0)
    ? appData.groups
    : [{ id: 'group_default', name: 'Общие' }];

  const sortSelect = document.getElementById('connections-sort-select');
  if (sortSelect && sortSelect.value !== currentSort) {
    sortSelect.value = currentSort;
  }

  if (connectionsCount) connectionsCount.textContent = rawList.length;
  if (connectionsBadge) connectionsBadge.textContent = rawList.length;

  if (rawList.length === 0) {
    connectionsGrid.innerHTML = '';
    if (emptyConnectionsState) emptyConnectionsState.classList.remove('hidden');
    return;
  }

  if (emptyConnectionsState) emptyConnectionsState.classList.add('hidden');

  const list = getSortedConnections(rawList, activeId);
  const favorites = list.filter(c => c.isFavorite);

  let html = '';

  // 1. Favorites section at top (if any)
  if (favorites.length > 0) {
    html += `
      <div class="favorites-container">
        <div class="section-group-divider favorites-divider">
          <span class="star-icon">⭐</span>
          <span>Избранные подключения</span>
          <span class="group-count">${favorites.length}</span>
        </div>
        <div class="connections-subgrid">
          ${favorites.map(c => renderConnectionCardHtml(c, activeId)).join('')}
        </div>
      </div>
    `;
  }

  // 2. Groups Accordions
  html += `<div class="groups-container">`;
  groups.forEach(g => {
    const groupConns = list.filter(c => (c.groupId || 'group_default') === g.id);
    const isCollapsed = collapsedGroupIds.has(g.id);
    const isSub = Boolean(g.isSubscription);

    let subInfoHtml = '';
    if (isSub) {
      const targetText = (g.targetList === 'whitelist') ? 'БС' : 'ЧС';
      const targetClass = (g.targetList === 'whitelist') ? 'target-whitelist' : 'target-blacklist';
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
        <span class="group-target-badge ${targetClass}" title="Назначение подписки: ${g.targetList === 'whitelist' ? 'Белые списки (БС)' : 'Черные списки (ЧС)'}">${targetText}</span>
        ${trafficText ? `<span class="group-traffic-badge" title="Трафик подписки">📊 ${escapeHtml(trafficText)}</span>` : ''}
        ${expireText ? `<span class="group-expire-badge" title="Истекает">⏳ до ${escapeHtml(expireText)}</span>` : ''}
      `;
    }

    html += `
      <div class="group-accordion-card ${isSub ? 'subscription-group-card' : ''} ${isCollapsed ? 'collapsed' : ''}" id="group-card-${g.id}">
        <div class="group-header" onclick="toggleGroupCollapse('${g.id}')">
          <div class="group-header-left">
            <span class="group-toggle-arrow ${isCollapsed ? '' : 'expanded'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
            <span class="group-icon">${isSub ? '🌐' : '📁'}</span>
            <span class="group-name">${escapeHtml(g.name)}</span>
            ${subInfoHtml}
            <span class="group-count-badge">${groupConns.length}</span>
          </div>
          <div class="group-actions" onclick="event.stopPropagation()">
            ${isSub ? `
              <button class="btn-group-action btn-sub-refresh" id="btn-refresh-sub-${g.id}" onclick="updateSubscription('${g.id}', event)" title="Обновить ссылки подписки из интернета">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              </button>
              <button class="btn-group-action" onclick="openEditSubscriptionModal('${g.id}', event)" title="Настройки подписки и назначение (ЧС/БС)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
              <button class="btn-group-action btn-group-delete" onclick="deleteSubscription('${g.id}', '${escapeJs(g.name)}', event)" title="Удалить подписку и все её подключения">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            ` : `
              <button class="btn-group-action" onclick="openAddConnectionModal('${g.id}')" title="Добавить подключение в эту группу">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <button class="btn-group-action" onclick="openRenameGroupModal('${g.id}', '${escapeJs(g.name)}')" title="Переименовать группу">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
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
          ${groupConns.length > 0 ? `
            <div class="connections-subgrid">
              ${groupConns.map(c => renderConnectionCardHtml(c, activeId)).join('')}
            </div>
          ` : `
            <div class="group-empty-state">
              <span>${isSub ? 'В этой подписке пока нет подключений' : 'В этой группе пока нет подключений'}</span>
              ${isSub ? `
                <button type="button" class="btn btn-secondary btn-sm" onclick="updateSubscription('${g.id}', event)">Загрузить ссылки</button>
              ` : `
                <button type="button" class="btn btn-secondary btn-sm" onclick="openAddConnectionModal('${g.id}')">Добавить подключение</button>
              `}
            </div>
          `}
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
}

// Populate group select dropdowns in modals
function populateGroupSelects(selectedGroupId = null) {
  const groups = (appData.groups && appData.groups.length > 0)
    ? appData.groups
    : [{ id: 'group_default', name: 'Общие' }];

  const optionsHtml = groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');

  const addGroupSel = document.getElementById('conn-group');
  if (addGroupSel) {
    const cur = selectedGroupId || addGroupSel.value || 'group_default';
    addGroupSel.innerHTML = optionsHtml;
    addGroupSel.value = groups.some(g => g.id === cur) ? cur : groups[0].id;
  }

  const editGroupSel = document.getElementById('edit-conn-group');
  if (editGroupSel) {
    const cur = selectedGroupId || editGroupSel.value || 'group_default';
    editGroupSel.innerHTML = optionsHtml;
    editGroupSel.value = groups.some(g => g.id === cur) ? cur : groups[0].id;
  }

  const batchGroupSel = document.getElementById('batch-group-select');
  if (batchGroupSel) {
    batchGroupSel.innerHTML = optionsHtml;
  }

  const moveCopySel = document.getElementById('move-copy-target-group');
  if (moveCopySel) {
    moveCopySel.innerHTML = optionsHtml;
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

// Universal Client-side Proxy URL & Config Parser
function parseProxyUrlInput(showNotice = true) {
  const input = document.getElementById('input-vless-url');
  if (!input || !input.value.trim()) return;

  const rawUrl = input.value.trim();

  try {
    let result = null;

    if (rawUrl.includes('[Interface]') || rawUrl.includes('[Peer]')) {
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
      if (showNotice) showToast('Неизвестный протокол. Вставьте vless://, vmess://, trojan://, ss://, wireguard:// или конфиг [Interface]', 'warning');
      return;
    }

    if (!result) return;

    // Populate Fields
    const nameInput = document.getElementById('conn-name');
    if (nameInput && result.name) {
      nameInput.value = result.name;
    }
    document.getElementById('conn-desc').value = result.desc || '';
    setEditorContent('conn-outbound-json', result.outboundJson);

    // Show Preview Pills
    document.getElementById('preview-host').textContent = result.serverAddress;
    document.getElementById('preview-port').textContent = result.serverPort;
    document.getElementById('preview-proto').textContent = (result.protocol || 'VLESS').toUpperCase();
    const previewNetEl = document.getElementById('preview-net');
    if (previewNetEl) previewNetEl.textContent = formatNetworkName(result.network || 'tcp');
    document.getElementById('preview-sec').textContent = result.security === 'reality' ? 'Reality' : (result.security || 'None');
    const sniWrap = document.getElementById('preview-sni-wrap');
    if (result.sni) {
      document.getElementById('preview-sni').textContent = result.sni;
      sniWrap.classList.remove('hidden');
    } else {
      sniWrap.classList.add('hidden');
    }
    document.getElementById('add-meta-preview').classList.remove('hidden');

    if (showNotice) showToast(`Ссылка ${result.protocol.toUpperCase()} успешно распознана!`, 'success');
  } catch (err) {
    if (showNotice) showToast('Ошибка разбора ссылки: ' + err.message, 'error');
  }
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

  let name = '';
  try {
    name = decodeURIComponent(u.hash ? u.hash.replace(/^#/, '') : '').trim();
  } catch (e) {
    name = (u.hash ? u.hash.replace(/^#/, '') : '').trim();
  }
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
  const u = new URL(rawUrl);
  const password = decodeURIComponent(u.username);
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10);
  if (!password || !address || !port) throw new Error('Некорректная ссылка Trojan');

  let rawName = u.hash ? u.hash.replace(/^#/, '') : '';
  let name = '';
  try { name = decodeURIComponent(rawName).trim(); } catch (e) { name = rawName.trim(); }
  if (!name) name = `Trojan - ${address}:${port}`;

  const sp = u.searchParams;
  const type = (sp.get('type') || 'tcp').toLowerCase();
  const security = (sp.get('security') || 'tls').toLowerCase();
  const sni = sp.get('sni') || sp.get('peer') || address;
  const fp = sp.get('fp') || 'chrome';

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
      fingerprint: fp
    };
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

  const outboundJsonObj = {
    outbounds: [
      {
        tag: 'trojan',
        protocol: 'trojan',
        settings: {
          servers: [
            {
              address: address,
              port: port,
              password: password,
              level: 0
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
  const name = `${isAwg ? 'AmneziaWG' : 'WireGuard'} - ${endpointHost}:${endpointPort}`;
  const cleanAddress = address.split(',')[0].trim();

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
              allowedIPs: ['0.0.0.0/0', '::/0']
            }
          ],
          mtu: parseInt(iface.mtu, 10) || 1420
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
  let name = '';
  try { name = decodeURIComponent(rawName).trim(); } catch (e) { name = rawName.trim(); }
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
  const password = decodeURIComponent(u.username);
  const address = (u.hostname || '').replace(/^\[|\]$/g, '');
  const port = parseInt(u.port, 10) || 443;
  if (!address || !port) throw new Error('Отсутствуют адрес или порт Hysteria2');

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
          tlsSettings: { serverName: sni }
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

// ==============================================================================
// CONNECTION ACTIONS
// ==============================================================================

// Open Add Connection Modal
function openAddConnectionModal(defaultGroupId = '') {
  document.getElementById('form-add-connection').reset();
  document.getElementById('add-meta-preview').classList.add('hidden');
  populateRoutingSelects();
  populateGroupSelects(defaultGroupId || 'group_default');

  const radioBlacklist = document.querySelector('input[name="conn-target-list"][value="blacklist"]');
  if (radioBlacklist) radioBlacklist.checked = true;

  const addSel = document.getElementById('conn-routing');
  if (addSel && appData.settings?.defaultRoutingBlacklist) {
    addSel.value = appData.settings.defaultRoutingBlacklist;
  }

  setEditorContent('conn-outbound-json', '{\n    "outbounds": []\n}');
  openModal('modal-add-connection');
}

// Submit Add Connection
async function onAddConnectionSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('conn-name').value.trim();
  const description = document.getElementById('conn-desc').value.trim();
  const groupId = document.getElementById('conn-group') ? document.getElementById('conn-group').value : 'group_default';
  const routingId = document.getElementById('conn-routing').value;
  const targetList = document.querySelector('input[name="conn-target-list"]:checked')?.value || 'blacklist';
  const outboundContent = document.getElementById('conn-outbound-json').value.trim();

  if (!name || !outboundContent) {
    showToast('Укажите название и содержимое outbound.json', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, groupId, routingId, outboundContent, targetList })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка при сохранении подключения');

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
  const editGroupSel = document.getElementById('edit-conn-group');
  if (editGroupSel) editGroupSel.value = conn.groupId || 'group_default';
  document.getElementById('edit-conn-routing').value = conn.routingId || 'routing_all_vpn';

  const targetRadio = document.querySelector(`input[name="edit-conn-target-list"][value="${conn.targetList || 'blacklist'}"]`);
  if (targetRadio) targetRadio.checked = true;

  // Preview pills
  document.getElementById('edit-preview-host').textContent = conn.serverAddress || '-';
  document.getElementById('edit-preview-port').textContent = conn.serverPort || '-';
  document.getElementById('edit-preview-proto').textContent = (conn.protocol || 'VLESS').toUpperCase();
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
    editNetEl.textContent = formatNetworkName(editNet || (conn.protocol === 'wireguard' ? 'udp' : 'tcp'));
  }
  document.getElementById('edit-preview-sec').textContent = conn.security || 'none';
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
  const idInput = document.getElementById('group-edit-id');
  const titleEl = document.getElementById('group-modal-title');
  const nameInput = document.getElementById('group-edit-name');
  if (idInput) idInput.value = '';
  if (titleEl) titleEl.textContent = 'Новая группа';
  if (nameInput) nameInput.value = getNextDefaultGroupName();
  openModal('modal-group-edit');
  setTimeout(() => {
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }, 100);
}

// Open modal to rename an existing group
function openRenameGroupModal(groupId, currentName) {
  const idInput = document.getElementById('group-edit-id');
  const titleEl = document.getElementById('group-modal-title');
  const nameInput = document.getElementById('group-edit-name');
  if (idInput) idInput.value = groupId;
  if (titleEl) titleEl.textContent = 'Переименовать группу';
  if (nameInput) nameInput.value = currentName || '';
  openModal('modal-group-edit');
  setTimeout(() => {
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }, 100);
}

// Submit Create or Rename Group
async function onGroupEditSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('group-edit-id').value;
  const name = document.getElementById('group-edit-name').value.trim();
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
        body: JSON.stringify({ name })
      });
    } else {
      res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
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
  const form = document.getElementById('form-subscription');
  if (form) form.reset();

  document.getElementById('sub-id').value = '';
  document.getElementById('modal-sub-title').textContent = 'Добавить подписку';
  document.getElementById('modal-sub-subtitle').textContent = 'Подписка будет создана как отдельная группа подключений';

  const editOpts = document.getElementById('sub-edit-options');
  if (editOpts) editOpts.classList.add('hidden');

  const radioBlacklist = document.querySelector('input[name="sub-target-list"][value="blacklist"]');
  if (radioBlacklist) radioBlacklist.checked = true;

  populateRoutingSelects();
  const subRoutingSel = document.getElementById('sub-routing');
  if (subRoutingSel && appData.settings?.defaultRoutingBlacklist) {
    subRoutingSel.value = appData.settings.defaultRoutingBlacklist;
  }

  const subNameInput = document.getElementById('sub-name');
  if (subNameInput) {
    const subCount = (appData.groups || []).filter(g => g.isSubscription).length;
    subNameInput.value = `Подписка ${subCount + 1}`;
  }

  const submitText = document.getElementById('btn-submit-sub-text');
  if (submitText) submitText.textContent = 'Загрузить подписку';

  openModal('modal-subscription');
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
  document.getElementById('modal-sub-subtitle').textContent = 'Управление ссылкой, маршрутизацией и назначением (ЧС / БС)';

  document.getElementById('sub-url').value = group.subscriptionUrl || '';
  document.getElementById('sub-name').value = group.name || '';

  const targetRadio = document.querySelector(`input[name="sub-target-list"][value="${group.targetList || 'blacklist'}"]`);
  if (targetRadio) targetRadio.checked = true;

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
  const targetList = document.querySelector('input[name="sub-target-list"]:checked')?.value || 'blacklist';
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
  const targetList = document.querySelector('input[name="sub-target-list"]:checked')?.value || 'blacklist';
  const routingId = document.getElementById('sub-routing').value;
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
        body: JSON.stringify({ name, subscriptionUrl: url, targetList, routingId, applyRoutingToConnections })
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
        body: JSON.stringify({ url, name, targetList, routingId })
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
  const btn = document.getElementById(`btn-refresh-sub-${groupId}`);
  if (btn) btn.classList.add('spinning');

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
    if (btn) btn.classList.remove('spinning');
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

  document.getElementById('move-copy-conn-id').value = conn.id;
  document.getElementById('move-copy-conn-name').textContent = conn.name;
  populateGroupSelects();

  const targetGroupSel = document.getElementById('move-copy-target-group');
  if (targetGroupSel) {
    targetGroupSel.value = conn.groupId || 'group_default';
  }

  const radioMove = document.querySelector('input[name="move-copy-action"][value="move"]');
  if (radioMove) radioMove.checked = true;

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
  const form = document.getElementById('form-batch-import');
  if (form) form.reset();

  populateRoutingSelects();
  populateGroupSelects();

  const radioBlacklist = document.querySelector('input[name="batch-target-list"][value="blacklist"]');
  if (radioBlacklist) radioBlacklist.checked = true;

  const batchRoutingSel = document.getElementById('batch-routing-select');
  if (batchRoutingSel && appData.settings?.defaultRoutingBlacklist) {
    batchRoutingSel.value = appData.settings.defaultRoutingBlacklist;
  }

  const newNameInput = document.getElementById('batch-group-new-name');
  if (newNameInput) newNameInput.value = getNextDefaultGroupName();

  const radioNew = document.querySelector('input[name="batch-group-choice"][value="new"]');
  if (radioNew) radioNew.checked = true;

  toggleBatchGroupMode();
  updateBatchImportCounter();
  openModal('modal-batch-import');
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
  const targetList = document.querySelector('input[name="batch-target-list"]:checked')?.value || 'blacklist';
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
  const targetList = document.querySelector('input[name="batch-target-list"]:checked')?.value || 'blacklist';
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
    renderConnections();
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

  try {
    for (let i = 0; i < list.length; i++) {
      const conn = list[i];
      if (btnText) btnText.innerHTML = `<span class="spin-icon">⏳</span> Проверка ${i + 1}/${list.length}...`;
      pingingConnectionIds.add(conn.id);
      renderConnections();

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
        renderConnections();
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

// ==============================================================================
// ROUTING ACTIONS
// ==============================================================================

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
  document.getElementById('btn-format-routing').classList.remove('hidden');

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

  const defaultRoutingTemplate = JSON.stringify({
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          type: "field",
          ip: ["geoip:private"],
          outboundTag: "direct"
        }
      ]
    }
  }, null, 2);

  setEditorContent('routing-content-json', defaultRoutingTemplate);
  openModal('modal-routing');
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
  const formatBtn = document.getElementById('btn-format-routing');
  if (routing.isSystem) {
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Сохранить по умолчанию';
    formatBtn.classList.add('hidden');
  } else {
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Сохранить маршрутизацию';
    formatBtn.classList.remove('hidden');
  }

  setEditorContent('routing-content-json', routing.content);
  openModal('modal-routing');
}

// Submit Add or Edit Routing
async function onRoutingSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('routing-id').value;
  const name = document.getElementById('routing-name').value.trim();
  const description = document.getElementById('routing-desc').value.trim();
  const content = document.getElementById('routing-content-json').value.trim();
  const isDefaultBlacklist = Boolean(document.getElementById('routing-default-blacklist')?.checked);
  const isDefaultWhitelist = Boolean(document.getElementById('routing-default-whitelist')?.checked);

  if (!name || !content) {
    showToast('Укажите название и содержимое routing.json', 'warning');
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
      body: JSON.stringify({ name, description, content, isDefaultBlacklist, isDefaultWhitelist })
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

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outboundPath, routingPath, restartCommand, startCommand, stopCommand, statusCommand, port })
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

  if (!fo || !fo.enabled || !fo.primaryConnectionId || !fo.backupConnectionId) {
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

async function populateFailoverForm() {
  const primarySelect = document.getElementById('fo-primary-conn');
  const backupSelect = document.getElementById('fo-backup-conn');
  if (!primarySelect || !backupSelect) return;

  const connections = (appData && appData.connections) || [];
  const optionsHtml = '<option value="">-- Выберите подключение --</option>' +
    connections.map(c => {
      const isAct = (c.id === appData.activeConnectionId) ? ' [Активно]' : '';
      const flag = getFlagEmoji(c.countryCode);
      const flagPrefix = flag ? `${flag} ` : '';
      return `<option value="${escapeHtml(c.id)}">${flagPrefix}${escapeHtml(c.name)}${isAct} (${escapeHtml(c.serverAddress || '')})</option>`;
    }).join('');

  primarySelect.innerHTML = optionsHtml;
  backupSelect.innerHTML = optionsHtml;

  try {
    const res = await fetch('/api/failover');
    if (res.ok) {
      failoverState = await res.json();
    }
  } catch (e) {}

  const fo = failoverState || {};

  const enabledInput = document.getElementById('fo-enabled');
  if (enabledInput) {
    enabledInput.checked = !!fo.enabled;
    updateFailoverToggleUI(!!fo.enabled);
  }

  if (fo.primaryConnectionId) {
    primarySelect.value = fo.primaryConnectionId;
  } else if (appData && appData.activeConnectionId) {
    primarySelect.value = appData.activeConnectionId;
  }

  if (fo.backupConnectionId) {
    backupSelect.value = fo.backupConnectionId;
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
  const backupSelect = document.getElementById('fo-backup-conn');
  const primaryConnId = (primarySelect && primarySelect.value) || (failoverState && failoverState.primaryConnectionId) || (appData && appData.activeConnectionId) || '';
  const backupConnId = (backupSelect && backupSelect.value) || (failoverState && failoverState.backupConnectionId) || '';

  if (enabled) {
    if (!backupConnId || !primaryConnId || primaryConnId === backupConnId) {
      toggle.checked = false;
      updateFailoverToggleUI(false);

      if (!backupConnId) {
        showToast('Не выбрано резервное подключение (для Белых Списков)!', 'warning');
        if (backupSelect) {
          backupSelect.focus();
          backupSelect.classList.add('input-error-highlight');
          setTimeout(() => backupSelect.classList.remove('input-error-highlight'), 2500);
        }
      } else if (!primaryConnId) {
        showToast('Не выбрано основное подключение!', 'warning');
        if (primarySelect) {
          primarySelect.focus();
          primarySelect.classList.add('input-error-highlight');
          setTimeout(() => primarySelect.classList.remove('input-error-highlight'), 2500);
        }
      } else {
        showToast('Основное и резервное подключения должны отличаться!', 'warning');
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
        backupConnectionId: backupConnId
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

async function onFailoverConnSelectChange() {
  const toggle = document.getElementById('fo-enabled');
  if (!toggle || !toggle.checked) return;

  const primarySelect = document.getElementById('fo-primary-conn');
  const backupSelect = document.getElementById('fo-backup-conn');
  const primaryConnId = primarySelect ? primarySelect.value : '';
  const backupConnId = backupSelect ? backupSelect.value : '';

  if (!primaryConnId || !backupConnId || primaryConnId === backupConnId) {
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
      showToast('Подключения не заданы. Режим БС автоматически отключен.', 'warning');
    } catch (e) {}
  }
}

async function onFailoverFormSubmit(e) {
  e.preventDefault();

  const enabled = document.getElementById('fo-enabled').checked;
  const primaryConnectionId = document.getElementById('fo-primary-conn').value;
  const backupConnectionId = document.getElementById('fo-backup-conn').value;
  const checkIntervalSec = parseInt(document.getElementById('fo-interval').value, 10) || 25;
  const failThreshold = parseInt(document.getElementById('fo-fail-threshold').value, 10) || 3;
  const recoveryThreshold = parseInt(document.getElementById('fo-recovery-threshold').value, 10) || 3;
  const ruCheckHost = document.getElementById('fo-ru-host').value.trim() || '77.88.8.8';
  const canaryUrl = document.getElementById('fo-canary-url').value.trim() || 'http://cp.cloudflare.com/generate_204';

  if (enabled) {
    if (!primaryConnectionId) {
      showToast('Выберите основное подключение (обычный режим)', 'warning');
      return;
    }
    if (!backupConnectionId) {
      showToast('Выберите резервное подключение (для Белых Списков)', 'warning');
      return;
    }
    if (primaryConnectionId === backupConnectionId) {
      showToast('Основное и резервное подключение должны отличаться!', 'warning');
      return;
    }
  }

  const btnSave = document.getElementById('btn-save-failover');
  const origText = btnSave ? btnSave.innerHTML : '';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<span class="spin-icon">⏳</span> Сохранение...';
  }

  try {
    const res = await fetch('/api/failover/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        primaryConnectionId,
        backupConnectionId,
        checkIntervalSec,
        failThreshold,
        recoveryThreshold,
        ruCheckHost,
        canaryUrl
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Ошибка сохранения настроек');
    }

    failoverState = data.failover;
    renderFailoverStatus(failoverState);
    showToast(data.message || 'Настройки Failover сохранены', 'success');
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

  // Pool container
  const poolContainer = document.getElementById('af-pool-container');
  if (poolContainer) {
    const savedPool = Array.isArray(af.poolConnectionIds) && af.poolConnectionIds.length > 0
      ? af.poolConnectionIds
      : conns.map(c => c.id);

    poolContainer.innerHTML = conns.map(c => {
      const isChecked = savedPool.includes(c.id);
      const flag = getFlagEmoji(c.countryCode);
      const flagHtml = flag ? `<span class="conn-flag">${flag}</span>` : '';
      const pingText = c.lastPing ? `${c.lastPing} ms` : (c.lastPingStatus === 'unreachable' ? 'Недоступен' : '–');
      const pingClass = c.lastPing ? 'ok' : '';

      return `
        <div class="pool-conn-item" onclick="togglePoolConnItem('${c.id}')">
          <div class="pool-conn-left">
            <input type="checkbox" class="pool-conn-checkbox" id="af-pool-conn-${c.id}" value="${c.id}" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation()">
            <label class="pool-conn-name" for="af-pool-conn-${c.id}" onclick="event.stopPropagation()">
              ${flagHtml}
              <span>${escapeHtml(c.name)}</span>
            </label>
          </div>
          <div class="pool-conn-right">
            <span class="pool-conn-host">${escapeHtml(c.serverAddress)}</span>
            <span class="pool-conn-ping ${pingClass}">${pingText}</span>
          </div>
        </div>
      `;
    }).join('');
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

function togglePoolConnItem(connId) {
  const cb = document.getElementById(`af-pool-conn-${connId}`);
  if (cb) {
    cb.checked = !cb.checked;
  }
}

function toggleAllPool(select) {
  const checkboxes = document.querySelectorAll('#af-pool-container .pool-conn-checkbox');
  checkboxes.forEach(cb => { cb.checked = select; });
}

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

  const poolCheckboxes = document.querySelectorAll('#af-pool-container .pool-conn-checkbox:checked');
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
const editorIds = [
  { textId: 'conn-outbound-json', codeId: 'conn-outbound-code', statusId: 'conn-outbound-status' },
  { textId: 'edit-conn-outbound-json', codeId: 'edit-conn-outbound-code', statusId: 'edit-conn-outbound-status' },
  { textId: 'routing-content-json', codeId: 'routing-content-code', statusId: 'routing-content-status' }
];

function setupCodeEditors() {
  editorIds.forEach(({ textId, codeId, statusId }) => {
    const textarea = document.getElementById(textId);
    const code = document.getElementById(codeId);
    if (!textarea || !code) return;

    const update = () => {
      code.innerHTML = highlightJson(textarea.value);
      validateEditorJson(textarea.value, statusId);
    };

    textarea.addEventListener('input', update);
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

window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
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
