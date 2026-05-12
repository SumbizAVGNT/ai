#!/usr/bin/env python3
import json, os, secrets, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "config" / "models.catalog.json"
STATE_FILE = ROOT / ".installer-state.json"


def run(cmd, check=True, env=None):
    print("+ " + " ".join(map(str, cmd)))
    return subprocess.run(list(map(str, cmd)), cwd=str(ROOT), check=check, env=env)


def run_capture(cmd, env=None):
    return subprocess.run(list(map(str, cmd)), cwd=str(ROOT), text=True, capture_output=True, env=env)


def compose_env():
    env = os.environ.copy()
    env.setdefault("COMPOSE_PARALLEL_LIMIT", "1")
    return env


def retry_docker_compose(args, attempts=3):
    env = compose_env()
    cmd = ["docker", "compose"] + args
    result = None

    for attempt in range(1, attempts + 1):
        if attempts > 1:
            print(f"\nDocker compose attempt {attempt}/{attempts}: docker compose {' '.join(map(str, args))}")
        result = run(cmd, check=False, env=env)
        if result.returncode == 0:
            return result
        if attempt < attempts:
            print("Docker compose failed. Waiting 15 seconds before retry...")
            time.sleep(15)

    return result


def compose_services():
    result = run_capture(["docker", "compose", "config", "--services"], env=compose_env())
    if result.returncode != 0:
        print(result.stderr.strip())
        raise RuntimeError("Could not read docker compose services")
    available = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    preferred = ["postgres", "llama-server-coder", "token-gateway", "admin-ui", "nginx"]
    return [service for service in preferred if service in available]


def container_names_for_service(service):
    return {
        "postgres": ["local-ai-postgres", "postgres"],
        "llama-server-coder": ["llama-server-coder"],
        "token-gateway": ["token-gateway"],
        "admin-ui": ["admin-ui"],
        "nginx": ["local-ai-nginx", "nginx"],
        "certbot": ["local-ai-certbot", "certbot"],
        "opencode-server": ["opencode-server"],
        "codex-runner": ["codex-runner"],
        "claude-code-proxy": ["claude-code-proxy"],
    }.get(service, [])


def remove_conflicting_container(service):
    for name in container_names_for_service(service):
        result = run_capture(["docker", "ps", "-aq", "--filter", f"name=^/{name}$"])
        for container_id in [line.strip() for line in result.stdout.splitlines() if line.strip()]:
            print(f"Removing existing stack container {name} ({container_id}) before starting {service}...")
            run(["docker", "rm", "-f", container_id], check=False)


def docker_compose_up(args, attempts=3):
    if not args or args[0] != "up":
        return retry_docker_compose(args, attempts=attempts)

    requested = [arg for arg in args[1:] if not str(arg).startswith("-")]
    services = requested or compose_services()
    force_recreate = "--force-recreate" in args
    result = None

    retry_docker_compose(["stop", "nginx"], attempts=1)
    print(f"Starting services one by one (COMPOSE_PARALLEL_LIMIT={compose_env()['COMPOSE_PARALLEL_LIMIT']})")
    for service in services:
        print(f"\n== Pull {service} ==")
        result = retry_docker_compose(["pull", "--ignore-buildable", service], attempts=attempts)
        if result.returncode != 0:
            return result

    for service in services:
        print(f"\n== Build {service} ==")
        result = retry_docker_compose(["build", service], attempts=attempts)
        if result.returncode != 0:
            return result

    for service in services:
        print(f"\n== Up {service} ==")
        remove_conflicting_container(service)
        up_args = ["up", "-d", "--no-build"]
        if force_recreate:
            up_args.append("--force-recreate")
        up_args.append(service)
        result = retry_docker_compose(up_args, attempts=attempts)
        if result.returncode != 0:
            return result

    return result


def explain_compose_failure(result):
    print("\nDocker compose did not finish successfully.")
    print("Чаще всего это временная ошибка сети при скачивании Docker images.")
    print("Сгенерированные файлы уже сохранены: .env, admin_login.txt, docker-compose.yml.")
    print("Попробуй позже запустить: ./install.sh start")
    print("Если снова будет TLS handshake timeout, проверь сеть/DNS до Docker Hub и ghcr.io.")
    print(f"Return code: {result.returncode}")


