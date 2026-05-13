/**
 * Local AI Admin Panel — Modern UI Controller
 * Compatible with glassmorphism design system
 */

// ===== UTILITIES =====
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Toast notifications
const toast = (message, type = 'info', timeout = 4000) => {
  const container = $('#toast-container');
  if (!container) return;
  
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${message}</span>`;
  
  container.appendChild(el);
  
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
};

// API helper with error handling
const api = async (url, options = {}) => {
  const isFormData = options.body instanceof FormData;
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { ...headers, ...(options.headers || {}) },
      ...options
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type');
    return contentType?.includes('application/json') ? await response.json() : { raw: await response.text() };
  } catch (error) {
    toast(error.message || 'Network error', 'error');
    throw error;
  }
};

// Formatting helpers
const fmtBytes = (n) => {
  if (!n || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let num = Number(n);
  while (num >= 1024 && i < units.length - 1) {
    num /= 1024;
    i++;
  }
  return `${num.toFixed(1)} ${units[i]}`;
};

const fmtDuration = (seconds) => {
  const s = Math.max(0, Number(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
};

// ===== NAVIGATION =====
const subtitles = {
  dashboard: 'Runtime state, services and stack controls',
  services: 'Manage Docker containers and compose stack',
  monitoring: 'Resource usage and performance metrics',
  tokens: 'API keys, limits and usage counters',
  users: 'Admin panel accounts management',
  models: 'Local GGUF models, downloads and uploads',
  llama: 'Prompt and llama.cpp runtime configuration',
  clients: 'OpenAI-compatible client helpers',
  logs: 'Container logs with filter and follow mode'
};

const setupNavigation = () => {
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      // Update active states
      $$('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      
      // Switch tabs
      const tab = item.dataset.tab;
      $$('.tab-content').forEach(t => t.classList.remove('active'));
      $(`#tab-${tab}`)?.classList.add('active');
      
      // Update header
      $('#page-title').textContent = item.textContent.trim();
      $('#page-subtitle').textContent = subtitles[tab] || '';
      
      // Close mobile sidebar
      if (window.innerWidth <= 1024) {
        $('#sidebar')?.classList.remove('open');
      }
      
      // Load content for active tab
      loadCurrentTab(tab);
    });
  });
};

const loadCurrentTab = async (tab) => {
  try {
    switch (tab) {
      case 'dashboard': await loadSystem(); break;
      case 'services': await loadServices(); break;
      case 'monitoring': await loadMonitoring(); break;
      case 'tokens': await loadTokens(); break;
      case 'users': await loadUsers(); break;
      case 'models': await loadModels(); break;
      case 'llama': await loadSettings(); break;
      case 'clients': await loadClients(); break;
      case 'logs': await loadLogs(); break;
    }
  } catch (error) {
    console.error(`Error loading ${tab}:`, error);
  }
};

