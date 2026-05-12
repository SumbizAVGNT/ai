#!/usr/bin/env python3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"

SNIPPETS = {
"opencode": '''

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
''',
"claude": '''

  claude-code-proxy:
    build:
      context: ./claude-code-proxy
    container_name: claude-code-proxy
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
''',
"codex": '''

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
'''
}

def enable(name: str):
    service = {"opencode":"opencode-server:","claude":"claude-code-proxy:","codex":"codex-runner:"}[name]
    text = COMPOSE.read_text(encoding="utf-8")
    if service in text:
        print(f"{name} already enabled")
        return
    text = text.rstrip() + SNIPPETS[name] + "\n"
    COMPOSE.write_text(text, encoding="utf-8")
    print(f"enabled {name}")

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "enable" or sys.argv[2] not in SNIPPETS:
        print("Usage: client_manager.py enable opencode|claude|codex", file=sys.stderr)
        sys.exit(2)
    enable(sys.argv[2])
