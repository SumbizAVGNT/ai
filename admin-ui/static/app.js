/**
 * Local AI Admin Panel frontend controller.
 *
 * This file intentionally adapts to the existing static HTML/CSS contracts.
 * It does not change layout or styling; it only wires data and actions.
 */

const APP_BASE = window.location.pathname.startsWith('/ui') ? '/ui' : '';
const API = (path) => `${APP_BASE}/api${path}`;

const state = {
  tab: 'overview',
  user: null,
  updateJobId: localStorage.getItem('localAiUpdateJobId') || null,
  updateTimer: null,
  logsTimer: null,
  lastLogsText: '',
  clientsBaseUrl: '',
  chat: {
    conversations: [],
    activeId: null,
    attachments: [],
    status: null,
    busy: false,
  },
};

const TAB_TITLES = {
  overview: 'Dashboard',
  services: 'Service Management',
  monitoring: 'Resource Monitoring',
  tokens: 'Token Management',
  users: 'User Accounts',
  models: 'Model Library',
  chat: 'AI Chat',
  settings: 'Llama / Prompt',
  clients: 'Client Integrations',
  logs: 'Container Logs',
};

const TAB_SUBTITLES = {
  overview: 'Runtime state, services and stack controls',
  services: 'Manage Docker containers and compose stack',
  monitoring: 'Resource usage and performance metrics',
  tokens: 'API keys, limits and usage counters',
  users: 'Admin panel accounts management',
  models: 'Local GGUF models, downloads and uploads',
  chat: 'Direct AI console with files, history and model controls',
  settings: 'Prompt and llama.cpp runtime configuration',
  clients: 'OpenAI-compatible client helpers',
  logs: 'Container logs with filter and follow mode',
};

const CHAT_STORAGE_KEY = 'localAiChatConversations';
const CHAT_ACTIVE_KEY = 'localAiChatActiveId';
const CHAT_SETTINGS_KEY = 'localAiChatSettings';
const CHAT_MAX_FILE_CHARS = 60000;
const CHAT_MAX_TOTAL_FILE_CHARS = 140000;
const CHAT_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env',
  'py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'sql', 'sh', 'bash',
  'ps1', 'bat', 'cmd', 'dockerfile', 'log', 'csv', 'xml', 'rs', 'go', 'java',
  'kt', 'cs', 'cpp', 'c', 'h', 'hpp', 'php', 'rb', 'swift',
]);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

const formatBytes = (value) => {
  let num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (num >= 1024 && index < units.length - 1) {
    num /= 1024;
    index += 1;
  }
  return `${num.toFixed(1)} ${units[index]}`;
};

const formatNumber = (value) => {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString() : '-';
};

const formatDuration = (seconds) => {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatTime = (value) => {
  const date = new Date(value || Date.now());
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const formatSpeed = (value) => {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? `${num.toFixed(1)} tok/s` : '-';
};

const makeId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const normalizeTab = (tab) => {
  if (tab === 'dashboard') return 'overview';
  if (tab === 'llama') return 'settings';
  return tab || 'overview';
};

const setText = (sel, value) => {
  const el = $(sel);
  if (el) el.textContent = value;
  return el;
};

const setHtml = (sel, value) => {
  const el = $(sel);
  if (el) el.innerHTML = value;
  return el;
};

const renderEmpty = (sel, message) => setHtml(
  sel,
  `<div class="empty-state"><h4>${escapeHtml(message)}</h4></div>`,
);

const statusTone = (value) => {
  const status = String(value || '').toLowerCase();
  if (status.includes('unhealthy') || status.includes('error') || status.includes('failed') || status.includes('disabled') || status.includes('exited') || status.includes('dead')) return 'bad';
  if (status.includes('running') || status.includes('healthy') || status.includes('enabled') || status.includes('current') || status.includes('done')) return 'good';
  if (status.includes('starting') || status.includes('queued') || status.includes('updating') || status.includes('restarting')) return 'warn';
  return 'neutral';
};

const statusPill = (label, tone = statusTone(label)) => (
  `<span class="status ${tone}">${escapeHtml(label || '-')}</span>`
);

const toast = (message, type = 'info', timeout = 4500) => {
  const container = $('#toast-container');
  if (!container) return;
  const labels = { success: 'OK', error: 'ERR', warning: 'WARN', info: 'INFO' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${labels[type] || 'INFO'}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-hiding');
    setTimeout(() => el.remove(), 300);
  }, timeout);
};

const openModal = (title, body, footer = '') => {
  setText('#modal-title', title);
  setHtml('#modal-body', body);
  setHtml('#modal-footer', footer || '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
  $('#modal-backdrop')?.classList.add('show');
};

const closeModal = () => $('#modal-backdrop')?.classList.remove('show');
window.closeModal = closeModal;

window.toggleUserInfo = (button) => {
  const box = button?.closest('.user-info-sidebar') || $('#sidebar-user-info');
  box?.classList.toggle('is-collapsed');
};

const parseResponseBody = async (response) => {
  const text = await response.text();
  if (!text) return {};
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
  return { raw: text };
};

const api = async (path, options = {}) => {
  const isForm = options.body instanceof FormData;
  const headers = isForm ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch(API(path), {
    credentials: 'same-origin',
    headers: { ...headers, ...(options.headers || {}) },
    ...options,
  });
  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(data.detail || data.error || data.raw || `HTTP ${response.status}`);
  }
  return data;
};

const commandOutput = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  const direct = [payload.stderr, payload.stdout, payload.error, payload.raw]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (direct) return direct;
  for (const key of ['result', 'restart', 'enable', 'image']) {
    const nested = commandOutput(payload[key]);
    if (nested) return nested;
  }
  return '';
};

const assertCommandOk = (payload, fallback = 'Command failed') => {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.ok === false) throw new Error(commandOutput(payload) || fallback);
  if (typeof payload.returncode === 'number' && payload.returncode !== 0) {
    throw new Error(commandOutput(payload) || fallback);
  }
  for (const key of ['result', 'restart', 'enable', 'image']) {
    const nested = payload[key];
    if (nested && typeof nested === 'object') assertCommandOk(nested, fallback);
  }
  return payload;
};

const showLoginError = (message) => {
  const el = $('#login-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  el.style.display = 'flex';
};

const hideLoginError = () => {
  const el = $('#login-error');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
  el.style.display = 'none';
};

const runAction = async (btn, task, successMessage) => {
  const original = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.dataset.busy = '1';
    if ('innerHTML' in btn) btn.innerHTML = '<span class="spinner spinner-inline"></span> Working...';
  }
  try {
    const result = await task();
    if (successMessage) toast(successMessage, 'success');
    return result;
  } catch (error) {
    toast(error.message || 'Action failed', 'error');
    throw error;
  } finally {
    if (btn) {
      btn.disabled = false;
      delete btn.dataset.busy;
      if (original !== undefined && 'innerHTML' in btn) btn.innerHTML = original;
    }
  }
};

