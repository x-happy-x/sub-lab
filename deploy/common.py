"""Общая механика деплоя стека sub-lab + account + lldap.

Используется двумя скриптами: `first-deploy.py` (первая установка на чистый
сервер) и `update.py` (обновление уже установленного). Всё, что знает про
конкретный сервер, лежит в `targets.local.json` — он в .gitignore, потому что
хранит пароль.

Почему Python, а не bash: деплой запускают с Windows, где нет ни `rsync`, ни
`sshpass`. Здесь всё делается одним процессом — tar локально, SFTP, распаковка
на сервере.
"""

from __future__ import annotations

import json
import os
import posixpath
import shlex
import subprocess
import sys
import tarfile
import time
from pathlib import Path

try:
    import paramiko
except ImportError:  # pragma: no cover - подсказка вместо стектрейса
    sys.exit("Нужен paramiko: python -m pip install paramiko")

DEPLOY_DIR = Path(__file__).resolve().parent
PROJECT_DIR = DEPLOY_DIR.parent
ACCOUNT_DIR = PROJECT_DIR.parent / "account"
TARGETS_FILE = DEPLOY_DIR / "targets.local.json"

REMOTE_DIR = "/opt/sublab-stack"
REMOTE_DATA = "/srv/sublab"

# Что уезжает в образ. Тесты, .git и node_modules фронтенда не нужны.
SUB_LAB_PAYLOAD = ["Dockerfile", ".dockerignore", "entrypoint.sh", "app", "resources", "frontend/dist"]
ACCOUNT_PAYLOAD = [
    "Dockerfile", ".dockerignore", "package.json", "package-lock.json",
    "server.js", "src", "scripts", "public",
]
SKIP_NAMES = {".git", ".github", ".idea", "__pycache__", ".tmp-test-data"}

# Секреты, без которых перенесённые данные бесполезны: каталог LLDAP зашифрован
# сидом, и со свежесгенерированным он не прочитается.
CARRIED_SECRETS = [
    "LLDAP_JWT_SECRET",
    "LLDAP_KEY_SEED",
    "LLDAP_ADMIN_PASSWORD",
    "ACCOUNT_SESSION_SECRET",
    "ACCOUNT_SERVICE_TOKEN",
]

DEFAULT_HOME = {
    "host": "192.168.99.20",
    "user": "amagomedsharipov",
    "key": str(Path.home() / ".ssh" / "id_ed25519_pve"),
    "stack": "/opt/homeapps",
    "data": "/srv/homeapps",
}


# --------------------------------------------------------------------------
# вывод
# --------------------------------------------------------------------------

def step(number: str, title: str) -> None:
    print(f"\n\033[1m[{number}] {title}\033[0m", flush=True)


def info(message: str) -> None:
    print(f"    {message}", flush=True)


def warn(message: str) -> None:
    print(f"    ! {message}", flush=True)


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    sys.exit(f"\nОстановка: {message}")


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"    {prompt}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def confirm(prompt: str) -> bool:
    try:
        return input(f"    {prompt} (y/N): ").strip().lower() in {"y", "yes", "д", "да"}
    except EOFError:
        return False


# --------------------------------------------------------------------------
# конфигурация целей
# --------------------------------------------------------------------------

def load_targets() -> dict:
    if not TARGETS_FILE.exists():
        return {"targets": {}, "home": dict(DEFAULT_HOME)}
    data = json.loads(TARGETS_FILE.read_text(encoding="utf-8"))
    data.setdefault("targets", {})
    data.setdefault("home", dict(DEFAULT_HOME))
    return data


def save_target(name: str, target: dict) -> None:
    data = load_targets()
    data["targets"][name] = target
    TARGETS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(TARGETS_FILE, 0o600)
    except OSError:
        pass  # на Windows прав всё равно нет, файл закрыт .gitignore


