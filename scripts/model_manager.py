#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "config" / "models.catalog.json"
MODELS_DIR = Path(os.getenv("MODELS_DIR", str(ROOT / "models"))).resolve()
ENV_FILE = ROOT / ".env"
LLAMA_ENV_FILE = ROOT / "config" / "llama.env"


def load_catalog():
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def ensure_hf_cli():
    if shutil.which("hf"):
        return "hf"
    print("hf CLI not found. Installing huggingface_hub...", file=sys.stderr)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-U", "huggingface_hub"])
    if not shutil.which("hf"):
        raise SystemExit("hf CLI still not found. Reopen shell or install huggingface_hub manually.")
    return "hf"


def run(cmd):
    print("+ " + " ".join(map(str, cmd)))
    subprocess.check_call(list(map(str, cmd)))


def find_gguf(local_dir: Path, include: str | None = None) -> Path:
    if include:
        exact = local_dir / include
        if exact.exists():
            return exact
    files = sorted(local_dir.rglob("*.gguf"), key=lambda p: p.stat().st_size if p.exists() else 0, reverse=True)
    if not files:
        raise SystemExit(f"No .gguf files found in {local_dir}")
    return files[0]


def update_env(key: str, value: str):
    lines = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    out = []
    found = False
    for line in lines:
        if line.startswith(key + "="):
            out.append(f'{key}="{value}"')
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f'{key}="{value}"')
    ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")


def list_catalog(_args):
    for i, item in enumerate(load_catalog(), start=1):
        print(f"{i}. {item['id']} | {item['title']} | {item['recommended']}")


def download_catalog(args):
    catalog = load_catalog()
    item = catalog[int(args.index) - 1]
    return download(item["repo"], item["include"], item["local_dir"], switch=args.switch)


def download(repo: str, include: str, local_dir: str, switch: bool = False):
    hf = ensure_hf_cli()
    dest = MODELS_DIR / local_dir
    dest.mkdir(parents=True, exist_ok=True)
    run([hf, "download", repo, "--include", include, "--local-dir", dest])
    gguf = find_gguf(dest, include)
    print(f"Downloaded: {gguf}")
    if switch:
        switch_model_path(gguf)
    return gguf


def download_custom(args):
    download(args.repo, args.include, args.local_dir, switch=args.switch)


def search(args):
    query = urllib.parse.urlencode({"search": args.query, "filter": "gguf", "limit": str(args.limit)})
    url = f"https://huggingface.co/api/models?{query}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for item in data:
        print(item.get("modelId"))


def update_llama_env(key: str, value: str):
    lines = []
    if LLAMA_ENV_FILE.exists():
        lines = LLAMA_ENV_FILE.read_text(encoding="utf-8").splitlines()
    out = []
    found = False
    for line in lines:
        if line.startswith(key + "="):
            out.append(f'{key}="{value}"')
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f'{key}="{value}"')
    LLAMA_ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    LLAMA_ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")


def switch_model_path(path: Path):
    path = path.resolve()
    try:
        rel = path.relative_to(MODELS_DIR)
    except ValueError:
        raise SystemExit(f"Model must be inside MODELS_DIR={MODELS_DIR}")
    current = MODELS_DIR / "current.gguf"
    if current.exists() or current.is_symlink():
        current.unlink()
    current.symlink_to(rel)
    update_llama_env("MODEL_PATH", "/models/current.gguf")
    update_llama_env("MODEL_ID", path.name)
    update_env("MODEL_PATH", "/models/current.gguf")
    update_env("MODEL_ID", path.name)
    print(f"Active model set to /models/current.gguf -> {rel}")


def switch(args):
    switch_model_path(Path(args.path))
    if args.restart:
        run(["docker", "compose", "restart", "llama-server-coder"])


def local_models(_args):
    for p in sorted(MODELS_DIR.rglob("*.gguf")):
        print(p)


def main():
    ap = argparse.ArgumentParser(description="Model manager for local-ai-stack")
    sub = ap.add_subparsers(required=True)

    p = sub.add_parser("list-catalog")
    p.set_defaults(func=list_catalog)

    p = sub.add_parser("download-catalog")
    p.add_argument("index")
    p.add_argument("--switch", action="store_true")
    p.set_defaults(func=download_catalog)

    p = sub.add_parser("download-custom")
    p.add_argument("repo")
    p.add_argument("include")
    p.add_argument("local_dir")
    p.add_argument("--switch", action="store_true")
    p.set_defaults(func=download_custom)

    p = sub.add_parser("search")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=search)

    p = sub.add_parser("local")
    p.set_defaults(func=local_models)

    p = sub.add_parser("switch")
    p.add_argument("path")
    p.add_argument("--restart", action="store_true")
    p.set_defaults(func=switch)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
