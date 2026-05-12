import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
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
SYNC_DEFAULT_ADMIN = os.getenv("ADMIN_UI_SYNC_DEFAULT_CREDENTIALS", "1").lower() not in {"0", "false", "no"}

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
BCRYPT_MAX_BYTES = 72
serializer = URLSafeTimedSerializer(SECRET_KEY, salt="local-ai-admin-session")
Base = declarative_base()
engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
app = FastAPI(title="Local AI Stack Admin", version="3.2.0")
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
app.mount("/ui/static", StaticFiles(directory=str(APP_DIR / "static")), name="ui-static")
jobs: dict[str, dict[str, Any]] = {}


@app.middleware("http")
async def strip_ui_api_prefix(request: Request, call_next):
    path = request.scope.get("path", "")
    if path.startswith("/ui/api/"):
        request.scope["path"] = path[3:]
    return await call_next(request)

class User(Base):
    __tablename__ = "admin_users"
    id = Column(Integer, primary_key=True)
    username = Column(String(128), unique=True, index=True, nullable=False)
    password_hash = Column(String(512), nullable=False)
    is_admin = Column(Boolean, default=True)
    enabled = Column(Boolean, default=True)
    created_at = Column(Integer, default=lambda: int(time.time()))
    updated_at = Column(Integer, default=lambda: int(time.time()))


def bcrypt_secret(secret: str) -> str:
    raw = str(secret or "").encode("utf-8")
    if len(raw) <= BCRYPT_MAX_BYTES:
        return str(secret or "")
    return "sha256$" + hashlib.sha256(raw).hexdigest()


def hash_password(secret: str) -> str:
    return pwd_context.hash(bcrypt_secret(secret))


def verify_password(secret: str, password_hash: str) -> bool:
    normalized = bcrypt_secret(secret)
    try:
        return pwd_context.verify(normalized, password_hash)
    except ValueError:
        return False


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        exists = db.execute(select(User).where(User.username == DEFAULT_ADMIN_USER)).scalar_one_or_none()
        if exists:
            if SYNC_DEFAULT_ADMIN:
                exists.password_hash = hash_password(DEFAULT_ADMIN_PASSWORD)
                exists.is_admin = True
                exists.enabled = True
                exists.updated_at = int(time.time())
                db.commit()
            return

        first_admin = db.execute(select(User).where(User.is_admin == True).order_by(User.id)).scalars().first()
        if first_admin and SYNC_DEFAULT_ADMIN:
            first_admin.username = DEFAULT_ADMIN_USER
            first_admin.password_hash = hash_password(DEFAULT_ADMIN_PASSWORD)
            first_admin.enabled = True
            first_admin.updated_at = int(time.time())
            db.commit()
            return

        db.add(User(username=DEFAULT_ADMIN_USER, password_hash=hash_password(DEFAULT_ADMIN_PASSWORD), is_admin=True, enabled=True))
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


