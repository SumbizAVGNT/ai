#!/usr/bin/env python3
import argparse
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
LOGIN_FILE = ROOT / "admin_login.txt"
ADMIN_KEY_FILE = ROOT / "admin_key.txt"

ENV_KEYS = (
    "ADMIN_WEB_USERNAME",
    "ADMIN_WEB_PASSWORD",
    "ADMIN_UI_USER",
    "ADMIN_UI_PASSWORD",
    "ADMIN_WEB_SECRET",
    "ADMIN_UI_SECRET",
)

CONTAINER_UPDATE_CODE = r"""
import os
import time
from sqlalchemy import select

from app import Base, SessionLocal, User, engine, hash_password

username = os.environ["NEW_ADMIN_USERNAME"]
password = os.environ["NEW_ADMIN_PASSWORD"]
old_username = os.environ.get("OLD_ADMIN_USERNAME") or username

Base.metadata.create_all(bind=engine)
with SessionLocal() as db:
    user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if user is None and old_username != username:
        user = db.execute(select(User).where(User.username == old_username)).scalar_one_or_none()
    if user is None:
        user = db.execute(select(User).where(User.is_admin == True).order_by(User.id)).scalars().first()
    if user is None:
        user = User(username=username, password_hash=hash_password(password), is_admin=True, enabled=True)
        db.add(user)
    else:
        user.username = username
        user.password_hash = hash_password(password)
        user.is_admin = True
        user.enabled = True
        user.updated_at = int(time.time())
    db.commit()
"""


def unquote_env(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1].replace('\\"', '"')
    return value


def quote_env(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = unquote_env(value)
    return values


def write_env(updates: dict[str, str]) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    out: list[str] = []
    seen: set[str] = set()

    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in raw:
            out.append(raw)
            continue
        key = raw.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={quote_env(updates[key])}")
            seen.add(key)
        else:
            out.append(raw)

    for key in ENV_KEYS:
        if key in updates and key not in seen:
            out.append(f"{key}={quote_env(updates[key])}")

    ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")


def admin_url(env: dict[str, str]) -> str:
    domain = env.get("DOMAIN", "").strip()
    if domain:
        return f"https://{domain}/ui/"
    return "http://127.0.0.1/ui/"


def read_admin_key(env: dict[str, str]) -> str:
    if env.get("ADMIN_KEY"):
        return env["ADMIN_KEY"]
    if ADMIN_KEY_FILE.exists():
        return ADMIN_KEY_FILE.read_text(encoding="utf-8").strip()
    return ""


def write_login_file(env: dict[str, str], username: str, password: str) -> None:
    lines = [
        f"URL: {admin_url(env)}",
        f"login: {username}",
        f"password: {password}",
    ]
    if env.get("DEFAULT_TOKEN"):
        lines.append(f"API token: {env['DEFAULT_TOKEN']}")
    admin_key = read_admin_key(env)
    if admin_key:
        lines.append(f"Admin key: {admin_key}")
    LOGIN_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def saved_username(env: dict[str, str]) -> str:
    return env.get("ADMIN_WEB_USERNAME") or env.get("ADMIN_UI_USER") or "admin"


def saved_password(env: dict[str, str]) -> str:
    return env.get("ADMIN_WEB_PASSWORD") or env.get("ADMIN_UI_PASSWORD") or ""


def show_credentials() -> int:
    env = parse_env()
    if LOGIN_FILE.exists():
        print(LOGIN_FILE.read_text(encoding="utf-8").strip())
        return 0

    username = saved_username(env)
    password = saved_password(env)
    if not password:
        print("Admin credentials were not found. Run ./install.sh install or regenerate them.")
        return 1

    write_login_file(env, username, password)
    print(LOGIN_FILE.read_text(encoding="utf-8").strip())
    return 0


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def docker_service_running(service: str) -> bool:
    if not shutil.which("docker"):
        return False
    proc = subprocess.run(
        ["docker", "compose", "ps", "-q", service],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    return proc.returncode == 0 and bool(proc.stdout.strip())


def update_running_admin_db(username: str, password: str, old_username: str) -> bool:
    if not docker_service_running("admin-ui"):
        print("admin-ui container is not running; .env was updated.")
        print("If this stack already has an admin database, start it and run regeneration again to update the DB user.")
        return False

    cmd = [
        "docker",
        "compose",
        "exec",
        "-T",
        "-e",
        f"NEW_ADMIN_USERNAME={username}",
        "-e",
        f"NEW_ADMIN_PASSWORD={password}",
        "-e",
        f"OLD_ADMIN_USERNAME={old_username}",
        "admin-ui",
        "python",
        "-c",
        CONTAINER_UPDATE_CODE,
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    if proc.returncode == 0:
        print("admin-ui database user was updated.")
        return True

    print("Could not update admin-ui database user.", file=sys.stderr)
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return False


def regenerate(args: argparse.Namespace) -> int:
    env = parse_env()
    old_username = saved_username(env)

    username = args.username or old_username
    password = args.password or secrets.token_urlsafe(16)

    if sys.stdin.isatty() and not args.yes:
        username = ask("Admin login", username)
        entered = ask("Admin password (empty = generate new)", "")
        if entered:
            password = entered

    secret = env.get("ADMIN_WEB_SECRET") or env.get("ADMIN_UI_SECRET") or secrets.token_urlsafe(48)
    updates = {
        "ADMIN_WEB_USERNAME": username,
        "ADMIN_WEB_PASSWORD": password,
        "ADMIN_UI_USER": username,
        "ADMIN_UI_PASSWORD": password,
        "ADMIN_WEB_SECRET": secret,
        "ADMIN_UI_SECRET": secret,
    }
    write_env(updates)

    refreshed_env = parse_env()
    write_login_file(refreshed_env, username, password)

    db_updated = False
    if not args.no_db:
        db_updated = update_running_admin_db(username, password, old_username)

    print()
    print("Admin panel credentials")
    print(f"URL: {admin_url(refreshed_env)}")
    print(f"login: {username}")
    print(f"password: {password}")
    print(f"saved_to: {LOGIN_FILE}")
    if not db_updated and not args.no_db:
        print("database: not updated yet")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Show or regenerate Local AI admin credentials.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("show", help="Print saved admin credentials.")

    regen = sub.add_parser("regenerate", help="Regenerate admin login/password.")
    regen.add_argument("--username", help="New admin username.")
    regen.add_argument("--password", help="New admin password. Generated when omitted.")
    regen.add_argument("--no-db", action="store_true", help="Only update .env and admin_login.txt.")
    regen.add_argument("-y", "--yes", action="store_true", help="Do not prompt; generate with defaults.")

    args = parser.parse_args()
    if args.command == "show":
        return show_credentials()
    if args.command == "regenerate":
        return regenerate(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
