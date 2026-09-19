# sub-lab

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
- Авторизация и роли account (`viewer`/`editor`/`admin`), админка `/admin`.
- Favorites, mock-sources, профильный редактор.

## Роли и интерфейс

Роль приходит из account (группа `sub_mirror_*`) и определяет и то, что видно в
интерфейсе, и то, что примет сервер.

| Роль | Что видит |
| --- | --- |
| `viewer` | Только список подписок: свои и выданные ему. Скопировать ссылку и открыть страницу подключения. Ничего не создаёт и не меняет. |
| `editor` | Свой список, короткая форма добавления и изменения: название, источник, формат, ОС, приложение. Резервная копия и восстановление. |
| `admin` | Всё вышеперечисленное плюс полный конструктор (короткая ссылка, теги, скрытие, режим серверов, группы Clash, профили, HWID), массовый импорт, объединение, тест приложения, overrides, устройства подписки, выдача доступов и `/admin`. |

Подписка, выданная через доступ к короткой ссылке, появляется в списке сама и
помечается «выдана вам»: она не хранится в списке получателя, а собирается на
каждый запрос, поэтому отзыв доступа убирает её сразу.

Страница подключения `/l/:id` остаётся публичной: вход для неё не требуется ни
на какой роли.

## Переезд с sub-mirror

Сервис переименован. Внутри контейнера всё переносится само:

- `sub-mirror.sqlite` переименовывается в `sub-lab.sqlite` при первом старте
  (вместе с `-wal` и `-shm`);
- прежние имена переменных окружения (`SUB_MIRROR_DATA_DIR`,
  `SUB_MIRROR_HOST_PREFIX`, `SUB_MIRROR_LOCAL_PORT`) продолжают работать как
  запасной вариант;
- избранное в браузере переносится со старого ключа `localStorage`.

Что нужно сделать руками на хосте — каталоги тома переименовались в
`docker-compose.yml`:

```bash
sudo mv /srv/homeapps/sub-mirror /srv/homeapps/sub-lab
sudo mv /opt/homeapps/sub-mirror /opt/homeapps/sub-lab
mv ~/projects/sub-mirror ~/projects/sub-lab
docker compose rm -sf sub-mirror
```

Ключ приложения в account остался `sub_mirror`: группы в LLDAP называются
`sub_mirror_admin`, `sub_mirror_editor`, `sub_mirror_viewer`, и переименовывать
их не требуется.

Cookie сессии сменила имя на `sub_lab_session`, поэтому после обновления
потребуется войти заново.

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
export SUB_LAB_DATA_DIR="$PWD/.local-data"
export PROFILE_DIR="$PWD/resources/profiles"
export PORT=8788
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
- `output` (`raw`, `raw_base64`, `json`, `clash`, `yml`, `yaml`)
- `nodes` (`collapse` по умолчанию, `group`, `expand`) — см. ниже
- `app`, `device`
- `profile`, `profiles`
- `hwid`
- `clash_groups`
- legacy: `use_converter`

Пример:
```bash
curl "http://localhost:25500/sub?sub_url=https://example.com/sub&output=raw"
```

### Внутренняя модель и параметр `nodes`

Подписка разбирается не в плоский список серверов, а в список **записей**
(`normalized-v2`, `app/model/`). Запись — это одна строка списка в приложении:
один конфиг JSON-бандла Xray, один прокси Clash, одна ссылка raw. Всё, что
провайдер держит внутри записи — кандидаты балансировщика, мосты, loopback,
`routing`, `dns`, `observatory` — остаётся внутри записи и не всплывает
отдельными серверами.

Каждая запись хранит исходный объект целиком (`entry.native`), поэтому
обратная конвертация в исходный формат отдаёт подписку без потерь.

`nodes` управляет только теми форматами, где вложенности нет:

| значение | что попадает в `raw` / `clash` |
| --- | --- |
| `collapse` (по умолчанию) | один узел на запись — представитель: цель маршрута по умолчанию, а при балансировщике самый дешёвый кандидат |
| `group` | представитель и кандидаты того же балансировщика; в Clash запись становится своей `url-test` группой |
| `expand` | каждый прокси-outbound отдельным сервером |

