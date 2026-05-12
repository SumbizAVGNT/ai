# Clients

## OpenCode

Рекомендуемый клиент для этого стека. Настраивается как OpenAI-compatible provider.

## Claude Code

Можно использовать через `claude-code-proxy`, но это экспериментально и может быть медленно из-за больших prompts/tools.

## Codex

Официальный OpenAI Codex CLI требует OpenAI account/API key. В пакете есть helper контейнер, но локальный llama.cpp endpoint не является полноценной заменой Codex backend.
