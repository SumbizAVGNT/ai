import os
import time
import uuid
import logging
from typing import Any

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://token-gateway:9000/v1").rstrip("/")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "sk-stack-default")
MODEL_NAME = os.getenv("MODEL_NAME", "qwen2.5-coder-14b-instruct-q4_k_m.gguf")
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "1200"))
DISABLE_TOOLS = os.getenv("DISABLE_TOOLS", "true").lower() in {"1", "true", "yes"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s claude-code-proxy %(message)s")
logger = logging.getLogger("claude-code-proxy")

app = FastAPI(title="Claude Messages to OpenAI Proxy", version="1.0.0")


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
                elif block.get("type") == "tool_result":
                    parts.append(str(block.get("content", "")))
        return "\n".join(p for p in parts if p)
    return str(content)


def build_openai_messages(body: dict) -> list[dict]:
    messages: list[dict] = []
    system = body.get("system")
    if system:
        if isinstance(system, str):
            messages.append({"role": "system", "content": system})
        elif isinstance(system, list):
            messages.append({"role": "system", "content": content_to_text(system)})

    for msg in body.get("messages", []):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "user")
        if role not in {"user", "assistant", "system"}:
            role = "user"
        messages.append({"role": role, "content": content_to_text(msg.get("content"))})

    if not messages:
        messages.append({"role": "user", "content": ""})
    return messages


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()
    max_tokens = int(body.get("max_tokens", 1024))
    payload = {
        "model": MODEL_NAME,
        "messages": build_openai_messages(body),
        "max_tokens": max_tokens,
        "temperature": body.get("temperature", 0.2),
        "stream": False,
    }

    if not DISABLE_TOOLS and body.get("tools"):
        # llama.cpp grammar/tool compatibility varies; keep opt-in only.
        payload["tools"] = body.get("tools")
        if body.get("tool_choice"):
            payload["tool_choice"] = body.get("tool_choice")

    start = time.time()
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        r = await client.post(
            f"{OPENAI_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
    elapsed_ms = int((time.time() - start) * 1000)

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    data = r.json()
    choice = data.get("choices", [{}])[0]
    message = choice.get("message", {})
    text = message.get("content") or ""
    usage = data.get("usage", {}) if isinstance(data.get("usage"), dict) else {}

    logger.info("request status=%s elapsed_ms=%s input=%s output=%s", r.status_code, elapsed_ms, usage.get("prompt_tokens"), usage.get("completion_tokens"))

    return JSONResponse({
        "id": data.get("id") or f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "model": body.get("model", MODEL_NAME),
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    })