def get_target(name: str) -> dict:
    data = load_targets()
    target = data["targets"].get(name)
    if not target:
        known = ", ".join(data["targets"]) or "пусто"
        fail(f"цель «{name}» не найдена в {TARGETS_FILE.name} (известные: {known})")
    return target


def home_config() -> dict:
    return load_targets().get("home", dict(DEFAULT_HOME))


# --------------------------------------------------------------------------
# удалённый сервер
# --------------------------------------------------------------------------

class Remote:
    """SSH-подключение с понятными ошибками и заливкой файлов."""

    def __init__(self, target: dict) -> None:
        self.target = target
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs = {
            "hostname": target["host"],
            "port": int(target.get("port", 22)),
            "username": target.get("user", "root"),
            "timeout": 30,
        }
        if target.get("key"):
            kwargs["key_filename"] = target["key"]
        else:
            kwargs["password"] = target["password"]
        self.client.connect(**kwargs)

    def run(self, command: str, check: bool = True, timeout: int = 900) -> str:
        _, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        err = stderr.read().decode("utf-8", "replace")
        if check and code != 0:
            fail(f"команда вернула {code}: {command}\n{out}\n{err}")
        return (out + err).strip()

    def ok(self, command: str) -> bool:
        return self.run(f"{command} >/dev/null 2>&1 && echo yes || echo no", check=False) == "yes"

    def put(self, local: Path, remote: str) -> None:
        sftp = self.client.open_sftp()
        try:
            sftp.put(str(local), remote)
        finally:
            sftp.close()

    def write(self, text: str, remote: str, mode: int = 0o600) -> None:
        sftp = self.client.open_sftp()
        try:
            with sftp.open(remote, "w") as fh:
                fh.write(text)
            sftp.chmod(remote, mode)
        finally:
            sftp.close()

    def compose(self) -> str:
        """compose v2, если он есть.

        v1 на свежих Docker падает с `KeyError: 'ContainerConfig'` при любом
        пересоздании контейнера с томами, поэтому v2 обязателен.
        """
        if self.ok("docker compose version"):
            return "docker compose"
        fail("на сервере нет `docker compose` (v2). Поставьте: apt-get install -y docker-compose-v2")

    def close(self) -> None:
        self.client.close()


# --------------------------------------------------------------------------
# сборка и упаковка
# --------------------------------------------------------------------------

def build_frontend() -> None:
    subprocess.run(
        ["npm", "run", "build"],
        cwd=PROJECT_DIR / "frontend",
        check=True,
        shell=(os.name == "nt"),
    )


def _add(tar: tarfile.TarFile, root: Path, entries: list[str], prefix: str) -> None:
    for entry in entries:
        path = root / entry
        if not path.exists():
            fail(f"нет файла для деплоя: {path}")
        tar.add(
            path,
            arcname=posixpath.join(prefix, entry.replace("\\", "/")),
            filter=lambda info: None if Path(info.name).name in SKIP_NAMES else info,
        )


def pack_code(tmp: Path) -> Path:
    archive = tmp / "stack.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        _add(tar, PROJECT_DIR, SUB_LAB_PAYLOAD, "sub-lab")
        _add(tar, ACCOUNT_DIR, ACCOUNT_PAYLOAD, "account")
    return archive


def upload_code(remote: Remote, archive: Path) -> None:
    """Залить код, сохранив inode каталогов.

    Каталог `sub-lab/resources` примонтирован в контейнер. Если удалить его и
    создать заново, работающий контейнер останется смотреть на удалённый inode
    и увидит пустоту — подписки начнут падать с «profile not found». Поэтому
    сам каталог не трогаем, а вычищаем только его содержимое.
    """
    remote.put(archive, "/tmp/stack.tar.gz")
    mounted = f"{REMOTE_DIR}/sub-lab/resources"
    remote.run(
        f"mkdir -p {mounted} {REMOTE_DIR}/account && "
        # всё внутри sub-lab, кроме самого resources
        f"find {REMOTE_DIR}/sub-lab -mindepth 1 -maxdepth 1 ! -name resources -exec rm -rf {{}} + && "
        f"find {mounted} -mindepth 1 -delete && "
        f"find {REMOTE_DIR}/account -mindepth 1 -delete"
    )
    remote.run(f"tar xzf /tmp/stack.tar.gz -C {REMOTE_DIR} && rm -f /tmp/stack.tar.gz")


