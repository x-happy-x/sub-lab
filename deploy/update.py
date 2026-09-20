#!/usr/bin/env python3
"""Обновление уже установленного стека.

Собирает фронтенд, заливает код sub-lab и account, пересобирает образы и
проверяет, что поднялось. Данные и секреты не трогает — они остаются на
сервере.

Запуск:
    python deploy/update.py vps           # цель из targets.local.json
    python deploy/update.py vps --no-build
    python deploy/update.py vps --with-data   # ещё и перелить данные с дома

Цели заводит `first-deploy.py`; список — `python deploy/update.py --list`.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as c  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Обновить sub-lab + account на сервере")
    parser.add_argument("target", nargs="?", help="имя цели из targets.local.json")
    parser.add_argument("--list", action="store_true", help="показать известные цели")
    parser.add_argument("--no-build", action="store_true", help="не пересобирать фронтенд")
    parser.add_argument("--with-data", action="store_true", help="перелить данные и секреты с домашнего сервера")
    parser.add_argument("--cert", action="store_true", help="досоздать сертификаты (если появились A-записи)")
    args = parser.parse_args()

    if args.list or not args.target:
        targets = c.load_targets()["targets"]
        if not targets:
            print(f"Целей нет. Заведите первую: python deploy/first-deploy.py")
            return 1
        print("Известные цели:")
        for name, target in targets.items():
            print(f"  {name:<12} {target['host']}  https://{target['sub_domain']}")
        return 0 if args.list else 1

    target = c.get_target(args.target)
    c.info(f"цель {args.target}: {target.get('user', 'root')}@{target['host']} -> https://{target['sub_domain']}")

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)

        c.step("1/4", "Собираю и пакую")
        if not args.no_build:
            c.build_frontend()
        elif not (c.PROJECT_DIR / "frontend" / "dist" / "index.html").exists():
            c.fail("frontend/dist пуст — соберите фронтенд или уберите --no-build")
        code_archive = c.pack_code(tmp)
        c.info(f"архив кода: {code_archive.stat().st_size // 1024} КиБ")

        secrets: dict[str, str] = {}
        data_archive = None
        if args.with_data:
            home = c.home_config()
            c.info(f"забираю данные с {home['host']}")
            data_archive, secrets = c.pull_home_data(tmp, home)
            c.info(f"архив данных: {data_archive.stat().st_size // 1024} КиБ")

        remote = c.Remote(target)
        try:
            c.step("2/4", "Заливаю")
            remote.run(f"mkdir -p {c.REMOTE_DIR} {c.REMOTE_DATA}")
            c.upload_code(remote, code_archive)
            if data_archive is not None:
                c.upload_data(remote, data_archive)
                c.info("данные обновлены, прежние сохранены рядом с суффиксом .bak-<дата>")
            c.write_env(remote, secrets)
            remote.write(c.compose_file(target), f"{c.REMOTE_DIR}/docker-compose.yml", mode=0o644)

            c.step("3/4", "Пересобираю и поднимаю")
            c.bring_up(remote)

            if args.cert:
                for domain, port in (
                    (target["sub_domain"], str(target["sub_port"])),
                    (target["account_domain"], str(target["account_port"])),
                ):
                    if not c.resolves_to(remote, domain, target["host"]):
                        c.warn(f"{domain} не резолвится — пропускаю")
                        continue
                    c.setup_vhost(remote, domain, port)
                    c.info(f"сертификат {domain}: {'на месте' if c.issue_cert(remote, domain) else 'не получилось'}")

            c.step("4/4", "Проверяю")
            healthy = c.health_report(remote, target)
        finally:
            remote.close()

    print()
    print("Обновлено." if healthy else "Поднялось не всё — смотрите логи выше.")
    print(f"  панель: https://{target['sub_domain']}")
    print(f"  вход:   https://{target['account_domain']}")
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
