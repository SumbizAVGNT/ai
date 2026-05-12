#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Install Docker Engine + Docker Compose plugin first." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "docker compose plugin is not available." >&2
    exit 1
  fi
}

run_python() {
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
    python3 "$@"
  elif command -v python >/dev/null 2>&1 && python -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
    python "$@"
  elif command -v py >/dev/null 2>&1 && py -3 -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
    py -3 "$@"
  else
    echo "Python 3 is not installed." >&2
    exit 1
  fi
}

install_stack(){ need_docker; run_python scripts/install_wizard.py; }
stop_stack(){ need_docker; docker compose stop; }
down_stack(){ need_docker; docker compose down; }
restart_stack(){ need_docker; docker compose restart; }
status_stack(){ need_docker; docker compose ps; }
logs_stack(){ need_docker; docker compose logs -f --tail=120 "$@"; }
test_stack(){ bash scripts/quick_test.sh; }
issue_cert(){ bash scripts/certbot_issue.sh; }
renew_certs(){ bash scripts/certbot_renew.sh; }
token_admin(){ bash scripts/token_admin.sh "$@"; }
admin_url(){ if [ -f .env ]; then . ./.env 2>/dev/null || true; fi; if [ -n "${DOMAIN:-}" ]; then echo "https://${DOMAIN}/ui"; else echo "http://127.0.0.1/ui or http://127.0.0.1:8088/ui/"; fi; }
doctor_stack(){ need_docker; echo "== compose =="; docker compose ps || true; echo "== health =="; curl -fsS http://127.0.0.1/health || true; echo; echo "== llama =="; curl -fsS http://127.0.0.1:8081/health || true; echo; echo "== admin =="; check_admin_panel || true; echo; }
backup_stack(){ mkdir -p backups; ts=$(date +%Y%m%d-%H%M%S); tar -czf "backups/local-ai-stack-$ts.tar.gz" docker-compose.yml .env admin_key.txt data nginx token-gateway admin-ui scripts config certbot 2>/dev/null || true; echo "Backup: backups/local-ai-stack-$ts.tar.gz"; }
show_admin_credentials(){ run_python scripts/admin_credentials.py show; }
regenerate_admin_credentials(){ run_python scripts/admin_credentials.py regenerate; }

compose_limited() {
  COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}" docker compose "$@"
}

retry_compose() {
  local attempt=1
  local max="${COMPOSE_RETRIES:-3}"
  local rc=0
  while [ "$attempt" -le "$max" ]; do
    if [ "$max" -gt 1 ]; then
      echo
      echo "Docker compose attempt $attempt/$max: docker compose $*"
    fi
    if compose_limited "$@"; then
      return 0
    fi
    rc=$?
    if [ "$attempt" -lt "$max" ]; then
      echo "Docker compose failed. Waiting 15 seconds before retry..."
      sleep 15
    fi
    attempt=$((attempt + 1))
  done
  return "$rc"
}

compose_services() {
  local all=()
  local preferred=(postgres llama-server-coder token-gateway admin-ui nginx)
  local svc item
  mapfile -t all < <(docker compose config --services)
  for svc in "${preferred[@]}"; do
    for item in "${all[@]}"; do
      if [ "$item" = "$svc" ]; then
        echo "$svc"
        break
      fi
    done
  done
}

compose_up_sequential() {
  local recreate="${1:-}"
  local services=()
  local svc
  mapfile -t services < <(compose_services)
  if [ "${#services[@]}" -eq 0 ]; then
    echo "No services found in docker-compose.yml" >&2
    return 1
  fi

  echo "Stopping nginx until admin-ui is ready..."
  compose_limited stop nginx >/dev/null 2>&1 || true

  echo "Starting services one by one (COMPOSE_PARALLEL_LIMIT=${COMPOSE_PARALLEL_LIMIT:-1})"
  for svc in "${services[@]}"; do
    echo
    echo "== Pull $svc =="
    retry_compose pull --ignore-buildable "$svc"
  done

  for svc in "${services[@]}"; do
    echo
    echo "== Build $svc =="
    retry_compose build "$svc"
  done

  for svc in "${services[@]}"; do
    echo
    echo "== Up $svc =="
    if [ "$recreate" = "--force-recreate" ]; then
      retry_compose up -d --no-build --force-recreate "$svc"
    else
      retry_compose up -d --no-build "$svc"
    fi
  done

  check_admin_panel || return 1
}

