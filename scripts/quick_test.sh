#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then . ./.env 2>/dev/null || true; fi
TOKEN="${TOKEN:-$(python3 - <<'PY'
import json
from pathlib import Path
p=Path('data/tokens.json')
if p.exists():
    data=json.loads(p.read_text())
    print(data['tokens'][0]['key'])
PY
)}"
if [ -n "${BASE_URL:-}" ]; then
  URL="$BASE_URL"
elif [ -n "${DOMAIN:-}" ]; then
  URL="https://${DOMAIN}"
else
  URL="http://127.0.0.1"
fi
MODEL_ID="${MODEL_ID:-$(grep -E '^MODEL_ID=' config/llama.env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
MODEL_ID="${MODEL_ID:-$(grep -E '^MODEL_ID=' .env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
echo "Testing $URL/v1 with model $MODEL_ID"
time curl -i -s "$URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"model\":\"$MODEL_ID\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Ответь одним словом: работает?\"}]}" \
  | grep -iE 'x-token-used-this-request|x-token-used-total|^\{'
