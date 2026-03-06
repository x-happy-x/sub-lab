# Repository Guidelines

## Project Structure & Module Organization
- `app/server.js` is the main HTTP API/UI entrypoint (auth, short links, admin, apps catalog, public share page).
- `app/subscription.js` contains subscription fetch/convert/cache logic and request config resolution.
- `app/sqlite-store.js` contains SQLite persistence for users, sessions, favorites and short-link stats.
- `app/apps-catalog.js` parses `resources/apps.yml` and per-app guides from `resources/app-guides/`.
- `frontend/src/` contains the React UI (main page, admin page, public share page `/l/:id`).
- `resources/profiles/*.yml` stores device header profiles.
- `resources/ua-catalog.json` stores UA mapping by `os/app`.
- `data/` is a bind-mounted runtime volume (`sub-mirror.sqlite`, cache and debug artifacts).

## Build, Test, and Development Commands
- `docker compose -f docker-compose.local.yml up -d --build` builds local image and starts stack (recommended for local dev).
- `docker compose up -d` starts the GHCR image from `docker-compose.yml`.
- `docker compose down` stops containers.
- `cd frontend && npm run build` builds frontend bundle.
- `node --test app/server.test.js` runs server/unit tests.
- `node app/server.js` runs HTTP service locally (Node 18+; expects env vars).
- GitHub Actions workflow: `.github/workflows/docker-image.yml` runs tests + frontend build, then docker build; image push happens on `push` events only.
- Deployment rule for this repo: after each user-requested code/UI change, run deploy immediately via `./deploy.sh` unless the user explicitly says not to deploy.

## Coding Style & Naming Conventions
- JavaScript is written as ES modules (`import ... from`).
- Use 2-space indentation and double quotes to match `app/server.js`.
- Prefer descriptive, verb-led function names (e.g., `handleSubscription`, `refreshCache`).
- Keep constants uppercase with underscores for environment-driven values.
- No formatter/linter is enforced in CI; match existing style manually.

## Testing Guidelines
- Automated tests exist in `app/server.test.js` (`node --test app/server.test.js`).
- For API behavior changes, also validate manually:
  - `curl "http://localhost:25500/sub?sub_url=..."` for fresh fetch.
  - `curl "http://localhost:25500/last?sub_url=..."` for cache behavior.
  - `curl "http://localhost:25500/l/<id>?type=raw"` for short-link output override.
  - `curl "http://localhost:25500/api/public-short-links/<id>/meta"` for public share metadata.

## Commit & Pull Request Guidelines
- Recent commits use short, imperative, sentence-case summaries (e.g., "Add Docker integration...").
- Keep commit messages concise and scoped to one change set.
- PRs should describe the behavior change, config/env updates, and any new ports or endpoints.
- Include example commands or curl calls when behavior changes are not obvious.

## Configuration Notes
- Core env vars: `SUB_URL`, `OUTPUT`, `CONVERTER_URL`, `SOURCE_URL`, `PROFILE_DIR`, `ADMIN_SEED_PATH`, `AUTH_SESSION_TTL_SEC`.
- Ports default to `APP_PORT=8788` and `SUBCONVERTER_PORT=8787`.
- In local compose (`docker-compose.local.yml`) only `25500 -> 8788` is published; subconverter stays internal.
- Frontend depends on local package tarball `frontend/vendor/x-happy-x-ui-kit-*.tgz`; keep `frontend/vendor/` tracked in git for CI reproducibility.
