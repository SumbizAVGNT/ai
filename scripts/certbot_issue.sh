#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:?domain required}"
EMAIL="${2:?email required}"
python3 - <<PY
from pathlib import Path
import sys
sys.path.insert(0, str(Path('scripts').resolve()))
from install_wizard import nginx_conf
Path('nginx/default.conf').write_text(nginx_conf('$DOMAIN', ssl=False), encoding='utf-8')
PY
docker compose up -d nginx
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
python3 - <<PY
from pathlib import Path
import sys
sys.path.insert(0, str(Path('scripts').resolve()))
from install_wizard import nginx_conf
Path('nginx/default.conf').write_text(nginx_conf('$DOMAIN', ssl=True), encoding='utf-8')
PY
docker compose up -d --force-recreate nginx
