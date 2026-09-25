#!/usr/bin/env bash
# Собирает libcore.aar (xray-core + mihomo) для Android через gomobile.
#
# Нужны: Go (версия из core/go.mod подтянется сама), Android SDK и NDK
# (ANDROID_HOME и ANDROID_NDK_HOME, например NDK 27).
# Результат: mobile/android/app/libs/libcore.aar
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root/core"

: "${ANDROID_HOME:?Укажите ANDROID_HOME — путь к Android SDK}"
: "${ANDROID_NDK_HOME:?Укажите ANDROID_NDK_HOME — путь к Android NDK}"

targets="${TARGETS:-android/arm64,android/arm,android/amd64}"
gobin="$(go env GOPATH)/bin"
mobile_version="$(go list -m -f '{{.Version}}' golang.org/x/mobile)"

go install "golang.org/x/mobile/cmd/gomobile@${mobile_version}" "golang.org/x/mobile/cmd/gobind@${mobile_version}"
export PATH="$gobin:$PATH"
gomobile init

mkdir -p "$root/android/app/libs"
# with_gvisor — gVisor-стек для TUN у mihomo (у xray-core он встроен).
gomobile bind \
  -v \
  -target="$targets" \
  -androidapi 26 \
  -tags with_gvisor \
  -trimpath \
  -ldflags="-s -w -buildid=" \
  -o "$root/android/app/libs/libcore.aar" \
  .

echo "Готово: $root/android/app/libs/libcore.aar"