# --------------------------------------------------------------------------
# данные с домашнего сервера
# --------------------------------------------------------------------------

def home_ssh_args(home: dict) -> list[str]:
    return [
        "ssh", "-i", home["key"], "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes",
        f"{home['user']}@{home['host']}",
    ]


def pull_home_data(tmp: Path, home: dict) -> tuple[Path, dict[str, str]]:
    """Данные и секреты с домашнего сервера.

    Кэш забираем тоже: ссылки с `endpoint=last` отдают последнюю удачную версию
    именно из него, и без кэша отвечают 404, пока кто-нибудь не дёрнет `/sub`.
    Снапшоты не забираем — это история, она большая и не нужна для работы.
    """
    archive = tmp / "data.tar.gz"
    # У GNU tar --exclude обязан идти до имён каталогов.
    inner = " ".join([
        "sudo tar czf - -C", shlex.quote(home["data"]),
        "--exclude=sub-lab/data/snapshots",
        "--exclude=*.before-rename",
        "--exclude=*.before-admin-rename",
        "--exclude=*.before-user-map-*",
        "lldap account sub-lab/data",
    ])
    with archive.open("wb") as fh:
        subprocess.run(home_ssh_args(home) + [inner], check=True, stdout=fh)

    raw = subprocess.run(
        home_ssh_args(home) + [f"sudo cat {shlex.quote(home['stack'])}/.env"],
        check=True, stdout=subprocess.PIPE,
    ).stdout.decode("utf-8", "replace")

    secrets: dict[str, str] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in CARRIED_SECRETS or key.endswith("SYNC_API_TOKEN"):
            secrets[key] = value.strip().strip('"').strip("'")
    missing = [key for key in CARRIED_SECRETS if key not in secrets]
    if missing:
        fail(f"в {home['stack']}/.env нет: {', '.join(missing)}")
    return archive, secrets


def upload_data(remote: Remote, archive: Path) -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    remote.put(archive, "/tmp/data.tar.gz")
    remote.run(
        f"if [ -d {REMOTE_DATA}/sub-lab ]; then cp -a {REMOTE_DATA}/sub-lab {REMOTE_DATA}/sub-lab.bak-{stamp}; fi"
    )
    remote.run(f"mkdir -p {REMOTE_DATA} && tar xzf /tmp/data.tar.gz -C {REMOTE_DATA} && rm -f /tmp/data.tar.gz")


# --------------------------------------------------------------------------
# конфигурация стека
# --------------------------------------------------------------------------

