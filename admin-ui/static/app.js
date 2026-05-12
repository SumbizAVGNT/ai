const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const APP_BASE = window.location.pathname.startsWith("/ui") ? "/ui" : "";

let me = null;
let updateJobId = null;
let updatePollTimer = null;

function apiUrl(path) {
  return `${APP_BASE}/api${path}`;
}

async function api(path, opt = {}) {
  const r = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    ...opt,
  });
  if (r.status === 401) {
    showLogin();
    throw new Error("auth");
  }
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    const text = ct.includes("json") ? JSON.stringify(await r.json()) : await r.text();
    throw new Error(text || `HTTP ${r.status}`);
  }
  return ct.includes("json") ? await r.json() : await r.text();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function fmt(n) {
  if (n == null) return "-";
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return String(n);
}

function showLogin() {
  $("#login").classList.remove("hidden");
  $("#dash").classList.add("hidden");
}

function showDash() {
  $("#login").classList.add("hidden");
  $("#dash").classList.remove("hidden");
}

async function login() {
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
    await boot();
  } catch (e) {
    $("#login-error").textContent = "Не вошло: проверь логин и пароль";
  }
}

async function logout() {
  await api("/logout", { method: "POST" });
  showLogin();
}

async function boot() {
  try {
    me = await api("/me");
    $("#user-pill").textContent = me.username;
    showDash();
    await refreshAll();
    setTimeout(() => loadUpdate(true), 1000);
  } catch (e) {
    showLogin();
  }
}

$$(".nav").forEach((button) => {
  button.onclick = () => {
    $$(".nav").forEach((x) => x.classList.remove("active"));
    button.classList.add("active");
    $$(".tab").forEach((x) => x.classList.add("hidden"));
    $(`#tab-${button.dataset.tab}`).classList.remove("hidden");
    $("#title").textContent = button.textContent.trim();
    if (button.dataset.tab === "updates") loadUpdate(true);
  };
});

async function refreshAll() {
  await Promise.allSettled([
    loadSystem(),
    loadTokens(),
    loadUsers(),
    loadModels(),
    loadSettings(),
    loadClients(),
    loadUpdate(false),
  ]);
}

async function loadSystem() {
  const d = await api("/system");
  $("#cpu").textContent = `${d.host.cpu_percent || 0}%`;
  $("#ram").textContent = `${fmt(d.host.memory.used)} / ${fmt(d.host.memory.total)}`;
  $("#prompt-speed").textContent = (d.llama_metrics.avg_prompt_tokens_per_second || 0).toFixed(1);
  $("#eta").textContent = d.llama_metrics.estimated_seconds_for_last_prompt
    ? `${Math.round(d.llama_metrics.estimated_seconds_for_last_prompt)}s`
    : "-";
  $("#containers").innerHTML = (d.containers || []).map((c) => `
    <div class="row">
      <b>${esc(c.name)}</b>
      <span class="tag ${c.status === "running" ? "good" : "bad"}">${esc(c.status)}</span>
      <span>CPU ${esc(c.stats?.cpu_percent ?? 0)}%</span>
      <span>RAM ${fmt(c.stats?.memory_usage || 0)}</span>
      <span></span>
    </div>
  `).join("");
}

async function loadTokens() {
  const d = await api("/tokens");
  $("#tokens-list").innerHTML = (d.tokens || []).map((t) => `
    <div class="row">
      <b>${esc(t.name)}</b>
      <code>${esc(t.key)}</code>
      <span>used ${esc(t.used_tokens)}</span>
      <span>${t.unlimited ? "unlimited" : `${esc(t.remaining_tokens)} left`}</span>
      <button data-key="${esc(t.key)}" onclick="resetToken(this.dataset.key)">reset</button>
    </div>
  `).join("");
}

async function createToken() {
  const body = { name: $("#tok-name").value || "token", unlimited: $("#tok-unlimited").checked };
  if (!body.unlimited && $("#tok-limit").value) body.limit_tokens = Number($("#tok-limit").value);
  await api("/tokens", { method: "POST", body: JSON.stringify(body) });
  loadTokens();
}

async function resetToken(key) {
  await api(`/tokens/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ reset_usage: true }) });
  loadTokens();
}

async function loadUsers() {
  const d = await api("/users");
  $("#users-list").innerHTML = (d.users || []).map((u) => `
    <div class="row">
      <b>${esc(u.username)}</b>
      <span class="tag">${u.is_admin ? "admin" : "user"}</span>
      <span>${u.enabled ? "enabled" : "disabled"}</span>
      <span></span>
      <button onclick="disableUser(${Number(u.id)}, ${Boolean(u.enabled)})">${u.enabled ? "disable" : "enable"}</button>
    </div>
  `).join("");
}

async function createUser() {
  await api("/users", {
    method: "POST",
    body: JSON.stringify({ username: $("#new-user").value, password: $("#new-pass").value, is_admin: true }),
  });
  loadUsers();
}

async function disableUser(id, enabled) {
  await api(`/users/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) });
  loadUsers();
}

