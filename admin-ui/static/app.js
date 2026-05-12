const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const APP_BASE = window.location.pathname === "/ui" || window.location.pathname.startsWith("/ui/")
  ? "/ui"
  : "";

const state = {
  tab: "overview",
  me: null,
  updateJobId: null,
  updatePollTimer: null,
};

const subtitles = {
  overview: "Runtime state, services and quick controls.",
  tokens: "API keys, limits and usage counters.",
  users: "Admin panel accounts.",
  models: "Local models, downloads and uploads.",
  settings: "Prompt injection and llama.cpp runtime args.",
  clients: "Optional OpenAI-compatible client helpers.",
  updates: "GitHub version checks and one-click update.",
  logs: "Container logs.",
};

function apiPath(path) {
  return `${APP_BASE}/api${path}`;
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function errorText(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || JSON.stringify(error);
}

function toast(message, kind = "info", timeout = 6000) {
  const el = $("#toast");
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.classList.remove("hidden");
  if (timeout) {
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => el.classList.add("hidden"), timeout);
  }
}

function pageError(message) {
  const el = $("#page-alert");
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = isForm ? {} : { "Content-Type": "application/json" };
  const response = await fetch(apiPath(path), {
    credentials: "same-origin",
    headers: { ...headers, ...(options.headers || {}) },
    ...options,
  });

  const payload = await parseResponse(response);
  if (response.status === 401) {
    showLogin();
    throw new Error("Not authenticated");
  }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || payload?.raw || payload;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

async function runAction(button, task, successMessage) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.dataset.busy = "true";
    button.textContent = "Working...";
  }
  pageError("");
  try {
    const result = await task();
    if (successMessage) toast(successMessage, "good");
    return result;
  } catch (error) {
    const message = errorText(error);
    pageError(message);
    toast(message, "bad", 9000);
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      delete button.dataset.busy;
      button.textContent = label;
    }
  }
}

