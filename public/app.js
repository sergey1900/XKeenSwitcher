// Global state
let state = {
  profiles: [],
  settings: {
    outboundPath: '/opt/etc/xray/configs/05_outbounds.json',
    routingPath: '/opt/etc/xray/configs/05_routing.json',
    restartCommand: 'xkeen -restart',
    startCommand: 'xkeen -start',
    stopCommand: 'xkeen -stop',
    statusCommand: 'xkeen -status',
    activeProfileId: null,
    port: 3000
  },
  service: {
    status: 'loading', // 'running' | 'stopped' | 'error' | 'loading'
    output: '',
    error: '',
    timestamp: null
  },
  currentEditingProfileId: null,
  activeTab: 'outbound' // 'outbound' | 'routing'
};

// Monaco / CodeMirror / Textarea editor wrappers
let outboundEditor = null;
let routingEditor = null;

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  initModals();
  initDragAndDrop();
  initSearch();
  initFormValidation();

  // Load initial data
  await loadProfiles();
  await loadServiceStatus();

  // Periodic status poll every 10 seconds
  setInterval(loadServiceStatus, 10000);
});

// Toast notification helper
function showToast(message, type = 'success', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? 'fa-circle-check' : (type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation');
  
  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <div class="toast-content">
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Escape HTML for safe rendering
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Fetch and render profiles
async function loadProfiles() {
  const listEl = document.getElementById('profiles-list');
  try {
    const res = await fetch('/api/profiles');
    if (!res.ok) throw new Error('Ошибка загрузки профилей');
    const data = await res.json();

    state.profiles = data.profiles || [];
    state.settings = data.settings || state.settings;

    renderProfiles();
    updateActiveProfileBadge();
  } catch (err) {
    showToast(err.message, 'error');
    if (listEl) {
      listEl.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-circle-exclamation" style="color: var(--danger-color);"></i>
          <p>Не удалось подключиться к серверу</p>
        </div>
      `;
    }
  }
}

// Extract server address from outbound JSON
function extractServerAddress(outboundContent) {
  if (!outboundContent) return '';
  try {
    const clean = outboundContent.replace(/(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g, '');
    const parsed = JSON.parse(clean);
    
    // Check root or outbounds list
    const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
    for (const ob of list) {
      if (!ob) continue;
      // Skip direct, block
      if (ob.tag === 'direct' || ob.tag === 'block') continue;

      // VLESS, VMess, Trojan, ShadowSocks
      if (ob.settings && ob.settings.vnext && ob.settings.vnext[0] && ob.settings.vnext[0].address) {
        return ob.settings.vnext[0].address;
      }
      if (ob.settings && ob.settings.servers && ob.settings.servers[0] && ob.settings.servers[0].address) {
        return ob.settings.servers[0].address;
      }
    }
  } catch (e) {
    // If not strict JSON or parsing failed, try regex match for address
    const match = outboundContent.match(/"address"\s*:\s*"([^"]+)"/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  return '';
}

// Render profiles list
function renderProfiles(filterQuery = '') {
  const listEl = document.getElementById('profiles-list');
  if (!listEl) return;

  const query = filterQuery.toLowerCase().trim();
  const filtered = state.profiles.filter(p => {
    return p.name.toLowerCase().includes(query) || (p.description && p.description.toLowerCase().includes(query));
  });

  if (filtered.length === 0) {
    if (state.profiles.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-layer-group"></i>
          <p>У вас пока нет профилей</p>
          <p class="help-text" style="margin-top: 4px;">Нажмите «Добавить профиль» или перетащите ZIP архив с конфигурациями</p>
        </div>
      `;
    } else {
      listEl.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-magnifying-glass"></i>
          <p>Профили не найдены</p>
        </div>
      `;
    }
    return;
  }

  listEl.innerHTML = filtered.map(profile => {
    const isActive = state.settings.activeProfileId === profile.id;
    const serverAddress = extractServerAddress(profile.outboundContent);

    return `
      <div class="profile-card ${isActive ? 'active' : ''}" data-id="${escapeHtml(profile.id)}">
        <div class="profile-header">
          <div>
            <div class="profile-title">
              <i class="fa-solid fa-shield-halved" style="color: ${isActive ? 'var(--primary-color)' : 'var(--text-muted)'};"></i>
              ${escapeHtml(profile.name)}
            </div>
            ${profile.description ? `<div class="profile-desc">${escapeHtml(profile.description)}</div>` : ''}
          </div>
          ${isActive ? '<span class="badge badge-active"><i class="fa-solid fa-check"></i> Активен</span>' : ''}
        </div>

        ${serverAddress ? `
          <div class="profile-meta">
            <span class="meta-item" title="Адрес сервера">
              <i class="fa-solid fa-server"></i> ${escapeHtml(serverAddress)}
            </span>
          </div>
        ` : ''}

        <div class="profile-actions">
          ${isActive ? `
            <button class="btn btn-outline btn-sm" disabled style="opacity: 0.7; cursor: default;">
              <i class="fa-solid fa-circle-check" style="color: var(--success-color);"></i> Активен
            </button>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="activateProfile('${escapeHtml(profile.id)}')">
              <i class="fa-solid fa-bolt"></i> Активировать
            </button>
          `}
          
          <button class="btn btn-secondary btn-sm" onclick="openEditProfileModal('${escapeHtml(profile.id)}')">
            <i class="fa-solid fa-pen-to-square"></i> Изменить
          </button>
          
          <button class="btn btn-outline btn-sm" onclick="downloadProfile('${escapeHtml(profile.id)}')">
            <i class="fa-solid fa-download"></i> ZIP
          </button>

          <button class="btn btn-danger btn-sm" onclick="deleteProfile('${escapeHtml(profile.id)}', '${escapeHtml(profile.name)}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Update top navbar active profile badge
function updateActiveProfileBadge() {
  const badge = document.getElementById('active-profile-badge');
  if (!badge) return;

  const active = state.profiles.find(p => p.id === state.settings.activeProfileId);
  if (active) {
    badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(active.name)}`;
    badge.style.display = 'inline-flex';
  } else {
    badge.innerHTML = `<i class="fa-solid fa-circle-pause"></i> Не выбран`;
    badge.style.display = 'inline-flex';
  }
}

// Activate Profile
async function activateProfile(id) {
  const profile = state.profiles.find(p => p.id === id);
  if (!profile) return;

  showToast(`Применение профиля "${profile.name}"...`, 'warning', 2500);

  try {
    const res = await fetch(`/api/profiles/${id}/activate`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Ошибка активации профиля');
    }

    state.settings.activeProfileId = id;
    renderProfiles();
    updateActiveProfileBadge();

    showToast(data.message || 'Профиль успешно активирован!', 'success');
    
    // Refresh service status
    setTimeout(loadServiceStatus, 1500);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Delete Profile
async function deleteProfile(id, name) {
  if (!confirm(`Вы действительно хотите удалить профиль "${name}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Ошибка при удалении');
    }

    showToast(data.message || 'Профиль удален', 'success');
    await loadProfiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Download Profile ZIP
function downloadProfile(id) {
  window.open(`/api/profiles/${id}/download`, '_blank');
}

// Search Filter
function initSearch() {
  const searchInput = document.getElementById('search-profiles');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    renderProfiles(e.target.value);
  });
}

// Service status management
async function loadServiceStatus() {
  const dot = document.getElementById('service-status-dot');
  const text = document.getElementById('service-status-text');

  try {
    const res = await fetch('/api/service/status');
    if (!res.ok) throw new Error('Ошибка статуса');
    const data = await res.json();

    state.service = data;

    if (dot && text) {
      dot.className = 'status-dot';
      if (data.status === 'running') {
        dot.classList.add('running');
        text.innerText = 'XKeen работает';
      } else if (data.status === 'stopped') {
        dot.classList.add('stopped');
        text.innerText = 'XKeen остановлен';
      } else if (data.status === 'error') {
        dot.classList.add('error');
        text.innerText = 'Ошибка службы XKeen';
      } else {
        dot.classList.add('loading');
        text.innerText = 'Статус неизвестен';
      }
    }
  } catch (err) {
    if (dot && text) {
      dot.className = 'status-dot error';
      text.innerText = 'Связь потеряна';
    }
  }
}

// Restart Service
async function restartService() {
  showToast('Перезапуск службы XKeen...', 'warning', 3000);
  try {
    const res = await fetch('/api/service/restart', { method: 'POST' });
    const data = await res.json();

    if (!res.ok || data.status === 'error') {
      showToast(`Ошибка перезапуска: ${data.error || data.output || 'Неизвестная ошибка'}`, 'error', 6000);
    } else {
      showToast('Служба XKeen успешно перезапущена!', 'success');
    }
    await loadServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Start Service
async function startService() {
  showToast('Запуск службы XKeen...', 'warning', 3000);
  try {
    const res = await fetch('/api/service/start', { method: 'POST' });
    const data = await res.json();

    if (!res.ok || data.status === 'error') {
      showToast(`Ошибка запуска: ${data.error || data.output || 'Неизвестная ошибка'}`, 'error', 6000);
    } else {
      showToast('Служба XKeen успешно запущена!', 'success');
    }
    await loadServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Stop Service
async function stopService() {
  if (!confirm('Остановить службу XKeen? Интернет через прокси перестанет работать.')) {
    return;
  }

  showToast('Остановка службы XKeen...', 'warning', 3000);
  try {
    const res = await fetch('/api/service/stop', { method: 'POST' });
    const data = await res.json();

    showToast('Служба XKeen остановлена', 'success');
    await loadServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Show Service Console Details Modal
function openServiceModal() {
  const modal = document.getElementById('service-modal');
  const term = document.getElementById('service-terminal-output');
  const time = document.getElementById('service-last-check');
  const badge = document.getElementById('service-modal-badge');

  if (term) {
    term.innerText = state.service.output || state.service.error || 'Нет данных вывода команды';
  }
  if (time) {
    time.innerText = state.service.timestamp ? new Date(state.service.timestamp).toLocaleString('ru-RU') : 'Только что';
  }
  if (badge) {
    badge.className = 'badge';
    if (state.service.status === 'running') {
      badge.classList.add('badge-active');
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Работает';
    } else if (state.service.status === 'stopped') {
      badge.classList.add('badge-inactive');
      badge.innerHTML = '<i class="fa-solid fa-circle-pause"></i> Остановлен';
    } else {
      badge.classList.add('badge-error');
      badge.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Ошибка';
    }
  }

  openModal('service-modal');
}

// Modals Management
function initModals() {
  // Close modals on overlay click
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('active');
    }
  });

  // Close modals on ESC key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

// Switch Editor Tabs
function switchEditorTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.editor-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  const outboundPane = document.getElementById('pane-outbound');
  const routingPane = document.getElementById('pane-routing');

  if (outboundPane) outboundPane.classList.toggle('active', tabName === 'outbound');
  if (routingPane) routingPane.classList.toggle('active', tabName === 'routing');
}

// JSON Syntax / Comment validator and formatter
function validateAndFormatJson(textareaId) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const raw = textarea.value.trim();
  if (!raw) {
    showToast('Поле пустое', 'warning');
    return;
  }

  try {
    // Strip comments for validation and formatting
    const clean = raw.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")|(\/\*[\s\S]*?\*\/)|(\/\/[^\r\n]*)/g, (match, stringToken) => {
      return stringToken || '';
    });
    const parsed = JSON.parse(clean);
    textarea.value = JSON.stringify(parsed, null, 2);
    showToast('JSON успешно отформатирован!', 'success');
  } catch (err) {
    showToast(`Ошибка в JSON: ${err.message}`, 'error', 5000);
  }
}

// Open Add Profile Modal
function openAddProfileModal() {
  state.currentEditingProfileId = null;
  document.getElementById('profile-modal-title').innerText = 'Новый профиль';
  document.getElementById('profile-id').value = '';
  document.getElementById('profile-name').value = '';
  document.getElementById('profile-desc').value = '';
  
  // Default templates
  document.getElementById('profile-outbound-editor').value = JSON.stringify({
    "outbounds": [
      {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
          "vnext": [
            {
              "address": "example.server.com",
              "port": 443,
              "users": [
                {
                  "id": "00000000-0000-0000-0000-000000000000",
                  "encryption": "none",
                  "flow": "xtls-rprx-vision"
                }
              ]
            }
          ]
        },
        "streamSettings": {
          "network": "tcp",
          "security": "reality",
          "realitySettings": {
            "serverName": "yahoo.com",
            "fingerprint": "chrome",
            "show": false,
            "publicKey": "",
            "shortId": "",
            "spiderX": ""
          }
        }
      }
    ]
  }, null, 2);

  document.getElementById('profile-routing-editor').value = JSON.stringify({
    "routing": {
      "domainStrategy": "IPIfNonMatch",
      "rules": [
        {
          "type": "field",
          "outboundTag": "proxy",
          "domain": [
            "geosite:youtube",
            "geosite:netflix",
            "geosite:instagram"
          ]
        },
        {
          "type": "field",
          "outboundTag": "direct",
          "domain": [
            "geosite:category-ru",
            "domain:ru"
          ]
        },
        {
          "type": "field",
          "outboundTag": "proxy",
          "network": "tcp,udp"
        }
      ]
    }
  }, null, 2);

  switchEditorTab('outbound');
  openModal('profile-modal');
}

// Open Edit Profile Modal
function openEditProfileModal(id) {
  const profile = state.profiles.find(p => p.id === id);
  if (!profile) return;

  state.currentEditingProfileId = id;
  document.getElementById('profile-modal-title').innerText = `Редактирование: ${profile.name}`;
  document.getElementById('profile-id').value = profile.id;
  document.getElementById('profile-name').value = profile.name;
  document.getElementById('profile-desc').value = profile.description || '';
  document.getElementById('profile-outbound-editor').value = profile.outboundContent;
  document.getElementById('profile-routing-editor').value = profile.routingContent;

  switchEditorTab('outbound');
  openModal('profile-modal');
}

// Form validation and submit handling
function initFormValidation() {
  const profileForm = document.getElementById('profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const id = document.getElementById('profile-id').value;
      const name = document.getElementById('profile-name').value.trim();
      const description = document.getElementById('profile-desc').value.trim();
      const outboundContent = document.getElementById('profile-outbound-editor').value.trim();
      const routingContent = document.getElementById('profile-routing-editor').value.trim();

      if (!name) {
        showToast('Введите название профиля', 'warning');
        return;
      }
      if (!outboundContent) {
        showToast('Заполните конфигурацию outbound.json', 'warning');
        return;
      }
      if (!routingContent) {
        showToast('Заполните конфигурацию routing.json', 'warning');
        return;
      }

      // Pre-flight JSON syntax validation
      try {
        const cleanOb = outboundContent.replace(/(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g, '');
        JSON.parse(cleanOb);
      } catch (err) {
        showToast(`Ошибка в outbound.json: ${err.message}`, 'error', 5000);
        switchEditorTab('outbound');
        return;
      }

      try {
        const cleanRt = routingContent.replace(/(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g, '');
        JSON.parse(cleanRt);
      } catch (err) {
        showToast(`Ошибка в routing.json: ${err.message}`, 'error', 5000);
        switchEditorTab('routing');
        return;
      }

      const isEdit = Boolean(id);
      const url = isEdit ? `/api/profiles/${id}` : '/api/profiles';
      const method = isEdit ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, outboundContent, routingContent })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Ошибка при сохранении профиля');
        }

        showToast(data.message || (isEdit ? 'Профиль сохранен!' : 'Профиль добавлен!'), 'success');
        closeModal('profile-modal');
        await loadProfiles();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Settings form
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const outboundPath = document.getElementById('setting-outbound-path').value.trim();
      const routingPath = document.getElementById('setting-routing-path').value.trim();
      const restartCommand = document.getElementById('setting-restart-cmd').value.trim();
      const startCommand = document.getElementById('setting-start-cmd').value.trim();
      const stopCommand = document.getElementById('setting-stop-cmd').value.trim();
      const statusCommand = document.getElementById('setting-status-cmd').value.trim();
      const portVal = document.getElementById('setting-port').value.trim();

      const port = portVal ? parseInt(portVal, 10) : 3000;
      if (isNaN(port) || port < 1 || port > 65535) {
        showToast('Введите корректный номер порта (1-65535)', 'warning');
        return;
      }

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            outboundPath,
            routingPath,
            restartCommand,
            startCommand,
            stopCommand,
            statusCommand,
            port
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Ошибка сохранения настроек');
        }

        state.settings = data.settings;
        showToast(data.message || 'Настройки сохранены!', 'success');
        closeModal('settings-modal');

        if (data.portChanged) {
          showToast(`Порт изменен на ${data.newPort}. Страница перезагрузится по новому адресу через 3 секунды...`, 'warning', 5000);
          setTimeout(() => {
            const loc = window.location;
            window.location.href = `${loc.protocol}//${loc.hostname}:${data.newPort}${loc.pathname}`;
          }, 3000);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

// Open Settings Modal
function openSettingsModal() {
  document.getElementById('setting-outbound-path').value = state.settings.outboundPath || '';
  document.getElementById('setting-routing-path').value = state.settings.routingPath || '';
  document.getElementById('setting-restart-cmd').value = state.settings.restartCommand || '';
  document.getElementById('setting-start-cmd').value = state.settings.startCommand || '';
  document.getElementById('setting-stop-cmd').value = state.settings.stopCommand || '';
  document.getElementById('setting-status-cmd').value = state.settings.statusCommand || '';
  document.getElementById('setting-port').value = state.settings.port || 3000;

  openModal('settings-modal');
}

// Drag & Drop / File upload archive handling
function initDragAndDrop() {
  const dropZone = document.getElementById('drag-drop-overlay');
  const fileInput = document.getElementById('archive-file-input');

  ['dragenter', 'dragover'].forEach(eventName => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dropZone) dropZone.classList.add('active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target === dropZone || eventName === 'drop') {
        if (dropZone) dropZone.classList.remove('active');
      }
    }, false);
  });

  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      handleUploadedArchive(files[0]);
    }
  });

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleUploadedArchive(e.target.files[0]);
        fileInput.value = '';
      }
    });
  }
}

