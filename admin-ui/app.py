import json
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

import docker
import httpx
import psutil
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer
from passlib.context import CryptContext
from sqlalchemy import Boolean, Column, Integer, String, create_engine, select
from sqlalchemy.orm import Session, declarative_base, sessionmaker

APP_DIR = Path(__file__).resolve().parent
STACK_ROOT = Path(os.getenv("STACK_ROOT", os.getenv("STACK_DIR", "/stack")))
PROJECT_ROOT = STACK_ROOT
ENV_FILE = STACK_ROOT / ".env"
MODELS_DIR = STACK_ROOT / "models"
CATALOG_FILE = STACK_ROOT / "config" / "models.catalog.json"
TOKEN_GATEWAY_URL = os.getenv("TOKEN_GATEWAY_URL", "http://token-gateway:9000").rstrip("/")
TOKEN_GATEWAY_ADMIN_KEY = os.getenv("TOKEN_GATEWAY_ADMIN_KEY", os.getenv("ADMIN_KEY", ""))
DOMAIN = os.getenv("DOMAIN", "")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL") or (f"https://{DOMAIN}" if DOMAIN else "http://127.0.0.1")
SECRET_KEY = os.getenv("ADMIN_UI_SECRET", os.getenv("ADMIN_WEB_SECRET", "local-ai-admin-change-me"))
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////data/admin.db")
DEFAULT_ADMIN_USER = os.getenv("ADMIN_UI_USER", os.getenv("ADMIN_WEB_USERNAME", "admin"))
DEFAULT_ADMIN_PASSWORD = os.getenv("ADMIN_UI_PASSWORD", os.getenv("ADMIN_WEB_PASSWORD", "admin"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
serializer = URLSafeTimedSerializer(SECRET_KEY, salt="local-ai-admin-session")
Base = declarative_base()
engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
app = FastAPI(title="Local AI Stack Admin", version="3.1.0")
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
jobs: dict[str, dict[str, Any]] = {}

class User(Base):
    __tablename__ = "admin_users"
    id = Column(Integer, primary_key=True)
    username = Column(String(128), unique=True, index=True, nullable=False)
    password_hash = Column(String(512), nullable=False)
    is_admin = Column(Boolean, default=True)
    enabled = Column(Boolean, default=True)
    created_at = Column(Integer, default=lambda: int(time.time()))
    updated_at = Column(Integer, default=lambda: int(time.time()))


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        exists = db.execute(select(User).where(User.username == DEFAULT_ADMIN_USER)).scalar_one_or_none()
        if not exists:
            db.add(User(username=DEFAULT_ADMIN_USER, password_hash=pwd_context.hash(DEFAULT_ADMIN_PASSWORD), is_admin=True, enabled=True))
            db.commit()

@app.on_event("startup")
def startup() -> None:
    init_db()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def make_session(user_id: int) -> str:
    return serializer.dumps({"uid": user_id, "ts": int(time.time())})


def read_session(request: Request) -> Optional[int]:
    raw = request.cookies.get("lai_session")
    if not raw:
        return None
    try:
        data = serializer.loads(raw, max_age=60 * 60 * 24 * 14)
        return int(data.get("uid"))
    except (BadSignature, Exception):
        return None


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    uid = read_session(request)
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, uid)
    if not user or not user.enabled:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def env_parse() -> dict[str, str]:
    out: dict[str, str] = {}
    if not ENV_FILE.exists():
        return out
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1].replace('\\"', '"')
        out[k.strip()] = v
    return out


def env_write(values: dict[str, Any]) -> None:
    current = env_parse()
    for k, v in values.items():
        if v is not None:
            current[k] = str(v)
    lines = []
    for k in sorted(current):
        val = current[k].replace('"', '\\"')
        lines.append(f'{k}="{val}"')
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_cmd(cmd: list[str], timeout: int = 60) -> dict[str, Any]:
    proc = subprocess.run(cmd, cwd=PROJECT_ROOT, text=True, capture_output=True, timeout=timeout)
    return {"cmd": cmd, "returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def run_compose(args: list[str], timeout: int = 60) -> dict[str, Any]:
    return run_cmd(["docker", "compose"] + args, timeout=timeout)


def token_gateway_headers() -> dict[str, str]:
    if not TOKEN_GATEWAY_ADMIN_KEY:
        raise HTTPException(status_code=500, detail="TOKEN_GATEWAY_ADMIN_KEY is not configured")
    return {"Authorization": f"Bearer {TOKEN_GATEWAY_ADMIN_KEY}"}

@app.get("/")
def root():
    return FileResponse(APP_DIR / "static" / "index.html")

@app.get("/ui/")
def ui_page():
    return FileResponse(APP_DIR / "static" / "index.html")

@app.get("/api/me")
def api_me(user: User = Depends(current_user)):
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin}