const stopLogsFollow = () => {
  if (state.logsTimer) clearInterval(state.logsTimer);
  state.logsTimer = null;
};

const syncLogsFollow = () => {
  stopLogsFollow();
  if ($('#logs-follow')?.checked && state.tab === 'logs') {
    state.logsTimer = setInterval(() => loadLogs({ silent: true }).catch(() => {}), 4000);
  }
};

const setActiveTab = (tab) => {
  const nextTab = normalizeTab(tab);
  state.tab = nextTab;

  $$('.nav-item').forEach((el) => {
    el.classList.toggle('active', normalizeTab(el.dataset.tab) === nextTab);
  });

  $$('.tab-panel, .tab-content').forEach((el) => {
    const active = el.id === `tab-${nextTab}`;
    el.classList.toggle('hidden', !active);
    el.classList.toggle('active', active);
  });

  setText('#page-title', TAB_TITLES[nextTab] || nextTab);
  setText('#page-subtitle', TAB_SUBTITLES[nextTab] || '');
  $('#page-alert')?.classList.add('hidden');
  if (window.innerWidth <= 1024) $('.sidebar')?.classList.remove('open');

  stopLogsFollow();
  loadCurrentTab(nextTab).catch((error) => toast(error.message, 'error'));
};

const syncGlobalSearch = () => {
  const q = ($('#global-search')?.value || '').trim().toLowerCase();
  const activePanel = $(`#tab-${state.tab}`);
  if (!activePanel) return;
  activePanel.querySelectorAll('.list-row, .client-card, .catalog-card, .chat-history-item, .chat-message').forEach((el) => {
    const hidden = Boolean(q) && !el.textContent.toLowerCase().includes(q);
    el.classList.toggle('is-search-hidden', hidden);
    el.style.display = hidden ? 'none' : '';
  });
};

const loadCurrentTab = async (tab = state.tab) => {
  const active = normalizeTab(tab);
  switch (active) {
    case 'overview':
      await loadSystem();
      break;
    case 'services':
      await loadServices();
      break;
    case 'monitoring':
      await loadMonitoring();
      break;
    case 'tokens':
      await loadTokens();
      break;
    case 'users':
      await loadUsers();
      break;
    case 'models':
      await loadModels();
      break;
    case 'chat':
      await loadChat();
      break;
    case 'settings':
      await loadSettings();
      break;
    case 'clients':
      await loadClients();
      break;
    case 'logs':
      await loadLogs();
      break;
  }
  syncGlobalSearch();
};

const preferredContainerOrder = [
  'llama-server-coder',
  'token-gateway',
  'admin-ui',
  'local-ai-nginx',
  'nginx',
  'postgres',
  'local-ai-postgres',
  'opencode-server',
  'codex-runner',
  'claude-code-proxy',
  'local-ai-certbot',
  'certbot',
];

const sortContainers = (containers) => [...containers].sort((a, b) => {
  const ai = preferredContainerOrder.indexOf(a.name);
  const bi = preferredContainerOrder.indexOf(b.name);
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || String(a.name).localeCompare(String(b.name));
});

const containerActions = (container) => {
  const name = escapeHtml(container.name);
  const running = container.status === 'running';
  const canSelfManage = container.name !== 'admin-ui';
  const actions = [`<button class="btn btn-secondary btn-small" data-action="container-logs" data-service="${name}">Logs</button>`];

  if (running && canSelfManage) {
    actions.unshift(`<button class="btn btn-secondary btn-small" data-action="container-restart" data-container="${name}">Restart</button>`);
    actions.push(`<button class="btn btn-danger btn-small" data-action="container-stop" data-container="${name}">Stop</button>`);
  } else if (!running) {
    actions.unshift(`<button class="btn btn-success btn-small" data-action="container-start" data-container="${name}">Start</button>`);
  }

  return actions.join('');
};

const renderContainerRows = (containers) => sortContainers(containers).map((container) => {
  const image = Array.isArray(container.image) ? container.image.join(', ') : String(container.image || 'unknown');
  const status = container.health || container.status || 'unknown';
  const stats = container.stats || {};
  return `<div class="list-row container-row">
    <div>
      <strong>${escapeHtml(container.name)}</strong>
      <small>${escapeHtml(image || 'unknown')}</small>
    </div>
    <div>${statusPill(status)}</div>
    <div>
      <small>CPU</small>
      <strong>${Number(stats.cpu_percent || 0).toFixed(1)}%</strong>
    </div>
    <div>
      <small>RAM</small>
      <strong>${formatBytes(stats.memory_usage)}</strong>
    </div>
    <div class="container-actions">${containerActions(container)}</div>
  </div>`;
}).join('');

const loadSystem = async () => {
  const data = await api('/system');
  const host = data.host || {};
  const metrics = data.llama_metrics || {};
  const stack = data.stack || {};

  setText('#metric-cpu', `${Math.round(host.cpu_percent || 0)}%`);
  setText('#metric-ram', `${formatBytes(host.memory?.used)} / ${formatBytes(host.memory?.total)}`);
  setText('#metric-speed', metrics.avg_prompt_tokens_per_second ? `${metrics.avg_prompt_tokens_per_second.toFixed(1)} tok/s` : '-');
  setText('#metric-eval-speed', metrics.avg_eval_tokens_per_second ? `${metrics.avg_eval_tokens_per_second.toFixed(1)} tok/s` : '-');
  setText('#metric-uptime', formatDuration(host.uptime_seconds));
  setText('#hero-backend', `backend: ${stack.backend || 'cpu'}`);
  setText('#hero-model', `model: ${stack.model_id || stack.model_path || 'not selected'}`);
  setText('#hero-url', `url: ${stack.public_base_url || window.location.origin}`);

  const containers = data.containers || [];
  if (!containers.length) {
    renderEmpty('#containers-list', data.docker_error || 'No containers found');
    return;
  }
  setHtml('#containers-list', renderContainerRows(containers));
};

const loadServices = async () => {
  const data = await api('/system');
  const containers = data.containers || [];
  if (!containers.length) {
    renderEmpty('#services-list', data.docker_error || 'No services detected');
    return;
  }
  setHtml('#services-list', renderContainerRows(containers));
};

const metricRow = (label, value, detail = '', tone = 'neutral') => `<div class="list-row user-row">
  <div>
    <strong>${escapeHtml(label)}</strong>
    ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
  </div>
  <div>${statusPill(value, tone)}</div>
  <div></div>
  <div></div>
</div>`;