async function loadSettings() {
  const d = await api("/settings");
  $("#prompt").value = d.prompt || "";
  for (const k of ["CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT"]) {
    $(`#${k}`).value = d.llama[k] || "";
  }
}

async function saveSettings(restart = false) {
  const body = { ANTI_CONFIRM_SYSTEM_PROMPT: $("#prompt").value };
  for (const k of ["CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT"]) {
    body[k] = $(`#${k}`).value;
  }
  await api("/settings", { method: "POST", body: JSON.stringify(body) });
  if (restart) await stack("restart");
  alert("saved");
}

async function stack(action) {
  const r = await api(`/stack/${action}`, { method: "POST" });
  alert((r.stdout || "") + (r.stderr || ""));
  loadSystem();
}

async function loadModels() {
  const d = await api("/models");
  $("#models-local").innerHTML = (d.local || []).map((m) => `
    <div class="row">
      <b>${esc(m.name)}</b>
      <span>${fmt(m.size)}</span>
      <span>${m.path === d.current ? "current" : ""}</span>
      <span></span>
      <button data-path="${esc(m.path)}" onclick="switchModel(this.dataset.path)">switch</button>
    </div>
  `).join("");
}

async function switchModel(path) {
  await api("/models/switch", { method: "POST", body: JSON.stringify({ path, restart: true }) });
  loadModels();
}

async function downloadModel() {
  await api("/models/download", {
    method: "POST",
    body: JSON.stringify({
      repo: $("#hf-repo").value,
      include: $("#hf-include").value || "*.gguf",
      local_dir: $("#hf-dir").value,
    }),
  });
  setTimeout(loadJobs, 1000);
}

async function loadJobs() {
  if ($("#dash").classList.contains("hidden")) return;
  const d = await api("/models/jobs");
  $("#jobs").textContent = JSON.stringify(d.jobs, null, 2);
}

async function uploadModel(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(apiUrl("/models/upload"), { method: "POST", body: fd });
  alert(await r.text());
  loadModels();
}

async function loadClients() {
  const d = await api("/clients");
  $("#clients").innerHTML = Object.entries(d).map(([k, v]) => `
    <div class="client-card">
      <div class="client-main">
        <div class="client-title">
          <b>${esc(k)}</b>
          <span class="tag ${v.enabled ? "good" : "bad"}">${v.enabled ? "enabled" : "off"}</span>
        </div>
        <p>${esc(v.hint)}</p>
      </div>
      <button data-client="${esc(k)}" onclick="enableClient(this.dataset.client)" ${v.enabled ? "disabled" : ""}>
        ${v.enabled ? "enabled" : "enable"}
      </button>
    </div>
  `).join("");
}

async function enableClient(client) {
  const r = await api(`/clients/${client}/enable`, { method: "POST" });
  alert((r.result?.stdout || "") + (r.result?.stderr || ""));
  loadClients();
}

async function loadLogs() {
  const svc = $("#log-service").value;
  const d = await api(`/logs/${svc}?tail=250`);
  $("#logs").textContent = (d.stdout || "") + (d.stderr || "");
}

function setUpdateState(kind, label) {
  const badge = $("#update-state");
  badge.className = `status-badge ${kind || ""}`.trim();
  badge.textContent = label;
}