// Upload and Parse Archive (ZIP, TAR, GZ, TGZ)
async function handleUploadedArchive(file) {
  const allowedExtensions = ['.zip', '.tar.gz', '.tgz', '.tar', '.json'];
  const nameLower = file.name.toLowerCase();
  const isAllowed = allowedExtensions.some(ext => nameLower.endsWith(ext));

  if (!isAllowed) {
    showToast('Поддерживаются только архивы .zip, .tar.gz, .tgz или файлы .json', 'warning');
    return;
  }

  showToast(`Обработка архива "${file.name}"...`, 'warning', 2500);

  const reader = new FileReader();
  reader.onload = async (e) => {
    const arrayBuffer = e.target.result;
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    try {
      const res = await fetch('/api/parse-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zipBase64: base64, filename: file.name })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Ошибка распаковки архива');
      }

      // Populate form and open modal
      state.currentEditingProfileId = null;
      document.getElementById('profile-modal-title').innerText = 'Импорт из архива: ' + (data.name || file.name);
      document.getElementById('profile-id').value = '';
      document.getElementById('profile-name').value = data.name || file.name.replace(/\.[^/.]+$/, '');
      document.getElementById('profile-desc').value = data.description || '';
      document.getElementById('profile-outbound-editor').value = data.outboundContent || '{\n  "outbounds": []\n}';
      document.getElementById('profile-routing-editor').value = data.routingContent || '{\n  "routing": {\n    "rules": []\n  }\n}';

      switchEditorTab('outbound');
      openModal('profile-modal');
      showToast('Архив успешно распознан!', 'success');
    } catch (err) {
      showToast(err.message, 'error', 5000);
    }
  };

  reader.readAsArrayBuffer(file);
}

// Trigger hidden file input
function triggerArchiveUpload() {
  const input = document.getElementById('archive-file-input');
  if (input) input.click();
}
