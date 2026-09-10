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

// Render Connections Grid
function renderConnections() {
  if (!connectionsGrid) return;
  const rawList = appData.connections || [];
  const activeId = appData.settings ? appData.settings.activeConnectionId : null;

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

  connectionsGrid.innerHTML = list.map(conn => {
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

    // Ping status display
    let pingHtml = '';
    if (isChecking) {
      pingHtml = `<span class="ping-badge ping-loading"><span class="spin-icon">⏳</span> Проверка...</span>`;
    } else if (conn.lastPingStatus === 'ok' && conn.lastPing !== null) {
      pingHtml = `<span class="ping-badge ping-ok" title="Последняя проверка: ${formatTime(conn.lastPingCheckedAt)}">● ${conn.lastPing} ms</span>`;
    } else if (conn.lastPingStatus === 'unreachable') {
      pingHtml = `<span class="ping-badge ping-unreachable" title="Последняя проверка: ${formatTime(conn.lastPingCheckedAt)}">● Недоступен</span>`;
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

    return `
      <div class="conn-card glass-card ${isActive ? 'active-conn' : ''}" id="card-conn-${conn.id}">
        <div>
          <div class="conn-card-header">
            <h3 class="conn-title">${flagHtml ? flagHtml + ' ' : ''}<span>${escapeHtml(conn.name)}</span></h3>
            ${isActive ? `<span class="active-pill-badge"><span class="status-dot"></span> Активно</span>` : ''}
          </div>

          <!-- BADGES ROW -->
          <div class="conn-badges-row">
            <span class="conn-badge badge-host" title="Хост:Порт">${escapeHtml(conn.serverAddress || '-')}:${conn.serverPort || '-'}</span>
            <span class="conn-badge badge-proto" title="Протокол">${escapeHtml((conn.protocol || 'vless').toUpperCase())}</span>
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
  }).join('');
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
    return `
      <div class="routing-card glass-card ${routing.isSystem ? 'system-routing' : ''}">
        <div>
          <div class="routing-header">
            <h3 class="routing-title">${escapeHtml(routing.name)}</h3>
            ${routing.isSystem ? `<span class="routing-system-badge">🔒 Защищен</span>` : ''}
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
}

// ==============================================================================
// VLESS URL PARSER (CLIENT-SIDE)
// ==============================================================================
function parseVlessUrlInput(showNotice = true) {
  const input = document.getElementById('input-vless-url');
  if (!input || !input.value.trim()) return;

  const rawUrl = input.value.trim();
  if (!rawUrl.startsWith('vless://')) {
    if (showNotice) showToast('Ссылка должна начинаться с vless://', 'warning');
    return;
  }

  try {
    const u = new URL(rawUrl);
    const id = u.username;
    const address = (u.hostname || '').replace(/^\[|\]$/g, '');
    const port = parseInt(u.port, 10);
    if (!id || !address || !port) {
      if (showNotice) showToast('Некорректная ссылка: нет UUID, адреса или порта', 'warning');
      return;
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

    // Build streamSettings
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

    // Populate Modal Fields (do not prefill connection name as requested)
    document.getElementById('conn-desc').value = '';
    setEditorContent('conn-outbound-json', JSON.stringify(outboundJsonObj, null, 4));

    // Show Preview Pills
    document.getElementById('preview-host').textContent = address;
    document.getElementById('preview-port').textContent = port;
    document.getElementById('preview-proto').textContent = 'VLESS';
    document.getElementById('preview-sec').textContent = security === 'reality' ? 'Reality' : security;
    const sniWrap = document.getElementById('preview-sni-wrap');
    if (sni) {
      document.getElementById('preview-sni').textContent = sni;
      sniWrap.classList.remove('hidden');
    } else {
      sniWrap.classList.add('hidden');
    }
    document.getElementById('add-meta-preview').classList.remove('hidden');

    if (showNotice) showToast('Ссылка успешно распознана!', 'success');
  } catch (err) {
    if (showNotice) showToast('Ошибка разбора ссылки: ' + err.message, 'error');
  }
}

// ==============================================================================
// CONNECTION ACTIONS
// ==============================================================================

// Open Add Connection Modal
function openAddConnectionModal() {
  document.getElementById('form-add-connection').reset();
  document.getElementById('add-meta-preview').classList.add('hidden');
  populateRoutingSelects();
  setEditorContent('conn-outbound-json', '{\n    "outbounds": []\n}');
  openModal('modal-add-connection');
}

// Submit Add Connection
async function onAddConnectionSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('conn-name').value.trim();
  const description = document.getElementById('conn-desc').value.trim();
  const routingId = document.getElementById('conn-routing').value;
  const outboundContent = document.getElementById('conn-outbound-json').value.trim();

  if (!name || !outboundContent) {
    showToast('Укажите название и содержимое outbound.json', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, routingId, outboundContent })
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
  document.getElementById('edit-conn-routing').value = conn.routingId || 'routing_all_vpn';

  // Preview pills
  document.getElementById('edit-preview-host').textContent = conn.serverAddress || '-';
  document.getElementById('edit-preview-port').textContent = conn.serverPort || '-';
  document.getElementById('edit-preview-proto').textContent = (conn.protocol || 'VLESS').toUpperCase();
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
  const routingId = document.getElementById('edit-conn-routing').value;
  const outboundContent = document.getElementById('edit-conn-outbound-json').value.trim();

  try {
    const res = await fetch(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, routingId, outboundContent })
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

// Reconstruct VLESS link from connection object or outbound JSON
function getConnectionVlessUrl(conn) {
  if (conn.url && conn.url.startsWith('vless://')) {
    return conn.url;
  }
  if (!conn.outboundContent) return '';
  try {
    const clean = stripComments(conn.outboundContent);
    const parsed = JSON.parse(clean);
    const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
    const ob = list.find(o => o && o.protocol === 'vless' && o.settings && o.settings.vnext && o.settings.vnext[0]);
    if (!ob) return '';

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
  } catch (e) {
    console.error('Error generating VLESS URL:', e);
    return '';
  }
}

// Open QR Code Modal for Connection
function openQrModal(id) {
  const conn = (appData.connections || []).find(c => c.id === id);
  if (!conn) return;

  const url = getConnectionVlessUrl(conn);
  if (!url) {
    showToast('Не удалось сформировать ссылку VLESS для этого подключения', 'warning');
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
      conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
      if (data.countryCode) conn.countryCode = data.countryCode;
      if (data.countryName) conn.countryName = data.countryName;
    }

    if (data.status === 'ok') {
      showToast(`Подключение доступно! Пинг: ${data.latencyStr}`, 'success');
    } else {
      showToast('Подключение недоступно', 'error');
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
          conn.lastPingCheckedAt = data.checkedAt || new Date().toISOString();
          if (data.countryCode) conn.countryCode = data.countryCode;
          if (data.countryName) conn.countryName = data.countryName;
        } else {
          conn.lastPing = null;
          conn.lastPingStatus = 'unreachable';
          conn.lastPingCheckedAt = new Date().toISOString();
        }
      } catch (e) {
        conn.lastPing = null;
        conn.lastPingStatus = 'unreachable';
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

  const saveBtn = document.getElementById('btn-save-routing');
  const formatBtn = document.getElementById('btn-format-routing');
  if (routing.isSystem) {
    saveBtn.classList.add('hidden');
    formatBtn.classList.add('hidden');
  } else {
    saveBtn.classList.remove('hidden');
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
      body: JSON.stringify({ name, description, content })
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
  const isAutoFailover = (tab === 'autofailover');
  const isFailover = (tab === 'failover');
  const isBackup = (tab === 'backup');

  const btnGeneral = document.getElementById('tab-btn-settings-general');
  const btnAutoFailover = document.getElementById('tab-btn-settings-autofailover');
  const btnBackup = document.getElementById('tab-btn-settings-backup');
  const btnFailover = document.getElementById('tab-btn-settings-failover');

  const contentGeneral = document.getElementById('settings-tab-content-general');
  const contentAutoFailover = document.getElementById('settings-tab-content-autofailover');
  const contentBackup = document.getElementById('settings-tab-content-backup');
  const contentFailover = document.getElementById('settings-tab-content-failover');

  if (btnGeneral) btnGeneral.classList.toggle('active', isGeneral);
  if (btnAutoFailover) btnAutoFailover.classList.toggle('active', isAutoFailover);
  if (btnBackup) btnBackup.classList.toggle('active', isBackup);
  if (btnFailover) btnFailover.classList.toggle('active', isFailover);

  if (contentGeneral) contentGeneral.classList.toggle('hidden', !isGeneral);
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

    // Handle Tab key in textarea
    textarea.addEventListener('keydown', (e) => {
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

  return escaped.replace(
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
  if (el) el.classList.add('hidden');
}

window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
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
let currentAppVersion = '2.0.1';
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
