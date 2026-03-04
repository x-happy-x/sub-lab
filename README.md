# sub-mirror

Сервис зеркалирует подписки, конвертирует форматы (`raw`/`yml`), хранит короткие ссылки, пользователей и сессии в SQLite, и отдает UI (главная, `/admin`, публичная страница `/l/:id`).

В контейнере запускаются:
- Node.js API/UI (`8788`)
- встроенный subconverter (`8787`)

## Что умеет
- Получение подписки с конвертацией (`/sub`).
- Выдача последней успешной версии из кэша (`/last`).
- Короткие ссылки `/l/:id` с публичной страницей подключения.
- Публичные API для страницы шаринга:
  - `/api/public-short-links/:id`
  - `/api/public-short-links/:id/meta`
- Каталог приложений и гайды:
  - `/api/apps`
  - `/api/apps/guide?app=...&os=...`
- Авторизация и роли (`user`/`admin`), админка `/admin`.
- Favorites, mock-sources, профильный редактор.

## Быстрый старт

### Локальная сборка (рекомендуется)
```bash
docker compose -f docker-compose.local.yml up -d --build
```

Доступ:
- `http://localhost:25500` -> приложение (`8788` внутри контейнера)

### GHCR образ
```bash
docker compose up -d
```

Доступ:
- `http://localhost:25500` -> приложение (`8788`)
- `http://localhost:25501` -> subconverter (`8787`, опционально нужен только для прямой отладки)

## Локальный запуск без Docker
Node.js 18+:
```bash
export SUB_URL=""
export OUTPUT="clash"
export CONVERTER_URL="http://127.0.0.1:8787/sub"
export SOURCE_URL="http://127.0.0.1:8788/source.txt"
node app/server.js
```

## Основные эндпоинты

### Публичные/служебные
- `GET /` — SPA (главная).
- `GET /admin` — SPA для admin.
- `GET /health` — `ok`.
- `ANY /debug/echo` — отладочный echo.
- `GET /raw.txt`, `/subscription.yaml`, `/converted.txt`, `/status.json` — debug-файлы из `/data`.

### Подписки
- `GET /sub` — получить подписку (fetch + convert).
- `GET /last` — получить последнюю успешную из кэша.
- `GET /subscription.yaml` — alias на `/sub`.

Параметры:
- `sub_url`
- `output` (`raw`, `clash`, `yml`, `yaml`)
- `app`, `device`
- `profile`, `profiles`
- `hwid`
- legacy: `use_converter`

Пример:
```bash
curl "http://localhost:25500/sub?sub_url=https://example.com/sub&output=raw"
```

### Короткие ссылки
- `POST /api/short-links` (auth)
- `GET /api/short-links/:id` (auth)
- `PUT /api/short-links/:id` (auth)
- `GET /l/:id` (public resolve)

`/l/:id` поддерживает query override:
- `?type=raw`
- `?type=yml`

Это переопределяет `output` для резолва короткой ссылки.

### Публичная страница шаринга
- `GET /api/public-short-links/:id`
- `GET /api/public-short-links/:id/meta`

### Каталог приложений и инструкции
- `GET /api/apps`
- `GET /api/apps/guide?app=<key>&os=<key>`

Конфиг:
- `resources/apps.yml`
- `resources/app-guides/<app>/*.yml`

### Auth и admin
- `GET /api/auth/me`
- `POST /api/auth/login` (`{ username, password }`)
- `POST /api/auth/logout`
- `GET /api/admin/users` (admin)
- `POST /api/admin/users` (admin)
- `PUT /api/admin/users/:username` (admin)
- `DELETE /api/admin/users/:username` (admin)

Ограничения безопасности:
- нельзя удалить текущего admin.
- нельзя сменить роль текущего admin самому себе.

### Прочие API (auth)
- `GET/PUT /api/favorites`
- `POST /api/sub-test`
- `POST /api/mock-sources`
- `GET/PUT /api/mock-sources/:id`
- `GET/POST /api/mock-sources/:id/logs`
- `GET /api/profile-editor/list`
- `GET/PUT/DELETE /api/profile-editor/file`
- `GET /api/ua-catalog`

## Профили и UA

Профили читаются из:
- `PROFILE_DIR` (если задан)
- `/data/profiles`
- `resources/profiles`

Текущий формат профиля:
```yaml
allow_hwid_override: true
headers:
  x-device-os: "Windows"
  x-hwid: "..."
```

Семантика `hwid`:
- `?hwid=...` (из UI/query) всегда имеет приоритет.
- `X-Hwid` из входящих заголовков учитывается только если `allow_hwid_override: true`.

UA каталог:
- `resources/ua-catalog.json`
- выбирается по паре `device + app`, иначе `__default__`.

## Конфигурация (env)
- `SUB_URL` — default источник.
- `OUTPUT` — default output (`raw`/`clash`).
- `USE_CONVERTER` — legacy fallback для default output.
- `CONVERTER_URL` — URL subconverter.
- `SOURCE_URL` — URL source для subconverter.
- `PROFILE_DIR` — каталог профилей.
- `ADMIN_SEED_PATH` — JSON seed admins (по умолчанию `/resources/admin.json` в контейнере).
- `AUTH_SESSION_TTL_SEC` — TTL сессии.
- `APP_PORT`, `SUBCONVERTER_PORT`.

## Bootstrap admin
Если в БД нет пользователей, admin берется из seed-файла (`resources/admin.json`).
Также при старте недостающие admin-пользователи из seed добавляются в существующую БД.

Пример:
```json
{
  "users": [
    { "username": "admin", "password": "StrongPass123", "role": "admin" }
  ]
}
```

## Тесты
```bash
node --test app/server.test.js
```

## CI (GitHub Actions)
- Workflow: `.github/workflows/docker-image.yml`
- На PR выполняются проверки (`backend tests` + `frontend build`) и docker build без push.
- Публикация образа в GHCR выполняется только на `push`.
- Важно: фронтенд использует локальный tarball UI-кита (`frontend/vendor/x-happy-x-ui-kit-*.tgz`), поэтому `frontend/vendor/` должен быть в репозитории.

## Deploy helper
`deploy.sh` синхронизирует проект на remote, поднимает `docker-compose.local.yml` и проверяет `/health`.