start_stack(){ need_docker; compose_up_sequential; }
recreate_stack(){ need_docker; compose_up_sequential --force-recreate; }

check_admin_panel() {
  local admin_ok=1
  echo "Checking admin-ui..."
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 8 http://127.0.0.1:8088/ui/ >/dev/null; then
      echo "admin-ui ok: http://127.0.0.1:8088/ui/"
      return 0
    fi
    admin_ok=0
  else
    echo "curl is not installed; skipping HTTP check."
    return 0
  fi

  echo
  echo "admin-ui is not responding. This is what causes nginx 502 Bad Gateway."
  echo "Current containers:"
  docker compose ps admin-ui nginx local-ai-nginx token-gateway postgres llama-server-coder 2>/dev/null || docker compose ps || true
  echo
  echo "Recent admin-ui logs:"
  docker compose logs --tail=80 admin-ui 2>/dev/null || true
  echo
  echo "Recent nginx logs:"
  docker compose logs --tail=80 nginx local-ai-nginx 2>/dev/null || true
  return "$admin_ok"
}

pause_menu() {
  printf "\nPress Enter to continue..."
  read -r _ || true
}

read_choice() {
  local __var="$1"
  local prompt="${2:-Choose: }"
  local value=""
  if ! read -r -p "$prompt" value; then
    return 1
  fi
  value="${value//$'\r'/}"
  printf -v "$__var" "%s" "$value"
}

read_required() {
  local prompt="$1"
  local value=""
  while [ -z "$value" ]; do
    read -r -p "$prompt: " value || return 1
    value="${value//$'\r'/}"
  done
  printf "%s" "$value"
}

logs_menu() {
  while true; do
    cat <<'EOF'

Logs
  1) Filtered stack logs
  2) All docker compose logs
  3) nginx
  4) token-gateway
  5) llama-server-coder
  6) admin-ui
  7) postgres
  0) Back
EOF
    read_choice c "Choose: " || return
    case "$c" in
      1) ./scripts/logs.sh ;;
      2) logs_stack ;;
      3) logs_stack nginx ;;
      4) logs_stack token-gateway ;;
      5) logs_stack llama-server-coder ;;
      6) logs_stack admin-ui ;;
      7) logs_stack postgres ;;
      0|q|quit|exit) return ;;
      *) echo "Unknown choice"; pause_menu ;;
    esac
  done
}

token_menu() {
  while true; do
    cat <<'EOF'

Token admin
  1) List tokens
  2) Create unlimited token
  3) Create limited token
  4) Set token limit
  5) Make token unlimited
  6) Reset token usage
  7) Enable token
  8) Disable token
  9) Delete token
  0) Back
EOF
    read_choice c "Choose: " || return
    case "$c" in
      1) token_admin list; pause_menu ;;
      2)
        name="$(read_required "Token name")"
        token_admin create "$name" unlimited
        pause_menu
        ;;
      3)
        name="$(read_required "Token name")"
        limit="$(read_required "Token limit")"
        token_admin create "$name" "$limit"
        pause_menu
        ;;
      4)
        key="$(read_required "Token key")"
        limit="$(read_required "Token limit")"
        token_admin limit "$key" "$limit"
        pause_menu
        ;;
      5) key="$(read_required "Token key")"; token_admin unlimited "$key"; pause_menu ;;
      6) key="$(read_required "Token key")"; token_admin reset "$key"; pause_menu ;;
      7) key="$(read_required "Token key")"; token_admin enable "$key"; pause_menu ;;
      8) key="$(read_required "Token key")"; token_admin disable "$key"; pause_menu ;;
      9) key="$(read_required "Token key")"; token_admin delete "$key"; pause_menu ;;
      0|q|quit|exit) return ;;
      *) echo "Unknown choice"; pause_menu ;;
    esac
  done
}

