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
    code: 0,
    timestamp: null,
    command: ''
  },
  currentViewProfileId: null,
  currentViewTab: 'outbound',
  activatingProfileId: null
};

let statusPollingInterval = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  preventGlobalDragDrop();
  initEventListeners();
  fetchData();
  fetchServiceStatus();

  // Poll service status every 12 seconds
  if (statusPollingInterval) clearInterval(statusPollingInterval);
  statusPollingInterval = setInterval(() => {
    fetchServiceStatus(true); // silent background poll
  }, 12000);
});

// Prevent browser from opening dropped files in new window
function preventGlobalDragDrop() {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
    }, false);
  });
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

// Fetch data from backend
async function fetchData() {
  try {
    const res = await fetch('/api/profiles');
    if (!res.ok) throw new Error('Не удалось загрузить данные');
    const data = await res.json();
    
    state.profiles = data.profiles || [];
    state.settings = { ...state.settings, ...(data.settings || {}) };
    
    if (data.version) {
      const verEl = document.getElementById('app-version-text');
      if (verEl) verEl.textContent = 'v' + data.version.replace(/^v/, '');
    }

    renderProfiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Render Profile Cards
function renderProfiles() {
  const grid = document.getElementById('profiles-grid');
  const emptyState = document.getElementById('empty-state');
  const countEl = document.getElementById('profiles-count');

  if (countEl) countEl.textContent = state.profiles.length;
  if (!grid) return;
  
  grid.innerHTML = '';

  if (state.profiles.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  } else {
    if (emptyState) emptyState.classList.add('hidden');
  }

  state.profiles.forEach(profile => {
    const isActive = profile.id === state.settings.activeProfileId;
    const isActivating = profile.id === state.activatingProfileId;
    const card = document.createElement('article');
    card.className = `glass-card profile-card ${isActive ? 'active-card' : ''}`;

    let activateBtnHtml = '';
    if (!isActive) {
      if (isActivating) {
        activateBtnHtml = `
          <button class="btn btn-activate loading" disabled title="Включение профиля...">
            <svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l6.17-5.19"/></svg>
            Включение...
          </button>
        `;
      } else {
        activateBtnHtml = `
          <button class="btn btn-activate" onclick="activateProfile('${profile.id}')" ${state.activatingProfileId ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Включить
          </button>
        `;
      }
    }

    card.innerHTML = `
      <div>
        <div class="card-header">
          <h3 class="card-title">${escapeHtml(profile.name)}</h3>
          <span class="card-badge ${isActive ? 'badge-active' : 'badge-inactive'}">
            ${isActive ? 'АКТИВЕН' : (isActivating ? 'Включение...' : 'Не активен')}
          </span>
        </div>
        <p class="card-desc">${escapeHtml(profile.description || 'Без описания')}</p>
      </div>

      <div class="card-actions">
        <div class="card-actions-left">
          ${activateBtnHtml}
        </div>
        <div class="card-actions-right">
          <button class="btn btn-icon btn-secondary" onclick="openEditModal('${profile.id}')" title="Просмотр и редактирование конфигурации" ${isActivating ? 'disabled' : ''}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 01-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <a href="/api/profiles/${profile.id}/download" class="btn btn-icon btn-secondary ${isActivating ? 'disabled' : ''}" title="Скачать ZIP архив" download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
          <button class="btn btn-icon btn-danger" onclick="deleteProfile('${profile.id}', '${escapeHtml(profile.name)}')" title="Удалить профиль" ${isActivating ? 'disabled' : ''}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);
  });
}

// Activate profile in 1 click
async function activateProfile(id) {
  if (state.activatingProfileId) return;

  state.activatingProfileId = id;
  renderProfiles();
  renderServiceStatus();

  try {
    const res = await fetch(`/api/profiles/${id}/activate`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Ошибка активации');

    let msg = data.message;
    if (data.restartStatus && data.restartStatus.executed) {
      msg += data.restartStatus.error ? ` (Перезапуск: ${data.restartStatus.error})` : ' (Служба XKeen перезапущена)';
    }

    showToast(msg, data.restartStatus && data.restartStatus.error ? 'error' : 'success');

    if (data.serviceStatus) {
      state.service = data.serviceStatus;
    } else {
      await fetchServiceStatus();
    }
  } catch (err) {
    showToast(err.message, 'error');
    await fetchServiceStatus();
  } finally {
    state.activatingProfileId = null;
    await fetchData();
    renderServiceStatus();
  }
}

// Delete profile
async function deleteProfile(id, name) {
  if (!confirm(`Удалить профиль "${name}"?`)) return;

  try {
    const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления');

    showToast(data.message, 'success');
    fetchData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Initialize Event Listeners
function initEventListeners() {
  const btnAdd = document.getElementById('btn-add-profile');
  if (btnAdd) btnAdd.addEventListener('click', openAddModal);

  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', openSettingsModal);

  // Add Form Submit
  const addForm = document.getElementById('add-profile-form');
  if (addForm) addForm.addEventListener('submit', handleAddProfile);

  // View/Edit Form Submit
  const viewForm = document.getElementById('view-profile-form');
  if (viewForm) viewForm.addEventListener('submit', handleSaveViewEdit);

  // Settings Form Submit
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) settingsForm.addEventListener('submit', handleSaveSettings);

  // Import ZIP listener
  const importZipInput = document.getElementById('import-zip-file');
  if (importZipInput) {
    importZipInput.addEventListener('change', handleImportZip);
  }

  // Setup Dropzone logic for outbound & routing (Add form)
  setupDropzone('outbound-dropzone', 'outbound-file-input', 'outbound-text', 'outbound-json-status', null, 'outbound-code');
  setupDropzone('routing-dropzone', 'routing-file-input', 'routing-text', 'routing-json-status', null, 'routing-code');

  // Setup Dropzone logic for outbound & routing (View/Edit modal)
  setupDropzone('view-outbound-dropzone', 'view-outbound-file-input', 'view-outbound-text', 'view-outbound-json-status', 'tab-outbound-dot', 'view-outbound-code');
  setupDropzone('view-routing-dropzone', 'view-routing-file-input', 'view-routing-text', 'view-routing-json-status', 'tab-routing-dot', 'view-routing-code');

  // Setup Code Editors with real-time syntax highlighting
  setupCodeEditor('outbound-text', 'outbound-code', 'outbound-json-status');
  setupCodeEditor('routing-text', 'routing-code', 'routing-json-status');
  setupCodeEditor('view-outbound-text', 'view-outbound-code', 'view-outbound-json-status', 'tab-outbound-dot');
  setupCodeEditor('view-routing-text', 'view-routing-code', 'view-routing-json-status', 'tab-routing-dot');

  // Multi-file drag & drop on add-modal and view-modal containers
  setupModalMultiFileDrop('add-modal', {
    outboundTextId: 'outbound-text',
    outboundCodeId: 'outbound-code',
    outboundStatusId: 'outbound-json-status',
    routingTextId: 'routing-text',
    routingCodeId: 'routing-code',
    routingStatusId: 'routing-json-status',
    nameInputId: 'profile-name'
  });

  setupModalMultiFileDrop('view-modal', {
    outboundTextId: 'view-outbound-text',
    outboundCodeId: 'view-outbound-code',
    outboundStatusId: 'view-outbound-json-status',
    outboundDotId: 'tab-outbound-dot',
    routingTextId: 'view-routing-text',
    routingCodeId: 'view-routing-code',
    routingStatusId: 'view-routing-json-status',
    routingDotId: 'tab-routing-dot'
  });
}

// JSON Syntax Highlighter (with // and /* */ comment support)
function highlightJson(jsonStr) {
  if (!jsonStr) return '';

  let html = jsonStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Group 1: comments (//... or /*...*/)
  // Group 2: strings + optional colon for keys ("key": or "string")
  // Group 5: booleans and null
  // Group 6: numbers
  // Group 7: punctuation/brackets
  const regex = /(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)|("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)|(\b(true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;

  let result = html.replace(regex, (match, commentToken, strToken, p3, isKey, keywordToken, boolNull, numToken, punctToken) => {
    if (commentToken) {
      return `<span class="tok-comment">${commentToken}</span>`;
    } else if (strToken) {
      if (isKey) {
        const colonIndex = strToken.lastIndexOf(':');
        const keyPart = strToken.slice(0, colonIndex);
        return `<span class="tok-key">${keyPart}</span><span class="tok-punct">:</span>`;
      } else {
        return `<span class="tok-string">${strToken}</span>`;
      }
    } else if (keywordToken) {
      return `<span class="tok-bool">${keywordToken}</span>`;
    } else if (numToken !== undefined && numToken !== '') {
      return `<span class="tok-num">${numToken}</span>`;
    } else if (punctToken) {
      return `<span class="tok-punct">${punctToken}</span>`;
    }
    return match;
  });

  if (jsonStr.endsWith('\n')) {
    result += ' ';
  }

  return result;
}

// Setup Code Editor with Syntax Highlighting and Scroll/Tab Sync
function setupCodeEditor(textareaId, codeId, statusId, dotId) {
  const textarea = document.getElementById(textareaId);
  const code = document.getElementById(codeId);
  if (!textarea || !code) return;

  function update() {
    code.innerHTML = highlightJson(textarea.value);
    validateJsonInput(textareaId, statusId, dotId);
  }

  function syncScroll() {
    const pre = code.parentElement;
    if (pre) {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }
  }

  textarea.addEventListener('input', update);
  textarea.addEventListener('scroll', syncScroll);

  // Tab key indentation support (inserts 2 spaces)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      textarea.value = val.substring(0, start) + '  ' + val.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      update();
    }
  });
}

function bindJsonValidation(textId, statusId, dotId) {
  const el = document.getElementById(textId);
  if (el) {
    el.addEventListener('input', () => validateJsonInput(textId, statusId, dotId));
  }
}

// Format JSON content helper button
function formatJsonField(textareaId, statusId, dotId) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const val = textarea.value.trim();
  if (!val) return;

  try {
    const parsed = parseJsonWithComments(val);
    textarea.value = JSON.stringify(parsed, null, 2);
    
    // Refresh highlight code layer if present
    const codeId = textareaId.replace('-text', '-code');
    const code = document.getElementById(codeId);
    if (code) {
      code.innerHTML = highlightJson(textarea.value);
    }

    validateJsonInput(textareaId, statusId, dotId);
    showToast('JSON успешно отформатирован', 'success');
  } catch (err) {
    validateJsonInput(textareaId, statusId, dotId);
    showToast('Невозможно отформатировать: ошибка синтаксиса JSON', 'error');
  }
}

// Handle ZIP archive import in Add Profile modal
async function handleImportZip(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const base64 = event.target.result.split(',')[1];
        const res = await fetch('/api/parse-zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zipBase64: base64, filename: file.name })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Ошибка чтения ZIP архива');

        if (data.name) {
          document.getElementById('profile-name').value = data.name;
        }
        if (data.description !== undefined) {
          document.getElementById('profile-desc').value = data.description;
        }
        if (data.outboundContent) {
          const outboundEl = document.getElementById('outbound-text');
          if (outboundEl) {
            outboundEl.value = data.outboundContent;
            formatJsonField('outbound-text', 'outbound-json-status');
          }
        }
        if (data.routingContent) {
          const routingEl = document.getElementById('routing-text');
          if (routingEl) {
            routingEl.value = data.routingContent;
            formatJsonField('routing-text', 'routing-json-status');
          }
        }

        showToast('Профиль успешно импортирован из ZIP архива!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    showToast('Не удалось прочитать файл', 'error');
    e.target.value = '';
  }
}

// Dropzone file loader helper with drag & drop support
function setupDropzone(dropzoneId, inputId, textId, statusId, dotId, codeId) {
  const dropzone = document.getElementById(dropzoneId);
  const input = document.getElementById(inputId);
  const textarea = document.getElementById(textId);

  if (!dropzone) return;

  if (input) {
    dropzone.addEventListener('click', (e) => {
      if (e.target !== input) {
        input.click();
      }
    });

    input.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesList(e.target.files, dropzoneId, textId, statusId, dotId, codeId);
        input.value = '';
      }
    });
  }

  let dragCounter = 0;

  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dropzone.classList.contains('dragover')) {
      dropzone.classList.add('dragover');
    }
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropzone.classList.remove('dragover');
    }
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropzone.classList.remove('dragover');

    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesList(e.dataTransfer.files, dropzoneId, textId, statusId, dotId, codeId);
    }
  });
}

// Smart file handler
function handleFilesList(files, dropzoneId, targetTextId, targetStatusId, dotId, codeId) {
  const fileArray = Array.from(files);

  // If multiple files dropped
  if (fileArray.length > 1) {
    let outboundFile = null;
    let routingFile = null;

    fileArray.forEach(file => {
      const lower = file.name.toLowerCase();
      if (lower.includes('outbound') || lower.includes('05_') || lower.includes('04_') || lower.includes('out')) {
        outboundFile = file;
      } else if (lower.includes('routing') || lower.includes('03_') || lower.includes('05_') || lower.includes('route')) {
        routingFile = file;
      }
    });

    const isViewModal = dropzoneId.startsWith('view-');
    const prefix = isViewModal ? 'view-' : '';
    const outboundDot = isViewModal ? 'tab-outbound-dot' : null;
    const routingDot = isViewModal ? 'tab-routing-dot' : null;
    const outboundCode = isViewModal ? 'view-outbound-code' : null;
    const routingCode = isViewModal ? 'view-routing-code' : null;

    if (outboundFile) {
      const el = document.getElementById(`${prefix}outbound-text`);
      if (el) readJsonFile(outboundFile, el, `${prefix}outbound-json-status`, outboundDot, outboundCode);
    }
    if (routingFile) {
      const el = document.getElementById(`${prefix}routing-text`);
      if (el) readJsonFile(routingFile, el, `${prefix}routing-json-status`, routingDot, routingCode);
    }

    if (outboundFile && routingFile) {
      showToast('Загружены outbound.json и routing.json', 'success');
      return;
    }
  }

  // Single file dropped directly on dropzone
  const singleFile = fileArray[0];
  const textarea = document.getElementById(targetTextId);
  if (textarea && singleFile) {
    readJsonFile(singleFile, textarea, targetStatusId, dotId, codeId);
    showToast(`Файл "${singleFile.name}" загружен`, 'success');

    const nameInput = document.getElementById('profile-name');
    if (nameInput && !nameInput.value.trim()) {
      const cleanName = singleFile.name.replace(/\.json$/i, '').replace(/^(05_|04_|03_)/, '');
      if (cleanName && cleanName.toLowerCase() !== 'outbound' && cleanName.toLowerCase() !== 'routing') {
        nameInput.value = cleanName;
      }
    }
  }
}

// Support dragging files onto modal card directly
function setupModalMultiFileDrop(modalId, config) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  const card = modal.querySelector('.modal-card');
  if (!card) return;

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  card.addEventListener('drop', (e) => {
    if (e.target.closest('.file-dropzone')) return;

    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      files.forEach(file => {
        const lower = file.name.toLowerCase();
        if (lower.includes('outbound') || lower.includes('04_') || (lower.includes('05_') && lower.includes('out'))) {
          const el = document.getElementById(config.outboundTextId);
          if (el) readJsonFile(file, el, config.outboundStatusId, config.outboundDotId, config.outboundCodeId);
        } else if (lower.includes('routing') || lower.includes('03_') || (lower.includes('05_') && lower.includes('rout'))) {
          const el = document.getElementById(config.routingTextId);
          if (el) readJsonFile(file, el, config.routingStatusId, config.routingDotId, config.routingCodeId);
        }
      });
      showToast('Файлы обработаны', 'success');
    }
  });
}

function readJsonFile(file, textarea, statusId, dotId, codeId) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = parseJsonWithComments(e.target.result);
      // If it has no comments, format it; otherwise keep comments intact
      if (!/\/\/|\/\*/.test(e.target.result)) {
        textarea.value = JSON.stringify(parsed, null, 2);
      } else {
        textarea.value = e.target.result;
      }
    } catch {
      textarea.value = e.target.result;
    }

    if (codeId) {
      const code = document.getElementById(codeId);
      if (code) {
        code.innerHTML = highlightJson(textarea.value);
      }
    }

    validateJsonInput(textarea.id, statusId, dotId);
  };
  reader.readAsText(file);
}

function validateJsonInput(textareaId, statusId, dotId) {
  const textarea = document.getElementById(textareaId);
  const statusEl = document.getElementById(statusId);
  const dotEl = dotId ? document.getElementById(dotId) : null;
  if (!textarea || !statusEl) return;

  const val = textarea.value.trim();

  if (!val) {
    statusEl.textContent = '';
    statusEl.className = 'json-status';
    if (dotEl) dotEl.className = 'tab-status-dot';
    return;
  }

  try {
    parseJsonWithComments(val);
    statusEl.textContent = '✓ Валидный JSON';
    statusEl.className = 'json-status valid';
    if (dotEl) dotEl.className = 'tab-status-dot valid';
  } catch (err) {
    statusEl.textContent = '✗ Ошибка JSON: ' + err.message.replace(/^JSON\.parse:\s*/i, '');
    statusEl.className = 'json-status invalid';
    if (dotEl) dotEl.className = 'tab-status-dot invalid';
  }
}

// Handle Add Profile Submission
async function handleAddProfile(e) {
  e.preventDefault();
  const name = document.getElementById('profile-name').value.trim();
  const description = document.getElementById('profile-desc').value.trim();
  const outboundContent = document.getElementById('outbound-text').value.trim();
  const routingContent = document.getElementById('routing-text').value.trim();

  if (!name || !outboundContent || !routingContent) {
    showToast('Пожалуйста, заполните все обязательные поля', 'error');
    return;
  }

  try {
    parseJsonWithComments(outboundContent);
  } catch (err) {
    showToast('Ошибка в outbound.json: ' + err.message, 'error');
    return;
  }

  try {
    parseJsonWithComments(routingContent);
  } catch (err) {
    showToast('Ошибка в routing.json: ' + err.message, 'error');
    return;
  }

  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, outboundContent, routingContent })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

    showToast('Профиль успешно создан!', 'success');
    closeModal('add-modal');
    document.getElementById('add-profile-form').reset();
    document.getElementById('outbound-json-status').textContent = '';
    document.getElementById('routing-json-status').textContent = '';
    fetchData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Handle View/Edit Profile Submission (Save + Restart)
async function handleSaveViewEdit(e) {
  e.preventDefault();
  const id = document.getElementById('view-profile-id').value;
  const name = document.getElementById('view-profile-name').value.trim();
  const description = document.getElementById('view-profile-desc').value.trim();
  const outboundContent = document.getElementById('view-outbound-text').value.trim();
  const routingContent = document.getElementById('view-routing-text').value.trim();

  if (!id || !name || !outboundContent || !routingContent) {
    showToast('Заполните название и конфигурацию обоих файлов', 'error');
    return;
  }

  try {
    parseJsonWithComments(outboundContent);
  } catch (err) {
    switchViewTab('outbound');
    showToast('Ошибка синтаксиса в outbound.json: ' + err.message, 'error');
    return;
  }

  try {
    parseJsonWithComments(routingContent);
  } catch (err) {
    switchViewTab('routing');
    showToast('Ошибка синтаксиса в routing.json: ' + err.message, 'error');
    return;
  }

  const saveBtn = document.getElementById('btn-save-view-edit');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const res = await fetch(`/api/profiles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, outboundContent, routingContent })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

    showToast(data.message || 'Профиль успешно сохранен!', 'success');
    closeModal('view-modal');
    fetchData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Handle Settings Submission
async function handleSaveSettings(e) {
  e.preventDefault();
  const outboundPath = document.getElementById('setting-outbound-path').value.trim();
  const routingPath = document.getElementById('setting-routing-path').value.trim();
  const restartCommand = document.getElementById('setting-restart-cmd').value.trim();
  const startCommand = document.getElementById('setting-start-cmd').value.trim();
  const stopCommand = document.getElementById('setting-stop-cmd').value.trim();
  const statusCommand = document.getElementById('setting-status-cmd').value.trim();
  const portVal = document.getElementById('setting-panel-port').value.trim();
  const port = parseInt(portVal, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    showToast('Укажите корректный номер порта (1-65535)', 'error');
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
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

    showToast(data.message || 'Настройки сохранены!', 'success');
    closeModal('settings-modal');

    if (data.portChanged && data.newPort) {
      const currentPort = window.location.port ? parseInt(window.location.port, 10) : (window.location.protocol === 'https:' ? 443 : 80);
      if (currentPort !== data.newPort) {
        showToast(`Перенаправление на порт ${data.newPort}...`, 'info');
        setTimeout(() => {
          window.location.href = `${window.location.protocol}//${window.location.hostname}:${data.newPort}/`;
        }, 2500);
        return;
      }
    }

    fetchData();
    fetchServiceStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Fetch Service Status
async function fetchServiceStatus(silent = false) {
  const badgeEl = document.getElementById('service-status-badge');
  const textEl = document.getElementById('service-status-text');
  
  if (!silent && badgeEl && textEl) {
    badgeEl.className = 'service-status-badge status-loading';
    textEl.textContent = 'Проверка...';
  }

  try {
    const res = await fetch('/api/service/status');
    if (!res.ok) throw new Error('Ошибка связи с сервером');
    const data = await res.json();
    state.service = data;
    renderServiceStatus();
  } catch (err) {
    state.service = {
      status: 'error',
      output: '',
      error: err.message,
      code: 1,
      timestamp: new Date().toISOString(),
      command: state.settings.statusCommand || 'xkeen -status'
    };
    renderServiceStatus();
  }
}

// Render Service Status Badge & Action Buttons
function renderServiceStatus() {
  const badgeEl = document.getElementById('service-status-badge');
  const textEl = document.getElementById('service-status-text');
  const btnRestart = document.getElementById('btn-service-restart');
  const btnStart = document.getElementById('btn-service-start');
  const btnStop = document.getElementById('btn-service-stop');

  if (!badgeEl || !textEl) return;

  if (state.activatingProfileId) {
    badgeEl.className = 'service-status-badge status-loading';
    textEl.textContent = 'Применение и перезапуск...';
    if (btnStart) btnStart.classList.add('hidden');
    if (btnRestart) btnRestart.classList.add('hidden');
    if (btnStop) btnStop.classList.add('hidden');
    return;
  }

  const status = state.service.status || 'unknown';

  badgeEl.className = `service-status-badge status-${status}`;

  if (status === 'running') {
    textEl.textContent = 'XKeen: Работает';
    // Active: Show Restart & Stop, Hide Start
    if (btnStart) btnStart.classList.add('hidden');
    if (btnRestart) btnRestart.classList.remove('hidden');
    if (btnStop) btnStop.classList.remove('hidden');
  } else if (status === 'stopped') {
    textEl.textContent = 'XKeen: Остановлен';
    // Inactive: Show ONLY Start, Hide Restart & Stop
    if (btnStart) btnStart.classList.remove('hidden');
    if (btnRestart) btnRestart.classList.add('hidden');
    if (btnStop) btnStop.classList.add('hidden');
  } else if (status === 'error') {
    textEl.textContent = 'XKeen: Ошибка ⚠️ (детали)';
    // Error / Failed to start: Show Start & Restart for recovery
    if (btnStart) btnStart.classList.remove('hidden');
    if (btnRestart) btnRestart.classList.remove('hidden');
    if (btnStop) btnStop.classList.add('hidden');
  } else {
    textEl.textContent = 'Проверка...';
    if (btnStart) btnStart.classList.add('hidden');
    if (btnRestart) btnRestart.classList.add('hidden');
    if (btnStop) btnStop.classList.add('hidden');
  }
}

// Control Service (restart, start, stop)
async function controlService(action) {
  const btnRestart = document.getElementById('btn-service-restart');
  const btnStart = document.getElementById('btn-service-start');
  const btnStop = document.getElementById('btn-service-stop');
  const badgeEl = document.getElementById('service-status-badge');
  const textEl = document.getElementById('service-status-text');

  const buttons = [btnRestart, btnStart, btnStop].filter(Boolean);
  buttons.forEach(b => b.disabled = true);

  if (badgeEl && textEl) {
    badgeEl.className = 'service-status-badge status-loading';
    textEl.textContent = action === 'restart' ? 'Перезапуск...' : (action === 'start' ? 'Запуск...' : 'Остановка...');
  }

  const actionLabels = {
    restart: 'Перезапуск',
    start: 'Запуск',
    stop: 'Остановка'
  };

  try {
    const res = await fetch(`/api/service/${action}`, { method: 'POST' });
    const data = await res.json();
    state.service = data;
    renderServiceStatus();

    if (res.ok && data.status !== 'error') {
      showToast(data.message || `${actionLabels[action]} выполнен успешно`, 'success');
    } else {
      showToast(`${actionLabels[action]} завершился с ошибкой. Нажмите на статус для лога`, 'error');
      // If error, auto open details modal
      openServiceStatusModal();
    }
  } catch (err) {
    state.service = {
      status: 'error',
      output: '',
      error: err.message,
      code: 1,
      timestamp: new Date().toISOString(),
      command: `POST /api/service/${action}`
    };
    renderServiceStatus();
    showToast(`Ошибка: ${err.message}`, 'error');
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
}

// On Status Badge Click
function onStatusBadgeClick() {
  openServiceStatusModal();
}

// Open Service Status Details Modal
function openServiceStatusModal() {
  const modal = document.getElementById('service-status-modal');
  if (!modal) return;

  const service = state.service || {};
  const status = service.status || 'unknown';

  const badgeEl = document.getElementById('service-modal-badge');
  const badgeText = document.getElementById('service-modal-badge-text');
  const cmdEl = document.getElementById('service-modal-cmd');
  const timeEl = document.getElementById('service-modal-time');
  const logEl = document.getElementById('service-modal-log');

  if (badgeEl) badgeEl.className = `service-status-badge status-${status}`;
  if (badgeText) {
    if (status === 'running') badgeText.textContent = 'Работает';
    else if (status === 'stopped') badgeText.textContent = 'Остановлен';
    else if (status === 'error') badgeText.textContent = 'Ошибка';
    else badgeText.textContent = 'Проверка...';
  }

  if (cmdEl) cmdEl.textContent = service.command || state.settings.statusCommand || 'xkeen -status';
  if (timeEl) {
    timeEl.textContent = service.timestamp ? new Date(service.timestamp).toLocaleString('ru-RU') : 'Только что';
  }

  let fullLog = '';
  if (service.output) fullLog += service.output;
  if (service.error) {
    if (fullLog) fullLog += '\n\n[STDERR / ERROR]:\n';
    fullLog += service.error;
  }
  if (!fullLog) {
    fullLog = '(Вывод пуст. Команда завершилась с кодом: ' + (service.code !== undefined ? service.code : 0) + ')';
  }

  if (logEl) logEl.textContent = fullLog;

  modal.classList.remove('hidden');
}

// Copy Terminal Service Log
function copyServiceLog() {
  const logEl = document.getElementById('service-modal-log');
  if (!logEl) return;
  
  navigator.clipboard.writeText(logEl.textContent).then(() => {
    showToast('Лог скопирован в буфер обмена', 'success');
  }).catch(() => {
    showToast('Не удалось скопировать лог', 'error');
  });
}

// Modal Handlers
function openAddModal() {
  document.getElementById('add-profile-form').reset();
  const outCode = document.getElementById('outbound-code');
  const routCode = document.getElementById('routing-code');
  if (outCode) outCode.innerHTML = '';
  if (routCode) routCode.innerHTML = '';
  document.getElementById('outbound-json-status').textContent = '';
  document.getElementById('routing-json-status').textContent = '';
  document.getElementById('add-modal').classList.remove('hidden');
}

function openEditModal(profileId) {
  state.currentViewProfileId = profileId;
  const profile = state.profiles.find(p => p.id === profileId);
  if (!profile) return;

  const isActive = profile.id === state.settings.activeProfileId;
  const badgeEl = document.getElementById('view-modal-badge');
  if (badgeEl) {
    badgeEl.textContent = isActive ? 'АКТИВЕН' : 'Не активен';
    badgeEl.className = `card-badge ${isActive ? 'badge-active' : 'badge-inactive'}`;
  }

  document.getElementById('view-modal-title').textContent = `Конфигурация профиля`;
  document.getElementById('view-profile-id').value = profile.id;
  document.getElementById('view-profile-name').value = profile.name;
  document.getElementById('view-profile-desc').value = profile.description || '';
  
  const outboundText = document.getElementById('view-outbound-text');
  const routingText = document.getElementById('view-routing-text');
  const outboundCode = document.getElementById('view-outbound-code');
  const routingCode = document.getElementById('view-routing-code');

  outboundText.value = profile.outboundContent;
  routingText.value = profile.routingContent;

  if (outboundCode) outboundCode.innerHTML = highlightJson(profile.outboundContent);
  if (routingCode) routingCode.innerHTML = highlightJson(profile.routingContent);

  validateJsonInput('view-outbound-text', 'view-outbound-json-status', 'tab-outbound-dot');
  validateJsonInput('view-routing-text', 'view-routing-json-status', 'tab-routing-dot');

  switchViewTab('outbound');
  document.getElementById('view-modal').classList.remove('hidden');
}

function switchViewTab(tab) {
  state.currentViewTab = tab;
  const isOutbound = tab === 'outbound';

  const tabOutboundBtn = document.getElementById('tab-outbound-btn');
  const tabRoutingBtn = document.getElementById('tab-routing-btn');
  const paneOutbound = document.getElementById('pane-outbound');
  const paneRouting = document.getElementById('pane-routing');

  if (tabOutboundBtn) tabOutboundBtn.classList.toggle('active', isOutbound);
  if (tabRoutingBtn) tabRoutingBtn.classList.toggle('active', !isOutbound);

  if (paneOutbound) {
    if (isOutbound) paneOutbound.classList.remove('hidden');
    else paneOutbound.classList.add('hidden');
  }

  if (paneRouting) {
    if (!isOutbound) paneRouting.classList.remove('hidden');
    else paneRouting.classList.add('hidden');
  }

  // Ensure highlight layer scroll matches textarea when switching tab
  setTimeout(() => {
    const textId = isOutbound ? 'view-outbound-text' : 'view-routing-text';
    const codeId = isOutbound ? 'view-outbound-code' : 'view-routing-code';
    const text = document.getElementById(textId);
    const code = document.getElementById(codeId);
    if (text && code && code.parentElement) {
      code.parentElement.scrollTop = text.scrollTop;
      code.parentElement.scrollLeft = text.scrollLeft;
    }
  }, 10);
}

function openSettingsModal() {
  document.getElementById('setting-outbound-path').value = state.settings.outboundPath || '';
  document.getElementById('setting-routing-path').value = state.settings.routingPath || '';
  document.getElementById('setting-restart-cmd').value = state.settings.restartCommand || '';
  document.getElementById('setting-start-cmd').value = state.settings.startCommand || '';
  document.getElementById('setting-stop-cmd').value = state.settings.stopCommand || '';
  document.getElementById('setting-status-cmd').value = state.settings.statusCommand || '';
  document.getElementById('setting-panel-port').value = state.settings.port || 3000;
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

// Toast helper
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : '⚠️'}</span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// Helper: Escape HTML
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}
