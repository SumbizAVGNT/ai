/**
 * Local AI Admin Panel — Frontend Controller (v3.2)
 * Адаптировано под новый glassmorphism/neon интерфейс
 */

// ==========================================
// 1. CONSTANTS & STATE
// ==========================================
const APP_BASE = window.location.pathname.startsWith('/ui') ? '/ui' : '';
const API = (path) => `${APP_BASE}/api${path}`;

const state = {
  tab: 'dashboard',
  user: null,
  updateJobId: localStorage.getItem('localAiUpdateJobId') || null,
  updateTimer: null,
  logsTimer: null,
  lastLogsText: '',
  clientsBaseUrl: '',
};

const TAB_TITLES = {
  dashboard: 'Dashboard',
  services: 'Service Management',
  monitoring: 'Resource Monitoring',
  tokens: 'Token Management',
  users: 'User Accounts',
  models: 'Model Library',
  llama: 'Llama Configuration',
  clients: 'Client Integrations',
  logs: 'Container Logs',
};

const TAB_SUBTITLES = {
  dashboard: 'Runtime state, services and stack controls',
  services: 'Manage Docker containers and compose stack',
  monitoring: 'Resource usage and performance metrics',
  tokens: 'API keys, limits and usage counters',
  users: 'Admin panel accounts management',
  models: 'Local GGUF models, downloads and uploads',
  llama: 'Prompt and llama.cpp runtime configuration',
  clients: 'OpenAI-compatible client helpers',
  logs: 'Container logs with filter and follow mode',
};

// ==========================================
// 2. UTILITIES
// ==========================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

const formatBytes = (n) => {
  const num = Number(n || 0);
  if (!isFinite(num)) return '-';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (num >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${num.toFixed(1)} ${units[i]}`;
};

const formatDuration = (sec) => {
  const s = Math.max(0, Number(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// Toast notifications
const toast = (msg, type = 'info', timeout = 4500) => {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
};

// API wrapper
const api = async (path, options = {}) => {
  const isForm = options.body instanceof FormData;
  const headers = isForm ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(API(path), {
    credentials: 'same-origin',
    headers: { ...headers, ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { raw: text }) : {};
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data.detail || data.error || `HTTP ${res.status}`);
  return data;
};

// Safe DOM setters
const setText = (sel, val) => { const el = $(sel); if (el) el.textContent = val; return el; };
const setHtml = (sel, val) => { const el = $(sel); if (el) el.innerHTML = val; return el; };
const renderEmpty = (sel, msg) => setHtml(sel, `<div class="empty-state"><div class="empty-state-icon">📭</div><h4>${escapeHtml(msg)}</h4></div>`);

// Modal helpers
const openModal = (title, body, footer = '') => {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-footer').innerHTML = footer;
  $('#modal-backdrop').classList.add('show');
};
const closeModal = () => $('#modal-backdrop')?.classList.remove('show');

// ==========================================
// 3. NAVIGATION & TABS
// ==========================================
const setActiveTab = (tab) => {
  state.tab = tab;
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  $$('.tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));
  $('#page-title').textContent = TAB_TITLES[tab] || tab;
  $('#page-subtitle').textContent = TAB_SUBTITLES[tab] || '';
  $('#page-alert')?.classList.add('hidden');
  if (window.innerWidth <= 1024) $('#sidebar')?.classList.remove('open');
  stopLogsFollow();
  loadCurrentTab();
};

const loadCurrentTab = async () => {
  try {
    switch (state.tab) {
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
    syncGlobalSearch();
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ==========================================
// 4. DATA LOADERS
// ==========================================
const loadSystem = async () => {
  const data = await api('/system');
  const host = data.host || {};
  const metrics = data.llama_metrics || {};
  const stack = data.stack || {};

  setText('#metric-cpu', `${Math.round(host.cpu_percent || 0)}%`);
  setText('#metric-ram', `${formatBytes(host.memory?.used)} / ${formatBytes(host.memory?.total)}`);
  setText('#metric-speed', metrics.avg_prompt_tokens_per_second ? `${metrics.avg_prompt_tokens_per_second.toFixed(1)} tok/s` : '-');
  setText('#metric-uptime', formatDuration(host.uptime_seconds));
  setText('#hero-backend', `backend: ${stack.backend || 'cpu'}`);
  setText('#hero-model', `model: ${stack.model_id || stack.model_path || 'not selected'}`);
  setText('#hero-url', `url: ${stack.public_base_url || window.location.origin}`);

  const preferred = ['llama-server-coder','token-gateway','admin-ui','local-ai-nginx','postgres','local-ai-postgres','opencode-server','codex-runner','claude-code-proxy','local-ai-certbot'];
  const containers = (data.containers || []).sort((a,b) => {
    const ai = preferred.indexOf(a.name), bi = preferred.indexOf(b.name);
    return (ai===-1?999:ai)-(bi===-1?999:bi) || a.name.localeCompare(b.name);
  });

  if (!containers.length) return renderEmpty('#containers-table', data.docker_error || 'No containers found');
  setHtml('#containers-table', containers.map(c => {
    const run = c.status === 'running';
    const badHealth = c.health === 'unhealthy';
    const cls = run && !badHealth ? 'running' : (run ? 'updating' : 'stopped');
    const stats = c.stats || {};
    return `<tr>
      <td><strong>${escapeHtml(c.name)}</strong><br><code>${escapeHtml((c.image||[]).join(', ') || 'unknown')}</code></td>
      <td><span class="badge ${cls}">${escapeHtml(c.health || c.status)}</span></td>
      <td>${stats.cpu_percent?.toFixed(1) || 0}%</td>
      <td>${formatBytes(stats.memory_usage)}</td>
      <td class="actions">
        ${run ? `<button class="btn btn-secondary btn-sm" data-action="container-restart" data-container="${escapeHtml(c.name)}">Restart</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-action="container-logs" data-service="${escapeHtml(c.name)}">Logs</button>
        ${run && c.name !== 'admin-ui' ? `<button class="btn btn-danger btn-sm" data-action="container-stop" data-container="${escapeHtml(c.name)}">Stop</button>` : `<button class="btn btn-success btn-sm" data-action="container-start" data-container="${escapeHtml(c.name)}" ${run?'disabled':''}>Start</button>`}
      </td>
    </tr>`;
  }).join(''));
};