const loadMonitoring = async () => {
  const data = await api('/system');
  const host = data.host || {};
  const metrics = data.llama_metrics || {};
  const memoryTotal = Number(host.memory?.total || 0);
  const memoryUsed = Number(host.memory?.used || 0);
  const diskTotal = Number(host.disk?.total || 0);
  const diskUsed = Number(host.disk?.used || 0);
  const memoryPct = memoryTotal > 0 ? `${((memoryUsed / memoryTotal) * 100).toFixed(1)}%` : '-';
  const diskPct = diskTotal > 0 ? `${((diskUsed / diskTotal) * 100).toFixed(1)}%` : '-';

  const running = (data.containers || []).filter((container) => container.status === 'running');
  const containerRows = running.length
    ? renderContainerRows(running)
    : '<div class="empty-state"><h4>No running containers</h4></div>';

  setHtml('#monitoring-list', `
    <div class="list-view">
      ${metricRow('CPU Usage', `${Math.round(host.cpu_percent || 0)}%`, 'Host load', 'neutral')}
      ${metricRow('RAM Usage', memoryPct, `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`, 'neutral')}
      ${metricRow('Disk Usage', diskPct, `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`, 'neutral')}
      ${metricRow('Last Prompt Tokens', metrics.last_task_tokens ?? '-', 'llama.cpp request telemetry', 'neutral')}
      ${metricRow('Prompt Speed', metrics.avg_prompt_tokens_per_second ? `${metrics.avg_prompt_tokens_per_second.toFixed(1)} tok/s` : '-', 'Recent average', 'neutral')}
      ${metricRow('Eval Speed', metrics.avg_eval_tokens_per_second ? `${metrics.avg_eval_tokens_per_second.toFixed(1)} tok/s` : '-', 'Recent average', 'neutral')}
    </div>
    <div style="height:16px"></div>
    <div class="list-view">${containerRows}</div>
  `);
};

const loadTokens = async () => {
  const { tokens = [] } = await api('/tokens');
  if (!tokens.length) {
    renderEmpty('#tokens-list', 'No tokens yet. Create one above.');
    return;
  }

  setHtml('#tokens-list', tokens.map((token) => {
    const key = escapeHtml(token.key);
    const limit = token.unlimited ? 'unlimited' : formatNumber(token.limit_tokens || 0);
    const remaining = token.unlimited ? 'unlimited' : formatNumber(token.remaining_tokens ?? 0);
    return `<div class="list-row token-row">
      <div>
        <strong>${escapeHtml(token.name || 'token')}</strong>
        <code>${key}</code>
      </div>
      <div>
        <small>Used</small>
        <strong>${formatNumber(token.used_tokens || 0)}</strong>
      </div>
      <div>
        <small>Limit</small>
        <strong>${escapeHtml(limit)} / ${escapeHtml(remaining)}</strong>
      </div>
      <div class="row-actions">
        ${token.enabled ? statusPill('enabled', 'good') : statusPill('disabled', 'bad')}
        <button class="btn btn-secondary btn-small" data-action="token-copy" data-key="${key}">Copy</button>
        <button class="btn btn-secondary btn-small" data-action="token-toggle" data-key="${key}" data-enabled="${token.enabled}">${token.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-secondary btn-small" data-action="token-reset" data-key="${key}">Reset</button>
        <button class="btn btn-danger btn-small" data-action="token-delete" data-key="${key}">Delete</button>
      </div>
    </div>`;
  }).join(''));
};

const loadUsers = async () => {
  const { users = [] } = await api('/users');
  if (!users.length) {
    renderEmpty('#users-list', 'No users found.');
    return;
  }

  setHtml('#users-list', users.map((user) => {
    const isMe = state.user && Number(state.user.id) === Number(user.id);
    return `<div class="list-row user-row">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <small>ID ${escapeHtml(user.id)}</small>
      </div>
      <div>${statusPill(user.is_admin ? 'admin' : 'user', user.is_admin ? 'good' : 'neutral')}</div>
      <div>${statusPill(user.enabled ? 'enabled' : 'disabled', user.enabled ? 'good' : 'bad')}</div>
      <div class="row-actions">
        <button class="btn btn-secondary btn-small" data-action="user-toggle" data-id="${escapeHtml(user.id)}" data-enabled="${user.enabled}" ${isMe ? 'disabled' : ''}>${user.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-secondary btn-small" data-action="user-password" data-id="${escapeHtml(user.id)}">Password</button>
        <button class="btn btn-danger btn-small" data-action="user-delete" data-id="${escapeHtml(user.id)}" ${isMe ? 'disabled' : ''}>Delete</button>
      </div>
    </div>`;
  }).join(''));
};

const loadSettings = async () => {
  const data = await api('/settings');
  const prompt = $('#prompt');
  if (prompt) prompt.value = data.prompt || '';
  for (const key of ['CTX_SIZE', 'THREADS', 'PARALLEL_SLOTS', 'N_GPU_LAYERS', 'LLAMA_TIMEOUT']) {
    const el = $(`#${key}`);
    if (el) el.value = data.llama?.[key] || '';
  }
};

const loadModels = async () => {
  const data = await api('/models');
  const local = data.local || [];
  const catalog = data.catalog || [];
  const currentName = data.current ? data.current.split('/').pop() : 'not set';

  setText('#model-active-name', currentName || 'not set');
  setText('#model-active-path', data.current || '-');

  if (!local.length) {
    renderEmpty('#models-local', 'No .gguf files in ./models');
  } else {
    setHtml('#models-local', local.map((model) => {
      const isCurrent = model.path === data.current;
      return `<div class="list-row model-row">
        <div>
          <strong>${escapeHtml(model.name)}</strong>
          <code>${escapeHtml(model.path)}</code>
        </div>
        <div>
          <small>Size</small>
          <strong>${formatBytes(model.size)}</strong>
        </div>
        <div>${statusPill(isCurrent ? 'current' : 'available', isCurrent ? 'good' : 'neutral')}</div>
        <div class="row-actions">
          ${isCurrent
            ? '<button class="btn btn-secondary btn-small" disabled>Active</button>'
            : `<button class="btn btn-primary btn-small" data-action="model-switch" data-path="${escapeHtml(model.path)}">Switch</button>`}
        </div>
      </div>`;
    }).join(''));
  }

  if (!catalog.length) {
    setHtml('#models-catalog', '');
  } else {
    setHtml('#models-catalog', catalog.map((item) => `<div class="catalog-card">
      <strong>${escapeHtml(item.title || item.repo)}</strong>
      <p>${escapeHtml(item.description || item.recommended || '')}</p>
      <code>${escapeHtml(item.repo)} / ${escapeHtml(item.include || '*.gguf')}</code>
      <div class="row-actions">
        <button class="btn btn-secondary btn-small" data-action="catalog-download" data-repo="${escapeHtml(item.repo)}" data-include="${escapeHtml(item.include || '*.gguf')}" data-dir="${escapeHtml(item.local_dir || '')}">Download</button>
      </div>
    </div>`).join(''));
  }
};

