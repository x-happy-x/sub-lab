#!/usr/bin/env python3
"""Первая установка стека на чистый сервер — пошагово, с проверками.

Ставит lldap + account + sub-lab, переносит данные с домашнего сервера,
настраивает nginx и сертификаты. Каждый шаг печатает, что делает, и
останавливается, если что-то не так, — чтобы не доводить до полуустановленного
состояния.

Запуск:
    python deploy/first-deploy.py

Скрипт спросит адрес сервера и домены. Всё можно задать и флагами:
    python deploy/first-deploy.py --host 1.2.3.4 --sub-domain sub.example.ru \\
        --account-domain account.example.ru --name vps --password ... --yes

Результат сохраняется в deploy/targets.local.json, дальше обновления идут
через `python deploy/update.py <имя>`.
"""

from __future__ import annotations

import argparse
import getpass
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as c  # noqa: E402


def collect_target(args: argparse.Namespace) -> tuple[str, dict]:
    c.step("1/9", "Куда ставим")
    print("    Домены должны указывать на этот сервер A-записями.")
    print("    Их два: панель (sub.…) и вход (account.…) — первая метка имени")
    print("    у них разная, остальное одинаковое, иначе вход не свяжется.\n")

    host = args.host or c.ask("IP сервера")
    if not host:
        c.fail("адрес сервера не задан")
    sub_domain = args.sub_domain or c.ask("домен панели", f"sub.{args.zone}" if args.zone else "")
    account_domain = args.account_domain or c.ask("домен входа", f"account.{args.zone}" if args.zone else "")
    if not sub_domain or not account_domain:
        c.fail("нужны оба домена")
    if sub_domain.split(".")[1:] != account_domain.split(".")[1:]:
        c.warn("у доменов разные зоны — вход будет уводить не туда")
        if not args.yes and not c.confirm("всё равно продолжить?"):
            c.fail("отменено")

    name = args.name or c.ask("короткое имя цели (для update.py)", host.replace(".", "-"))
    user = args.user or c.ask("пользователь SSH", "root")
    password = args.password
    if not password and not args.key:
        password = getpass.getpass("    пароль SSH (не отображается): ")

    target = {
        "host": host,
        "port": int(args.port),
        "user": user,
        "sub_domain": sub_domain,
        "account_domain": account_domain,
        "sub_port": int(args.sub_port),
        "account_port": int(args.account_port),
    }
    if args.key:
        target["key"] = args.key
    else:
        target["password"] = password
    return name, target


def check_dns(remote: c.Remote, target: dict, yes: bool) -> None:
    c.step("3/9", "Проверяю DNS")
    host = target["host"]
    for domain in (target["sub_domain"], target["account_domain"]):
        while True:
            if c.resolves_to(remote, domain, host):
                c.info(f"{domain} -> {host} ✓")
                break
            c.warn(f"{domain} пока не указывает на {host}")
            print(f"        Добавьте A-запись: {domain}  A  {host}")
            print("        Записи расходятся не мгновенно — после добавления подождите пару минут.")
            if yes:
                c.warn("режим --yes: продолжаю без записи, сертификат для этого домена не выпишется")
                break
            if not c.confirm("запись добавлена, проверить ещё раз?"):
                c.warn("продолжаю без этой записи — сертификат для неё не выпишется")
                break
            time.sleep(5)


