#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-all}"
case "$what" in
  llama)
    docker compose logs -f --tail=0 llama-server-coder | grep -E "task.n_tokens|prompt processing|prompt eval time|eval time|total time|done request|error|failed" ;;
  gateway)
    docker compose logs -f --tail=100 token-gateway ;;
  admin)
    docker compose logs -f --tail=100 admin-ui ;;
  nginx)
    docker compose logs -f --tail=100 nginx ;;
  db|postgres)
    docker compose logs -f --tail=100 postgres ;;
  *)
    docker compose logs -f --tail=100 admin-ui token-gateway nginx llama-server-coder \
      | grep -E "admin-ui|token-gateway request|POST /v1|GET /v1|task.n_tokens|total time|done request|401|402|403|429|500|error|failed" ;;
esac