const renderClientSettings = (settings) => `<dl class="client-settings">
  ${settings.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
</dl>`;

const loadClients = async () => {
  const [data, settings] = await Promise.all([
    api('/clients'),
    api('/settings').catch(() => ({})),
  ]);
  const baseUrl = String(settings.public_base_url || window.location.origin).replace(/\/$/, '');
  state.clientsBaseUrl = `${baseUrl}/v1`;
  const model = settings.model_path ? settings.model_path.split('/').pop() : 'active GGUF';

  const meta = {
    opencode: {
      title: 'OpenCode Desktop',
      tone: 'client-recommended',
      settings: [['Provider', 'OpenAI Compatible'], ['Base URL', state.clientsBaseUrl], ['API Key', 'Token from Tokens tab'], ['Model', model]],
    },
    codex: {
      title: 'Codex Runner',
      tone: '',
      settings: [['OPENAI_BASE_URL', state.clientsBaseUrl], ['OPENAI_API_KEY', 'Token from Tokens tab'], ['Model', model]],
    },
    claude: {
      title: 'Claude Code Proxy',
      tone: 'client-experimental',
      settings: [['Status', 'Experimental'], ['Base URL', state.clientsBaseUrl], ['API Key', 'Token from Tokens tab']],
    },
    openrouter: {
      title: 'OpenRouter',
      tone: 'client-external',
      settings: [['Base URL', 'https://openrouter.ai/api/v1'], ['API Key', 'OpenRouter key'], ['Use Case', 'External fallback']],
    },
  };

  const entries = Object.entries(data || {});
  if (!entries.length) {
    renderEmpty('#clients-list', 'No clients configured.');
    return;
  }

  const runningCount = entries.filter(([, client]) => client.external || client.enabled).length;
  setHtml('#clients-summary', `<div class="clients-summary">
    <div class="client-summary-card"><span class="client-summary-label">Available</span><strong>${entries.length}</strong></div>
    <div class="client-summary-card"><span class="client-summary-label">Active</span><strong>${runningCount}</strong></div>
    <div class="client-summary-card client-summary-wide"><span class="client-summary-label">Base URL</span><code>${escapeHtml(state.clientsBaseUrl)}</code></div>
  </div>`);

  setHtml('#clients-list', entries.map(([name, client]) => {
    const info = meta[name] || { title: name, tone: '', settings: [['Base URL', state.clientsBaseUrl]] };
    const external = Boolean(client.external);
    const running = external || Boolean(client.enabled);
    const stateClass = external ? 'is-external' : (running ? 'is-running' : 'is-stopped');
    const status = external ? 'external' : (running ? 'running' : 'off');
    const service = escapeHtml(client.service || '');
    const actions = external
      ? '<span style="font-size:12px;color:var(--accent-blue)">External service</span>'
      : running
        ? `<button class="btn btn-danger btn-small" data-action="client-disable" data-client="${escapeHtml(name)}">Disable</button>
           <button class="btn btn-secondary btn-small" data-action="client-logs" data-service="${service}">Logs</button>`
        : `<button class="btn btn-success btn-small" data-action="client-enable" data-client="${escapeHtml(name)}">Enable</button>`;

    return `<div class="client-card ${stateClass} ${info.tone}">
      <div class="client-card-header">
        <div class="client-icon">${escapeHtml((info.title || name).slice(0, 1))}</div>
        <div>
          <h3>${escapeHtml(info.title)}</h3>
          <p>${escapeHtml(client.hint || '')}</p>
        </div>
        <span class="client-power ${running ? 'on' : ''}"></span>
      </div>
      <div class="client-status-line">${statusPill(status, external ? 'neutral' : (running ? 'good' : 'warn'))}</div>
      ${renderClientSettings(info.settings)}
      <div class="client-actions">${actions}</div>
    </div>`;
  }).join(''));
};

const newChatConversation = () => ({
  id: makeId(),
  title: 'New chat',
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const loadChatStorage = () => {
  let conversations = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
    if (Array.isArray(parsed)) conversations = parsed;
  } catch {
    conversations = [];
  }
  if (!conversations.length) conversations = [newChatConversation()];
  state.chat.conversations = conversations;
  state.chat.activeId = localStorage.getItem(CHAT_ACTIVE_KEY) || conversations[0].id;
  if (!state.chat.conversations.some((item) => item.id === state.chat.activeId)) {
    state.chat.activeId = state.chat.conversations[0].id;
  }
};

const saveChatStorage = () => {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.chat.conversations.slice(0, 40)));
  if (state.chat.activeId) localStorage.setItem(CHAT_ACTIVE_KEY, state.chat.activeId);
};

const activeChat = () => state.chat.conversations.find((item) => item.id === state.chat.activeId) || null;

const loadChatSettings = () => {
  try {
    const settings = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || '{}');
    if ($('#chat-temperature') && settings.temperature !== undefined) $('#chat-temperature').value = settings.temperature;
    if ($('#chat-top-p') && settings.top_p !== undefined) $('#chat-top-p').value = settings.top_p;
    if ($('#chat-max-tokens') && settings.max_tokens !== undefined) $('#chat-max-tokens').value = settings.max_tokens;
    if ($('#chat-system') && settings.system !== undefined) $('#chat-system').value = settings.system;
  } catch {
    /* keep defaults */
  }
};

const saveChatSettings = () => {
  localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({
    temperature: $('#chat-temperature')?.value || '',
    top_p: $('#chat-top-p')?.value || '',
    max_tokens: $('#chat-max-tokens')?.value || '',
    system: $('#chat-system')?.value || '',
  }));
};

const chatTitleFromText = (text) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 64) : 'File chat';
};

const renderChatHistory = () => {
  setHtml('#chat-history', state.chat.conversations.map((conversation) => {
    const active = conversation.id === state.chat.activeId;
    const count = conversation.messages?.length || 0;
    return `<button class="chat-history-item ${active ? 'active' : ''}" data-action="chat-open" data-id="${escapeHtml(conversation.id)}">
      <strong>${escapeHtml(conversation.title || 'New chat')}</strong>
      <span>${count} messages - ${escapeHtml(formatTime(conversation.updatedAt || conversation.createdAt))}</span>
    </button>`;
  }).join(''));
};