def run_cmd(cmd: list[str], timeout: int = 60, env: Optional[dict[str, str]] = None) -> dict[str, Any]:
    try:
        proc = subprocess.run(cmd, cwd=PROJECT_ROOT, text=True, capture_output=True, timeout=timeout, env=env)
        return {"cmd": cmd, "returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except FileNotFoundError as exc:
        return {"cmd": cmd, "returncode": 127, "stdout": "", "stderr": str(exc)}
    except subprocess.TimeoutExpired as exc:
        return {"cmd": cmd, "returncode": 124, "stdout": exc.stdout or "", "stderr": exc.stderr or f"Command timed out after {timeout}s"}


def compose_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("COMPOSE_PARALLEL_LIMIT", "1")
    return env


def docker_executable() -> Optional[str]:
    configured = os.getenv("DOCKER_CLI", "").strip()
    candidates = [configured, "docker", "/usr/bin/docker", "/usr/local/bin/docker"]
    for candidate in candidates:
        if not candidate:
            continue
        if os.sep in candidate and Path(candidate).exists():
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    return None


def compose_base_command() -> Optional[list[str]]:
    docker = docker_executable()
    if docker:
        try:
            probe = subprocess.run([docker, "compose", "version"], text=True, capture_output=True, timeout=10)
            if probe.returncode == 0:
                return [docker, "compose"]
        except Exception:
            pass

    legacy = shutil.which("docker-compose")
    if legacy:
        return [legacy]
    return [docker, "compose"] if docker else None


def missing_docker_result(args: list[str]) -> dict[str, Any]:
    return {
        "cmd": ["docker", "compose"] + args,
        "returncode": 127,
        "stdout": "",
        "stderr": (
            "Docker CLI is not installed inside the admin-ui container. "
            "Pull the latest code and rebuild admin-ui: docker compose build --no-cache admin-ui && docker compose up -d admin-ui nginx"
        ),
    }


def run_compose(args: list[str], timeout: int = 60) -> dict[str, Any]:
    base = compose_base_command()
    if not base:
        return missing_docker_result(args)
    return run_cmd(base + args, timeout=timeout, env=compose_env())


def run_docker(args: list[str], timeout: int = 60) -> dict[str, Any]:
    docker = docker_executable()
    if not docker:
        return {
            "cmd": ["docker"] + args,
            "returncode": 127,
            "stdout": "",
            "stderr": (
                "Docker CLI is not installed inside the admin-ui container. "
                "Rebuild admin-ui with the latest Dockerfile."
            ),
        }
    return run_cmd([docker] + args, timeout=timeout)


def run_compose_retry(args: list[str], timeout: int = 60, attempts: int = 3) -> dict[str, Any]:
    result: dict[str, Any] = {"cmd": ["docker", "compose"] + args, "returncode": 1, "stdout": "", "stderr": ""}
    for attempt in range(1, attempts + 1):
        result = run_compose(args, timeout=timeout)
        if result["returncode"] == 0:
            return result
        if attempt < attempts:
            time.sleep(15)
    return result


def compose_services() -> list[str]:
    result = run_compose(["config", "--services"], timeout=30)
    if result["returncode"] != 0:
        return []
    available = {line.strip() for line in (result.get("stdout") or "").splitlines() if line.strip()}
    preferred = ["postgres", "llama-server-coder", "token-gateway", "admin-ui", "nginx"]
    return [service for service in preferred if service in available]


def container_names_for_service(service: str) -> list[str]:
    return {
        "postgres": ["local-ai-postgres", "postgres"],
        "llama-server-coder": ["llama-server-coder"],
        "token-gateway": ["token-gateway"],
        "admin-ui": ["admin-ui"],
        "nginx": ["local-ai-nginx", "nginx"],
        "certbot": ["local-ai-certbot", "certbot"],
    }.get(service, [])


def remove_conflicting_container(service: str) -> dict[str, Any]:
    removed: list[dict[str, str]] = []
    errors: list[str] = []
    compose_id_result = run_compose(["ps", "-q", service], timeout=20)
    compose_id = (compose_id_result.get("stdout") or "").strip()

    for name in container_names_for_service(service):
        listed = run_docker(["ps", "-aq", "--filter", f"name=^/{name}$"], timeout=20)
        if listed["returncode"] != 0:
            errors.append(clean_output(listed))
            continue
        for container_id in [line.strip() for line in (listed.get("stdout") or "").splitlines() if line.strip()]:
            if compose_id and container_id == compose_id:
                continue
            result = run_docker(["rm", "-f", container_id], timeout=60)
            if result["returncode"] == 0:
                removed.append({"name": name, "id": container_id})
            else:
                errors.append(clean_output(result))

    return {"service": service, "removed": removed, "errors": errors}


def run_compose_up_sequential(force_recreate: bool = False, services: Optional[list[str]] = None, timeout: int = 900) -> dict[str, Any]:
    selected = services or compose_services()
    stdout: list[str] = [f"Starting services one by one (COMPOSE_PARALLEL_LIMIT={compose_env()['COMPOSE_PARALLEL_LIMIT']})\n"]
    stderr: list[str] = []
    last: dict[str, Any] = {"cmd": ["docker", "compose", "up"], "returncode": 0, "stdout": "", "stderr": ""}

    run_compose(["stop", "nginx"], timeout=30)

    for service in selected:
        stdout.append(f"\n== Pull {service} ==\n")
        last = run_compose_retry(["pull", "--ignore-buildable", service], timeout=timeout)
        stdout.append(last.get("stdout") or "")
        stderr.append(last.get("stderr") or "")
        if last["returncode"] != 0:
            break

    if last["returncode"] == 0:
        for service in selected:
            stdout.append(f"\n== Build {service} ==\n")
            last = run_compose_retry(["build", service], timeout=timeout)
            stdout.append(last.get("stdout") or "")
            stderr.append(last.get("stderr") or "")
            if last["returncode"] != 0:
                break

    if last["returncode"] == 0:
        for service in selected:
            stdout.append(f"\n== Up {service} ==\n")
            cleanup = remove_conflicting_container(service)
            for item in cleanup["removed"]:
                stdout.append(f"Removed old conflicting container {item['name']} ({item['id']}) before starting {service}.\n")
            for error in cleanup["errors"]:
                stderr.append(error + "\n")
            args = ["up", "-d", "--no-build"]
            if force_recreate:
                args.append("--force-recreate")
            args.append(service)
            last = run_compose_retry(args, timeout=timeout)
            stdout.append(last.get("stdout") or "")
            stderr.append(last.get("stderr") or "")
            if last["returncode"] != 0:
                break

    return {"cmd": ["docker", "compose", "up", "sequential"], "returncode": last["returncode"], "stdout": "".join(stdout), "stderr": "".join(stderr)}


def run_git(args: list[str], timeout: int = 30) -> dict[str, Any]:
    return run_cmd(["git", "-c", f"safe.directory={PROJECT_ROOT}"] + args, timeout=timeout)


def clean_output(result: dict[str, Any]) -> str:
    return ((result.get("stdout") or "") + (result.get("stderr") or "")).strip()


def git_value(args: list[str], default: str = "", timeout: int = 30) -> str:
    result = run_git(args, timeout=timeout)
    if result["returncode"] != 0:
        return default
    return (result["stdout"] or "").strip()


def git_message(ref: str) -> str:
    return git_value(["log", "-1", "--pretty=format:%h %s", ref], "")


GENERATED_LOCAL_FILES = {"nginx/default.conf"}


def git_dirty_paths() -> list[str]:
    result = run_git(["status", "--porcelain"], timeout=30)
    if result["returncode"] != 0:
        return []
    paths: list[str] = []
    for raw in (result.get("stdout") or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if " -> " in line:
            line = line.split(" -> ", 1)[1]
        paths.append(line[3:] if len(line) > 3 else line)
    return paths


def backup_generated_files(paths: list[str]) -> dict[str, str]:
    backups: dict[str, str] = {}
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for rel in paths:
        if rel not in GENERATED_LOCAL_FILES:
            continue
        src = PROJECT_ROOT / rel
        if not src.exists():
            continue
        backup = src.with_name(f"{src.name}.local-{stamp}.bak")
        backup.write_bytes(src.read_bytes())
        backups[rel] = str(backup)
    return backups


def parse_stack_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not ENV_FILE.exists():
        return out
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1].replace('\\"', '"')
        out[key.strip()] = value
    return out


def regenerate_nginx_config() -> dict[str, Any]:
    env = parse_stack_env()
    domain = env.get("DOMAIN", "").strip()
    ssl = bool(domain and (PROJECT_ROOT / "certbot" / "conf" / "live" / domain / "fullchain.pem").exists())
    try:
        sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
        from install_wizard import nginx_conf

        target = PROJECT_ROOT / "nginx" / "default.conf"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(nginx_conf(domain, ssl=ssl), encoding="utf-8")
        return {"ok": True, "domain": domain, "ssl": ssl, "path": str(target)}
    except Exception as exc:
        return {"ok": False, "domain": domain, "ssl": ssl, "error": str(exc)}


def git_update_status(fetch: bool = True) -> dict[str, Any]:
    if not (PROJECT_ROOT / ".git").exists():
        return {"configured": False, "error": "This stack is not installed from a git repository."}

    branch = git_value(["rev-parse", "--abbrev-ref", "HEAD"], "main")
    remote = git_value(["remote", "get-url", "origin"], "")
    current = git_value(["rev-parse", "HEAD"], "")
    current_short = git_value(["rev-parse", "--short", "HEAD"], "")
    dirty_paths = git_dirty_paths()
    generated_dirty_paths = [path for path in dirty_paths if path in GENERATED_LOCAL_FILES]
    blocking_dirty_paths = [path for path in dirty_paths if path not in GENERATED_LOCAL_FILES]
    dirty = bool(blocking_dirty_paths)

    remote_ref = f"origin/{branch}" if branch and branch != "HEAD" else "origin/main"
    fetch_error = ""
    if fetch:
        fetch_result = run_git(["fetch", "--quiet", "origin", branch if branch != "HEAD" else "main"], timeout=90)
        if fetch_result["returncode"] != 0:
            fetch_error = clean_output(fetch_result)

    latest = git_value(["rev-parse", remote_ref], "")
    latest_short = git_value(["rev-parse", "--short", remote_ref], "")
    behind = git_value(["rev-list", "--count", f"{current}..{remote_ref}"], "0") if current and latest else "0"
    ahead = git_value(["rev-list", "--count", f"{remote_ref}..{current}"], "0") if current and latest else "0"

    try:
        behind_count = int(behind or 0)
    except ValueError:
        behind_count = 0
    try:
        ahead_count = int(ahead or 0)
    except ValueError:
        ahead_count = 0

    return {
        "configured": True,
        "branch": branch,
        "remote": remote,
        "remote_ref": remote_ref,
        "current": current,
        "current_short": current_short,
        "current_message": git_message("HEAD"),
        "latest": latest,
        "latest_short": latest_short,
        "latest_message": git_message(remote_ref) if latest else "",
        "behind": behind_count,
        "ahead": ahead_count,
        "dirty": dirty,
        "dirty_paths": blocking_dirty_paths,
        "generated_dirty_paths": generated_dirty_paths,
        "has_update": behind_count > 0,
        "can_update": behind_count > 0 and ahead_count == 0 and not dirty and not bool(fetch_error),
        "fetch_error": fetch_error,
        "checked_at": int(time.time()),
    }


def update_worker(job_id: str) -> None:
    def mark(**data: Any) -> None:
        jobs[job_id].update(data)

    mark(status="running", step="checking", started_at=int(time.time()))
    status = git_update_status(fetch=True)
    mark(status_data=status)

    if not status.get("configured"):
        mark(status="error", step="failed", error=status.get("error", "git repository is not configured"), finished_at=int(time.time()))
        return
    if status.get("dirty"):
        dirty = ", ".join(status.get("dirty_paths") or [])
        mark(status="error", step="failed", error=f"Local files have uncommitted changes: {dirty}. Commit or stash them before updating.", finished_at=int(time.time()))
        return
    if status.get("ahead"):
        mark(status="error", step="failed", error="Local branch has commits that are not on origin; fast-forward update is not safe.", finished_at=int(time.time()))
        return
    if status.get("fetch_error"):
        mark(status="error", step="failed", error=status["fetch_error"], finished_at=int(time.time()))
        return
    if not status.get("has_update"):
        mark(status="done", step="already-current", message="Already on the latest version.", finished_at=int(time.time()))
        return

    branch = status.get("branch") if status.get("branch") != "HEAD" else "main"
    generated_dirty = status.get("generated_dirty_paths") or []
    if generated_dirty:
        mark(step="preparing-generated-config", generated_dirty_paths=generated_dirty)
        backups = backup_generated_files(generated_dirty)
        restore = run_git(["restore", "--"] + list(generated_dirty), timeout=30)
        mark(generated_backups=backups, generated_restore=restore)
        if restore["returncode"] != 0:
            mark(status="error", step="failed", error=clean_output(restore), finished_at=int(time.time()))
            return

    mark(step="downloading")
    pull = run_git(["pull", "--ff-only", "origin", branch], timeout=180)
    mark(pull=pull)
    if pull["returncode"] != 0:
        mark(status="error", step="failed", error=clean_output(pull), finished_at=int(time.time()))
        return

    if generated_dirty:
        mark(step="regenerating-nginx")
        nginx_result = regenerate_nginx_config()
        mark(nginx=nginx_result)
        if not nginx_result.get("ok"):
            mark(status="error", step="failed", error=nginx_result.get("error", "Could not regenerate nginx/default.conf"), finished_at=int(time.time()))
            return

    mark(step="restarting")
    compose = run_compose_up_sequential(timeout=900)
    mark(compose=compose)
    if compose["returncode"] != 0:
        mark(status="error", step="failed", error=clean_output(compose), finished_at=int(time.time()))
        return

    mark(status="done", step="complete", finished_at=int(time.time()), status_data=git_update_status(fetch=False))


def token_gateway_headers() -> dict[str, str]:
    if not TOKEN_GATEWAY_ADMIN_KEY:
        raise HTTPException(status_code=500, detail="TOKEN_GATEWAY_ADMIN_KEY is not configured")
    return {"Authorization": f"Bearer {TOKEN_GATEWAY_ADMIN_KEY}"}


def response_payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return {"detail": response.text or f"HTTP {response.status_code}"}


async def token_gateway_request(method: str, path: str, json_data: Optional[dict[str, Any]] = None, timeout: int = 30) -> httpx.Response:
    headers = token_gateway_headers()
    if json_data is not None:
        headers = {**headers, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(method, f"{TOKEN_GATEWAY_URL}{path}", headers=headers, json=json_data)


async def token_gateway_json(method: str, path: str, json_data: Optional[dict[str, Any]] = None, timeout: int = 30) -> JSONResponse:
    try:
        response = await token_gateway_request(method, path, json_data=json_data, timeout=timeout)
    except Exception as exc:
        return JSONResponse({"detail": f"token-gateway is not reachable: {exc}"}, status_code=502)
    return JSONResponse(response_payload(response), status_code=response.status_code)

@app.get("/")
def root():
    return FileResponse(APP_DIR / "static" / "index.html")

@app.get("/ui")
def ui_page_no_slash():
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
    if not user or not user.enabled or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    resp = JSONResponse({"ok": True, "username": user.username})
    resp.set_cookie("lai_session", make_session(user.id), httponly=True, samesite="lax", max_age=60 * 60 * 24 * 14, path="/")
    return resp

@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("lai_session", path="/")
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
    u = User(username=username, password_hash=hash_password(password), enabled=True, is_admin=bool(data.get("is_admin", True)))
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
        u.password_hash = hash_password(str(data["password"]))
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
    return await token_gateway_json("GET", "/admin/tokens")

@app.post("/api/tokens")
async def api_create_token(request: Request, _: User = Depends(current_user)):
    data = await request.json()
    return await token_gateway_json("POST", "/admin/tokens", json_data=data)

@app.patch("/api/tokens/{key}")
async def api_update_token(key: str, request: Request, _: User = Depends(current_user)):
    data = await request.json()
    return await token_gateway_json("PATCH", f"/admin/tokens/{key}", json_data=data)

@app.delete("/api/tokens/{key}")
async def api_delete_token(key: str, _: User = Depends(current_user)):
    return await token_gateway_json("DELETE", f"/admin/tokens/{key}")

@app.get("/api/settings")
async def api_get_settings(_: User = Depends(current_user)):
    env = env_parse()
    gateway_config: dict[str, Any] = {}
    gateway_error = ""
    try:
        response = await token_gateway_request("GET", "/admin/config", timeout=10)
        if response.status_code == 200:
            payload = response_payload(response)
            if isinstance(payload, dict):
                gateway_config = payload
        else:
            gateway_error = str(response_payload(response))
    except Exception as exc:
        gateway_error = str(exc)
    return {
        "env": env,
        "gateway_config": gateway_config,
        "gateway_error": gateway_error,
        "public_base_url": PUBLIC_BASE_URL,
        "model_path": env.get("MODEL_PATH", ""),
        "prompt": gateway_config.get("system_prompt") or env.get("ANTI_CONFIRM_SYSTEM_PROMPT", ""),
        "llama": {k: env.get(k, d) for k, d in {"CTX_SIZE":"32768", "THREADS":"16", "PARALLEL_SLOTS":"1", "N_GPU_LAYERS":"0", "LLAMA_TIMEOUT":"1200"}.items()},
    }

@app.post("/api/settings")
async def api_save_settings(request: Request, _: User = Depends(current_user)):
    data = await request.json()
    allowed = {"ANTI_CONFIRM_SYSTEM_PROMPT", "CTX_SIZE", "THREADS", "PARALLEL_SLOTS", "N_GPU_LAYERS", "LLAMA_TIMEOUT", "MODEL_PATH", "MODEL_ID"}
    to_write = {k: v for k, v in data.items() if k in allowed}
    env_write(to_write)
    gateway_config = None
    gateway_error = ""
    if "ANTI_CONFIRM_SYSTEM_PROMPT" in to_write:
        try:
            response = await token_gateway_request("PATCH", "/admin/config", json_data={"system_prompt": str(to_write["ANTI_CONFIRM_SYSTEM_PROMPT"])}, timeout=15)
            gateway_config = response_payload(response)
            if response.status_code >= 400:
                gateway_error = str(gateway_config)
        except Exception as exc:
            gateway_error = str(exc)
    return {"ok": True, "saved": sorted(to_write.keys()), "gateway_config": gateway_config, "gateway_error": gateway_error}

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
    result = run_docker(["logs", "--tail", "600", "llama-server-coder"], timeout=5)
    if result["returncode"] != 0:
        return {"error": clean_output(result)}
    text = result["stdout"] + result["stderr"]
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
    if action == "start":
        return run_compose_up_sequential(timeout=900)
    return run_compose(actions[action], timeout=180)

@app.get("/api/update/status")
def api_update_status(fetch: bool = True, _: User = Depends(current_user)):
    return git_update_status(fetch=fetch)

@app.post("/api/update/apply")
def api_update_apply(_: User = Depends(current_user)):
    job_id = secrets.token_hex(8)
    jobs[job_id] = {"type": "stack-update", "status": "queued", "step": "queued", "created_at": int(time.time())}
    threading.Thread(target=update_worker, args=(job_id,), daemon=True).start()
    return {"ok": True, "job_id": job_id}

@app.get("/api/update/jobs/{job_id}")
def api_update_job(job_id: str, _: User = Depends(current_user)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job

@app.get("/api/logs/{service}")
def api_logs(service: str, tail: int = 200, _: User = Depends(current_user)):
    allowed = {"llama-server-coder", "token-gateway", "local-ai-nginx", "nginx", "admin-ui", "postgres"}
    if service not in allowed: raise HTTPException(status_code=400, detail="unsupported service")
    real = "nginx" if service == "local-ai-nginx" else service
    return run_compose(["logs", f"--tail={int(tail)}", real], timeout=15)

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
    compose_text = (PROJECT_ROOT / "docker-compose.yml").read_text(encoding="utf-8") if (PROJECT_ROOT / "docker-compose.yml").exists() else ""
    enable_result = None
    if f"{service}:" not in compose_text:
        enable_result = run_cmd([sys.executable, "scripts/client_manager.py", "enable", client], timeout=30)
        if enable_result["returncode"] != 0:
            return {"ok": False, "service": service, "enable": enable_result, "result": None}
    result = run_compose(args, timeout=600)
    return {"ok": result["returncode"] == 0, "service": service, "enable": enable_result, "result": result}