function renderEmpty(target, message) {
  $(target).innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function showCommandOutput(title, result) {
  const box = $("#command-output");
  const stdout = result?.stdout || "";
  const stderr = result?.stderr || "";
  const code = result?.returncode ?? "";
  box.textContent = `${title}\nreturncode: ${code}\n\n${stdout}${stderr}`;
  box.classList.remove("hidden");
}

function setActiveTab(tab) {
  state.tab = tab;
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${tab}`).classList.remove("hidden");
  $("#page-title").textContent = $(`.nav[data-tab="${tab}"]`)?.textContent.trim() || tab;
  $("#page-subtitle").textContent = subtitles[tab] || "";
  pageError("");
  loadCurrentTab();
}

async function loadCurrentTab() {
  try {
    if (state.tab === "overview") await loadSystem();
    if (state.tab === "tokens") await loadTokens();
    if (state.tab === "users") await loadUsers();
    if (state.tab === "models") await loadModels();
    if (state.tab === "settings") await loadSettings();
    if (state.tab === "clients") await loadClients();
    if (state.tab === "updates") await loadUpdate(true);
    if (state.tab === "logs") await loadLogs();
  } catch (error) {
    pageError(errorText(error));
  }
}

async function login() {
  $("#login-error").textContent = "";
  await api("/login", {
    method: "POST",
    body: JSON.stringify({
      username: $("#login-user").value.trim(),
      password: $("#login-pass").value,
    }),
  });
  await boot();
}

async function logout() {
  await api("/logout", { method: "POST" });
  state.me = null;
  showLogin();
}

async function boot() {
  try {
    state.me = await api("/me");
    $("#user-pill").textContent = state.me.username || "admin";
    showApp();
    setActiveTab(state.tab || "overview");
    loadUpdate(false).catch(() => {});
  } catch {
    showLogin();
  }
}

async function loadSystem() {
  const data = await api("/system");
  const host = data.host || {};
  const memory = host.memory || {};
  const disk = host.disk || {};
  const metrics = data.llama_metrics || {};

  $("#metric-cpu").textContent = `${Math.round(Number(host.cpu_percent || 0))}%`;
  $("#metric-ram").textContent = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;
  $("#metric-disk").textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`;
  $("#metric-speed").textContent = metrics.avg_prompt_tokens_per_second
    ? `${Number(metrics.avg_prompt_tokens_per_second).toFixed(1)} tok/s`
    : "-";

  const containers = data.containers || [];
  if (!containers.length) {
    renderEmpty("#containers-list", data.docker_error || "No containers found.");
    return;
  }

  $("#containers-list").innerHTML = containers.map((container) => {
    const running = container.status === "running";
    const stats = container.stats || {};
    return `
      <div class="list-row container-row">
        <div>
          <strong>${escapeHtml(container.name)}</strong>
          <small>${escapeHtml((container.image || []).join(", ") || "image")}</small>
        </div>
        <span class="status ${running ? "good" : "bad"}">${escapeHtml(container.status)}</span>
        <span>CPU ${escapeHtml(stats.cpu_percent ?? 0)}%</span>
        <span>${formatBytes(stats.memory_usage)}</span>
      </div>
    `;
  }).join("");
}

async function stackAction(action) {
  const result = await api(`/stack/${action}`, { method: "POST" });
  showCommandOutput(`docker compose ${action}`, result);
  if (["start", "restart", "stop", "down"].includes(action)) {
    window.setTimeout(() => loadSystem().catch(() => {}), 1500);
  }
  return result;
}

async function loadTokens() {
  const data = await api("/tokens");
  const tokens = data.tokens || [];
  if (!tokens.length) {
    renderEmpty("#tokens-list", "No tokens yet.");
    return;
  }

  $("#tokens-list").innerHTML = tokens.map((token) => `
    <div class="list-row token-row">
      <div>
        <strong>${escapeHtml(token.name || "token")}</strong>
        <code>${escapeHtml(token.key)}</code>
      </div>
      <span class="status ${token.enabled ? "good" : "bad"}">${token.enabled ? "enabled" : "disabled"}</span>
      <span>${escapeHtml(token.used_tokens ?? 0)} used</span>
      <span>${token.unlimited ? "unlimited" : `${escapeHtml(token.remaining_tokens ?? 0)} left`}</span>
      <div class="row-actions">
        <button class="secondary small" data-action="token-toggle" data-key="${escapeHtml(token.key)}" data-enabled="${token.enabled}">
          ${token.enabled ? "Disable" : "Enable"}
        </button>
        <button class="secondary small" data-action="token-reset" data-key="${escapeHtml(token.key)}">Reset</button>
        <button class="danger small" data-action="token-delete" data-key="${escapeHtml(token.key)}">Delete</button>
      </div>
    </div>
  `).join("");
}

async function createToken() {
  const unlimited = $("#token-unlimited").checked;
  const body = {
    name: $("#token-name").value.trim() || "token",
    unlimited,
  };
  if (!unlimited && $("#token-limit").value.trim()) {
    body.limit_tokens = Number($("#token-limit").value.trim());
  }
  await api("/tokens", { method: "POST", body: JSON.stringify(body) });
  $("#token-form").reset();
  $("#token-unlimited").checked = true;
  await loadTokens();
}

async function patchToken(key, body) {
  await api(`/tokens/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(body) });
  await loadTokens();
}

async function deleteToken(key) {
  if (!window.confirm("Delete this token?")) return;
  await api(`/tokens/${encodeURIComponent(key)}`, { method: "DELETE" });
  await loadTokens();
}

async function loadUsers() {
  const data = await api("/users");
  const users = data.users || [];
  if (!users.length) {
    renderEmpty("#users-list", "No users found.");
    return;
  }

  $("#users-list").innerHTML = users.map((user) => {
    const isMe = state.me && Number(state.me.id) === Number(user.id);
    return `
      <div class="list-row user-row">
        <div>
          <strong>${escapeHtml(user.username)}</strong>
          <small>${isMe ? "current session" : `id ${escapeHtml(user.id)}`}</small>
        </div>
        <span class="status ${user.enabled ? "good" : "bad"}">${user.enabled ? "enabled" : "disabled"}</span>
        <span>${user.is_admin ? "admin" : "user"}</span>
        <div class="row-actions">
          <button class="secondary small" data-action="user-toggle" data-id="${escapeHtml(user.id)}" data-enabled="${user.enabled}">
            ${user.enabled ? "Disable" : "Enable"}
          </button>
          <button class="secondary small" data-action="user-password" data-id="${escapeHtml(user.id)}">Password</button>
          <button class="danger small" data-action="user-delete" data-id="${escapeHtml(user.id)}" ${isMe ? "disabled" : ""}>Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

async function createUser() {
  await api("/users", {
    method: "POST",
    body: JSON.stringify({
      username: $("#new-user").value.trim(),
      password: $("#new-pass").value,
      is_admin: true,
    }),
  });
  $("#user-form").reset();
  await loadUsers();
}

async function patchUser(id, body) {
  await api(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  await loadUsers();
}

async function deleteUser(id) {
  if (!window.confirm("Delete this user?")) return;
  await api(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadUsers();
}

async function loadSettings() {
  const data = await api("/settings");
  $("#prompt").value = data.prompt || "";
  const llama = data.llama || {};
  for (const key of ["CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT"]) {
    $(`#${key}`).value = llama[key] || "";
  }
}

function settingsPayload() {
  const body = { ANTI_CONFIRM_SYSTEM_PROMPT: $("#prompt").value };
  for (const key of ["CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT"]) {
    body[key] = $(`#${key}`).value;
  }
  return body;
}

async function saveSettings(restart = false) {
  const result = await api("/settings", { method: "POST", body: JSON.stringify(settingsPayload()) });
  if (result.gateway_error) {
    throw new Error(`Saved to .env, but token-gateway did not accept prompt update: ${result.gateway_error}`);
  }
  if (restart) await stackAction("restart");
}

async function loadModels() {
  const data = await api("/models");
  const local = data.local || [];
  const catalog = data.catalog || [];

  if (!local.length) {
    renderEmpty("#models-local", "No .gguf files found in ./models.");
  } else {
    $("#models-local").innerHTML = local.map((model) => `
      <div class="list-row model-row">
        <div>
          <strong>${escapeHtml(model.name)}</strong>
          <code>${escapeHtml(model.path)}</code>
        </div>
        <span>${formatBytes(model.size)}</span>
        <span class="status ${model.path === data.current ? "good" : ""}">${model.path === data.current ? "current" : "available"}</span>
        <button class="secondary small" data-action="model-switch" data-path="${escapeHtml(model.path)}">Switch</button>
      </div>
    `).join("");
  }

  if (!catalog.length) {
    renderEmpty("#models-catalog", "Catalog is empty.");
  } else {
    $("#models-catalog").innerHTML = catalog.map((item) => `
      <div class="catalog-card">
        <strong>${escapeHtml(item.title || item.repo)}</strong>
        <p>${escapeHtml(item.description || item.recommended || "")}</p>
        <code>${escapeHtml(item.repo)} / ${escapeHtml(item.include)}</code>
        <button class="secondary small"
          data-action="catalog-download"
          data-repo="${escapeHtml(item.repo)}"
          data-include="${escapeHtml(item.include)}"
          data-dir="${escapeHtml(item.local_dir || "")}">
          Download
        </button>
      </div>
    `).join("");
  }

  await loadModelJobs(false);
}

async function switchModel(path) {
  await api("/models/switch", { method: "POST", body: JSON.stringify({ path, restart: true }) });
  await loadModels();
}

async function downloadModel(repo, include, localDir) {
  const result = await api("/models/download", {
    method: "POST",
    body: JSON.stringify({ repo, include: include || "*.gguf", local_dir: localDir || "" }),
  });
  toast(`Download queued: ${result.job_id}`, "good");
  await loadModelJobs(true);
}

async function uploadModel() {
  const file = $("#gguf-file").files[0];
  if (!file) throw new Error("Choose a .gguf file first.");
  const form = new FormData();
  form.append("file", file);
  await api("/models/upload", { method: "POST", body: form });
  $("#gguf-file").value = "";
  await loadModels();
}

async function loadModelJobs(show = true) {
  const data = await api("/models/jobs");
  const box = $("#jobs-output");
  box.textContent = JSON.stringify(data.jobs || {}, null, 2);
  box.classList.toggle("hidden", !show && Object.keys(data.jobs || {}).length === 0);
}

async function loadClients() {
  const data = await api("/clients");
  $("#clients-list").innerHTML = Object.entries(data).map(([name, client]) => {
    const external = Boolean(client.external);
    const statusClass = external || client.enabled ? "good" : "bad";
    const statusLabel = external ? "external" : (client.enabled ? "running" : "off");
    const composeLabel = external ? "no local proxy" : (client.defined ? "defined" : "missing in compose");
    const action = external
      ? `<span class="muted small">No action</span>`
      : `<button class="secondary small" data-action="client-enable" data-client="${escapeHtml(name)}" ${client.enabled ? "disabled" : ""}>
          ${client.enabled ? "Enabled" : "Enable"}
        </button>`;
    return `
      <div class="list-row client-row">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(client.hint || "")}</small>
        </div>
        <span class="status ${statusClass}">${statusLabel}</span>
        <span>${composeLabel}</span>
        ${action}
      </div>
    `;
  }).join("");
}

async function enableClient(client) {
  const result = await api(`/clients/${encodeURIComponent(client)}/enable`, { method: "POST" });
  showCommandOutput(`enable ${client}`, result.result || result);
  if (result.ok === false || (result.result && result.result.returncode !== 0)) {
    throw new Error((result.result?.stderr || result.result?.stdout || result.enable?.stderr || "Client command failed").trim());
  }
  await loadClients();
}

async function loadLogs() {
  const service = $("#log-service").value;
  const data = await api(`/logs/${encodeURIComponent(service)}?tail=300`);
  $("#logs-output").textContent = (data.stdout || "") + (data.stderr || "") || "No logs.";
}

function setUpdateState(kind, label) {
  const badge = $("#update-state");
  badge.className = `status ${kind || ""}`.trim();
  badge.textContent = label;
}

function renderUpdate(data) {
  $("#update-current").textContent = data.current_short || "-";
  $("#update-current-msg").textContent = data.current_message || "-";
  $("#update-latest").textContent = data.latest_short || "-";
  $("#update-latest-msg").textContent = data.latest_message || "-";
  $("#update-branch").textContent = data.branch || "-";
  $("#update-remote").textContent = data.remote || "-";
  $("#update-dot").classList.toggle("hidden", !data.has_update);

  const apply = $("#update-apply");
  apply.disabled = true;

  if (!data.configured) {
    setUpdateState("bad", "Git not configured");
    $("#update-title").textContent = "Updates are not available";
    $("#update-copy").textContent = data.error || "This folder is not a git repository.";
    return;
  }
  if (data.fetch_error) {
    setUpdateState("bad", "Check failed");
    $("#update-title").textContent = "Could not check GitHub";
    $("#update-copy").textContent = data.fetch_error;
    return;
  }
  if (data.dirty) {
    setUpdateState("bad", "Local changes");
    $("#update-title").textContent = "Update is blocked";
    $("#update-copy").textContent = "There are uncommitted local changes. Commit or stash them first.";
    return;
  }
  if (data.ahead > 0) {
    setUpdateState("warn", "Local branch ahead");
    $("#update-title").textContent = "Manual check required";
    $("#update-copy").textContent = "Local commits are not on origin; fast-forward update is not safe.";
    return;
  }
  if (data.has_update) {
    setUpdateState("warn", "Update available");
    $("#update-title").textContent = `New version: ${data.behind} commit(s)`;
    $("#update-copy").textContent = "Download the latest code from GitHub and rebuild the stack.";
    apply.disabled = !data.can_update;
    return;
  }
  setUpdateState("good", "Up to date");
  $("#update-title").textContent = "Installed version matches GitHub";
  $("#update-copy").textContent = "No update is available.";
}

async function loadUpdate(fetch = true) {
  const data = await api(`/update/status?fetch=${fetch ? "true" : "false"}`);
  renderUpdate(data);
}

function renderUpdateJob(job) {
  const box = $("#update-progress");
  box.classList.remove("hidden");
  box.textContent = JSON.stringify(job, null, 2);

  if (job.status === "done") {
    setUpdateState("good", "Done");
    $("#update-title").textContent = "Update completed";
    $("#update-copy").textContent = job.message || "Stack was updated and restarted.";
  } else if (job.status === "error") {
    setUpdateState("bad", "Failed");
    $("#update-title").textContent = "Update failed";
    $("#update-copy").textContent = job.error || "Check the update output.";
  } else {
    setUpdateState("warn", "Updating");
    $("#update-title").textContent = "Downloading and restarting";
    $("#update-copy").textContent = `Current step: ${job.step || "queued"}`;
  }
}

async function pollUpdateJob() {
  if (!state.updateJobId) return;
  const job = await api(`/update/jobs/${state.updateJobId}`);
  renderUpdateJob(job);
  if (["done", "error"].includes(job.status)) {
    window.clearInterval(state.updatePollTimer);
    state.updatePollTimer = null;
    state.updateJobId = null;
    await loadUpdate(false).catch(() => {});
  }
}

async function applyUpdate() {
  $("#update-progress").classList.remove("hidden");
  $("#update-progress").textContent = "Queued...";
  const result = await api("/update/apply", { method: "POST", body: "{}" });
  state.updateJobId = result.job_id;
  if (state.updatePollTimer) window.clearInterval(state.updatePollTimer);
  state.updatePollTimer = window.setInterval(() => pollUpdateJob().catch(() => {}), 2500);
  await pollUpdateJob();
}

function handleAction(button) {
  const action = button.dataset.action;
  const stackMap = {
    "stack-start": "start",
    "stack-stop": "stop",
    "stack-restart": "restart",
    "stack-down": "down",
    "stack-status": "status",
  };

  if (action === "refresh") return runAction(button, loadCurrentTab, "Refreshed");
  if (action === "logout") return runAction(button, logout);
  if (action === "load-system") return runAction(button, loadSystem, "Containers reloaded");
  if (action === "load-tokens") return runAction(button, loadTokens, "Tokens reloaded");
  if (action === "load-users") return runAction(button, loadUsers, "Users reloaded");
  if (action === "load-models") return runAction(button, loadModels, "Models reloaded");
  if (action === "load-clients") return runAction(button, loadClients, "Clients reloaded");
  if (action === "load-update") return runAction(button, () => loadUpdate(true), "Update status refreshed");
  if (action === "apply-update") return runAction(button, applyUpdate);
  if (action === "upload-model") return runAction(button, uploadModel, "Model uploaded");
  if (stackMap[action]) return runAction(button, () => stackAction(stackMap[action]), `Stack ${stackMap[action]} finished`);

  if (action === "token-toggle") {
    return runAction(button, () => patchToken(button.dataset.key, { enabled: button.dataset.enabled !== "true" }), "Token updated");
  }
  if (action === "token-reset") {
    return runAction(button, () => patchToken(button.dataset.key, { reset_usage: true }), "Token usage reset");
  }
  if (action === "token-delete") {
    return runAction(button, () => deleteToken(button.dataset.key), "Token deleted");
  }
  if (action === "user-toggle") {
    return runAction(button, () => patchUser(button.dataset.id, { enabled: button.dataset.enabled !== "true" }), "User updated");
  }
  if (action === "user-password") {
    const password = window.prompt("New password");
    if (!password) return undefined;
    return runAction(button, () => patchUser(button.dataset.id, { password }), "Password changed");
  }
  if (action === "user-delete") {
    return runAction(button, () => deleteUser(button.dataset.id), "User deleted");
  }
  if (action === "model-switch") {
    return runAction(button, () => switchModel(button.dataset.path), "Model switched");
  }
  if (action === "catalog-download") {
    return runAction(
      button,
      () => downloadModel(button.dataset.repo, button.dataset.include, button.dataset.dir),
      "Download started",
    );
  }
  if (action === "client-enable") {
    return runAction(button, () => enableClient(button.dataset.client), "Client command finished");
  }
  if (action === "save-settings-restart") {
    return runAction(button, () => saveSettings(true), "Settings saved");
  }
  return undefined;
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-tab]");
  if (nav) {
    event.preventDefault();
    setActiveTab(nav.dataset.tab);
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  handleAction(button)?.catch(() => {});
});

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runAction($("#login-form button[type='submit']"), login).catch((error) => {
    $("#login-error").textContent = errorText(error);
  });
});

$("#token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runAction($("#token-form button[type='submit']"), createToken, "Token created").catch(() => {});
});

$("#user-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runAction($("#user-form button[type='submit']"), createUser, "User created").catch(() => {});
});

$("#hf-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const repo = $("#hf-repo").value.trim();
  const include = $("#hf-include").value.trim() || "*.gguf";
  const localDir = $("#hf-dir").value.trim();
  runAction($("#hf-form button[type='submit']"), () => downloadModel(repo, include, localDir), "Download started").catch(() => {});
});

$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runAction($("#settings-form button[type='submit']"), () => saveSettings(false), "Settings saved").catch(() => {});
});

$("#logs-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runAction($("#logs-form button[type='submit']"), loadLogs, "Logs loaded").catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  pageError(errorText(event.reason));
});

window.setInterval(() => {
  if (!$("#app-view").classList.contains("hidden") && state.tab === "overview") {
    loadSystem().catch(() => {});
  }
}, 7000);

window.setInterval(() => {
  if (!$("#app-view").classList.contains("hidden")) {
    loadUpdate(false).catch(() => {});
  }
}, 300000);

window.setInterval(() => {
  if (!$("#app-view").classList.contains("hidden") && state.tab === "models") {
    loadModelJobs(false).catch(() => {});
  }
}, 5000);

boot();
