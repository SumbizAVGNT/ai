# Admin Site Feature Map

Path: `/ui/`

Implemented:

- login/password auth for admin site;
- user create/update/disable/delete;
- Postgres-backed user storage, with install option for local Postgres or external `DATABASE_URL`;
- token CRUD through token-gateway admin API;
- usage counters and limits from token-gateway;
- system prompt editor via `.env` `ANTI_CONFIRM_SYSTEM_PROMPT`;
- llama.cpp config editor via `.env`: `CTX_SIZE`, `THREADS`, `PARALLEL_SLOTS`, `N_GPU_LAYERS`, `LLAMA_TIMEOUT`;
- btop-like cards: CPU, RAM, Docker container status, llama prompt speed, ETA from logs;
- local `.gguf` model list;
- HuggingFace model download by repo/include;
- drag-and-drop `.gguf` upload;
- model switch + llama restart;
- stack start/stop/down/restart/status;
- service logs;
- OpenCode/Codex/Claude enable buttons and setup hints;
- anime style UI with local CSS only, no external image dependencies.

Security note: Admin UI mounts Docker socket and stack directory so it can manage containers and files. Protect `/ui/` with a strong password and preferably a firewall/VPN.