def compose_file(target: dict) -> str:
    """docker-compose для сервера. Секреты сюда не попадают — они в .env."""
    host = target["host"]
    sub_domain = target["sub_domain"]
    account_domain = target["account_domain"]
    sub_port = str(target.get("sub_port", 25500))
    account_port = str(target.get("account_port", 4161))
    return f"""# Сгенерировано скриптами deploy/ — правки перетрутся следующим обновлением.
services:
  lldap:
    image: lldap/lldap:stable
    restart: unless-stopped
    # Только локально: админка каталога на публичном адресе никому не нужна.
    ports:
      - "127.0.0.1:17170:17170"
    environment:
      LLDAP_JWT_SECRET: ${{LLDAP_JWT_SECRET}}
      LLDAP_KEY_SEED: ${{LLDAP_KEY_SEED}}
      LLDAP_LDAP_BASE_DN: dc=home,dc=lan
      LLDAP_LDAP_USER_DN: admin
      LLDAP_LDAP_USER_PASS: ${{LLDAP_ADMIN_PASSWORD}}
      LLDAP_HTTP_URL: http://127.0.0.1:17170
    volumes:
      - {REMOTE_DATA}/lldap:/data

  account:
    build: ./account
    restart: unless-stopped
    depends_on:
      - lldap
    expose:
      - "4160"
    ports:
      - "0.0.0.0:{account_port}:4161"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 4160
      UI_PORT: 4161
      ACCOUNT_DB: /data/account.db
      PROXY_HOST: {host}
      PUBLIC_ORIGIN: https://{account_domain}
      ACCOUNT_HOST_PREFIX: account
      SUB_MIRROR_HOST_PREFIX: sub
      ACCOUNT_LOCAL_PORT: {account_port}
      SUB_MIRROR_LOCAL_PORT: {sub_port}
      LDAP_URL: ldap://lldap:3890
      LDAP_BASE_DN: dc=home,dc=lan
      LDAP_BIND_DN: uid=admin,ou=people,dc=home,dc=lan
      LDAP_BIND_PASSWORD: ${{LLDAP_ADMIN_PASSWORD}}
      LLDAP_HTTP_URL: http://lldap:17170
      SESSION_SECRET: ${{ACCOUNT_SESSION_SECRET}}
      ACCOUNT_SERVICE_TOKEN: ${{ACCOUNT_SERVICE_TOKEN}}
    volumes:
      - {REMOTE_DATA}/account:/data

  sub-lab:
    build: ./sub-lab
    restart: unless-stopped
    depends_on:
      - account
    ports:
      - "0.0.0.0:{sub_port}:8788"
    volumes:
      - {REMOTE_DATA}/sub-lab/data:/data
      - {REMOTE_DIR}/sub-lab/resources:/resources:ro
    environment:
      SUB_URL: ""
      OUTPUT: clash
      USE_CONVERTER: "1"
      AUTH_SESSION_TTL_SEC: "2592000"
      CONVERTER_URL: http://127.0.0.1:8787/sub
      SOURCE_URL: http://127.0.0.1:8788/source.txt
      ADMIN_SEED_PATH: /resources/admin.json
      PROFILE_DIR: /resources/profiles
      APP_PORT: "8788"
      SUBCONVERTER_PORT: "8787"
      PUBLIC_BASE_URL: https://{sub_domain}
      PROXY_HOST: {host}
      ACCOUNT_URL: http://account:4160
      ACCOUNT_SERVICE_TOKEN: ${{ACCOUNT_SERVICE_TOKEN}}
      SESSION_COOKIE: sub_lab_session
      ACCOUNT_SESSION_COOKIE: kartoteka_session
      ACCOUNT_HOST_PREFIX: account
      ACCOUNT_LOCAL_PORT: "{account_port}"
      SUB_LAB_HOST_PREFIX: sub
      SUB_LAB_LOCAL_PORT: "{sub_port}"
      SYNC_API_TOKEN: ${{SUB_LAB_SYNC_API_TOKEN:-}}
"""


def nginx_vhost(domain: str, port: str) -> str:
    """HTTP-vhost. TLS доклеит certbot — до выпуска сертификата его тут нет."""
    return f"""server {{
    listen 80;
    server_name {domain};

    location / {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }}
}}
"""


def setup_vhost(remote: Remote, domain: str, port: str) -> None:
    path = f"/etc/nginx/sites-available/{domain}"
    remote.write(nginx_vhost(domain, port), path, mode=0o644)
    remote.run(f"ln -sf {shlex.quote(path)} /etc/nginx/sites-enabled/{domain}")
    remote.run("nginx -t && systemctl reload nginx")


def issue_cert(remote: Remote, domain: str) -> bool:
    """Сертификат для домена.

    Проверку делает сам Let's Encrypt своим резолвером, поэтому локальный
    отрицательный кеш сервера выпуску не мешает. Повторный запуск безопасен:
    живой сертификат certbot просто оставит как есть.
    """
    out = remote.run(
        f"certbot --nginx -d {shlex.quote(domain)} --non-interactive --agree-tos "
        "--register-unsafely-without-email --redirect --keep-until-expiring 2>&1 | tail -15",
        check=False, timeout=300,
    )
    got = remote.run(
        f"certbot certificates -d {shlex.quote(domain)} 2>/dev/null | grep -c 'Certificate Name: {domain}' || echo 0"
    ).strip()
    if got == "0":
        warn(f"сертификат для {domain} не выписан:\n{out}")
        return False
    remote.run("nginx -t && systemctl reload nginx")
    return True