const messageStats = (message) => {
  const stats = message.stats || {};
  const pieces = [];
  if (stats.elapsed_ms) pieces.push(`${(Number(stats.elapsed_ms) / 1000).toFixed(1)}s`);
  if (stats.used_tokens) pieces.push(`${stats.used_tokens} tokens`);
  const metrics = stats.metrics || {};
  if (metrics.avg_prompt_tokens_per_second) pieces.push(`prompt ${formatSpeed(metrics.avg_prompt_tokens_per_second)}`);
  if (metrics.avg_eval_tokens_per_second) pieces.push(`eval ${formatSpeed(metrics.avg_eval_tokens_per_second)}`);
  return pieces;
};

const renderChatMessages = () => {
  const conversation = activeChat();
  if (!conversation || !conversation.messages.length) {
    setHtml('#chat-messages', '<div class="chat-empty"><span>AI</span><strong>Ready</strong></div>');
    setText('#chat-title', conversation?.title || 'New chat');
    setText('#chat-subtitle', '0 messages');
    return;
  }

  setText('#chat-title', conversation.title || 'New chat');
  setText('#chat-subtitle', `${conversation.messages.length} messages`);
  setHtml('#chat-messages', conversation.messages.map((message) => {
    const role = escapeHtml(message.role || 'assistant');
    const body = escapeHtml(message.displayContent || message.content || '');
    const attachments = (message.attachments || []).map((file) => `<span>${escapeHtml(file.name)} - ${formatBytes(file.size)}</span>`);
    const meta = [...attachments, ...messageStats(message).map(escapeHtml)];
    return `<article class="chat-message ${role}">
      <div class="chat-message-head"><span>${role}</span><span>${escapeHtml(formatTime(message.createdAt))}</span></div>
      <div class="chat-message-body">${body}</div>
      ${meta.length ? `<div class="chat-message-meta">${meta.map((item) => `<span>${item}</span>`).join('')}</div>` : ''}
    </article>`;
  }).join(''));
  const messages = $('#chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
};

const renderChatAttachments = () => {
  if (!state.chat.attachments.length) {
    setHtml('#chat-attachments', '');
    return;
  }
  setHtml('#chat-attachments', state.chat.attachments.map((file) => `<span class="chat-file-chip">
    <strong>${escapeHtml(file.name)}</strong>
    ${formatBytes(file.size)}
    ${file.truncated ? '<em>trimmed</em>' : ''}
    <button type="button" data-action="chat-file-remove" data-id="${escapeHtml(file.id)}">x</button>
  </span>`).join(''));
};

const renderChat = () => {
  renderChatHistory();
  renderChatMessages();
  renderChatAttachments();
};

const applyChatMetrics = (metrics = {}) => {
  setText('#chat-prompt-speed', `prompt: ${formatSpeed(metrics.avg_prompt_tokens_per_second)}`);
  setText('#chat-eval-speed', `eval: ${formatSpeed(metrics.avg_eval_tokens_per_second)}`);
};

const loadChatStatus = async () => {
  const status = await api('/chat/status');
  state.chat.status = status;
  const models = status.models || [];
  const current = status.current_model_path || '';
  const select = $('#chat-model-select');
  if (select) {
    const options = models.map((model) => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`);
    if (current && !models.some((model) => model.path === current)) {
      options.unshift(`<option value="${escapeHtml(current)}">${escapeHtml(status.current_model_name || current)}</option>`);
    }
    select.innerHTML = options.join('') || '<option value="">local-model</option>';
    select.value = current || models[0]?.path || '';
  }
  setText('#chat-active-model', `model: ${status.current_model_name || (current ? current.split('/').pop() : 'local-model') || 'local-model'}`);
  applyChatMetrics(status.metrics || {});
};

const loadChat = async () => {
  loadChatStorage();
  loadChatSettings();
  renderChat();
  await loadChatStatus();
};

const isTextFile = (file) => {
  const ext = String(file.name || '').toLowerCase().split('.').pop();
  return String(file.type || '').startsWith('text/') || CHAT_TEXT_EXTENSIONS.has(ext);
};

const addChatFiles = async (files) => {
  let totalChars = state.chat.attachments.reduce((sum, file) => sum + String(file.content || '').length, 0);
  for (const file of files) {
    const attachment = {
      id: makeId(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      content: '',
      truncated: false,
    };
    if (isTextFile(file)) {
      const slice = file.slice(0, CHAT_MAX_FILE_CHARS);
      attachment.content = await slice.text();
      attachment.truncated = file.size > CHAT_MAX_FILE_CHARS || attachment.content.length >= CHAT_MAX_FILE_CHARS;
      if (totalChars + attachment.content.length > CHAT_MAX_TOTAL_FILE_CHARS) {
        const available = Math.max(0, CHAT_MAX_TOTAL_FILE_CHARS - totalChars);
        attachment.content = attachment.content.slice(0, available);
        attachment.truncated = true;
      }
      totalChars += attachment.content.length;
    } else {
      attachment.content = `[Binary attachment: ${file.name}, ${formatBytes(file.size)}, ${attachment.type}]`;
    }
    state.chat.attachments.push(attachment);
  }
  renderChatAttachments();
};

const attachmentContext = (attachments) => attachments.map((file) => [
  `--- file: ${file.name} (${file.type || 'unknown'}, ${formatBytes(file.size)}${file.truncated ? ', trimmed' : ''}) ---`,
  file.content || '[No readable text extracted]',
].join('\n')).join('\n\n');

const selectedChatModel = () => {
  const value = $('#chat-model-select')?.value || '';
  return value ? value.split('/').pop() : '';
};

const chatRequestMessages = (conversation) => {
  const system = ($('#chat-system')?.value || '').trim();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const message of conversation.messages || []) {
    if (message.role === 'user' || message.role === 'assistant') {
      messages.push({ role: message.role, content: message.content || message.displayContent || '' });
    }
  }
  return messages;
};

const sendChat = async () => {
  if (state.chat.busy) return;
  loadChatStorage();
  const conversation = activeChat() || newChatConversation();
  if (!activeChat()) {
    state.chat.conversations.unshift(conversation);
    state.chat.activeId = conversation.id;
  }

  const input = $('#chat-input');
  const text = (input?.value || '').trim();
  const attachments = [...state.chat.attachments];
  if (!text && !attachments.length) throw new Error('Message is empty');

  const filesText = attachmentContext(attachments);
  const content = [text, filesText ? `Attached files:\n${filesText}` : ''].filter(Boolean).join('\n\n');
  const displayContent = text || attachments.map((file) => file.name).join('\n');
  const userMessage = {
    id: makeId(),
    role: 'user',
    content,
    displayContent,
    attachments: attachments.map(({ id, name, size, type, truncated }) => ({ id, name, size, type, truncated })),
    createdAt: Date.now(),
  };

  conversation.messages.push(userMessage);
  conversation.updatedAt = Date.now();
  if (!conversation.title || conversation.title === 'New chat') conversation.title = chatTitleFromText(displayContent);
  state.chat.attachments = [];
  if (input) input.value = '';
  saveChatSettings();
  saveChatStorage();
  renderChat();

  const body = {
    model: selectedChatModel(),
    messages: chatRequestMessages(conversation),
    temperature: Number($('#chat-temperature')?.value || 0.7),
    top_p: Number($('#chat-top-p')?.value || 0.95),
  };
  const maxTokens = $('#chat-max-tokens')?.value;
  if (maxTokens) body.max_tokens = Number(maxTokens);

  state.chat.busy = true;
  try {
    const response = await api('/chat', { method: 'POST', body: JSON.stringify(body) });
    const assistantMessage = {
      id: makeId(),
      role: 'assistant',
      content: response.message || JSON.stringify(response.raw || response, null, 2),
      createdAt: Date.now(),
      stats: {
        elapsed_ms: response.elapsed_ms,
        usage: response.usage,
        used_tokens: response.used_tokens,
        total_used_tokens: response.total_used_tokens,
        metrics: response.metrics || {},
      },
    };
    conversation.messages.push(assistantMessage);
    conversation.updatedAt = Date.now();
    saveChatStorage();
    applyChatMetrics(response.metrics || {});
    renderChat();
  } finally {
    state.chat.busy = false;
  }
};

const createChat = () => {
  const conversation = newChatConversation();
  state.chat.conversations.unshift(conversation);
  state.chat.activeId = conversation.id;
  state.chat.attachments = [];
  saveChatStorage();
  renderChat();
};

const openChat = (id) => {
  if (!state.chat.conversations.some((item) => item.id === id)) return;
  state.chat.activeId = id;
  state.chat.attachments = [];
  saveChatStorage();
  renderChat();
};

const deleteChat = () => {
  const conversation = activeChat();
  if (!conversation) return false;
  if (!confirm('Delete this chat?')) return false;
  state.chat.conversations = state.chat.conversations.filter((item) => item.id !== conversation.id);
  if (!state.chat.conversations.length) state.chat.conversations = [newChatConversation()];
  state.chat.activeId = state.chat.conversations[0].id;
  state.chat.attachments = [];
  saveChatStorage();
  renderChat();
  return true;
};

const exportChat = () => {
  const conversation = activeChat();
  if (!conversation) throw new Error('No active chat');
  const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(conversation.title || 'chat').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const switchChatModel = async () => {
  const path = $('#chat-model-select')?.value || '';
  if (!path) throw new Error('Select a model first');
  const result = await api('/models/switch', {
    method: 'POST',
    body: JSON.stringify({ path, restart: true }),
  });
  assertCommandOk(result.restart, 'Model switched, but llama restart failed');
  await loadChatStatus();
};

const applyLogFilter = (text) => {
  const q = ($('#log-filter')?.value || '').trim().toLowerCase();
  return q ? text.split('\n').filter((line) => line.toLowerCase().includes(q)).join('\n') : text;
};

const loadLogs = async ({ silent = false } = {}) => {
  const service = $('#log-service')?.value || 'llama-server-coder';
  const tail = Number($('#log-tail')?.value || 300);
  const data = await api(`/logs/${encodeURIComponent(service)}?tail=${encodeURIComponent(tail)}`);
  state.lastLogsText = `${data.stdout || ''}${data.stderr || ''}` || 'No logs available.';
  const output = setText('#logs-output', applyLogFilter(state.lastLogsText));
  if (output) output.scrollTop = output.scrollHeight;
  if (!silent) syncLogsFollow();
};

const renderUpdate = (data) => {
  setText('#update-current', data.current_short || '-');
  setText('#update-latest', data.latest_short || '-');
  setText('#update-branch', data.branch || '-');
  $('#update-dot')?.classList.toggle('hidden', !data.has_update);
  const apply = $('#update-apply');
  if (apply) apply.disabled = true;
  const badge = $('#update-state');
  if (!data.configured) {
    if (badge) badge.className = 'badge badge-danger';
    setText('#update-title', 'Updates not available');
    setText('#update-copy', data.error || 'Not a git repo');
    return;
  }
  if (data.fetch_error) {
    if (badge) badge.className = 'badge badge-warning';
    setText('#update-title', 'Check failed');
    setText('#update-copy', data.fetch_error);
    return;
  }
  if (data.ahead > 0) {
    if (badge) badge.className = 'badge badge-warning';
    setText('#update-title', 'Local ahead');
    setText('#update-copy', 'Local commits block fast-forward');
    return;
  }
  if (data.has_update) {
    if (badge) badge.className = 'badge badge-warning';
    setText('#update-title', `New: ${data.behind} commit(s)`);
    setText('#update-copy', data.dirty ? 'Local changes will be stashed' : 'Download & rebuild');
    if (apply) apply.disabled = !data.can_update;
    return;
  }
  if (badge) badge.className = 'badge badge-success';
  setText('#update-title', 'Up to date');
  setText('#update-copy', data.dirty ? 'Local changes present. Auto-stashed on update.' : 'No updates available.');
};

const loadUpdate = async (fetch = true) => {
  const data = await api(`/update/status?fetch=${fetch ? 'true' : 'false'}`);
  renderUpdate(data);
};

const renderUpdateJob = (job) => {
  const box = $('#update-progress');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = JSON.stringify(job, null, 2);
  const badge = $('#update-state');
  if (job.status === 'done') {
    if (badge) badge.className = 'badge badge-success';
    setText('#update-title', 'Done');
    setText('#update-copy', 'Stack updated & restarted');
  } else if (job.status === 'error') {
    if (badge) badge.className = 'badge badge-danger';
    setText('#update-title', 'Failed');
    setText('#update-copy', job.error || 'Check output');
  } else if (job.status === 'restarting') {
    if (badge) badge.className = 'badge badge-warning';
    setText('#update-title', 'Restarting');
    setText('#update-copy', 'UI will reconnect shortly');
  } else {
    if (badge) badge.className = 'badge badge-warning';
    setText('#update-title', 'Updating');
    setText('#update-copy', `Step: ${job.step || 'queued'}`);
  }
};

const pollUpdateJob = async () => {
  if (!state.updateJobId) return;
  const job = await api(`/update/jobs/${state.updateJobId}`);
  renderUpdateJob(job);
  if (['done', 'error'].includes(job.status)) {
    clearInterval(state.updateTimer);
    state.updateTimer = null;
    localStorage.removeItem('localAiUpdateJobId');
    state.updateJobId = null;
    await loadUpdate(false).catch(() => {});
  }
};

const createToken = async () => {
  const unlimited = Boolean($('#token-unlimited')?.checked);
  const body = {
    name: $('#token-name')?.value?.trim() || 'token',
    unlimited,
  };
  if (!unlimited && $('#token-limit')?.value) body.limit_tokens = Number($('#token-limit').value);
  await api('/tokens', { method: 'POST', body: JSON.stringify(body) });
  $('#token-form')?.reset();
  if ($('#token-unlimited')) $('#token-unlimited').checked = true;
  await loadTokens();
};

const toggleToken = async (key, enabled) => {
  await api(`/tokens/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  await loadTokens();
};

const resetToken = async (key) => {
  await api(`/tokens/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ reset_usage: true }) });
  await loadTokens();
};

const deleteToken = async (key) => {
  if (!confirm('Delete this token?')) return;
  await api(`/tokens/${encodeURIComponent(key)}`, { method: 'DELETE' });
  await loadTokens();
};

const createUser = async () => {
  await api('/users', {
    method: 'POST',
    body: JSON.stringify({
      username: $('#new-user')?.value?.trim(),
      password: $('#new-pass')?.value,
      is_admin: true,
    }),
  });
  $('#user-form')?.reset();
  await loadUsers();
};

const toggleUser = async (id, enabled) => {
  await api(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  await loadUsers();
};

const changePassword = async (id) => {
  const password = prompt('New password:');
  if (!password) return;
  await api(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ password }) });
};

const deleteUser = async (id) => {
  if (!confirm('Delete user?')) return;
  await api(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadUsers();
};

const switchModel = async (path) => {
  const result = await api('/models/switch', {
    method: 'POST',
    body: JSON.stringify({ path, restart: true }),
  });
  assertCommandOk(result.restart, 'Model switched, but llama restart failed');
  await loadModels();
};

const downloadModel = async (repo, include, dir) => {
  const result = await api('/models/download', {
    method: 'POST',
    body: JSON.stringify({ repo, include: include || '*.gguf', local_dir: dir || '' }),
  });
  toast(`Download queued: ${result.job_id}`, 'success');
  await loadModels();
};

const uploadModel = async () => {
  const file = $('#gguf-file')?.files?.[0];
  if (!file) throw new Error('Select .gguf');
  const form = new FormData();
  form.append('file', file);
  await api('/models/upload', { method: 'POST', body: form });
  $('#gguf-file').value = '';
  await loadModels();
};

const saveSettings = async (restart = false) => {
  const body = { ANTI_CONFIRM_SYSTEM_PROMPT: $('#prompt')?.value || '' };
  for (const key of ['CTX_SIZE', 'THREADS', 'PARALLEL_SLOTS', 'N_GPU_LAYERS', 'LLAMA_TIMEOUT']) {
    body[key] = $(`#${key}`)?.value || '';
  }
  const result = await api('/settings', { method: 'POST', body: JSON.stringify(body) });
  if (result.gateway_error) throw new Error(`Saved, but gateway rejected: ${result.gateway_error}`);
  if (restart) await stackAction('restart');
};

const toggleClient = async (name, enabled) => {
  const result = await api(`/clients/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
  assertCommandOk(result, `Could not ${enabled ? 'enable' : 'disable'} ${name}`);
  await loadClients();
};

const stackAction = async (action) => {
  const result = await api(`/stack/${encodeURIComponent(action)}`, { method: 'POST' });
  assertCommandOk(result, `Stack ${action} failed`);
  if (action === 'status') {
    openModal('Stack Status', `<pre class="logs-output">${escapeHtml(commandOutput(result) || JSON.stringify(result, null, 2))}</pre>`);
  } else {
    toast(`Stack ${action} finished`, 'success');
    setTimeout(() => loadCurrentTab().catch(() => {}), 1200);
  }
  return result;
};

const containerAction = async (name, action) => {
  const result = await api(`/containers/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: 'POST' });
  assertCommandOk(result, `Container ${action} failed`);
  toast(`Container ${action}ed`, 'success');
  setTimeout(() => loadCurrentTab().catch(() => {}), 800);
  return result;
};

const openContainerLogs = (service) => {
  setActiveTab('logs');
  const select = $('#log-service');
  if (select && ![...select.options].some((option) => option.value === service)) {
    const option = document.createElement('option');
    option.value = service;
    option.textContent = service;
    select.appendChild(option);
  }
  if (select) select.value = service;
  loadLogs().catch((error) => toast(error.message, 'error'));
};

const copyText = async (value) => {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(value);
  } else {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
};

const login = async () => {
  hideLoginError();
  await api('/login', {
    method: 'POST',
    body: JSON.stringify({
      username: $('#login-user')?.value.trim(),
      password: $('#login-pass')?.value,
    }),
  });
  await boot();
};

const logout = async () => {
  await api('/logout', { method: 'POST' });
  state.user = null;
  $('#app-view')?.classList.add('hidden');
  $('#login-view')?.classList.remove('hidden');
};

const handleAction = (btn) => {
  const action = btn.dataset.action;
  const stackActions = {
    'stack-start': 'start',
    'stack-stop': 'stop',
    'stack-restart': 'restart',
    'stack-down': 'down',
    'stack-status': 'status',
  };

  if (action === 'toggle-sidebar') {
    $('.sidebar')?.classList.toggle('open');
    return undefined;
  }
  if (action === 'refresh') return runAction(btn, () => loadCurrentTab(), 'Refreshed');
  if (action === 'logout') return runAction(btn, logout);
  if (stackActions[action]) return runAction(btn, () => stackAction(stackActions[action]));
  if (action === 'container-logs') return openContainerLogs(btn.dataset.service);
  if (action === 'container-start') return runAction(btn, () => containerAction(btn.dataset.container, 'start'));
  if (action === 'container-stop') return runAction(btn, () => containerAction(btn.dataset.container, 'stop'));
  if (action === 'container-restart') return runAction(btn, () => containerAction(btn.dataset.container, 'restart'));
  if (action === 'load-tokens') return runAction(btn, loadTokens, 'Tokens loaded');
  if (action === 'load-users') return runAction(btn, loadUsers, 'Users loaded');
  if (action === 'load-models') return runAction(btn, loadModels, 'Models loaded');
  if (action === 'load-clients') return runAction(btn, loadClients, 'Clients loaded');
  if (action === 'load-chat-status') return runAction(btn, loadChatStatus, 'Chat status loaded');
  if (action === 'chat-new') return createChat();
  if (action === 'chat-open') return openChat(btn.dataset.id);
  if (action === 'chat-delete') {
    if (deleteChat()) toast('Chat deleted', 'success');
    return undefined;
  }
  if (action === 'chat-export') return runAction(btn, exportChat, 'Exported');
  if (action === 'chat-attach') {
    $('#chat-file-input')?.click();
    return undefined;
  }
  if (action === 'chat-clear-files') {
    state.chat.attachments = [];
    renderChatAttachments();
    return undefined;
  }
  if (action === 'chat-file-remove') {
    state.chat.attachments = state.chat.attachments.filter((file) => file.id !== btn.dataset.id);
    renderChatAttachments();
    return undefined;
  }
  if (action === 'chat-switch-model') return runAction(btn, switchChatModel, 'Model switch queued');
  if (action === 'token-copy') return runAction(btn, () => copyText(btn.dataset.key), 'Copied');
  if (action === 'token-toggle') return runAction(btn, () => toggleToken(btn.dataset.key, btn.dataset.enabled !== 'true'), 'Updated');
  if (action === 'token-reset') return runAction(btn, () => resetToken(btn.dataset.key), 'Reset');
  if (action === 'token-delete') return runAction(btn, () => deleteToken(btn.dataset.key), 'Deleted');
  if (action === 'user-toggle') return runAction(btn, () => toggleUser(btn.dataset.id, btn.dataset.enabled !== 'true'), 'Updated');
  if (action === 'user-password') return runAction(btn, () => changePassword(btn.dataset.id), 'Changed');
  if (action === 'user-delete') return runAction(btn, () => deleteUser(btn.dataset.id), 'Deleted');
  if (action === 'model-switch') return runAction(btn, () => switchModel(btn.dataset.path), 'Switched');
  if (action === 'catalog-download') return runAction(btn, () => downloadModel(btn.dataset.repo, btn.dataset.include, btn.dataset.dir));
  if (action === 'client-enable') return runAction(btn, () => toggleClient(btn.dataset.client, true), 'Enabled');
  if (action === 'client-disable') return runAction(btn, () => toggleClient(btn.dataset.client, false), 'Disabled');
  if (action === 'client-logs') return openContainerLogs(btn.dataset.service);
  if (action === 'client-copy-base') return runAction(btn, () => copyText(state.clientsBaseUrl || `${window.location.origin}/v1`), 'Copied');
  if (action === 'save-settings-restart') return runAction(btn, () => saveSettings(true), 'Saved');
  if (action === 'apply-update') {
    return runAction(btn, async () => {
      const result = await api('/update/apply', { method: 'POST', body: '{}' });
      state.updateJobId = result.job_id;
      localStorage.setItem('localAiUpdateJobId', result.job_id);
      if (state.updateTimer) clearInterval(state.updateTimer);
      state.updateTimer = setInterval(pollUpdateJob, 2500);
      await pollUpdateJob();
    }, 'Queued');
  }
  return undefined;
};

document.addEventListener('DOMContentLoaded', () => {
  $$('.nav-item').forEach((el) => el.addEventListener('click', () => setActiveTab(el.dataset.tab)));

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    event.preventDefault();
    const result = handleAction(btn);
    if (result?.catch) result.catch(() => {});
  });

  $('#login-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(event.target.querySelector('button[type=submit]'), login).catch((error) => showLoginError(error.message));
  });

  $('#token-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(event.target.querySelector('button[type=submit]'), createToken, 'Token created').catch(() => {});
  });

  $('#user-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(event.target.querySelector('button[type=submit]'), createUser, 'User created').catch(() => {});
  });

  $('#hf-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(
      event.target.querySelector('button[type=submit]'),
      () => downloadModel($('#hf-repo')?.value.trim(), $('#hf-include')?.value.trim() || '*.gguf', $('#hf-dir')?.value.trim()),
    ).catch(() => {});
  });

  $('#logs-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(event.target.querySelector('button[type=submit]'), () => loadLogs(), 'Logs loaded').catch(() => {});
  });

  $('#chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(event.target.querySelector('button[type=submit]'), sendChat).catch(() => {});
  });

  $('#chat-file-input')?.addEventListener('change', (event) => {
    runAction(null, async () => {
      await addChatFiles(event.target.files || []);
      event.target.value = '';
    }, 'Files attached').catch(() => {});
  });

  ['#chat-temperature', '#chat-top-p', '#chat-max-tokens', '#chat-system'].forEach((selector) => {
    $(selector)?.addEventListener('change', saveChatSettings);
  });

  $('#gguf-file')?.addEventListener('change', () => {
    runAction($('#drop-zone'), uploadModel, 'Uploaded').catch(() => {});
  });

  $('#log-filter')?.addEventListener('input', () => setText('#logs-output', applyLogFilter(state.lastLogsText)));
  $('#logs-follow')?.addEventListener('change', syncLogsFollow);
  $('#global-search')?.addEventListener('input', syncGlobalSearch);
  window.addEventListener('unhandledrejection', (event) => toast(event.reason?.message || 'Unknown error', 'error'));

  boot();
});