def check_admin_panel():
    print("\nChecking admin-ui...")
    wait_seconds = int(os.getenv("ADMIN_WAIT_SECONDS", "90"))
    elapsed = 0
    last_error = ""
    while elapsed < wait_seconds:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8088/ui/", timeout=5) as resp:
                if 200 <= resp.status < 400:
                    print("admin-ui ok: http://127.0.0.1:8088/ui/")
                    return True
        except Exception as exc:
            last_error = str(exc)
        time.sleep(3)
        elapsed += 3
        print(f"admin-ui not ready yet ({elapsed}s/{wait_seconds}s)...")

    print(f"admin-ui is not responding: {last_error}")

    print("This is what causes nginx 502 Bad Gateway.")
    print("+ docker compose ps")
    subprocess.run(["docker", "compose", "ps"], cwd=str(ROOT), check=False)
    print("\nRecent admin-ui logs:")
    subprocess.run(["docker", "compose", "logs", "--tail=80", "admin-ui"], cwd=str(ROOT), check=False)
    print("\nRecent nginx logs:")
    subprocess.run(["docker", "compose", "logs", "--tail=80", "nginx"], cwd=str(ROOT), check=False)
    return False


def load_state():
    if not STATE_FILE.exists():
        return {"version": 1, "completed": False, "step": "start", "values": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state is not an object")
        data.setdefault("version", 1)
        data.setdefault("completed", False)
        data.setdefault("step", "start")
        data.setdefault("values", {})
        data.pop("_resume", None)
        if not isinstance(data["values"], dict):
            data["values"] = {}
        return data
    except Exception as exc:
        print(f"Не удалось прочитать {STATE_FILE.name}: {exc}")
        return {"version": 1, "completed": False, "step": "start", "values": {}}


def save_state(state):
    state["updated_at"] = int(time.time())
    saved = {k: v for k, v in state.items() if not k.startswith("_")}
    STATE_FILE.write_text(json.dumps(saved, indent=2, ensure_ascii=False), encoding="utf-8")


def mark_step(state, step, **values):
    state["step"] = step
    state.setdefault("values", {}).update(values)
    save_state(state)


def clear_state():
    try:
        STATE_FILE.unlink()
    except FileNotFoundError:
        pass


def state_value(state, key, prompt=None):
    vals = state.setdefault("values", {})
    if state.get("_resume") and key in vals and vals[key] not in (None, ""):
        if prompt:
            print(f"{prompt}: {vals[key]} (saved)")
        return vals[key]
    return None


def ask_state(state, key, prompt, default=""):
    saved = state_value(state, key, prompt)
    if saved is not None:
        return str(saved)
    val = ask(prompt, default)
    mark_step(state, key, **{key: val})
    return val


def yes_state(state, key, prompt, default=True):
    saved = state_value(state, key, prompt)
    if saved is not None:
        return bool(saved)
    val = yes(prompt, default)
    mark_step(state, key, **{key: val})
    return val


def choose_state(state, key, prompt, options, default):
    saved = state_value(state, key, prompt)
    allowed = {k for k, _ in options}
    if saved in allowed:
        return saved
    val = choose(prompt, options, default)
    mark_step(state, key, **{key: val})
    return val


def parse_env_file():
    env = {}
    path = ROOT / ".env"
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        env[key.strip()] = value
    return env


def existing_install_ready():
    env = parse_env_file()
    model_path = env.get("MODEL_PATH", "")
    model_file = None
    if model_path.startswith("/models/"):
        model_file = ROOT / "models" / model_path.removeprefix("/models/")
    elif model_path:
        model_file = Path(model_path)
        if not model_file.is_absolute():
            model_file = ROOT / model_file
    ready = bool(model_file and model_file.is_file() and (ROOT / "docker-compose.yml").exists())
    if env.get("MODEL_PATH") and not ready:
        print(f"Найдена .env, но файл модели не найден: {model_path}")
    return ready, env


def print_saved_admin_credentials(env):
    login_file = ROOT / "admin_login.txt"
    if login_file.exists():
        print("\n" + login_file.read_text(encoding="utf-8").strip())
        return
    print_admin_credentials(
        env.get("DOMAIN", ""),
        env.get("ADMIN_WEB_USERNAME", "admin"),
        env.get("ADMIN_WEB_PASSWORD", ""),
        env.get("DEFAULT_TOKEN", ""),
        env.get("ADMIN_KEY", ""),
    )


def start_existing_install(env):
    result = docker_compose_up(["up","-d","--build"])
    if result.returncode != 0:
        explain_compose_failure(result)
    else:
        check_admin_panel()
    print_saved_admin_credentials(env)


def ask(prompt, default=""):
    suffix = f" [{default}]" if default not in (None, "") else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val if val else (default or "")


def yes(prompt, default=True):
    d = "Y/n" if default else "y/N"
    v = input(f"{prompt} [{d}]: ").strip().lower()
    if not v: return default
    return v in {"y","yes","д","да"}


def choose(prompt, options, default):
    print("\n" + prompt)
    aliases = {}
    for i, (k, label) in enumerate(options, 1):
        hint = f" / {k}" if str(k) != str(i) else ""
        print(f"  {i}) {label}{hint}")
        aliases[str(i)] = k
        aliases[k] = k
    while True:
        v = ask("Выбор", default)
        if v in aliases: return aliases[v]
        print("Неверный выбор")


def ensure_dirs():
    for p in ["data","nginx","models","projects","postgres","certbot/www","certbot/conf","backups","opencode-config"]:
        (ROOT / p).mkdir(parents=True, exist_ok=True)


def load_catalog():
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def venv_paths():
    venv = ROOT / ".installer-venv"
    if os.name == "nt":
        return venv, venv / "Scripts" / "python.exe", venv / "Scripts"
    return venv, venv / "bin" / "python", venv / "bin"


def local_hf_command():
    _, _, bin_dir = venv_paths()
    for name in ("hf", "hf.exe", "huggingface-cli", "huggingface-cli.exe"):
        path = bin_dir / name
        if path.exists():
            return [str(path)]
    return None


def ensure_hf():
    for name in ("hf", "huggingface-cli"):
        found = shutil.which(name)
        if found:
            return [found]

    local = local_hf_command()
    if local:
        return local

    if not yes("hf CLI не найден. Установить в локальный .installer-venv?", True):
        return None

    venv, python_path, _ = venv_paths()
    if not python_path.exists():
        try:
            run([sys.executable, "-m", "venv", venv])
        except subprocess.CalledProcessError:
            print("\nНе удалось создать Python venv.")
            print("На Debian/Ubuntu установи: apt install -y python3-venv python3-pip")
            raise

    run([python_path, "-m", "pip", "install", "-U", "pip", "huggingface_hub[cli]"])
    return local_hf_command()


def clear_hf_locks(dest: Path):
    locks = sorted(dest.rglob("*.lock")) if dest.exists() else []
    if not locks:
        return

    print("\nНайдены lock-файлы HuggingFace в папке модели:")
    now = time.time()
    for lock in locks:
        try:
            age = int(now - lock.stat().st_mtime)
            shown = lock.relative_to(ROOT)
            print(f"  - {shown} ({age}s old)")
        except (OSError, ValueError):
            print(f"  - {lock}")

    print("Если прямо сейчас запущена другая загрузка этой же модели, ответь n.")
    if not yes("Удалить эти lock-файлы и продолжить?", True):
        raise RuntimeError("HF download lock exists; stop the other download or remove stale .lock files")

    for lock in locks:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass
    print("Lock-файлы удалены.")


def download_model(item):
    hf = ensure_hf()
    if not hf: raise RuntimeError("hf CLI missing")
    dest = ROOT / "models" / item["local_dir"]
    dest.mkdir(parents=True, exist_ok=True)
    existing = sorted((p for p in dest.rglob("*.gguf") if p.stat().st_size > 0), key=lambda p:p.stat().st_size, reverse=True)
    if existing:
        print(f"Модель уже есть: {existing[0]}")
        return existing[0]
    clear_hf_locks(dest)
    run(hf + ["download",item["repo"],"--include",item["include"],"--local-dir",dest])
    files = sorted(dest.rglob("*.gguf"), key=lambda p:p.stat().st_size, reverse=True)
    if not files: raise RuntimeError("GGUF not found after download")
    return files[0]


def docker_model_path(path: Path):
    try:
        rel = path.resolve().relative_to((ROOT/"models").resolve())
    except ValueError:
        raise RuntimeError(f"GGUF file must be inside {ROOT/'models'}: {path}") from None
    return "/models/" + str(rel).replace(os.sep,"/")


def write_env(vals):
    lines=[]
    for k,v in vals.items():
        if v is None: continue
        lines.append(f'{k}="{str(v).replace(chr(34), chr(92)+chr(34))}"')
    (ROOT/".env").write_text("\n".join(lines)+"\n", encoding="utf-8")


def gpu_yaml(mode):
    if mode == "cuda": return "    gpus: all\n"
    if mode in {"rocm","vulkan"}: return "    devices:\n      - /dev/dri:/dev/dri\n      - /dev/kfd:/dev/kfd\n    group_add:\n      - video\n"
    return ""


def postgres_yaml(local: bool):
    if not local: return ""
    return '''
  postgres:
    image: postgres:16-alpine
    container_name: local-ai-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: "${POSTGRES_DB:-localai}"
      POSTGRES_USER: "${POSTGRES_USER:-localai}"
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
    volumes:
      - ./postgres:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
'''


def client_yaml(clients):
    parts=[]
    if "claude" in clients:
        parts.append('''
  claude-code-proxy:
    build:
      context: ./claude-code-proxy
    container_name: claude-code-proxy
    profiles: ["claude"]
    restart: unless-stopped
    depends_on:
      - token-gateway
    environment:
      OPENAI_BASE_URL: "http://token-gateway:9000/v1"
      OPENAI_API_KEY: "${DEFAULT_TOKEN}"
      MODEL_NAME: "${MODEL_ID}"
      REQUEST_TIMEOUT: "${REQUEST_TIMEOUT:-1200}"
      DISABLE_TOOLS: "true"
    ports:
      - "127.0.0.1:8082:8082"
''')
    if "opencode" in clients:
        parts.append('''
  opencode-server:
    build:
      context: ./clients/opencode-server
    container_name: opencode-server
    profiles: ["tools"]
    restart: unless-stopped
    depends_on:
      - nginx
    working_dir: /workspace
    volumes:
      - ./projects:/workspace
      - ./opencode-config:/root/.config/opencode
    environment:
      OPENCODE_SERVER_USERNAME: "opencode"
      OPENCODE_SERVER_PASSWORD: "opencode"
      OPENCODE_CONFIG_DIR: "/root/.config/opencode"
    ports:
      - "127.0.0.1:4096:4096"
    command: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
''')
    if "codex" in clients:
        parts.append('''
  codex-runner:
    build:
      context: ./clients/codex-runner
    container_name: codex-runner
    profiles: ["tools"]
    working_dir: /workspace
    volumes:
      - ./projects:/workspace
    environment:
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
    stdin_open: true
    tty: true
''')
    return "".join(parts)


def compose(vals, clients, local_pg):
    pg = postgres_yaml(local_pg)
    admin_dep = "      - postgres\n" if local_pg else ""
    return f'''services:{pg}
  llama-server-coder:
    image: ${{LLAMA_IMAGE}}
    container_name: llama-server-coder
    restart: unless-stopped
    ports:
      - "127.0.0.1:8081:8081"
    volumes:
      - ./models:/models:ro
{gpu_yaml(vals['BACKEND'])}    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8081/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 120s
    command:
      - "-m"
      - "${{MODEL_PATH}}"
      - "--host"
      - "0.0.0.0"
      - "--port"
      - "8081"
      - "-c"
      - "${{CTX_SIZE:-32768}}"
      - "-t"
      - "${{THREADS:-16}}"
      - "--jinja"
      - "-np"
      - "${{PARALLEL_SLOTS:-1}}"
      - "--timeout"
      - "${{LLAMA_TIMEOUT:-1200}}"
      - "--n-gpu-layers"
      - "${{N_GPU_LAYERS:-0}}"

  token-gateway:
    build:
      context: ./token-gateway
    container_name: token-gateway
    restart: unless-stopped
    depends_on:
      - llama-server-coder
    volumes:
      - ./data:/data
    environment:
      TOKENS_FILE: "/data/tokens.json"
      UPSTREAM: "http://llama-server-coder:8081"
      UPSTREAM_API_KEY: "sk-dummy"
      ADMIN_KEY: "${{ADMIN_KEY}}"
      REQUEST_TIMEOUT: "${{REQUEST_TIMEOUT:-1200}}"
      ANTI_CONFIRM_SYSTEM_PROMPT: "${{ANTI_CONFIRM_SYSTEM_PROMPT}}"
    ports:
      - "127.0.0.1:9000:9000"

  admin-ui:
    build:
      context: ./admin-ui
    container_name: admin-ui
    restart: unless-stopped
    depends_on:
      - token-gateway
{admin_dep}    volumes:
      - ./:/stack
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      STACK_DIR: "/stack"
      DATABASE_URL: "${{DATABASE_URL}}"
      ADMIN_WEB_SECRET: "${{ADMIN_WEB_SECRET}}"
      ADMIN_WEB_USERNAME: "${{ADMIN_WEB_USERNAME}}"
      ADMIN_WEB_PASSWORD: "${{ADMIN_WEB_PASSWORD}}"
      ADMIN_KEY: "${{ADMIN_KEY}}"
      TOKEN_GATEWAY_URL: "http://token-gateway:9000"
      DOMAIN: "${{DOMAIN}}"
    ports:
      - "127.0.0.1:8088:8080"

  nginx:
    image: nginx:1.27-alpine
    container_name: local-ai-nginx
    restart: unless-stopped
    depends_on:
      - token-gateway
      - admin-ui
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certbot/www:/var/www/certbot:ro
      - ./certbot/conf:/etc/letsencrypt:ro

  certbot:
    image: certbot/certbot:latest
    container_name: local-ai-certbot
    volumes:
      - ./certbot/www:/var/www/certbot
      - ./certbot/conf:/etc/letsencrypt
{client_yaml(clients)}'''


def nginx_conf(domain, ssl):
    sn = domain or "_"
    locations = '''
    location = / { return 302 /ui/; }

    location /health {
        default_type application/json;
        return 200 '{"ok":true}';
    }

    location = /ui { return 302 /ui/; }
    location /ui/api/ { proxy_pass http://admin-ui:8080/api/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 1200s; client_max_body_size 20g; }
    location /ui/static/ { proxy_pass http://admin-ui:8080/static/; proxy_http_version 1.1; proxy_set_header Host $host; }
    location /ui/ { proxy_pass http://admin-ui:8080/ui/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
    location /login { proxy_pass http://admin-ui:8080/login; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
    location /logout { proxy_pass http://admin-ui:8080/logout; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
    location /api/ { proxy_pass http://admin-ui:8080/api/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 1200s; client_max_body_size 20g; }
    location /static/ { proxy_pass http://admin-ui:8080/static/; proxy_http_version 1.1; proxy_set_header Host $host; }

    location /admin/ { proxy_pass http://token-gateway:9000/admin/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 1200s; }
    location /v1/ { proxy_pass http://token-gateway:9000/v1/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_connect_timeout 1200s; proxy_send_timeout 1200s; proxy_read_timeout 1200s; send_timeout 1200s; client_max_body_size 20g; }
'''
    if not ssl:
        return f'''server {{
    listen 80;
    server_name {sn};
    location /.well-known/acme-challenge/ {{ root /var/www/certbot; }}
{locations}
}}
'''
    return f'''server {{
    listen 80;
    server_name {sn};
    location /.well-known/acme-challenge/ {{ root /var/www/certbot; }}
    location / {{ return 301 https://$host$request_uri; }}
}}
server {{
    listen 443 ssl;
    server_name {sn};
    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;
{locations}
}}
'''


def write_tokens(token, admin_key):
    tokens_file = ROOT/"data"/"tokens.json"
    data = {"tokens": []}
    if tokens_file.exists():
        try:
            data = json.loads(tokens_file.read_text(encoding="utf-8"))
        except Exception:
            data = {"tokens": []}
    tokens = data.setdefault("tokens", [])
    if not any(isinstance(t, dict) and t.get("key") == token for t in tokens):
        tokens.append({"key":token,"name":"default","enabled":True,"unlimited":True,"limit_tokens":None,"used_tokens":0})
    (ROOT/"data"/"tokens.json").write_text(json.dumps(data,indent=2,ensure_ascii=False), encoding="utf-8")
    (ROOT/"admin_key.txt").write_text(admin_key+"\n", encoding="utf-8")


def write_opencode(vals, base_url):
    cfg={"$schema":"https://opencode.ai/config.json","model":f"local-qwen/{vals['MODEL_ID']}","small_model":f"local-qwen/{vals['MODEL_ID']}","provider":{"local-qwen":{"npm":"@ai-sdk/openai-compatible","name":"Local Qwen","options":{"baseURL":base_url,"apiKey":vals['DEFAULT_TOKEN']},"models":{vals['MODEL_ID']:{"name":vals['MODEL_ID'],"limit":{"context":int(vals['CTX_SIZE']),"output":4096}}}}},"permission":{"bash":"ask","edit":"ask","write":"ask"}}
    (ROOT/"opencode-config").mkdir(exist_ok=True)
    (ROOT/"opencode-config"/"opencode.json").write_text(json.dumps(cfg,indent=2,ensure_ascii=False), encoding="utf-8")


def print_admin_credentials(domain, web_user, web_pass, default_token, admin_key):
    url = f"https://{domain}/ui/" if domain else "http://127.0.0.1/ui/"
    print("\nAdmin panel credentials")
    print(f"URL: {url}")
    print(f"login: {web_user}")
    print(f"password: {web_pass}")
    print(f"API token: {default_token}")
    print(f"Admin key: {admin_key}")
    print("Saved to admin_login.txt")


def choose_model(catalog, state=None):
    if state is not None:
        saved = state_value(state, "model_choice", "Выбор модели")
        if saved in {"c", "e"} or (str(saved).isdigit() and 1 <= int(saved) <= len(catalog)):
            return str(saved)
    while True:
        ch = ask("Выбор модели","2")
        if ch in {"c", "e"}:
            if state is not None:
                mark_step(state, "model_choice", model_choice=ch)
            return ch
        if ch.isdigit() and 1 <= int(ch) <= len(catalog):
            if state is not None:
                mark_step(state, "model_choice", model_choice=ch)
            return ch
        print("Неверный выбор")


def main():
    ensure_dirs(); print("=== Local AI Stack installer ===")
    state = load_state()
    ready, existing_env = existing_install_ready()

    if state.get("values") and not state.get("completed"):
        print(f"\nНайдена незавершённая установка, последний шаг: {state.get('step', 'unknown')}")
        if yes("Продолжить с сохранённых ответов?", True):
            state["_resume"] = True
        else:
            clear_state()
            state = {"version": 1, "completed": False, "step": "start", "values": {}}
    elif ready:
        print("\nНайдена готовая конфигурация (.env + docker-compose.yml).")
        if yes("Запустить docker compose без повторной настройки?", True):
            start_existing_install(existing_env)
            return
        clear_state()
        state = {"version": 1, "completed": False, "step": "start", "values": {}}

    mark_step(state, "dirs-ready")

    backend = choose_state(state, "backend", "Backend llama.cpp", [("cpu","CPU"),("cuda","NVIDIA CUDA"),("rocm","AMD ROCm"),("vulkan","Vulkan/Hybrid")], "cpu")
    image = {"cpu":"ghcr.io/ggml-org/llama.cpp:server","cuda":"ghcr.io/ggml-org/llama.cpp:server-cuda","rocm":"ghcr.io/ggml-org/llama.cpp:server-rocm","vulkan":"ghcr.io/ggml-org/llama.cpp:server-vulkan"}[backend]
    ngl = "0" if backend == "cpu" else "999"
    if backend != "cpu" and yes_state(state, "gpu_hybrid", "CPU+GPU hybrid вместо полной выгрузки?", False):
        ngl=ask_state(state, "n_gpu_layers", "N_GPU_LAYERS", "35")
    mark_step(state, "backend-ready", backend=backend, image=image, n_gpu_layers=ngl)

    print("\nМодели:")
    catalog=load_catalog()
    for i,it in enumerate(catalog,1): print(f"  {i}) {it['title']} ({it.get('recommended','')})")
    print("  c) Custom HF repo/include\n  e) Existing .gguf inside ./models")

    saved_model = state_value(state, "model_abs_path", "Модель")
    if saved_model and Path(saved_model).exists():
        model = Path(saved_model)
        ctx = str(state.setdefault("values", {}).get("ctx_size", "32768"))
    else:
        ch=choose_model(catalog, state); ctx="32768"
        if ch=="c":
            item={"repo":ask_state(state, "hf_repo", "HF repo","Qwen/Qwen2.5-Coder-14B-Instruct-GGUF"),"include":ask_state(state, "hf_include", "include","qwen2.5-coder-14b-instruct-q4_k_m.gguf"),"local_dir":ask_state(state, "hf_local_dir", "local dir","custom_model")}
            if yes_state(state, "download_model_now", "Скачать сейчас?", True):
                model=download_model(item)
            else:
                model=Path(ask_state(state, "model_source_path", "Путь к GGUF"))
        elif ch=="e":
            model=Path(ask_state(state, "model_source_path", "Путь к GGUF внутри ./models"))
        else:
            item=catalog[int(ch)-1]; ctx=str(item.get("ctx",32768))
            mark_step(state, "model-selected", ctx_size=ctx)
            if yes_state(state, "download_model_now", "Скачать выбранную модель сейчас?", True):
                model=download_model(item)
            else:
                model=Path(ask_state(state, "model_source_path", "Путь к GGUF"))

    if not model.is_absolute(): model=(ROOT/model).resolve()
    if not model.is_file() or model.suffix.lower() != ".gguf":
        raise RuntimeError(f"GGUF file not found: {model}")
    model_path=docker_model_path(model); model_id=model.name
    mark_step(state, "model-ready", model_abs_path=str(model), model_path=model_path, model_id=model_id, ctx_size=ctx)

    domain=ask_state(state, "domain", "Домен для nginx", "")
    email=""; ssl=False
    if domain:
        email=ask_state(state, "email", "Email Let's Encrypt", f"admin@{domain}")
        ssl=yes_state(state, "ssl", "Выпустить SSL автоматически?", True)
    mark_step(state, "domain-ready", domain=domain, email=email, ssl=ssl)

    dbmode=choose_state(state, "dbmode", "Postgres", [("local","Создать postgres контейнер"),("external","Подключиться к существующей БД")], "local")
    vals_state = state.setdefault("values", {})
    pgpass=vals_state.get("postgres_password") or secrets.token_urlsafe(24)
    db_url = f"postgresql+psycopg://localai:{pgpass}@postgres:5432/localai" if dbmode=="local" else ask_state(state, "database_url", "DATABASE_URL", "postgresql+psycopg://user:pass@host:5432/db")
    mark_step(state, "postgres-ready", dbmode=dbmode, postgres_password=pgpass, database_url=db_url)

    cchoice=choose_state(state, "clients_choice", "Клиенты", [("opencode","OpenCode"),("claude","Claude Code proxy"),("codex","Codex"),("all","Все"),("none","Ничего")], "opencode")
    clients={"opencode","claude","codex"} if cchoice=="all" else ({cchoice} if cchoice!="none" else set())
    mark_step(state, "clients-ready", clients_choice=cchoice, clients=sorted(clients))

    admin_key=vals_state.get("admin_key") or secrets.token_hex(32)
    default_token=vals_state.get("default_token") or "sk-"+secrets.token_urlsafe(32)
    web_secret=vals_state.get("web_secret") or secrets.token_urlsafe(48)
    mark_step(state, "secrets-ready", admin_key=admin_key, default_token=default_token, web_secret=web_secret)
    web_user=ask_state(state, "web_user", "Admin UI login", "admin")
    web_pass=ask_state(state, "web_pass", "Admin UI password", vals_state.get("web_pass") or secrets.token_urlsafe(12))
    vals={"BACKEND":backend,"LLAMA_IMAGE":image,"MODEL_PATH":model_path,"MODEL_ID":model_id,"CTX_SIZE":ctx,"THREADS":"","PARALLEL_SLOTS":"","LLAMA_TIMEOUT":"1200","REQUEST_TIMEOUT":"1200","N_GPU_LAYERS":ngl,"ADMIN_KEY":admin_key,"DEFAULT_TOKEN":default_token,"DOMAIN":domain,"DATABASE_URL":db_url,"POSTGRES_DB":"localai","POSTGRES_USER":"localai","POSTGRES_PASSWORD":pgpass,"ADMIN_WEB_SECRET":web_secret,"ADMIN_WEB_USERNAME":web_user,"ADMIN_WEB_PASSWORD":web_pass,"ANTI_CONFIRM_SYSTEM_PROMPT":"Ты помощник по коду. Никогда не проси подтверждение продолжения анализа. Если задача понятна, сразу выполняй её. Отвечай сразу и по делу."}
    vals["THREADS"]=ask_state(state, "threads", "CPU threads", str(os.cpu_count() or 8))
    vals["PARALLEL_SLOTS"]=ask_state(state, "parallel_slots", "Parallel slots (-np)","1")
    write_env(vals); write_tokens(default_token, admin_key); write_opencode(vals, f"https://{domain}/v1" if domain else "http://127.0.0.1/v1")
    (ROOT/"docker-compose.yml").write_text(compose(vals, clients, dbmode=="local"), encoding="utf-8")
    (ROOT/"nginx"/"default.conf").write_text(nginx_conf(domain, ssl=False), encoding="utf-8")
    (ROOT/"admin_login.txt").write_text(f"URL: {'https://'+domain+'/ui/' if domain else 'http://127.0.0.1/ui/'}\nlogin: {web_user}\npassword: {web_pass}\nAPI token: {default_token}\nAdmin key: {admin_key}\n", encoding="utf-8")
    mark_step(state, "files-generated", vals=vals)
    print("\nGenerated.")
    if yes_state(state, "start_now", "Запустить docker compose сейчас?", True):
        compose_result = docker_compose_up(["up","-d","--build"])
        if compose_result.returncode != 0:
            explain_compose_failure(compose_result)
            mark_step(state, "compose-failed")
            print_admin_credentials(domain, web_user, web_pass, default_token, admin_key)
            return
        check_admin_panel()
        if domain and ssl:
            res=run(["docker","compose","run","--rm","certbot","certonly","--webroot","-w","/var/www/certbot","-d",domain,"--email",email,"--agree-tos","--non-interactive"], check=False)
            if res.returncode==0:
                (ROOT/"nginx"/"default.conf").write_text(nginx_conf(domain, ssl=True), encoding="utf-8")
                docker_compose_up(["up","-d","--force-recreate","nginx"], attempts=2)
            else: print("Certbot failed, kept HTTP config")
    state["completed"] = True
    mark_step(state, "completed")
    print_admin_credentials(domain, web_user, web_pass, default_token, admin_key)
    print("\nDone. Open /ui/ with the credentials above.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\nУстановка прервана. Прогресс сохранён в {STATE_FILE.name}; следующий запуск продолжит с этого места.")
        raise SystemExit(130)
    except subprocess.CalledProcessError as exc:
        print(f"\nКоманда завершилась с ошибкой: {' '.join(map(str, exc.cmd))}")
        print(f"Прогресс сохранён в {STATE_FILE.name}; следующий запуск продолжит с последнего шага.")
        raise SystemExit(exc.returncode)
    except RuntimeError as exc:
        print(f"\nОшибка установки: {exc}")
        print(f"Прогресс сохранён в {STATE_FILE.name}; следующий запуск продолжит с последнего шага.")
        raise SystemExit(1)