const loadServices = async () => {
  const data = await api('/system');
  const tbody = $('#tab-services tbody');
  if (!tbody) return;
  tbody.innerHTML = (data.containers || []).map(c => {
    const run = c.status === 'running';
    return `<tr>
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td><span class="badge ${run?'running':'stopped'}">${escapeHtml(c.status)}</span></td>
      <td><code>${escapeHtml((c.image||[])[0]||'unknown')}</code></td>
      <td>-</td>
      <td class="actions">
        ${run ? `<button class="btn btn-secondary btn-sm" data-action="container-restart" data-container="${escapeHtml(c.name)}">Restart</button>` : `<button class="btn btn-success btn-sm" data-action="container-start" data-container="${escapeHtml(c.name)}">Start</button>`}
        <button class="btn btn-secondary btn-sm" data-action="container-logs" data-service="${escapeHtml(c.name)}">Logs</button>
        ${run && c.name !== 'admin-ui' ? `<button class="btn btn-danger btn-sm" data-action="container-stop" data-container="${escapeHtml(c.name)}">Stop</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state">No services detected</td></tr>';
};

const loadMonitoring = async () => {
  const data = await api('/system');
  const host = data.host || {};
  const metrics = data.llama_metrics || {};
  const cards = $$('#tab-monitoring .card-value');
  if (cards[0]) cards[0].textContent = `${Math.round(host.cpu_percent||0)}%`;
  if (cards[1]) cards[1].textContent = `${((host.memory?.used/host.memory?.total)*100||0).toFixed(1)}%`;
  if (cards[2]) cards[2].textContent = `${((host.disk?.used/host.disk?.total)*100||0).toFixed(1)}%`;

  const tbody = $('#tab-monitoring .table-wrapper:first-of-type tbody');
  if (tbody) {
    tbody.innerHTML = (data.containers||[]).filter(c=>c.status==='running').map(c => {
      const s = c.stats||{};
      const ramPct = s.memory_limit ? ((s.memory_usage/s.memory_limit)*100).toFixed(1)+'%' : '-';
      return `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td><span class="badge running">running</span></td><td>${s.cpu_percent?.toFixed(1)||0}%</td><td>${ramPct}</td><td>${formatBytes(s.memory_usage)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty-state">No running containers</td></tr>';
  }

  const llama = $('#tab-monitoring .table-wrapper:last-of-type tbody');
  if (llama) {
    llama.innerHTML = `
      <tr><td><strong>Last Prompt Tokens</strong></td><td>${metrics.last_task_tokens||'-'}</td></tr>
      <tr><td><strong>Prompt Speed</strong></td><td>${metrics.avg_prompt_tokens_per_second?.toFixed(1)||'-'} tok/s</td></tr>
      <tr><td><strong>Eval Speed</strong></td><td>${metrics.avg_eval_tokens_per_second?.toFixed(1)||'-'} tok/s</td></tr>
      <tr><td><strong>Estimated Prompt Time</strong></td><td>${metrics.estimated_seconds_for_last_prompt?.toFixed(2)||'-'} sec</td></tr>
    `;
  }
};

const loadTokens = async () => {
  const { tokens = [] } = await api('/tokens');
  const tbody = $('#tokens-table');
  if (!tbody) return;
  if (!tokens.length) return renderEmpty('#tokens-table', 'No tokens yet. Create one above.');
  tbody.innerHTML = tokens.map(t => `<tr>
    <td><strong>${escapeHtml(t.name||'token')}</strong></td>
    <td><code>${escapeHtml(t.key)}</code></td>
    <td>${(t.used_tokens||0).toLocaleString()}</td>
    <td>${t.unlimited ? '∞' : (t.limit_tokens||0).toLocaleString()}</td>
    <td>${t.unlimited ? '∞' : (t.remaining_tokens??0).toLocaleString()}</td>
    <td><span class="badge ${t.enabled?'running':'disabled'}">${t.enabled?'enabled':'disabled'}</span></td>
    <td class="actions">
      <button class="btn btn-secondary btn-sm" data-action="token-toggle" data-key="${escapeHtml(t.key)}" data-enabled="${t.enabled}">${t.enabled?'Disable':'Enable'}</button>
      <button class="btn btn-secondary btn-sm" data-action="token-reset" data-key="${escapeHtml(t.key)}">Reset</button>
      <button class="btn btn-danger btn-sm" data-action="token-delete" data-key="${escapeHtml(t.key)}">Delete</button>
    </td>
  </tr>`).join('');
};

const loadUsers = async () => {
  const { users = [] } = await api('/users');
  const tbody = $('#users-table');
  if (!tbody) return;
  if (!users.length) return renderEmpty('#users-table', 'No users found.');
  tbody.innerHTML = users.map(u => {
    const isMe = state.user && Number(state.user.id) === Number(u.id);
    return `<tr>
      <td><strong>${escapeHtml(u.id)}</strong></td>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td><code>${u.is_admin?'admin':'user'}</code></td>
      <td><span class="badge ${u.enabled?'running':'disabled'}">${u.enabled?'enabled':'disabled'}</span></td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" data-action="user-toggle" data-id="${u.id}" data-enabled="${u.enabled}">${u.enabled?'Disable':'Enable'}</button>
        <button class="btn btn-secondary btn-sm" data-action="user-password" data-id="${u.id}">Password</button>
        <button class="btn btn-danger btn-sm" data-action="user-delete" data-id="${u.id}" ${isMe?'disabled':''}>Delete</button>
      </td>
    </tr>`;
  }).join('');
};

const loadSettings = async () => {
  const data = await api('/settings');
  $('#prompt').value = data.prompt || '';
  for (const k of ['CTX_SIZE','THREADS','PARALLEL_SLOTS','N_GPU_LAYERS','LLAMA_TIMEOUT']) {
    const el = $(`#${k}`);
    if (el) el.value = data.llama?.[k] || '';
  }
};

const loadModels = async () => {
  const data = await api('/models');
  const local = data.local || [];
  const catalog = data.catalog || [];

  const activeBox = $('#tab-models .form-card:first-child');
  if (activeBox) {
    activeBox.querySelector('div[style*="display:flex"] strong')?.textContent = data.current?.split('/').pop() || 'not set';
    activeBox.querySelector('code')?.textContent = data.current || '-';
  }

  const lTbody = $('#models-local');
  if (lTbody) {
    lTbody.innerHTML = local.length ? local.map(m => `<tr>
      <td><strong>${escapeHtml(m.name)}</strong></td>
      <td><code>${escapeHtml(m.path)}</code></td>
      <td>${formatBytes(m.size)}</td>
      <td><span class="badge ${m.path===data.current?'running':'disabled'}">${m.path===data.current?'current':'available'}</span></td>
      <td>${m.path===data.current ? '<button class="btn btn-secondary btn-sm" disabled>Active</button>' : `<button class="btn btn-primary btn-sm" data-action="model-switch" data-path="${escapeHtml(m.path)}">Switch</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No .gguf files in ./models</td></tr>';
  }

  const cBox = $('#models-catalog');
  if (cBox) {
    cBox.innerHTML = catalog.length ? catalog.map(c => `<div class="catalog-card">
      <strong>${escapeHtml(c.title||c.repo)}</strong>
      <p>${escapeHtml(c.description||c.recommended||'')}</p>
      <code>${escapeHtml(c.repo)} / ${escapeHtml(c.include)}</code>
      <button class="btn btn-secondary btn-sm" data-action="catalog-download" data-repo="${escapeHtml(c.repo)}" data-include="${escapeHtml(c.include)}" data-dir="${escapeHtml(c.local_dir||'')}">Download</button>
    </div>`).join('') : '<div class="empty-state">Catalog is empty</div>';
  }
};

const loadClients = async () => {
  const [data, settings] = await Promise.all([api('/clients'), api('/settings').catch(()=>({}))]);
  const baseUrl = String(settings.public_base_url || window.location.origin).replace(/\/$/,'');
  state.clientsBaseUrl = `${baseUrl}/v1`;
  const model = settings.model_path ? settings.model_path.split('/').pop() : 'active GGUF';

  const meta = {
    opencode: { title:'OpenCode Desktop', icon:'🖥️', tone:'recommended', steps:[['Provider','OpenAI Compatible'],['Base URL',state.clientsBaseUrl],['API Key','Token from Tokens tab'],['Model',model]] },
    codex: { title:'Codex Runner', icon:'💻', tone:'tools', steps:[['OPENAI_BASE_URL',state.clientsBaseUrl],['OPENAI_API_KEY','Token from Tokens tab'],['Model',model]] },
    claude: { title:'Claude Code Proxy', icon:'🧩', tone:'experimental', steps:[['Status','Experimental'],['Base URL',state.clientsBaseUrl],['API Key','Token from Tokens tab']] },
    openrouter: { title:'OpenRouter', icon:'🌐', tone:'external', steps:[['Base URL','https://openrouter.ai/api/v1'],['API Key','OpenRouter key'],['Use Case','External fallback']] }
  };

  const entries = Object.entries(data);
  if (!entries.length) return renderEmpty('#clients-list', 'No clients configured.');

  setHtml('#clients-list', entries.map(([name, c]) => {
    const info = meta[name] || { title:name, icon:'📦', tone:'tools', steps:[['Base URL',state.clientsBaseUrl]] };
    const ext = Boolean(c.external);
    const cls = ext || c.enabled ? 'running' : 'stopped';
    const statusLabel = ext ? 'external' : (c.enabled ? 'running' : 'off');
    const actionBtn = ext ? '<span style="font-size:12px;color:var(--accent-blue)">External service</span>' :
      c.enabled ? `<button class="btn btn-danger btn-sm" data-action="client-disable" data-client="${name}">Disable</button>
                   <button class="btn btn-secondary btn-sm" data-action="client-logs" data-service="${c.service||''}">Logs</button>` :
      `<button class="btn btn-success btn-sm" data-action="client-enable" data-client="${name}">Enable</button>`;

    return `<div class="client-card ${cls}">
      <h5><span class="status-indicator"></span>${escapeHtml(info.title)}</h5>
      <p>${escapeHtml(c.hint||'')}</p>
      <div class="client-settings-list">${info.steps.map(([l,v])=>`<div class="client-setting"><span class="label">${escapeHtml(l)}</span><span class="value">${escapeHtml(v)}</span></div>`).join('')}</div>
      <div class="actions">${actionBtn}</div>
    </div>`;
  }).join(''));
};

// Logs
const stopLogsFollow = () => { if (state.logsTimer) clearInterval(state.logsTimer); state.logsTimer = null; };
const syncLogsFollow = () => {
  stopLogsFollow();
  if ($('#logs-follow')?.checked && state.tab === 'logs') state.logsTimer = setInterval(() => loadLogs({ silent:true }).catch(()=>{}), 4000);
};
const applyLogFilter = (text) => {
  const q = $('#log-filter')?.value.trim().toLowerCase() || '';
  return q ? text.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n') : text;
};
const loadLogs = async ({ silent=false } = {}) => {
  const service = $('#log-service')?.value || 'llama-server-coder';
  const data = await api(`/logs/${encodeURIComponent(service)}?tail=300`);
  state.lastLogsText = (data.stdout||'') + (data.stderr||'') || 'No logs available.';
  setText('#logs-output', applyLogFilter(state.lastLogsText));
  if (!silent) syncLogsFollow();
};

// Updates
const renderUpdate = (data) => {
  setText('#update-current', data.current_short || '-');
  setText('#update-latest', data.latest_short || '-');
  setText('#update-branch', data.branch || '-');
  $('#update-dot')?.classList.toggle('hidden', !data.has_update);
  const apply = $('#update-apply');
  if (apply) apply.disabled = true;
  const badge = $('#update-state');
  if (!data.configured) { if(badge) badge.className='badge badge-danger'; setText('#update-title','Updates not available'); setText('#update-copy', data.error||'Not a git repo'); return; }
  if (data.fetch_error) { if(badge) badge.className='badge badge-warning'; setText('#update-title','Check failed'); setText('#update-copy', data.fetch_error); return; }
  if (data.ahead > 0) { if(badge) badge.className='badge badge-warning'; setText('#update-title','Local ahead'); setText('#update-copy','Local commits block fast-forward'); return; }
  if (data.has_update) { if(badge) badge.className='badge badge-warning'; setText('#update-title',`New: ${data.behind} commit(s)`); setText('#update-copy', data.dirty?'Local changes will be stashed':'Download & rebuild'); if(apply) apply.disabled=!data.can_update; return; }
  if(badge) badge.className='badge badge-success'; setText('#update-title','Up to date'); setText('#update-copy', data.dirty?'Local changes present. Auto-stashed on update.':'No updates available.');
};
const loadUpdate = async (fetch=true) => {
  const data = await api(`/update/status?fetch=${fetch?'true':'false'}`);
  renderUpdate(data);
};
const renderUpdateJob = (job) => {
  const box = $('#update-progress'); if(!box) return;
  box.classList.remove('hidden'); box.textContent = JSON.stringify(job, null, 2);
  const badge = $('#update-state');
  if(job.status==='done') { if(badge) badge.className='badge badge-success'; setText('#update-title','Done'); setText('#update-copy','Stack updated & restarted'); }
  else if(job.status==='error') { if(badge) badge.className='badge badge-danger'; setText('#update-title','Failed'); setText('#update-copy',job.error||'Check output'); }
  else if(job.status==='restarting') { if(badge) badge.className='badge badge-warning'; setText('#update-title','Restarting'); setText('#update-copy','UI will reconnect shortly'); }
  else { if(badge) badge.className='badge badge-warning'; setText('#update-title','Updating'); setText('#update-copy',`Step: ${job.step||'queued'}`); }
};
const pollUpdateJob = async () => {
  if (!state.updateJobId) return;
  const job = await api(`/update/jobs/${state.updateJobId}`);
  renderUpdateJob(job);
  if (['done','error'].includes(job.status)) {
    clearInterval(state.updateTimer); state.updateTimer=null;
    localStorage.removeItem('localAiUpdateJobId'); state.updateJobId=null;
    await loadUpdate(false).catch(()=>{});
  }
};

// ==========================================
// 5. ACTIONS & CRUD
// ==========================================
const runAction = async (btn, task, successMsg) => {
  const orig = btn?.innerHTML;
  if (btn) { btn.disabled=true; btn.dataset.busy='1'; btn.innerHTML='<span class="spinner"></span> Working...'; }
  try {
    const res = await task();
    if (successMsg) toast(successMsg, 'success');
    return res;
  } catch (e) { toast(e.message, 'error'); throw e; }
  finally {
    if (btn) { btn.disabled=false; delete btn.dataset.busy; btn.innerHTML=orig||''; }
  }
};

const createToken = async () => {
  const unlimited = $('#token-unlimited')?.checked;
  const body = { name:$('#token-name')?.value?.trim()||'token', unlimited };
  if (!unlimited && $('#token-limit')?.value) body.limit_tokens = Number($('#token-limit').value);
  await api('/tokens', { method:'POST', body:JSON.stringify(body) });
  $('#token-form')?.reset(); if($('#token-unlimited')) $('#token-unlimited').checked=true;
  await loadTokens();
};
const toggleToken = async (key, enabled) => { await api(`/tokens/${encodeURIComponent(key)}`, { method:'PATCH', body:JSON.stringify({ enabled }) }); await loadTokens(); };
const resetToken = async (key) => { await api(`/tokens/${encodeURIComponent(key)}`, { method:'PATCH', body:JSON.stringify({ reset_usage:true }) }); await loadTokens(); };
const deleteToken = async (key) => { if (!confirm('Delete this token?')) return; await api(`/tokens/${encodeURIComponent(key)}`, { method:'DELETE' }); await loadTokens(); };

const createUser = async () => {
  await api('/users', { method:'POST', body:JSON.stringify({ username:$('#new-user')?.value?.trim(), password:$('#new-pass')?.value, is_admin:true }) });
  $('#user-form')?.reset(); await loadUsers();
};
const toggleUser = async (id, enabled) => { await api(`/users/${id}`, { method:'PATCH', body:JSON.stringify({ enabled }) }); await loadUsers(); };
const changePassword = async (id) => { const p = prompt('New password:'); if (!p) return; await api(`/users/${id}`, { method:'PATCH', body:JSON.stringify({ password:p }) }); toast('Password updated','success'); };
const deleteUser = async (id) => { if (!confirm('Delete user?')) return; await api(`/users/${id}`, { method:'DELETE' }); await loadUsers(); };

const switchModel = async (path) => { await api('/models/switch', { method:'POST', body:JSON.stringify({ path, restart:true }) }); await loadModels(); };
const downloadModel = async (repo, inc, dir) => { const r = await api('/models/download', { method:'POST', body:JSON.stringify({ repo, include:inc||'*.gguf', local_dir:dir||'' }) }); toast(`Download queued: ${r.job_id}`,'success'); await loadModels(); };
const uploadModel = async () => {
  const f = $('#gguf-file')?.files?.[0]; if (!f) throw new Error('Select .gguf');
  const fd = new FormData(); fd.append('file', f);
  await api('/models/upload', { method:'POST', body:fd });
  $('#gguf-file').value=''; await loadModels();
};

const saveSettings = async (restart=false) => {
  const body = { ANTI_CONFIRM_SYSTEM_PROMPT: $('#prompt')?.value || '' };
  for (const k of ['CTX_SIZE','THREADS','PARALLEL_SLOTS','N_GPU_LAYERS','LLAMA_TIMEOUT']) body[k] = $(`#${k}`)?.value || '';
  const res = await api('/settings', { method:'POST', body:JSON.stringify({ ...body, restart }) });
  if (res.gateway_error) throw new Error(`Saved, but gateway rejected: ${res.gateway_error}`);
  if (restart) await stackAction('restart');
};

const toggleClient = async (name, enabled) => {
  await api(`/clients/${encodeURIComponent(name)}/${enabled?'enable':'disable'}`, { method:'POST' });
  await loadClients();
};

const stackAction = async (action) => { await api(`/stack/${encodeURIComponent(action)}`, { method:'POST' }); toast(`Stack ${action} finished`, 'success'); setTimeout(loadSystem, 1200); };
const containerAction = async (name, action) => { await api(`/containers/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method:'POST' }); toast(`Container ${action}ed`, 'success'); setTimeout(loadSystem, 800); };
const openContainerLogs = (service) => {
  setActiveTab('logs');
  const sel = $('#log-service'); if (sel && ![...sel.options].some(o=>o.value===service)) { const o=document.createElement('option'); o.value=service; o.textContent=service; sel.appendChild(o); }
  if (sel) sel.value = service; loadLogs();
};
const copyText = async (val) => { if (navigator.clipboard) await navigator.clipboard.writeText(val); toast('Copied to clipboard', 'success'); };

// Auth
const login = async () => {
  $('#login-error')?.classList.add('hidden');
  await api('/login', { method:'POST', body:JSON.stringify({ username:$('#login-user').value.trim(), password:$('#login-pass').value }) });
  await boot();
};
const logout = async () => { await api('/logout', { method:'POST' }); state.user=null; $('#login-view')?.classList.remove('hidden'); $('#app-view')?.classList.add('hidden'); };

// ==========================================
// 6. EVENT BINDING & INIT
// ==========================================
const handleAction = (btn) => {
  const a = btn.dataset.action;
  const map = { 'stack-start':'start','stack-stop':'stop','stack-restart':'restart','stack-down':'down','stack-status':'status' };
  if (a==='refresh') return runAction(btn, loadCurrentTab, 'Refreshed');
  if (a==='logout') return runAction(btn, logout);
  if (map[a]) return runAction(btn, ()=>stackAction(map[a]), `Stack ${map[a]}`);
  if (a==='container-logs') return openContainerLogs(btn.dataset.service);
  if (a==='container-start') return runAction(btn, ()=>containerAction(btn.dataset.container,'start'), 'Started');
  if (a==='container-stop') return runAction(btn, ()=>containerAction(btn.dataset.container,'stop'), 'Stopped');
  if (a==='container-restart') return runAction(btn, ()=>containerAction(btn.dataset.container,'restart'), 'Restarted');
  if (a==='token-copy') return runAction(btn, ()=>copyText(btn.dataset.key), 'Copied');
  if (a==='token-toggle') return runAction(btn, ()=>toggleToken(btn.dataset.key, btn.dataset.enabled!=='true'), 'Updated');
  if (a==='token-reset') return runAction(btn, ()=>resetToken(btn.dataset.key), 'Reset');
  if (a==='token-delete') return runAction(btn, ()=>deleteToken(btn.dataset.key), 'Deleted');
  if (a==='user-toggle') return runAction(btn, ()=>toggleUser(btn.dataset.id, btn.dataset.enabled!=='true'), 'Updated');
  if (a==='user-password') return runAction(btn, ()=>changePassword(btn.dataset.id), 'Changed');
  if (a==='user-delete') return runAction(btn, ()=>deleteUser(btn.dataset.id), 'Deleted');
  if (a==='model-switch') return runAction(btn, ()=>switchModel(btn.dataset.path), 'Switched');
  if (a==='catalog-download') return runAction(btn, ()=>downloadModel(btn.dataset.repo, btn.dataset.include, btn.dataset.dir), 'Started');
  if (a==='client-enable') return runAction(btn, ()=>toggleClient(btn.dataset.client, true), 'Enabled');
  if (a==='client-disable') return runAction(btn, ()=>toggleClient(btn.dataset.client, false), 'Disabled');
  if (a==='client-logs') return openContainerLogs(btn.dataset.service);
  if (a==='save-settings-restart') return runAction(btn, ()=>saveSettings(true), 'Saved');
  if (a==='apply-update') return runAction(btn, async () => { const r=await api('/update/apply',{method:'POST',body:'{}'}); state.updateJobId=r.job_id; localStorage.setItem('localAiUpdateJobId',r.job_id); if(state.updateTimer) clearInterval(state.updateTimer); state.updateTimer=setInterval(pollUpdateJob, 2500); await pollUpdateJob(); }, 'Queued');
};

const syncGlobalSearch = () => {
  const q = $('#global-search')?.value.trim().toLowerCase() || '';
  $$('.tab-content.active .list-row, .tab-content.active .client-card, .tab-content.active .catalog-card').forEach(el => el.classList.toggle('is-search-hidden', q && !el.textContent.toLowerCase().includes(q)));
};

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  $$('.nav-item').forEach(el => el.addEventListener('click', () => setActiveTab(el.dataset.tab)));

  // Action delegation
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn) { e.preventDefault(); handleAction(btn)?.catch(()=>{}); }
  });

  // Forms
  $('#login-form')?.addEventListener('submit', e => { e.preventDefault(); runAction(e.target.querySelector('button[type=submit]'), login).catch(err => { const el=$('#login-error'); if(el){el.textContent=err.message; el.classList.remove('hidden'); }}); });
  $('#token-form')?.addEventListener('submit', e => { e.preventDefault(); runAction(e.target.querySelector('button[type=submit]'), createToken, 'Token created').catch(()=>{}); });
  $('#user-form')?.addEventListener('submit', e => { e.preventDefault(); runAction(e.target.querySelector('button[type=submit]'), createUser, 'User created').catch(()=>{}); });
  $('#hf-form')?.addEventListener('submit', e => { e.preventDefault(); runAction(e.target.querySelector('button[type=submit]'), ()=>downloadModel($('#hf-repo').value.trim(), $('#hf-include').value.trim()||'*.gguf', $('#hf-dir').value.trim()), 'Download started').catch(()=>{}); });
  $('#settings-form')?.addEventListener('submit', e => { e.preventDefault(); runAction(e.target.querySelector('button[type=submit]'), ()=>saveSettings(false), 'Settings saved').catch(()=>{}); });
  $('#gguf-file')?.addEventListener('change', e => { runAction(e.target, uploadModel, 'Uploaded').catch(()=>{}); });

  // Logs & Search
  $('#log-filter')?.addEventListener('input', () => setText('#logs-output', applyLogFilter(state.lastLogsText)));
  $('#logs-follow')?.addEventListener('change', syncLogsFollow);
  $('#global-search')?.addEventListener('input', syncGlobalSearch);

  // Global error handler
  window.addEventListener('unhandledrejection', e => toast(e.reason?.message || 'Unknown error', 'error'));

  // Boot
  boot();
});

const boot = async () => {
  try {
    state.user = await api('/me');
    $('#user-avatar').textContent = state.user.username?.[0]?.toUpperCase() || 'A';
    $('#user-pill').textContent = state.user.username;
    $('#user-role').textContent = state.user.is_admin ? 'Administrator' : 'User';
    $('#login-view')?.classList.add('hidden');
    $('#app-view')?.classList.remove('hidden');
    setActiveTab(state.tab || 'dashboard');
    loadUpdate(false).catch(()=>{});
    if (state.updateJobId && !state.updateTimer) { state.updateTimer = setInterval(pollUpdateJob, 2500); pollUpdateJob().catch(()=>{}); }
  } catch {
    $('#login-view')?.classList.remove('hidden');
    $('#app-view')?.classList.add('hidden');
  }
};

// Auto-refresh
setInterval(() => { if ($('#app-view') && !$('#app-view').classList.contains('hidden') && state.tab==='dashboard') loadSystem().catch(()=>{}); }, 8000);
setInterval(() => { if ($('#app-view') && !$('#app-view').classList.contains('hidden')) loadUpdate(false).catch(()=>{}); }, 300000);
setInterval(() => { if ($('#app-view') && !$('#app-view').classList.contains('hidden') && state.tab==='models') loadModels().catch(()=>{}); }, 5000);