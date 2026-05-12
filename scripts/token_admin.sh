#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${DOMAIN:-$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
if [ -n "${BASE_URL:-}" ]; then
  BASE_URL="$BASE_URL"
elif [ -n "$DOMAIN" ]; then
  BASE_URL="https://${DOMAIN}"
else
  BASE_URL="http://127.0.0.1"
fi
ADMIN_KEY="${ADMIN_KEY:-$(cat admin_key.txt 2>/dev/null || true)}"
cmd="${1:-help}"
shift || true
case "$cmd" in
  list)
    curl -s "$BASE_URL/admin/tokens" -H "Authorization: Bearer $ADMIN_KEY"; echo ;;
  create)
    name="${1:-user}"
    limit="${2:-}"
    if [ -z "$limit" ] || [ "$limit" = "unlimited" ]; then
      body="{\"name\":\"$name\",\"unlimited\":true}"
    else
      body="{\"name\":\"$name\",\"unlimited\":false,\"limit_tokens\":$limit}"
    fi
    curl -s -X POST "$BASE_URL/admin/tokens" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d "$body"; echo ;;
  disable|enable)
    key="${1:?token key required}"
    enabled=false; [ "$cmd" = "enable" ] && enabled=true
    curl -s -X PATCH "$BASE_URL/admin/tokens/$key" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d "{\"enabled\":$enabled}"; echo ;;
  limit)
    key="${1:?token key required}"; limit="${2:?limit required}"
    curl -s -X PATCH "$BASE_URL/admin/tokens/$key" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d "{\"unlimited\":false,\"limit_tokens\":$limit}"; echo ;;
  unlimited)
    key="${1:?token key required}"
    curl -s -X PATCH "$BASE_URL/admin/tokens/$key" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"unlimited":true}'; echo ;;
  reset)
    key="${1:?token key required}"
    curl -s -X PATCH "$BASE_URL/admin/tokens/$key" -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"reset_usage":true}'; echo ;;
  delete)
    key="${1:?token key required}"
    curl -s -X DELETE "$BASE_URL/admin/tokens/$key" -H "Authorization: Bearer $ADMIN_KEY"; echo ;;
  *)
    cat <<EOF
Usage:
  scripts/token_admin.sh list
  scripts/token_admin.sh create "Name" unlimited
  scripts/token_admin.sh create "Name" 100000
  scripts/token_admin.sh limit TOKEN 200000
  scripts/token_admin.sh unlimited TOKEN
  scripts/token_admin.sh reset TOKEN
  scripts/token_admin.sh disable TOKEN
  scripts/token_admin.sh enable TOKEN
  scripts/token_admin.sh delete TOKEN
EOF
    ;;
esac