const boot = async () => {
  try {
    state.user = await api('/me');
    setText('#user-avatar', state.user.username?.[0]?.toUpperCase() || 'A');
    setText('#user-pill', state.user.username);
    setText('#user-role', state.user.is_admin ? 'Administrator' : 'User');
    $('#login-view')?.classList.add('hidden');
    $('#app-view')?.classList.remove('hidden');
    hideLoginError();

    const activeNav = $('.nav-item.active')?.dataset.tab;
    setActiveTab(state.tab || activeNav || 'overview');
    loadUpdate(false).catch(() => {});
    if (state.updateJobId && !state.updateTimer) {
      state.updateTimer = setInterval(pollUpdateJob, 2500);
      pollUpdateJob().catch(() => {});
    }
  } catch {
    $('#login-view')?.classList.remove('hidden');
    $('#app-view')?.classList.add('hidden');
  }
};

setInterval(() => {
  if ($('#app-view') && !$('#app-view').classList.contains('hidden') && state.tab === 'overview') {
    loadSystem().catch(() => {});
  }
}, 8000);

setInterval(() => {
  if ($('#app-view') && !$('#app-view').classList.contains('hidden')) {
    loadUpdate(false).catch(() => {});
  }
}, 300000);

setInterval(() => {
  if ($('#app-view') && !$('#app-view').classList.contains('hidden') && state.tab === 'models') {
    loadModels().catch(() => {});
  }
}, 5000);

setInterval(() => {
  if ($('#app-view') && !$('#app-view').classList.contains('hidden') && state.tab === 'chat') {
    loadChatStatus().catch(() => {});
  }
}, 15000);