function renderUpdate(d) {
  const dot = $("#update-dot");
  const apply = $("#update-apply");
  apply.disabled = true;
  dot.classList.toggle("hidden", !d.has_update);

  $("#update-current").textContent = d.current_short || "-";
  $("#update-current-msg").textContent = d.current_message || "-";
  $("#update-latest").textContent = d.latest_short || "-";
  $("#update-latest-msg").textContent = d.latest_message || "-";
  $("#update-branch").textContent = d.branch || "-";
  $("#update-remote").textContent = d.remote || "-";

  if (!d.configured) {
    setUpdateState("bad", "Git не настроен");
    $("#update-title").textContent = "Обновления недоступны";
    $("#update-copy").textContent = d.error || "Папка стека не является git-репозиторием.";
  } else if (d.fetch_error) {
    setUpdateState("bad", "Ошибка проверки");
    $("#update-title").textContent = "Не удалось проверить GitHub";
    $("#update-copy").textContent = d.fetch_error;
  } else if (d.dirty) {
    setUpdateState("bad", "Есть локальные изменения");
    $("#update-title").textContent = "Обновление заблокировано";
    $("#update-copy").textContent = "В рабочей папке есть незакоммиченные изменения. Сохрани их перед обновлением.";
  } else if (d.ahead > 0) {
    setUpdateState("warn", "Локальная версия впереди");
    $("#update-title").textContent = "Нужна ручная проверка";
    $("#update-copy").textContent = "Локальная ветка содержит коммиты, которых нет на GitHub.";
  } else if (d.has_update) {
    setUpdateState("warn", "Доступно обновление");
    $("#update-title").textContent = `Новая версия готова: +${d.behind} commit`;
    $("#update-copy").textContent = "Можно скачать обновление с GitHub и пересобрать контейнеры автоматически.";
    apply.disabled = !d.can_update;
  } else {
    setUpdateState("good", "Актуально");
    $("#update-title").textContent = "Установлена свежая версия";
    $("#update-copy").textContent = "Локальный стек совпадает с GitHub.";
  }

  $("#update-mini").innerHTML = `
    <b>${esc($("#update-state").textContent)}</b><br>
    ${esc($("#update-title").textContent)}<br>
    <span>${esc(d.current_short || "-")} -> ${esc(d.latest_short || "-")}</span>
  `;
}

async function loadUpdate(fetch = true) {
  try {
    const d = await api(`/update/status?fetch=${fetch ? "true" : "false"}`);
    renderUpdate(d);
  } catch (e) {
    setUpdateState("bad", "Ошибка");
    $("#update-title").textContent = "Проверка не выполнена";
    $("#update-copy").textContent = e.message;
    $("#update-mini").textContent = "Проверка обновлений не выполнена.";
    $("#update-apply").disabled = true;
  }
}

function renderUpdateJob(job) {
  const box = $("#update-progress");
  box.classList.remove("hidden");
  const status = job.status || "running";
  const step = job.step || "queued";
  const error = job.error ? `<div class="error">${esc(job.error)}</div>` : "";
  const message = job.message ? `<div>${esc(job.message)}</div>` : "";
  box.innerHTML = `
    <div class="progress-step"><b>Status</b><span>${esc(status)}</span></div>
    <div class="progress-step"><b>Step</b><span>${esc(step)}</span></div>
    ${message}
    ${error}
  `;
  if (status === "done") {
    setUpdateState("good", "Готово");
    $("#update-title").textContent = "Обновление установлено";
    $("#update-copy").textContent = "Контейнеры пересобираются или уже перезапущены.";
  } else if (status === "error") {
    setUpdateState("bad", "Ошибка");
    $("#update-title").textContent = "Обновление не завершилось";
    $("#update-copy").textContent = job.error || "Проверь лог обновления.";
  } else {
    setUpdateState("warn", "Обновляется");
    $("#update-title").textContent = "Скачиваю обновление и перезапускаю стек";
    $("#update-copy").textContent = "Админка может на короткое время пропасть, пока контейнер пересобирается.";
  }
}

async function pollUpdateJob() {
  if (!updateJobId) return;
  try {
    const job = await api(`/update/jobs/${updateJobId}`);
    renderUpdateJob(job);
    if (["done", "error"].includes(job.status)) {
      clearInterval(updatePollTimer);
      updatePollTimer = null;
      updateJobId = null;
      $("#update-apply").disabled = true;
      setTimeout(() => loadUpdate(false), 2500);
    }
  } catch (e) {
    $("#update-progress").classList.remove("hidden");
    $("#update-progress").innerHTML = `
      <div class="progress-step"><b>Status</b><span>waiting</span></div>
      <div class="muted">Админка может перезапускаться. Проверка продолжится автоматически.</div>
    `;
  }
}

async function applyUpdate() {
  $("#update-apply").disabled = true;
  $("#update-progress").classList.remove("hidden");
  $("#update-progress").innerHTML = '<div class="progress-step"><b>Status</b><span>queued</span></div>';
  const result = await api("/update/apply", { method: "POST", body: "{}" });
  updateJobId = result.job_id;
  if (updatePollTimer) clearInterval(updatePollTimer);
  updatePollTimer = setInterval(pollUpdateJob, 2500);
  await pollUpdateJob();
}

setInterval(loadJobs, 5000);
setInterval(() => {
  if (!$("#dash").classList.contains("hidden")) loadSystem();
}, 5000);
setInterval(() => {
  if (!$("#dash").classList.contains("hidden")) loadUpdate(true);
}, 300000);

boot();