Обратная конвертация (`json` → `json`, `yml` → `clash` без правок) отдаёт
сохранённый исходник и `nodes` не учитывает.

Пример на реальной подписке из 10 конфигов Xray:

```bash
curl ".../sub?output=raw&sub_url=..."               # 10 строк
curl ".../sub?output=raw&nodes=group&sub_url=..."   # 13 строк
curl ".../sub?output=raw&nodes=expand&sub_url=..."  # 122 строки
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
- `POST /api/auth/login` — возвращает ссылку на вход в account
- `POST /api/auth/logout`

Пользователи, пароли и роли живут в account; здесь они только читаются.
Роль берётся из `access.sub_mirror` (ключ приложения в account остался
прежним — так называются группы в LLDAP).

Cookie сессии в браузере — `sub_lab_session` (`SESSION_COOKIE`), а не общая
`kartoteka_session`: cookie не разделяются по портам, и с общим именем вход в
соседнее домашнее приложение подменял пользователя здесь. Имя cookie для
внутреннего API account задаётся отдельно — `ACCOUNT_SESSION_COOKIE`.
- `GET /api/admin/users` (admin)
- `POST /api/admin/users` (admin)
- `PUT /api/admin/users/:username` (admin)
- `DELETE /api/admin/users/:username` (admin)

Ограничения безопасности:
- нельзя удалить текущего admin.
- нельзя сменить роль текущего admin самому себе.

### Прочие API (auth)
- `GET/PUT /api/favorites`
- `POST /api/favorites/restore` (editor) — восстановление резервной копии.
  Короткие ссылки из копии, которых нет в базе, создаются заново с теми же
  идентификаторами и переходят к восстанавливающему; чужие пропускаются, и ответ
  перечисляет их в `report.skippedTitles`.
- `POST /api/sub-test`
- `POST /api/mock-sources`
- `GET/PUT /api/mock-sources/:id`
- `GET/POST /api/mock-sources/:id/logs`
- `GET /api/profile-editor/list`
- `GET/PUT/DELETE /api/profile-editor/file`
- `GET /api/ua-catalog`

### Синхронизация панелей
Machine-to-machine API включается только если задан `SYNC_API_TOKEN`.

- `GET /api/sync/export` — экспорт данных, требует `Authorization: Bearer <SYNC_API_TOKEN>` или `X-Sync-Token`.
- `POST /api/sync/import` — импорт bundle, требует admin-сессию или sync token.
- `POST /api/sync/pull` — текущая панель забирает export с другой панели и импортирует его.

Экспорт не включает пароли и auth-сессии. Синхронизируются короткие ссылки, доступы, favorites, лимиты пользователей, seen-users/history, override-данные и editable profiles.

Пример pull с `99.21` из панели `sub.nl.cdn6.ru`:
```bash
curl -X POST "http://192.168.99.21:25500/api/sync/pull" \
  -H "Authorization: Bearer $SYNC_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"remoteUrl":"https://sub.nl.cdn6.ru"}'
```

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
- `SYNC_API_TOKEN` — shared secret для безопасной синхронизации панелей.
- `AUTH_SESSION_TTL_SEC` — TTL сессии.
- `APP_PORT`, `SUBCONVERTER_PORT`.
- `SUB_LAB_DATA_DIR` — каталог рабочих данных (в контейнере `/data`).
- `SESSION_COOKIE` — cookie сессии в браузере, по умолчанию `sub_lab_session`.
  Имя обязано отличаться у каждого домашнего приложения: cookie не разделяются
  по портам.
- `ACCOUNT_SESSION_COOKIE` — имя cookie для внутреннего API account
  (`kartoteka_session`), общее для всех приложений.
- `ACCOUNT_URL`, `ACCOUNT_SERVICE_TOKEN` — внутренний API account.
- `SUB_LAB_HOST_PREFIX`, `SUB_LAB_LOCAL_PORT` — как вычислять свой адрес и адрес account.

## Bootstrap admin
Устарело: пользователи, пароли и роли живут в account. Seed-файл
(`resources/admin.json`, `ADMIN_SEED_PATH`) наполняет только локальную таблицу
`users`, которой вход больше не пользуется.

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