def ensure_server(remote: c.Remote) -> None:
    c.step("4/9", "Проверяю сервер")
    if not remote.ok("command -v docker"):
        c.info("ставлю docker")
        remote.run("DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
                   "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io", timeout=900)
    c.info(remote.run("docker --version"))

    if not remote.ok("docker compose version"):
        # v1 на свежих Docker падает с KeyError: 'ContainerConfig' при любом
        # пересоздании контейнера с томами — нужен именно плагин v2.
        c.info("ставлю docker compose v2")
        remote.run("DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
                   "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2", timeout=900)
    c.info(remote.run("docker compose version"))

    if not remote.ok("command -v nginx"):
        c.info("ставлю nginx")
        remote.run("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx", timeout=900)
    if not remote.ok("command -v certbot"):
        c.info("ставлю certbot")
        remote.run("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx",
                   timeout=900)
    c.info("docker, compose v2, nginx и certbot на месте")

    busy = remote.run("ss -ltn | awk 'NR>1{print $4}' | sed 's/.*://' | sort -u | tr '\\n' ' '", check=False)
    c.info(f"занятые порты: {busy or 'нет данных'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Первая установка sub-lab + account на чистый сервер")
    parser.add_argument("--host")
    parser.add_argument("--port", default="22")
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--key", help="путь к приватному ключу вместо пароля")
    parser.add_argument("--name", help="короткое имя цели для update.py")
    parser.add_argument("--zone", help="общая зона, чтобы подсказать домены (example.ru)")
    parser.add_argument("--sub-domain")
    parser.add_argument("--account-domain")
    parser.add_argument("--sub-port", default="25500")
    parser.add_argument("--account-port", default="4161")
    parser.add_argument("--no-data", action="store_true", help="не переносить данные с домашнего сервера")
    parser.add_argument("--no-build", action="store_true", help="не пересобирать фронтенд")
    parser.add_argument("--yes", action="store_true", help="не задавать вопросов")
    args = parser.parse_args()

    name, target = collect_target(args)

    print()
    c.info(f"сервер:  {target.get('user', 'root')}@{target['host']}:{target['port']}")
    c.info(f"панель:  https://{target['sub_domain']}  (порт {target['sub_port']})")
    c.info(f"вход:    https://{target['account_domain']}  (порт {target['account_port']})")
    c.info(f"данные:  {'не переносим' if args.no_data else 'копируем с ' + c.home_config()['host']}")
    if not args.yes and not c.confirm("всё верно, ставим?"):
        return 1

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)

        c.step("2/9", "Собираю и пакую")
        if not args.no_build:
            c.build_frontend()
        elif not (c.PROJECT_DIR / "frontend" / "dist" / "index.html").exists():
            c.fail("frontend/dist пуст — соберите фронтенд или уберите --no-build")
        code_archive = c.pack_code(tmp)
        c.info(f"архив кода: {code_archive.stat().st_size // 1024} КиБ")

        remote = c.Remote(target)
        try:
            check_dns(remote, target, args.yes)
            ensure_server(remote)

            c.step("5/9", "Переношу данные")
            secrets: dict[str, str] = {}
            if args.no_data:
                c.warn("пропущено: данных и секретов не будет, вход не заработает")
            else:
                home = c.home_config()
                data_archive, secrets = c.pull_home_data(tmp, home)
                c.info(f"архив данных: {data_archive.stat().st_size // 1024} КиБ")
                c.info(f"секретов перенесено: {len(secrets)} (значения не печатаем)")
                remote.run(f"mkdir -p {c.REMOTE_DIR} {c.REMOTE_DATA}")
                c.upload_data(remote, data_archive)
                c.info("каталог LLDAP, база account и база sub-lab на месте")

            c.step("6/9", "Заливаю код")
            remote.run(f"mkdir -p {c.REMOTE_DIR} {c.REMOTE_DATA}")
            c.upload_code(remote, code_archive)
            c.write_env(remote, secrets)
            remote.write(c.compose_file(target), f"{c.REMOTE_DIR}/docker-compose.yml", mode=0o644)
            c.info(f"код в {c.REMOTE_DIR}")

            c.step("7/9", "Поднимаю контейнеры")
            c.bring_up(remote)

            c.step("8/9", "Настраиваю nginx и сертификаты")
            for domain, port in (
                (target["sub_domain"], str(target["sub_port"])),
                (target["account_domain"], str(target["account_port"])),
            ):
                c.setup_vhost(remote, domain, port)
                c.info(f"vhost {domain} -> 127.0.0.1:{port}")
                if c.resolves_to(remote, domain, target["host"]):
                    c.info(f"сертификат {domain}: {'выписан' if c.issue_cert(remote, domain) else 'не получилось'}")
                else:
                    c.warn(f"{domain} не резолвится — сертификат пропущен, "
                           f"после появления записи: certbot --nginx -d {domain}")

            c.step("9/9", "Проверяю")
            healthy = c.health_report(remote, target)
        finally:
            remote.close()

    c.save_target(name, target)
    print()
    if healthy:
        print("Готово.")
    else:
        print("Поднялось не всё — смотрите логи выше.")
    print(f"  панель:     https://{target['sub_domain']}")
    print(f"  вход:       https://{target['account_domain']}")
    print(f"  обновление: python deploy/update.py {name}")
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