@app.post("/api/login")
async def api_login(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    username = str(data.get("username", ""))
    password = str(data.get("password", ""))
    user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if not user or not user.enabled or not pwd_context.verify(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    resp = JSONResponse({"ok": True, "username": user.username})
    resp.set_cookie("lai_session", make_session(user.id), httponly=True, samesite="lax", max_age=60 * 60 * 24 * 14)
    return resp

@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("lai_session")
    return resp

@app.get("/api/users")
def api_users(_: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(User).order_by(User.id)).scalars().all()
    return {"users": [{"id": u.id, "username": u.username, "enabled": u.enabled, "is_admin": u.is_admin, "created_at": u.created_at} for u in rows]}

@app.post("/api/users")
async def api_create_user(request: Request, _: User = Depends(current_user), db: Session = Depends(get_db)):
    data = await request.json()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")
    if db.execute(select(User).where(User.username == username)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="username already exists")
    u = User(username=username, password_hash=pwd_context.hash(password), enabled=True, is_admin=bool(data.get("is_admin", True)))
    db.add(u)
    db.commit()
    return {"ok": True, "id": u.id}

@app.patch("/api/users/{user_id}")
async def api_update_user(user_id: int, request: Request, _: User = Depends(current_user), db: Session = Depends(get_db)):
    data = await request.json()
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    if "username" in data and str(data["username"]).strip():
        u.username = str(data["username"]).strip()
    if "password" in data and str(data["password"]):
        u.password_hash = pwd_context.hash(str(data["password"]))
    if "enabled" in data:
        u.enabled = bool(data["enabled"])
    u.updated_at = int(time.time())
    db.commit()
    return {"ok": True}

@app.delete("/api/users/{user_id}")
def api_delete_user(user_id: int, current: User = Depends(current_user), db: Session = Depends(get_db)):
    if current.id == user_id:
        raise HTTPException(status_code=400, detail="cannot delete yourself")
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    db.delete(u)
    db.commit()
    return {"ok": True}

@app.get("/api/tokens")
async def api_tokens(_: User = Depends(current_user)):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{TOKEN_GATEWAY_URL}/admin/tokens", headers=token_gateway_headers())
    return JSONResponse(r.json(), status_code=r.status_code)

@app.post("/api/tokens")
async def api_create_token(request: Request, _: User = Depends(current_user)):
    data = await request.json()
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{TOKEN_GATEWAY_URL}/admin/tokens", headers={**token_gateway_headers(), "Content-Type": "application/json"}, json=data)
    return JSONResponse(r.json(), status_code=r.status_code)

@app.patch("/api/tokens/{key}")
async def api_update_token(key: str, request: Request, _: User = Depends(current_user)):
    data = await request.json()
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.patch(f"{TOKEN_GATEWAY_URL}/admin/tokens/{key}", headers={**token_gateway_headers(), "Content-Type": "application/json"}, json=data)
    return JSONResponse(r.json(), status_code=r.status_code)

@app.delete("/api/tokens/{key}")
async def api_delete_token(key: str, _: User = Depends(current_user)):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.delete(f"{TOKEN_GATEWAY_URL}/admin/tokens/{key}", headers=token_gateway_headers())
    return JSONResponse(r.json(), status_code=r.status_code)

@app.get("/api/settings")
def api_get_settings(_: User = Depends(current_user)):
    env = env_parse()
    return {"env": env, "public_base_url": PUBLIC_BASE_URL, "model_path": env.get("MODEL_PATH", ""), "prompt": env.get("ANTI_CONFIRM_SYSTEM_PROMPT", ""), "llama": {k: env.get(k, d) for k, d in {"CTX_SIZE":"32768", "THREADS":"16", "PARALLEL_SLOTS":"1", "N_GPU_LAYERS":"0", "LLAMA_TIMEOUT":"1200"}.items()}}

@app.post("/api/settings")
async def api_save_settings(request: Request, _: User = Depends(current_user)):
    data = await request.json()
    allowed = {"ANTI_CONFIRM_SYSTEM_PROMPT", "CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT", "MODEL_PATH", "MODEL_ID"}
    to_write = {k: v for k, v in data.items() if k in allowed}
    env_write(to_write)
    return {"ok": True, "saved": sorted(to_write.keys())}

def docker_stats_summary(raw: dict) -> dict:
    try:
        mem_usage = raw.get("memory_stats", {}).get("usage", 0)
        mem_limit = raw.get("memory_stats", {}).get("limit", 0)
        cpu_delta = raw["cpu_stats"]["cpu_usage"]["total_usage"] - raw["precpu_stats"]["cpu_usage"]["total_usage"]
        system_delta = raw["cpu_stats"].get("system_cpu_usage", 0) - raw["precpu_stats"].get("system_cpu_usage", 0)
        online = raw["cpu_stats"].get("online_cpus") or len(raw["cpu_stats"]["cpu_usage"].get("percpu_usage", [])) or 1
        cpu_percent = (cpu_delta / system_delta) * online * 100 if system_delta > 0 else 0
        return {"cpu_percent": round(cpu_percent, 2), "memory_usage": mem_usage, "memory_limit": mem_limit}
    except Exception:
        return {}

def parse_llama_logs() -> dict:
    try:
        proc = subprocess.run(["docker", "logs", "--tail", "600", "llama-server-coder"], text=True, capture_output=True, timeout=5)
        text = proc.stdout + proc.stderr
    except Exception as e:
        return {"error": str(e)}
    task_tokens = [int(x) for x in re.findall(r"task\.n_tokens = (\d+)", text)]
    prompt_speeds = [float(x) for x in re.findall(r"prompt eval time =.*?,\s+([0-9.]+) tokens per second", text)]
    eval_speeds = [float(x) for x in re.findall(r"eval time =.*?,\s+([0-9.]+) tokens per second", text)]
    avg_prompt = sum(prompt_speeds[-5:]) / len(prompt_speeds[-5:]) if prompt_speeds else None
    return {"last_task_tokens": task_tokens[-1] if task_tokens else None, "recent_task_tokens": task_tokens[-10:], "avg_prompt_tokens_per_second": avg_prompt, "avg_eval_tokens_per_second": sum(eval_speeds[-5:]) / len(eval_speeds[-5:]) if eval_speeds else None, "estimated_seconds_for_last_prompt": (task_tokens[-1] / avg_prompt) if task_tokens and avg_prompt else None}

@app.get("/api/system")
def api_system(_: User = Depends(current_user)):
    result: dict[str, Any] = {"host": {"cpu_percent": psutil.cpu_percent(interval=0.2), "memory": psutil.virtual_memory()._asdict(), "disk": psutil.disk_usage("/")._asdict(), "boot_time": psutil.boot_time()}, "containers": [], "llama_metrics": parse_llama_logs()}
    try:
        client = docker.from_env(); known = {"llama-server-coder", "token-gateway", "local-ai-nginx", "local-ai-certbot", "admin-ui", "local-ai-postgres", "opencode-server", "codex-runner", "claude-code-proxy", "postgres"}
        for c in client.containers.list(all=True):
            if c.name not in known: continue
            stats = docker_stats_summary(c.stats(stream=False)) if c.status == "running" else {}
            result["containers"].append({"name": c.name, "status": c.status, "image": c.image.tags, "stats": stats})
    except Exception as e:
        result["docker_error"] = str(e)
    return result

@app.post("/api/stack/{action}")
def api_stack_action(action: str, _: User = Depends(current_user)):
    actions = {"start": ["up", "-d", "--build"], "stop": ["stop"], "restart": ["restart"], "down": ["down"], "status": ["ps"]}
    if action not in actions: raise HTTPException(status_code=400, detail="unknown action")
    return run_compose(actions[action], timeout=180)

@app.get("/api/logs/{service}")
def api_logs(service: str, tail: int = 200, _: User = Depends(current_user)):
    allowed = {"llama-server-coder", "token-gateway", "local-ai-nginx", "nginx", "admin-ui", "postgres"}
    if service not in allowed: raise HTTPException(status_code=400, detail="unsupported service")
    real = "nginx" if service == "local-ai-nginx" else service
    proc = subprocess.run(["docker", "compose", "logs", f"--tail={int(tail)}", real], cwd=PROJECT_ROOT, text=True, capture_output=True, timeout=15)
    return {"stdout": proc.stdout, "stderr": proc.stderr, "returncode": proc.returncode}

@app.get("/api/models")
def api_models(_: User = Depends(current_user)):
    local = []
    for p in sorted(MODELS_DIR.rglob("*.gguf")):
        local.append({"name": p.name, "path": "/models/" + str(p.relative_to(MODELS_DIR)).replace(os.sep, "/"), "size": p.stat().st_size})
    catalog = []
    if CATALOG_FILE.exists():
        try: catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
        except Exception: pass
    return {"local": local, "catalog": catalog, "current": env_parse().get("MODEL_PATH", "")}

@app.post("/api/models/switch")
async def api_model_switch(request: Request, _: User = Depends(current_user)):
    data = await request.json(); model_path = str(data.get("path", ""))
    if not model_path.startswith("/models/"): raise HTTPException(status_code=400, detail="path must start with /models/")
    env_write({"MODEL_PATH": model_path, "MODEL_ID": Path(model_path).name})
    restart = run_compose(["restart", "llama-server-coder"], timeout=60) if data.get("restart", True) else None
    return {"ok": True, "restart": restart}

@app.post("/api/models/upload")
async def api_model_upload(file: UploadFile = File(...), _: User = Depends(current_user)):
    if not file.filename.endswith(".gguf"): raise HTTPException(status_code=400, detail="Only .gguf files are supported")
    dest = MODELS_DIR / "uploads" / Path(file.filename).name; dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk: break
            f.write(chunk)
    return {"ok": True, "path": "/models/" + str(dest.relative_to(MODELS_DIR)).replace(os.sep, "/")}

@app.post("/api/models/download")
async def api_model_download(request: Request, _: User = Depends(current_user)):
    data = await request.json(); repo = str(data.get("repo", "")).strip(); include = str(data.get("include", "*.gguf")).strip(); local_dir = str(data.get("local_dir") or repo.replace("/", "_")).strip()
    if not repo: raise HTTPException(status_code=400, detail="repo is required")
    job_id = secrets.token_hex(8); jobs[job_id] = {"status": "running", "repo": repo, "include": include, "started_at": int(time.time())}
    threading.Thread(target=download_worker, args=(job_id, repo, include, local_dir), daemon=True).start()
    return {"job_id": job_id}

def download_worker(job_id: str, repo: str, include: str, local_dir: str) -> None:
    from huggingface_hub import snapshot_download
    try:
        dest = MODELS_DIR / local_dir; dest.mkdir(parents=True, exist_ok=True)
        path = snapshot_download(repo_id=repo, allow_patterns=[include], local_dir=str(dest), local_dir_use_symlinks=False)
        jobs[job_id].update({"status": "done", "path": path, "finished_at": int(time.time())})
    except Exception as e:
        jobs[job_id].update({"status": "error", "error": str(e), "finished_at": int(time.time())})

@app.get("/api/models/jobs")
def api_model_jobs(_: User = Depends(current_user)): return {"jobs": jobs}

@app.get("/api/clients")
def api_clients(_: User = Depends(current_user)):
    compose = (PROJECT_ROOT / "docker-compose.yml").read_text(encoding="utf-8") if (PROJECT_ROOT / "docker-compose.yml").exists() else ""
    status = {}
    try:
        client = docker.from_env()
        for name in ["opencode-server", "codex-runner", "claude-code-proxy"]:
            try:
                c = client.containers.get(name)
                status[name] = c.status
            except Exception:
                status[name] = "not-created"
    except Exception:
        status = {}
    return {
        "opencode": {"enabled": status.get("opencode-server") == "running", "defined": "opencode-server:" in compose, "hint": "OpenCode Desktop connects to opencode serve at http://localhost:4096, model provider points to /v1."},
        "codex": {"enabled": status.get("codex-runner") == "running", "defined": "codex-runner:" in compose, "hint": "Codex helper uses @openai/codex. Configure OPENAI_API_KEY or use your /v1 endpoint if supported by your client."},
        "claude": {"enabled": status.get("claude-code-proxy") == "running", "defined": "claude-code-proxy:" in compose, "hint": "Claude Code proxy is experimental; OpenAI-compatible clients are preferred."},
    }

@app.post("/api/clients/{client}/enable")
def api_enable_client(client: str, _: User = Depends(current_user)):
    mapping = {
        "opencode": (["--profile", "tools", "up", "-d", "--build", "opencode-server"], "opencode-server"),
        "codex": (["--profile", "tools", "up", "-d", "--build", "codex-runner"], "codex-runner"),
        "claude": (["--profile", "claude", "up", "-d", "--build", "claude-code-proxy"], "claude-code-proxy"),
    }
    if client not in mapping:
        raise HTTPException(status_code=400, detail="unknown client")
    args, service = mapping[client]
    return {"ok": True, "service": service, "result": run_compose(args, timeout=600)}