admin_menu() {
  while true; do
    cat <<'EOF'

Admin panel
  1) Show admin URL
  2) Show saved login/password
  3) Regenerate login/password
  4) Restart admin-ui
  0) Back
EOF
    read_choice c "Choose: " || return
    case "$c" in
      1) admin_url; pause_menu ;;
      2) show_admin_credentials; pause_menu ;;
      3) regenerate_admin_credentials; pause_menu ;;
      4) need_docker; docker compose restart admin-ui; pause_menu ;;
      0|q|quit|exit) return ;;
      *) echo "Unknown choice"; pause_menu ;;
    esac
  done
}

main_menu() {
  while true; do
    cat <<'EOF'

Local AI Stack
  1) Install / configure
  2) Start
  3) Stop
  4) Down
  5) Restart
  6) Recreate containers
  7) Status
  8) Logs
  9) Quick test
 10) Token admin
 11) Admin panel
 12) Issue SSL certificate
 13) Renew SSL certificates
 14) Backup
 15) Doctor
  0) Exit
EOF
    read_choice c "Choose: " || exit 0
    case "$c" in
      1) install_stack; pause_menu ;;
      2) start_stack || true; pause_menu ;;
      3) stop_stack; pause_menu ;;
      4) down_stack; pause_menu ;;
      5) restart_stack; pause_menu ;;
      6) recreate_stack || true; pause_menu ;;
      7) status_stack; pause_menu ;;
      8) logs_menu ;;
      9) test_stack; pause_menu ;;
      10) token_menu ;;
      11) admin_menu ;;
      12) issue_cert; pause_menu ;;
      13) renew_certs; pause_menu ;;
      14) backup_stack; pause_menu ;;
      15) doctor_stack || true; pause_menu ;;
      0|q|quit|exit) exit 0 ;;
      *) echo "Unknown choice"; pause_menu ;;
    esac
  done
}

cmd="${1:-menu}"
case "$cmd" in
  install|configure|setup) install_stack ;;
  start|up) start_stack ;;
  stop) stop_stack ;;
  down) down_stack ;;
  restart) restart_stack ;;
  recreate) recreate_stack ;;
  status|ps) status_stack ;;
  logs) shift || true; if [ "$#" -gt 0 ]; then logs_stack "$@"; else ./scripts/logs.sh; fi ;;
  quick-test|test) test_stack ;;
  token-admin) shift || true; token_admin "$@" ;;
  cert) issue_cert ;;
  admin) admin_url ;;
  admin-credentials|credentials) show_admin_credentials ;;
  admin-regenerate|regenerate-admin) regenerate_admin_credentials ;;
  doctor) doctor_stack ;;
  renew) renew_certs ;;
  backup) backup_stack ;;
  help|-h|--help)
    cat <<'EOF'
Usage: ./install.sh [command]

Commands:
  install       Interactive install wizard
  start         pull/build/start core services one by one
  stop          docker compose stop
  down          docker compose down
  restart       docker compose restart
  recreate      rebuild and recreate core services one by one
  status        docker compose ps
  logs [svc...] follow logs
  quick-test    test /v1/chat/completions
  token-admin   token helper CLI
  cert          issue Let's Encrypt cert
  admin         print admin UI URL
  credentials   print saved admin login/password
  regenerate-admin
                regenerate admin login/password
  doctor        basic diagnostics
  renew         renew Let's Encrypt certs
  backup        archive important configs

Run ./install.sh without arguments to open the numbered menu.
EOF
    ;;
  menu) main_menu ;;
  *) echo "Unknown command: $cmd" >&2; echo "Run ./install.sh help" >&2; exit 1 ;;
esac