# --------------------------------------------------------------------------
# запуск и проверки
# --------------------------------------------------------------------------

def write_env(remote: Remote, secrets: dict[str, str]) -> None:
    if secrets:
        remote.write("\n".join(f"{k}={v}" for k, v in secrets.items()) + "\n", f"{REMOTE_DIR}/.env")
        return
    if not remote.ok(f"test -f {REMOTE_DIR}/.env"):
        fail(f"на сервере нет {REMOTE_DIR}/.env — нужен первый деплой с переносом данных")


def bring_up(remote: Remote) -> None:
    dc = remote.compose()
    print(remote.run(f"cd {REMOTE_DIR} && {dc} up -d --build 2>&1 | tail -20"))

    # Проверяем не файлы на хосте, а то, что реально видит контейнер: именно
    # здесь ломалось монтирование, и молча — подписки просто переставали
    # собираться с «profile not found».
    seen = remote.run(
        f"cd {REMOTE_DIR} && {dc} exec -T sub-lab sh -lc 'ls /resources/profiles 2>/dev/null | wc -l'",
        check=False,
    ).strip()
    if not seen.isdigit() or int(seen) == 0:
        info("контейнер не видит профили — пересоздаю")
        remote.run(f"cd {REMOTE_DIR} && {dc} up -d --force-recreate sub-lab 2>&1 | tail -5")
        seen = remote.run(
            f"cd {REMOTE_DIR} && {dc} exec -T sub-lab sh -lc 'ls /resources/profiles | wc -l'", check=False,
        ).strip()
    info(f"профилей видно в контейнере: {seen}")


def wait_http(remote: Remote, url: str, tries: int = 45) -> bool:
    for _ in range(tries):
        if remote.ok(f"curl -fsS {shlex.quote(url)}"):
            return True
        time.sleep(2)
    return False


def health_report(remote: Remote, target: dict) -> bool:
    dc = remote.compose()
    sub_port = str(target.get("sub_port", 25500))
    account_port = str(target.get("account_port", 4161))

    ok_sub = wait_http(remote, f"http://127.0.0.1:{sub_port}/health")
    ok_account = wait_http(remote, f"http://127.0.0.1:{account_port}/", tries=20)
    print(remote.run(f"cd {REMOTE_DIR} && {dc} ps"))

    info(f"sub-lab /health: {'отвечает' if ok_sub else 'НЕ отвечает'}")
    info(f"account UI:      {'отвечает' if ok_account else 'НЕ отвечает'}")
    if not ok_sub:
        print(remote.run(f"cd {REMOTE_DIR} && {dc} logs --tail 60 sub-lab", check=False))
        return False

    for domain, path in ((target["sub_domain"], "/health"), (target["account_domain"], "/")):
        code = remote.run(
            f"curl -fsS -o /dev/null -m 15 -w '%{{http_code}}' https://{domain}{path} || echo fail",
            check=False,
        ).strip()
        info(f"https://{domain}{path} -> {code}")
    return True


def resolves_to(remote: Remote, domain: str, host: str) -> bool:
    """Резолвится ли домен в нужный адрес (спрашиваем публичный резолвер).

    Локальный кеш сервера может помнить отрицательный ответ, поэтому его не
    спрашиваем — важно, что видит внешний мир и Let's Encrypt.
    """
    out = remote.run(
        f"host {shlex.quote(domain)} 8.8.8.8 2>/dev/null | awk '/has address/{{print $NF}}' | head -1",
        check=False,
    ).strip()
    return out == host
