# Local AI Stack Complete + Admin UI

Полный переносимый стек для OpenAI-compatible API поверх `llama.cpp` с красивой web-админкой, PostgreSQL, токенами, лимитами, управлением моделями и сервисами.

```
OpenCode / Codex / curl / any OpenAI-compatible client
        -> nginx
        -> token-gateway
        -> llama-server-coder

Admin browser
        -> nginx /ui
        -> admin-ui
        -> postgres + docker socket + token-gateway admin API
```

## Быстрый старт

```bash
unzip local-ai-stack-complete-admin.zip
cd local-ai-stack-admin
./install.sh install
```

Установщик спросит:

1. backend llama.cpp: CPU / NVIDIA CUDA / AMD ROCm / Vulkan;
2. full GPU или hybrid через `--n-gpu-layers`;
3. модель из каталога HuggingFace или кастомный GGUF;
4. создать PostgreSQL контейнер или подключиться к существующему PostgreSQL;
5. домен, email и выпуск SSL сертификата;
6. admin login/password;
7. клиенты: OpenCode, Claude Code proxy, Codex helper.

## install.sh меню и команды

```bash
./install.sh             # интерактивное меню 1/2/3...
./install.sh install     # интерактивная установка
./install.sh start       # docker compose up -d --build
./install.sh stop        # docker compose stop
./install.sh restart     # docker compose restart
./install.sh down        # docker compose down
./install.sh status      # docker compose ps
./install.sh logs [svc]  # логи всех сервисов или одного
./install.sh quick-test  # тест /v1/chat/completions
./install.sh token-admin # CLI helper для токенов
./install.sh credentials # показать логин/пароль админки
./install.sh regenerate-admin # перегенерировать логин/пароль админки
./install.sh cert        # выпуск сертификата
```

После установки логин и пароль админ-панели печатаются в терминал и сохраняются в
`admin_login.txt`. В меню это доступно через `Admin panel -> Show saved login/password`;
там же можно выбрать `Regenerate login/password`.

## Обновления из GitHub

В админке есть вкладка `Updates`. Она проверяет `origin/main`, показывает текущий
commit и последнюю версию на GitHub. Если есть новая версия, появляется кнопка
`Загрузить и перезапустить`: она делает fast-forward update из репозитория,
пересобирает контейнеры через `docker compose up -d --build` и перезапускает стек.

Если в рабочей папке есть незакоммиченные локальные изменения, автообновление
блокируется, чтобы не потерять правки.

## Web admin

После установки обычно:

```text
https://YOUR_DOMAIN/ui/
```

или локально:

```text
http://127.0.0.1/ui/
```

В админке есть:

- авторизация;
- создание пользователей;
- смена логина/пароля;
- токены: создать, удалить, включить/выключить, лимит, безлимит, сброс расхода;
- просмотр `used_tokens`, `remaining_tokens`, `x-token-used-total`;
- настройка system prompt, который автоматически добавляется в запросы;
- загрузка GGUF через браузер;
- загрузка модели с HuggingFace repo/include;
- список локальных моделей;
- переключение active model через `MODEL_PATH` в `.env` и restart llama;
- настройка llama.cpp: `-c`, `-t`, `-np`, `--n-gpu-layers`, timeout, extra args;
- restart/start/stop сервисов;
- btop-like мониторинг контейнеров;
- llama throughput и estimated prompt time;
- логи nginx/token-gateway/llama/admin/postgres;
- подсказки для OpenCode / Claude Code / Codex.

Админка оформлена в автономном anime-style CSS без внешних картинок и без copyrighted assets.

## API

Список моделей:

```bash
curl https://YOUR_DOMAIN/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Chat completions:

```bash
curl https://YOUR_DOMAIN/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "model":"qwen2.5-coder-14b-instruct-q4_k_m.gguf",
    "messages":[{"role":"user","content":"Ответь одним словом: работает?"}],
    "max_tokens":8
  }'
```

Ответ содержит headers:

```text
x-token-used-this-request: 41
x-token-used-total: 136009
```

## OpenCode

В OpenCode provider:

```text
Provider: OpenAI Compatible
Base URL: https://YOUR_DOMAIN/v1
API Key: token from admin UI
Model: active GGUF filename
```

Если включил контейнер OpenCode server:

```bash
docker compose --profile tools up -d opencode-server
```

Desktop server:

```text
http://localhost:4096
username: opencode
password: opencode
```

На Windows часто удобнее локально:

```bat
npm install -g opencode-ai
set OPENCODE_SERVER_USERNAME=opencode
set OPENCODE_SERVER_PASSWORD=12345
opencode serve --hostname 127.0.0.1 --port 4096
```

## Codex

Codex helper есть в compose как profile service:

```bash
docker compose --profile tools run --rm codex-runner
```

Ему нужен OpenAI account/API key. В админке есть страница с подсказками.

## Claude Code proxy

Есть экспериментальный proxy:

```bash
docker compose --profile claude up -d claude-code-proxy
```

Для локальных llama.cpp моделей чаще лучше OpenCode. Claude Code может слать огромный tool/system context и тормозить на CPU.

## Модели через CLI

```bash
./scripts/model_manager.py list-catalog
./scripts/model_manager.py download-catalog 2 --switch
./scripts/model_manager.py search "Qwen coder GGUF" --limit 10
./scripts/model_manager.py local
./scripts/model_manager.py switch ./models/path/to/model.gguf --restart
```

## Безопасность

- `/v1/*` требует Bearer token.
- `/admin/*` требует `ADMIN_KEY`.
- `/ui/*` требует логин/пароль admin-ui.
- Не публикуй `.env`, `admin_key.txt`, `data/tokens.json`.
- Admin UI монтирует Docker socket, поэтому не выставляй `/ui` публично без сильного пароля/VPN/фаервола.

## Скорость

На CPU большие agent prompts на 10k+ токенов будут медленными. Для OpenCode:

- CPU: лучше 3B/7B coder;
- 8GB VRAM: 7B Q4/Q5 комфортнее 14B;
- 12GB+ VRAM: 14B Q4 уже реальнее;
- RTX 3060 12GB минимум, RTX 4060 Ti 16GB комфортнее, RTX 3090 24GB отлично.