// ===== SYSTEM & DASHBOARD =====
const loadSystem = async () => {
  try {
    const data = await api('/api/system');
    const host = data.host || {};
    const metrics = data.llama_metrics || {};
    
    // Update hero stats
    const heroStats = $('#tab-dashboard .hero-stats');
    if (heroStats) {
      heroStats.innerHTML = `
        <div class="hero-stat"><span class="label">backend:</span><span class="value">${data.stack?.backend || 'cpu'}</span></div>
        <div class="hero-stat"><span class="label">model:</span><span class="value">${data.stack?.model_id || 'not set'}</span></div>
        <div class="hero-stat"><span class="label">url:</span><span class="value">${data.stack?.public_base_url || window.location.origin}</span></div>
      `;
    }
    
    // Update metric cards
    const cards = {
      cpu: $('.card-value.cyan'),
      ram: $('.card-value.violet'),
      speed: $('.card-value.pink'),
      uptime: $('.card-value.emerald')
    };
    
    if (cards.cpu) cards.cpu.textContent = `${Math.round(host.cpu_percent || 0)}%`;
    if (cards.ram) cards.ram.textContent = fmtBytes(host.memory?.used);
    if (cards.speed) cards.speed.textContent = metrics.avg_prompt_tokens_per_second?.toFixed(1) || '0';
    if (cards.uptime) cards.uptime.textContent = fmtDuration(host.uptime_seconds);
    
    // Update containers table
    const tbody = $('#containers-table');
    if (tbody && data.containers?.length) {
      tbody.innerHTML = data.containers.map(c => {
        const running = c.status === 'running';
        const statusClass = running ? 'running' : 'stopped';
        return `
          <tr>
            <td><strong>${c.name}</strong><br><code>${(c.image || [])[0] || 'unknown'}</code></td>
            <td><span class="badge ${statusClass}">${c.health || c.status}</span></td>
            <td>${c.stats?.cpu_percent?.toFixed(1) || 0}%</td>
            <td>${fmtBytes(c.stats?.memory_usage)}</td>
            <td class="actions">
              ${running ? `<button class="btn btn-secondary btn-sm" onclick="containerAction('${c.name}', 'restart')">Restart</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="openLogs('${c.name}')">Logs</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (error) {
    console.error('Failed to load system:', error);
  }
};

const loadServices = async () => {
  const data = await api('/api/system');
  const tbody = $('#tab-services tbody');
  if (!tbody) return;
  
  tbody.innerHTML = (data.containers || []).map(c => {
    const running = c.status === 'running';
    return `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span class="badge ${running ? 'running' : 'stopped'}">${c.status}</span></td>
        <td><code>${(c.image || [])[0] || 'unknown'}</code></td>
        <td>-</td>
        <td class="actions">
          ${running 
            ? `<button class="btn btn-secondary btn-sm" onclick="containerAction('${c.name}', 'restart')">Restart</button>` 
            : `<button class="btn btn-success btn-sm" onclick="containerAction('${c.name}', 'start')">Start</button>`
          }
          <button class="btn btn-secondary btn-sm" onclick="openLogs('${c.name}')">Logs</button>
          ${running ? `<button class="btn btn-danger btn-sm" onclick="containerAction('${c.name}', 'stop')">Stop</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
};

const loadMonitoring = async () => {
  const data = await api('/api/system');
  const host = data.host || {};
  const metrics = data.llama_metrics || {};
  
  // Update metric cards
  const cards = $$('#tab-monitoring .card-value');
  if (cards[0]) cards[0].textContent = `${Math.round(host.cpu_percent || 0)}%`;
  if (cards[1]) cards[1].textContent = `${((host.memory?.used / host.memory?.total) * 100 || 0).toFixed(1)}%`;
  if (cards[2]) cards[2].textContent = `${((host.disk?.used / host.disk?.total) * 100 || 0).toFixed(1)}%`;
  
  // Update containers table
  const tbody = $('#tab-monitoring .table-wrapper table tbody');
  if (tbody) {
    tbody.innerHTML = (data.containers || []).filter(c => c.status === 'running').map(c => `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span class="badge running">running</span></td>
        <td>${c.stats?.cpu_percent?.toFixed(1) || 0}%</td>
        <td>${c.stats?.memory_limit ? ((c.stats.memory_usage / c.stats.memory_limit) * 100).toFixed(1) + '%' : '-'}</td>
        <td>${fmtBytes(c.stats?.memory_usage)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty-state">No running containers</td></tr>';
  }
  
  // Update llama metrics
  const llamaTable = $('#tab-monitoring .table-wrapper:last-of-type tbody');
  if (llamaTable) {
    llamaTable.innerHTML = `
      <tr><td><strong>Last Prompt Tokens</strong></td><td>${metrics.last_task_tokens || '-'}</td></tr>
      <tr><td><strong>Prompt Speed</strong></td><td>${metrics.avg_prompt_tokens_per_second?.toFixed(1) || '-'} tok/s</td></tr>
      <tr><td><strong>Eval Speed</strong></td><td>${metrics.avg_eval_tokens_per_second?.toFixed(1) || '-'} tok/s</td></tr>
      <tr><td><strong>Estimated Prompt Time</strong></td><td>${metrics.estimated_seconds_for_last_prompt?.toFixed(2) || '-'} sec</td></tr>
    `;
  }
};

// ===== TOKENS =====
const loadTokens = async () => {
  try {
    const data = await api('/api/tokens');
    const tbody = $('#tokens-table');
    if (!tbody) return;
    
    if (!data.tokens?.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No tokens yet. Create one above.</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.tokens.map(t => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td><code>${t.key.slice(0, 16)}...</code></td>
        <td>${t.used_tokens?.toLocaleString() || 0}</td>
        <td>${t.unlimited ? '∞' : t.limit_tokens?.toLocaleString() || '-'}</td>
        <td>${t.unlimited ? '∞' : (t.remaining_tokens ?? '∞')?.toLocaleString()}</td>
        <td><span class="badge ${t.enabled ? 'running' : 'disabled'}">${t.enabled ? 'enabled' : 'disabled'}</span></td>
        <td class="actions">
          <button class="btn btn-secondary btn-sm" onclick="toggleToken('${t.key}', ${!t.enabled})">${t.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-secondary btn-sm" onclick="resetToken('${t.key}')">Reset</button>
          <button class="btn btn-danger btn-sm" onclick="deleteToken('${t.key}')">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Failed to load tokens:', error);
  }
};

const createToken = async (e) => {
  e?.preventDefault();
  try {
    const name = $('#tok-name')?.value || 'token';
    const unlimited = $('#tok-unlimited')?.checked;
    const limit = unlimited ? null : Number($('#tok-limit')?.value);
    
    await api('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, unlimited, limit_tokens: limit })
    });
    
    $('#tok-name').value = '';
    $('#tok-limit').value = '';
    toast('Token created successfully', 'success');
    await loadTokens();
  } catch (error) {
    console.error('Failed to create token:', error);
  }
};

const toggleToken = async (key, enabled) => {
  try {
    await api(`/api/tokens/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
    toast(`Token ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
    await loadTokens();
  } catch (error) {
    console.error('Failed to toggle token:', error);
  }
};

const resetToken = async (key) => {
  try {
    await api(`/api/tokens/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reset_usage: true })
    });
    toast('Token usage reset', 'success');
    await loadTokens();
  } catch (error) {
    console.error('Failed to reset token:', error);
  }
};

const deleteToken = async (key) => {
  if (!confirm('Delete this token?')) return;
  try {
    await api(`/api/tokens/${encodeURIComponent(key)}`, { method: 'DELETE' });
    toast('Token deleted', 'error');
    await loadTokens();
  } catch (error) {
    console.error('Failed to delete token:', error);
  }
};

// ===== USERS =====
const loadUsers = async () => {
  try {
    const data = await api('/api/users');
    const tbody = $('#users-table');
    if (!tbody) return;
    
    if (!data.users?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No users found</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.users.map(u => `
      <tr>
        <td><strong>${u.id}</strong></td>
        <td><strong>${u.username}</strong></td>
        <td><code>${u.is_admin ? 'admin' : 'user'}</code></td>
        <td><span class="badge ${u.enabled ? 'running' : 'disabled'}">${u.enabled ? 'enabled' : 'disabled'}</span></td>
        <td class="actions">
          <button class="btn btn-secondary btn-sm" onclick="toggleUser(${u.id}, ${!u.enabled})">${u.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-secondary btn-sm" onclick="changePassword(${u.id})">Password</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Failed to load users:', error);
  }
};

const createUser = async (e) => {
  e?.preventDefault();
  try {
    const username = $('#new-user')?.value?.trim();
    const password = $('#new-pass')?.value;
    
    if (!username || !password) {
      toast('Username and password are required', 'warning');
      return;
    }
    
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, is_admin: true })
    });
    
    $('#new-user').value = '';
    $('#new-pass').value = '';
    toast('User created', 'success');
    await loadUsers();
  } catch (error) {
    console.error('Failed to create user:', error);
  }
};

const toggleUser = async (id, enabled) => {
  try {
    await api(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
    toast(`User ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
    await loadUsers();
  } catch (error) {
    console.error('Failed to toggle user:', error);
  }
};

const changePassword = async (id) => {
  const password = prompt('New password:');
  if (!password) return;
  try {
    await api(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ password })
    });
    toast('Password updated', 'success');
  } catch (error) {
    console.error('Failed to change password:', error);
  }
};

const deleteUser = async (id) => {
  if (!confirm('Delete this user?')) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    toast('User deleted', 'error');
    await loadUsers();
  } catch (error) {
    console.error('Failed to delete user:', error);
  }
};

// ===== MODELS =====
const loadModels = async () => {
  try {
    const data = await api('/api/models');
    
    // Update active model display
    const activeModel = $('#tab-models .form-card:first-child');
    if (activeModel && data.current) {
      activeModel.querySelector('div[style*="display:flex"] strong')?.textContent = 
        data.current.split('/').pop() || 'not set';
      activeModel.querySelector('code')?.textContent = data.current;
    }
    
    // Update local models table
    const tbody = $('#models-local');
    if (tbody) {
      if (!data.local?.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No .gguf files found in ./models</td></tr>';
      } else {
        tbody.innerHTML = data.local.map(m => `
          <tr>
            <td><strong>${m.name}</strong></td>
            <td><code>${m.path}</code></td>
            <td>${(m.size / 1024 / 1024 / 1024).toFixed(2)} GB</td>
            <td><span class="badge ${m.path === data.current ? 'running' : 'disabled'}">${m.path === data.current ? 'current' : 'available'}</span></td>
            <td>
              ${m.path === data.current 
                ? '<button class="btn btn-secondary btn-sm" disabled>Active</button>' 
                : `<button class="btn btn-primary btn-sm" onclick="switchModel('${m.path}')">Switch</button>`
              }
            </td>
          </tr>
        `).join('');
      }
    }
  } catch (error) {
    console.error('Failed to load models:', error);
  }
};

const switchModel = async (path) => {
  if (!confirm(`Switch to ${path} and restart llama-server?`)) return;
  try {
    toast('Switching model...', 'info');
    await api('/api/models/switch', {
      method: 'POST',
      body: JSON.stringify({ path, restart: true })
    });
    toast('Model switched successfully', 'success');
    await loadModels();
  } catch (error) {
    console.error('Failed to switch model:', error);
  }
};

const downloadModel = async (e) => {
  e?.preventDefault();
  try {
    const repo = $('#hf-repo')?.value?.trim();
    const include = $('#hf-include')?.value?.trim() || '*.gguf';
    const localDir = $('#hf-dir')?.value?.trim();
    
    if (!repo) {
      toast('Repository is required', 'warning');
      return;
    }
    
    const result = await api('/api/models/download', {
      method: 'POST',
      body: JSON.stringify({ repo, include, local_dir: localDir })
    });
    
    toast(`Download queued: ${result.job_id}`, 'success');
    $('#hf-repo').value = '';
    $('#hf-dir').value = '';
    await loadModels();
  } catch (error) {
    console.error('Failed to download model:', error);
  }
};

const uploadModel = async (e) => {
  const file = e?.target?.files?.[0];
  if (!file) return;
  
  if (!file.name.endsWith('.gguf')) {
    toast('Please select a .gguf file', 'error');
    return;
  }
  
  try {
    toast(`Uploading ${file.name}...`, 'info');
    const formData = new FormData();
    formData.append('file', file);
    
    await api('/api/models/upload', {
      method: 'POST',
      body: formData
    });
    
    toast('Model uploaded successfully', 'success');
    e.target.value = '';
    await loadModels();
  } catch (error) {
    console.error('Failed to upload model:', error);
  }
};

// ===== SETTINGS (LLAMA) =====
const loadSettings = async () => {
  try {
    const data = await api('/api/settings');
    
    // Fill form fields
    const fields = ['CTX_SIZE', 'THREADS', 'PARALLEL_SLOTS', 'N_GPU_LAYERS', 'LLAMA_TIMEOUT'];
    fields.forEach(key => {
      const el = $(`#${key}`);
      if (el && data.llama?.[key]) el.value = data.llama[key];
    });
    
    // System prompt
    const promptEl = $('#system-prompt');
    if (promptEl && data.prompt) promptEl.value = data.prompt;
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
};

const saveSettings = async (e, restart = false) => {
  e?.preventDefault();
  try {
    const keys = ['CTX_SIZE', 'THREADS', 'PARALLEL_SLOTS', 'N_GPU_LAYERS', 'LLAMA_TIMEOUT', 'ANTI_CONFIRM_SYSTEM_PROMPT'];
    const body = { restart };
    
    keys.forEach(key => {
      const el = $(`#${key}`) || $('#system-prompt');
      if (el?.value !== undefined) body[key] = el.value;
    });
    
    const result = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    
    toast(`Settings saved${restart ? ' and restarting...' : ''}`, 'success');
    
    if (result.gateway_error) {
      toast(`Warning: ${result.gateway_error}`, 'warning');
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
};

// ===== CLIENTS =====
const loadClients = async () => {
  try {
    const data = await api('/api/clients');
    const grid = $('#tab-clients .client-grid');
    if (!grid) return;
    
    const clients = {
      opencode: {
        title: 'OpenCode Desktop',
        status: data.opencode?.enabled ? 'running' : 'stopped',
        hint: data.opencode?.hint || 'Best client for this stack',
        settings: [
          ['Provider', 'OpenAI Compatible'],
          ['Base URL', `${window.location.origin}/v1`],
          ['API Key', 'Token from Tokens tab'],
          ['Model', 'Active GGUF']
        ]
      },
      codex: {
        title: 'Codex Runner',
        status: data.codex?.enabled ? 'running' : 'stopped',
        hint: data.codex?.hint || 'Uses @openai/codex',
        settings: [
          ['OPENAI_BASE_URL', `${window.location.origin}/v1`],
          ['OPENAI_API_KEY', 'Token from Tokens tab'],
          ['Model', 'Active GGUF']
        ]
      },
      claude: {
        title: 'Claude Code Proxy',
        status: data.claude?.enabled ? 'running' : 'stopped',
        hint: data.claude?.hint || 'Experimental local proxy',
        settings: [
          ['Status', 'Experimental'],
          ['Base URL', `${window.location.origin}/v1`],
          ['API Key', 'Token from Tokens tab']
        ]
      },
      openrouter: {
        title: 'OpenRouter',
        status: 'external',
        hint: 'External OpenAI-compatible API',
        settings: [
          ['Base URL', 'https://openrouter.ai/api/v1'],
          ['API Key', 'OpenRouter key'],
          ['Use Case', 'External fallback']
        ],
        external: true
      }
    };
    
    grid.innerHTML = Object.entries(clients).map(([key, c]) => `
      <div class="client-card ${c.status}">
        <h5><span class="status-indicator"></span>${c.title}</h5>
        <p>${c.hint}</p>
        <div class="client-settings-list">
          ${c.settings.map(([label, value]) => `
            <div class="client-setting">
              <span class="label">${label}</span>
              <span class="value">${value}</span>
            </div>
          `).join('')}
        </div>
        <div class="actions">
          ${c.external 
            ? `<span style="font-size:12px;color:var(--accent-blue)">External service</span>`
            : c.status === 'running'
              ? `<button class="btn btn-danger btn-sm" onclick="toggleClient('${key}', false)">Disable</button>
                 <button class="btn btn-secondary btn-sm" onclick="openLogs('${key}-server')">Logs</button>`
              : `<button class="btn btn-success btn-sm" onclick="toggleClient('${key}', true)">Enable</button>`
          }
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load clients:', error);
  }
};

const toggleClient = async (name, enable) => {
  try {
    toast(`${enable ? 'Enabling' : 'Disabling'} ${name}...`, 'info');
    await api(`/api/clients/${name}/${enable ? 'enable' : 'disable'}`, { method: 'POST' });
    toast(`${name} ${enable ? 'enabled' : 'disabled'}`, enable ? 'success' : 'info');
    await loadClients();
  } catch (error) {
    console.error(`Failed to ${enable ? 'enable' : 'disable'} client:`, error);
  }
};

// ===== LOGS =====
let logsFollowInterval = null;

const loadLogs = async () => {
  try {
    const service = $('#log-service')?.value || 'llama-server-coder';
    const tail = $('#log-tail')?.value || 300;
    
    const data = await api(`/api/logs/${service}?tail=${tail}`);
    const output = $('#logs-output');
    if (output) {
      output.textContent = (data.stdout || '') + (data.stderr || '') || 'No logs available.';
      // Auto-scroll to bottom
      output.scrollTop = output.scrollHeight;
    }
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
};

const openLogs = (service) => {
  // Switch to logs tab
  $$('.nav-item').forEach(i => i.classList.remove('active'));
  $$('[data-tab="logs"]').forEach(i => i.classList.add('active'));
  $$('.tab-content').forEach(t => t.classList.remove('active'));
  $('#tab-logs')?.classList.add('active');
  
  // Update header
  $('#page-title').textContent = 'Logs';
  $('#page-subtitle').textContent = 'Container logs';
  
  // Set service and load
  if ($('#log-service')) $('#log-service').value = service;
  loadLogs();
};

const setupLogsFollow = () => {
  const checkbox = $('#logs-follow');
  if (!checkbox) return;
  
  checkbox.addEventListener('change', () => {
    if (logsFollowInterval) {
      clearInterval(logsFollowInterval);
      logsFollowInterval = null;
    }
    
    if (checkbox.checked) {
      logsFollowInterval = setInterval(loadLogs, 5000);
    }
  });
};

// ===== CONTAINER ACTIONS =====
const containerAction = async (name, action) => {
  try {
    toast(`${action}ing ${name}...`, 'info');
    await api(`/api/containers/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    toast(`Container ${action}ed`, 'success');
    
    // Refresh relevant tabs
    if (['dashboard', 'services', 'monitoring'].includes($('.nav-item.active')?.dataset.tab)) {
      loadSystem();
    }
  } catch (error) {
    console.error(`Failed to ${action} container:`, error);
  }
};

// ===== STACK ACTIONS =====
const stackAction = async (action) => {
  try {
    toast(`${action}ing stack...`, 'info');
    await api(`/api/stack/${action}`, { method: 'POST' });
    toast(`Stack ${action}ed`, 'success');
    await loadSystem();
  } catch (error) {
    console.error(`Failed to ${action} stack:`, error);
  }
};

// ===== INITIALIZATION =====
const init = () => {
  // Setup navigation
  setupNavigation();
  
  // Setup form handlers
  $('#token-form')?.addEventListener('submit', createToken);
  $('#user-form')?.addEventListener('submit', createUser);
  $('#hf-form')?.addEventListener('submit', downloadModel);
  $('#settings-form')?.addEventListener('submit', (e) => saveSettings(e, false));
  
  // Setup logs follow
  setupLogsFollow();
  
  // Setup file upload handler
  $('#gguf-file')?.addEventListener('change', uploadModel);
  
  // Load initial content
  const activeTab = $('.nav-item.active')?.dataset.tab || 'dashboard';
  loadCurrentTab(activeTab);
  
  // Auto-refresh dashboard
  setInterval(() => {
    if ($('.nav-item.active')?.dataset.tab === 'dashboard') {
      loadSystem();
    }
  }, 10000);
  
  // Global event delegation for dynamic buttons
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    
    const action = btn.dataset.action;
    const target = btn.dataset.target;
    
    switch (action) {
      case 'stack-start': stackAction('start'); break;
      case 'stack-stop': stackAction('stop'); break;
      case 'stack-restart': stackAction('restart'); break;
      case 'refresh': loadCurrentTab($('.nav-item.active')?.dataset.tab); break;
    }
  });
  
  toast('Admin panel ready', 'success');
};

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { api, toast, loadSystem, loadTokens, loadUsers, loadModels, loadSettings, loadClients, loadLogs };
}