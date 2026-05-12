import os
import json
import time
import secrets
import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, Response

TOKENS_FILE = Path(os.getenv("TOKENS_FILE", "/data/tokens.json"))
CONFIG_FILE = Path(os.getenv("CONFIG_FILE", "/data/config.json"))
UPSTREAM = os.getenv("UPSTREAM", "http://llama-server-coder:8081").rstrip("/")
UPSTREAM_API_KEY = os.getenv("UPSTREAM_API_KEY", "sk-dummy")
ADMIN_KEY = os.getenv("ADMIN_KEY", "")
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "1200"))
LOG_TOKEN_PREFIX = int(os.getenv("LOG_TOKEN_PREFIX", "12"))

ANTI_CONFIRM_SYSTEM_PROMPT = os.getenv(
    "ANTI_CONFIRM_SYSTEM_PROMPT",
    "Ты помощник по коду. Никогда не проси подтверждение продолжения анализа. "
    "Если задача понятна, сразу выполняй её. Не пиши фразы вроде: "
    "'подтвердите, если хотите продолжить анализ', 'please confirm', "
    "'confirm if you want to continue'. Отвечай сразу и по делу."
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s token-gateway %(message)s",
)
logger = logging.getLogger("token-gateway")

app = FastAPI(title="Local AI Token Gateway", version="2.0.0")
lock = asyncio.Lock()


def generate_token() -> str:
    return "sk-" + secrets.token_urlsafe(32)


def now_ts() -> int:
    return int(time.time())


def normalize_db(data: Any) -> dict:
    if not isinstance(data, dict):
        data = {}

    raw_tokens = data.get("tokens", [])
    tokens = []

    for item in raw_tokens:
        if isinstance(item, str):
            tokens.append({
                "key": item,
                "name": item[-8:],
                "enabled": True,
                "unlimited": True,
                "limit_tokens": None,
                "used_tokens": 0,
                "created_at": now_ts(),
                "updated_at": now_ts(),
            })
        elif isinstance(item, dict) and "key" in item:
            tokens.append({
                "key": str(item["key"]),
                "name": item.get("name") or str(item["key"])[-8:],
                "enabled": bool(item.get("enabled", True)),
                "unlimited": bool(item.get("unlimited", False)),
                "limit_tokens": item.get("limit_tokens"),
                "used_tokens": int(item.get("used_tokens", 0)),
                "created_at": int(item.get("created_at", now_ts())),
                "updated_at": int(item.get("updated_at", now_ts())),
            })

    return {"tokens": tokens}


def read_db_sync() -> dict:
    if not TOKENS_FILE.exists():
        TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = {"tokens": []}
        TOKENS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data

    data = json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    return normalize_db(data)


