#!/usr/bin/env python3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1].replace('\\"', '"')
        values[key.strip()] = value
    return values


def main() -> int:
    sys.path.insert(0, str((ROOT / "scripts").resolve()))
    from install_wizard import nginx_conf

    env = read_env()
    domain = env.get("DOMAIN", "").strip()
    ssl = bool(domain and (ROOT / "certbot" / "conf" / "live" / domain / "fullchain.pem").exists())
    target = ROOT / "nginx" / "default.conf"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(nginx_conf(domain, ssl=ssl), encoding="utf-8")
    print(f"nginx/default.conf regenerated: domain={domain or '_'} ssl={str(ssl).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
