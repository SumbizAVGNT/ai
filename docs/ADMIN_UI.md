# Admin UI

Admin UI находится на `/ui` выбранного домена и работает через PostgreSQL.

## Возможности

- пользователи админки;
- токены gateway;
- лимиты/безлимиты;
- учёт расхода;
- prompt injection;
- модели GGUF: upload/download/switch;
- настройки llama.cpp;
- сервисы Docker;
- btop-like monitoring;
- логи.

## PostgreSQL

Установщик может:

1. создать внутренний контейнер `postgres`;
2. подключиться к внешнему PostgreSQL через `DATABASE_URL`.

Формат:

```text
postgresql://user:password@host:5432/localai
```

## Первый пользователь

Создаётся при первом запуске admin-ui из `.env`:

```text
ADMIN_UI_USER
ADMIN_UI_PASSWORD
```

После входа пароль можно сменить в Users.
