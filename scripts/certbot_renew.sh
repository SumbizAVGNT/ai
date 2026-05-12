#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm certbot renew --webroot -w /var/www/certbot
docker compose exec nginx nginx -s reload || docker compose restart nginx