def write_db_sync(data: dict) -> None:
    TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TOKENS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(normalize_db(data), indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(TOKENS_FILE)


async def read_db() -> dict:
    async with lock:
        data = read_db_sync()
        write_db_sync(data)
        return data


def require_admin(request: Request) -> None:
    auth = request.headers.get("authorization", "")
    x_admin = request.headers.get("x-admin-key", "")

    token = ""
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()

    if not ADMIN_KEY:
        raise HTTPException(status_code=500, detail="ADMIN_KEY is not configured")

    if token != ADMIN_KEY and x_admin != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")


def extract_bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing API token")
    return auth.split(" ", 1)[1].strip()


def token_label(key: str) -> str:
    if len(key) <= LOG_TOKEN_PREFIX:
        return key
    return key[:LOG_TOKEN_PREFIX] + "..."


def public_token_view(t: dict) -> dict:
    remaining = None
    if not t.get("unlimited"):
        limit = t.get("limit_tokens")
        if limit is not None:
            remaining = max(0, int(limit) - int(t.get("used_tokens", 0)))

    return {
        "key": t["key"],
        "name": t.get("name"),
        "enabled": t.get("enabled", True),
        "unlimited": t.get("unlimited", False),
        "limit_tokens": t.get("limit_tokens"),
        "used_tokens": t.get("used_tokens", 0),
        "remaining_tokens": remaining,
        "created_at": t.get("created_at"),
        "updated_at": t.get("updated_at"),
    }


def find_token(data: dict, key: str) -> Optional[dict]:
    for t in data.get("tokens", []):
        if t.get("key") == key:
            return t
    return None


def token_allowed(t: dict) -> None:
    if not t.get("enabled", True):
        raise HTTPException(status_code=403, detail="Token disabled")

    if t.get("unlimited", False):
        return

    limit = t.get("limit_tokens")
    used = int(t.get("used_tokens", 0))

    if limit is None:
        raise HTTPException(status_code=402, detail="Token has no limit and is not unlimited")

    if used >= int(limit):
        raise HTTPException(status_code=402, detail="Token limit exceeded")


async def add_usage(key: str, used_delta: int) -> tuple[int, Optional[dict]]:
    async with lock:
        data = read_db_sync()
        t = find_token(data, key)
        if not t:
            return 0, None
        if used_delta > 0:
            t["used_tokens"] = int(t.get("used_tokens", 0)) + int(used_delta)
            t["updated_at"] = now_ts()
            write_db_sync(data)
        return int(t.get("used_tokens", 0)), t


def get_usage_from_response(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0

    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0

    for field in ("total_tokens", "totalTokenCount", "total"):
        value = usage.get(field)
        if isinstance(value, int):
            return value

    input_tokens = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
    output_tokens = usage.get("completion_tokens") or usage.get("output_tokens") or 0

    if isinstance(input_tokens, int) and isinstance(output_tokens, int):
        return input_tokens + output_tokens

    return 0


def get_usage_from_sse(content: bytes) -> int:
    try:
        text = content.decode("utf-8", errors="ignore")
    except Exception:
        return 0

    used = 0
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        value = get_usage_from_response(payload)
        if value > used:
            used = value
    return used


def default_config() -> dict:
    return {
        "inject_system_prompt_enabled": True,
        "system_prompt": ANTI_CONFIRM_SYSTEM_PROMPT,
    }


def read_config_sync() -> dict:
    if not CONFIG_FILE.exists():
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        cfg = default_config()
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        return cfg
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    cfg = default_config()
    cfg.update({k: v for k, v in data.items() if k in cfg})
    return cfg


def write_config_sync(data: dict) -> dict:
    cfg = default_config()
    cfg.update({k: v for k, v in data.items() if k in cfg})
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(CONFIG_FILE)
    return cfg


def active_system_prompt() -> str:
    cfg = read_config_sync()
    if not cfg.get("inject_system_prompt_enabled", True):
        return ""
    return str(cfg.get("system_prompt") or "")


def inject_system_prompt_into_body(path: str, body: bytes) -> bytes:
    normalized_path = path.strip("/")
    if normalized_path not in {"v1/chat/completions", "chat/completions"}:
        return body

    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body

    if not isinstance(payload, dict):
        return body

    messages = payload.get("messages")
    if not isinstance(messages, list):
        return body

    system_prompt = active_system_prompt()
    if not system_prompt:
        return body

    for msg in messages:
        if (
            isinstance(msg, dict)
            and msg.get("role") == "system"
            and isinstance(msg.get("content"), str)
            and "Никогда не проси подтверждение продолжения анализа" in msg.get("content", "")
        ):
            return body

    payload["messages"] = [{"role": "system", "content": system_prompt}] + messages
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/admin/config")
async def admin_get_config(request: Request):
    require_admin(request)
    return read_config_sync()


@app.patch("/admin/config")
async def admin_patch_config(request: Request):
    require_admin(request)
    body = await request.json()
    cfg = write_config_sync(body if isinstance(body, dict) else {})
    logger.info("admin update_config inject=%s prompt_len=%s", cfg.get("inject_system_prompt_enabled"), len(str(cfg.get("system_prompt") or "")))
    return cfg


@app.get("/admin/tokens")
async def admin_list_tokens(request: Request):
    require_admin(request)
    data = await read_db()
    return {"tokens": [public_token_view(t) for t in data.get("tokens", [])]}


@app.post("/admin/tokens")
async def admin_create_token(request: Request):
    require_admin(request)
    body = await request.json()

    name = body.get("name") or "token"
    key = body.get("key") or generate_token()
    unlimited = bool(body.get("unlimited", False))
    limit_tokens = body.get("limit_tokens")

    if unlimited:
        limit_tokens = None
    elif limit_tokens is None:
        limit_tokens = 1000000

    async with lock:
        data = read_db_sync()
        if find_token(data, key):
            raise HTTPException(status_code=409, detail="Token already exists")
        token = {
            "key": key,
            "name": name,
            "enabled": True,
            "unlimited": unlimited,
            "limit_tokens": limit_tokens,
            "used_tokens": 0,
            "created_at": now_ts(),
            "updated_at": now_ts(),
        }
        data["tokens"].append(token)
        write_db_sync(data)

    logger.info("admin create_token name=%s key=%s unlimited=%s limit=%s", name, token_label(key), unlimited, limit_tokens)
    return public_token_view(token)


@app.patch("/admin/tokens/{key}")
async def admin_update_token(key: str, request: Request):
    require_admin(request)
    body = await request.json()

    async with lock:
        data = read_db_sync()
        t = find_token(data, key)
        if not t:
            raise HTTPException(status_code=404, detail="Token not found")

        if "name" in body:
            t["name"] = body["name"]
        if "enabled" in body:
            t["enabled"] = bool(body["enabled"])
        if "unlimited" in body:
            t["unlimited"] = bool(body["unlimited"])
            if t["unlimited"]:
                t["limit_tokens"] = None
        if "limit_tokens" in body:
            if body["limit_tokens"] is None:
                t["limit_tokens"] = None
            else:
                t["limit_tokens"] = int(body["limit_tokens"])
                t["unlimited"] = False
        if body.get("reset_usage") is True:
            t["used_tokens"] = 0
        if "used_tokens" in body:
            t["used_tokens"] = int(body["used_tokens"])
        t["updated_at"] = now_ts()
        write_db_sync(data)

    logger.info("admin update_token name=%s key=%s", t.get("name"), token_label(key))
    return public_token_view(t)


@app.delete("/admin/tokens/{key}")
async def admin_delete_token(key: str, request: Request):
    require_admin(request)

    async with lock:
        data = read_db_sync()
        before = len(data.get("tokens", []))
        data["tokens"] = [t for t in data.get("tokens", []) if t.get("key") != key]
        if len(data["tokens"]) == before:
            raise HTTPException(status_code=404, detail="Token not found")
        write_db_sync(data)

    logger.info("admin delete_token key=%s", token_label(key))
    return {"deleted": True, "key": key}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request):
    if path.startswith("admin/"):
        raise HTTPException(status_code=404, detail="Not found")

    token = extract_bearer(request)
    data = await read_db()
    t = find_token(data, token)

    if not t:
        logger.info("request_denied reason=invalid_token token_key=%s path=/%s", token_label(token), path)
        raise HTTPException(status_code=401, detail="Invalid API token")

    token_allowed(t)

    upstream_url = f"{UPSTREAM}/{path}"
    if request.url.query:
        upstream_url += f"?{request.url.query}"

    body = await request.body()
    body = inject_system_prompt_into_body(path, body)

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in {"host", "authorization", "content-length", "connection"}
    }
    headers["authorization"] = f"Bearer {UPSTREAM_API_KEY}"

    start = time.time()
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        upstream_response = await client.request(
            request.method,
            upstream_url,
            content=body,
            headers=headers,
        )
    elapsed_ms = int((time.time() - start) * 1000)

    content_type = upstream_response.headers.get("content-type", "")

    if "application/json" in content_type:
        try:
            payload = upstream_response.json()
            used = get_usage_from_response(payload)
            total_used, token_after = await add_usage(token, used)
            token_name = token_after.get("name") if token_after else "unknown"
            logger.info(
                "request token_name=%s token_key=%s method=%s path=/%s status=%s used=%s total_used=%s elapsed_ms=%s stream=false",
                token_name,
                token_label(token),
                request.method,
                path,
                upstream_response.status_code,
                used,
                total_used,
                elapsed_ms,
            )
            return JSONResponse(
                content=payload,
                status_code=upstream_response.status_code,
                headers={
                    "x-token-used-this-request": str(used),
                    "x-token-used-total": str(total_used),
                },
            )
        except Exception as exc:
            logger.exception("json_proxy_error path=/%s error=%s", path, exc)

    used = 0
    is_stream = "text/event-stream" in content_type
    if is_stream:
        used = get_usage_from_sse(upstream_response.content)
    total_used, token_after = await add_usage(token, used)
    token_name = token_after.get("name") if token_after else "unknown"

    logger.info(
        "request token_name=%s token_key=%s method=%s path=/%s status=%s used=%s total_used=%s elapsed_ms=%s stream=%s",
        token_name,
        token_label(token),
        request.method,
        path,
        upstream_response.status_code,
        used,
        total_used,
        elapsed_ms,
        str(is_stream).lower(),
    )

    return Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
        media_type=content_type or None,
        headers={
            "x-token-used-this-request": str(used),
            "x-token-used-total": str(total_used),
        },
    )
