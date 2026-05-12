# Migration from old ai.zip

Old `ai.zip` only had compose/backups/certbot folders. It did not include:

- `token-gateway/server.py`
- `token-gateway/Dockerfile`
- `token-gateway/requirements.txt`
- `nginx/default.conf`
- model installer/manager
- scripts for tokens/logs/certbot

This package is a clean full replacement. Recommended install:

```bash
cp -a /home/local-ai-stack /home/local-ai-stack.backup.$(date +%s)
unzip local-ai-stack-complete.zip -d /home/local-ai-stack-new
cd /home/local-ai-stack-new/local-ai-stack-complete
./install.sh
```

Do not copy old certbot private keys unless you really need to preserve the same certificate. The installer can issue new Let's Encrypt certs automatically.
