# Models

Каталог лежит в `config/models.catalog.json`. Он специально маленький и стабильный.

Для добавления модели внеси объект:

```json
{
  "id": "my-model",
  "title": "My Model",
  "repo": "owner/repo-GGUF",
  "include": "model-q4_k_m.gguf",
  "local_dir": "owner/repo-GGUF",
  "ctx": 32768,
  "recommended": "notes"
}
```

Потом:

```bash
./scripts/model_manager.py list-catalog
./scripts/model_manager.py download-catalog N --switch
```
