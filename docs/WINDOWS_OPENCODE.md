# OpenCode на Windows

1. Установить Node.js LTS.
2. В CMD/PowerShell:

```bat
npm install -g opencode-ai
opencode --version
```

3. Запустить сервер:

```bat
set OPENCODE_SERVER_USERNAME=opencode
set OPENCODE_SERVER_PASSWORD=12345
opencode serve --hostname 127.0.0.1 --port 4096
```

4. В OpenCode Desktop добавить сервер:

```
URL: http://localhost:4096
username: opencode
password: 12345
```

5. Провайдер модели:

```
Provider ID: local-qwen
Base URL: https://YOUR_DOMAIN/v1
API Key: token from token gateway
Model ID: qwen2.5-coder-14b-instruct-q4_k_m.gguf
```
