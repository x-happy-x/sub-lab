#!/usr/bin/env bash
set -euo pipefail

CLEAR_PROFILES=0
for arg in "$@"; do
  case "$arg" in
    --clear)
      CLEAR_PROFILES=1
      ;;
    -h|--help)
      echo "Usage: ./deploy.sh [--clear]"
      echo "  --clear   Clear editable profiles in /data/profiles/{base,ua} inside container after start"
      exit 0
      ;;
    *)
      echo "[ERR] unknown option: $arg" >&2
      echo "Usage: ./deploy.sh [--clear]" >&2
      exit 1
      ;;
  esac
done

HOST="192.168.99.21"
USER_NAME="amagomedsharipov"
REMOTE_DIR="${REMOTE_DIR:-/home/amagomedsharipov/projects/sub-mirror}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_SRC="${PROJECT_DIR}/homeserver"
KEY_DST="${HOME}/.ssh/sub_mirror_homeserver"
SSH_OPTS=(
  -i "${KEY_DST}"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
)

if [[ ! -f "${KEY_SRC}" ]]; then
  echo "[ERR] private key not found: ${KEY_SRC}" >&2
  exit 1
fi

mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"
install -m 600 "${KEY_SRC}" "${KEY_DST}"

echo "[1/4] Sync project files to ${USER_NAME}@${HOST}:${REMOTE_DIR}"
rsync -az --delete \
  --omit-dir-times \
  --no-perms \
  --no-owner \
  --no-group \
  --exclude '.git/' \
  --exclude 'homeserver' \
  --exclude 'data/cache/' \
  --exclude 'data/cache/**' \
  --exclude 'data/profiles/' \
  --exclude 'data/profiles/**' \
  --exclude 'data/local-sources/' \
  --exclude 'data/local-sources/**' \
  --exclude 'data/raw.txt' \
  --exclude 'data/subscription.yaml' \
  --exclude 'data/status.json' \
  --exclude 'data/converted.txt' \
  --exclude 'data/source.txt' \
  --exclude 'data/short-links.json' \
  --exclude 'data/mock-sources.json' \
  --exclude 'data/sub-mirror.sqlite' \
  --exclude 'data/sub-mirror.sqlite-shm' \
  --exclude 'data/sub-mirror.sqlite-wal' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${PROJECT_DIR}/" "${USER_NAME}@${HOST}:${REMOTE_DIR}/"

if [[ "${CLEAR_PROFILES}" == "1" ]]; then
  STEP_BUILD="[2/5]"
  STEP_CLEAR="[3/5]"
  STEP_HEALTH="[4/5]"
  STEP_DONE="[5/5]"
else
  STEP_BUILD="[2/4]"
  STEP_HEALTH="[3/4]"
  STEP_DONE="[4/4]"
fi

echo "${STEP_BUILD} Build and start docker compose local"
ssh "${SSH_OPTS[@]}" "${USER_NAME}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"
docker compose -f docker-compose.local.yml up -d --build
REMOTE

if [[ "${CLEAR_PROFILES}" == "1" ]]; then
  echo "${STEP_CLEAR} Clear editable profiles in container /data/profiles/{base,ua}"
  ssh "${SSH_OPTS[@]}" "${USER_NAME}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"
docker compose -f docker-compose.local.yml exec -T sub-mirror sh -lc '
mkdir -p /data/profiles/base /data/profiles/ua
find /data/profiles/base -mindepth 1 -delete
find /data/profiles/ua -mindepth 1 -delete
'
REMOTE
fi

echo "${STEP_HEALTH} Wait for healthcheck endpoint"
ssh "${SSH_OPTS[@]}" "${USER_NAME}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:25500/health >/dev/null 2>&1; then
    echo "[OK] health endpoint is up"
    exit 0
  fi
  sleep 2
done

echo "[ERR] healthcheck failed: http://127.0.0.1:25500/health" >&2
docker compose -f docker-compose.local.yml ps >&2 || true
docker compose -f docker-compose.local.yml logs --tail 120 >&2 || true
exit 1
REMOTE

echo "${STEP_DONE} Deployed successfully"
