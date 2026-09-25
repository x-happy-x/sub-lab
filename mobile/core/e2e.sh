#!/usr/bin/env bash
# Сквозной тест обоих ядер через настоящий TUN (Linux, root, /dev/net/tun).
#
# На Linux xray-core сам создаёт TUN по имени, а на Android берёт готовый fd из
# переменной xray.tun.fd. Чтобы проверить именно Android-путь, тест собирается
# с копией xray-core, где tun_linux.go заменён на tun_android.go.
set -euo pipefail
cd "$(dirname "$0")"

xray_dir=$(go list -m -f '{{.Dir}}' github.com/xtls/xray-core)
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT

cp -r "$xray_dir" "$work/xray-core"
chmod -R u+w "$work/xray-core"
# Суффикс _android в имени сам ограничивает файл Android'ом, поэтому копия
# получает нейтральное имя.
rm "$work/xray-core/proxy/tun/tun_linux.go"
sed 's#^//go:build android$#//go:build linux#' "$xray_dir/proxy/tun/tun_android.go" \
  > "$work/xray-core/proxy/tun/tun_fd.go"

cp go.mod "$work/go.mod"
cp go.sum "$work/go.sum"
echo "replace github.com/xtls/xray-core => $work/xray-core" >> "$work/go.mod"

go test -modfile "$work/go.mod" -tags "e2e with_gvisor" -run TestEndToEnd -count=1 -v "$@" .
