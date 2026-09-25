# sub·lab client — Android-клиент с Xray и Mihomo

Мобильный VPN-клиент в тёмной теме: большая кнопка подключения, карточка
сервера, пинги, подписки. Внутри два ядра — **xray-core** и **mihomo** — и
переключатель между ними прямо на главном экране. Смена ядра или сервера
на живом подключении перезапускает только ядро, TUN остаётся тем же.

```
mobile/
├── core/            Go-библиотека libcore (gomobile → libcore.aar)
│   ├── libcore.go       API для Android: Init/Start/Stop/ParseSubscription/TcpPing…
│   ├── node.go          разбор подписок: ссылки, base64, Clash YAML, Xray JSON
│   ├── convert.go       конвертация сервера между форматами xray ⇄ mihomo
│   ├── engine_xray.go   конфиг и запуск xray-core на fd из VpnService
│   ├── engine_mihomo.go конфиг и запуск mihomo на fd из VpnService
│   ├── e2e_test.go      сквозной тест обоих ядер через настоящий TUN
│   └── e2e.sh
├── android/         Android-приложение (Kotlin, Jetpack Compose)
└── build-core.sh    сборка libcore.aar
```

## Как это работает

- `SubLabVpnService` открывает TUN (`172.19.0.1/30`, весь IPv4, по желанию IPv6)
  и исключает из туннеля само приложение, поэтому соединения ядер с серверами
  идут напрямую, без петли.
- Дескриптор TUN уходит в `Libcore.start(engine, node, fd, options)`:
  - **Xray** — встроенный TUN-вход xray-core (`protocol: "tun"`), fd передаётся
    через `xray.tun.fd`, как это делает сам xray на Android;
  - **Mihomo** — `tun.file-descriptor`, стек gVisor, DNS fake-ip.
- Каждое ядро получает свою копию fd (`dup`), оригинал остаётся у сервиса.
  У TUN-входа xray-core нет закрытия, и его gVisor продолжает слушать номер fd
  после остановки. Поэтому номер «забивается» `/dev/null` только на запись,
  а не освобождается, иначе старый стек воровал бы пакеты у следующего ядра
  (это ловит e2e-тест).
- Подписка скачивается приложением (заголовки `subscription-userinfo` и
  `profile-title` показываются как трафик, срок и название) и разбирается в Go.
  Каждый сервер хранится сразу в двух видах — outbound xray и прокси mihomo,
  поэтому одна и та же подписка работает на обоих ядрах.
- Серверы, которые умеет только одно ядро (TUIC, AnyTLS, WireGuard,
  Shadowsocks с плагинами — только mihomo), помечены в списке.
- Трафик считается по UID приложения (`TrafficStats`): одинаково для обоих ядер.

### Что поддерживается

| | Xray | Mihomo |
|---|---|---|
| VLESS (Reality, Vision, XTLS), TCP / WS / gRPC / XHTTP / HTTPUpgrade | ✓ | ✓ |
| VMess, Trojan, Shadowsocks | ✓ | ✓ |
| Hysteria2 (без obfs) | ✓ | ✓ |
| TUIC, Hysteria v1, AnyTLS, WireGuard, SS-плагины | — | ✓ |

Форматы подписки: список ссылок (`vless://`, `vmess://`, `trojan://`, `ss://`,
`hysteria2://`, `tuic://`…), он же в base64, Clash/mihomo YAML (`proxies:`),
Xray JSON (полный конфиг или массив — как `?type=json` у sub-lab).

Настройки: DNS, «локальная сеть напрямую», «.ru/.рф/.su напрямую», IPv6,
User-Agent подписки, уровень журнала; журнал ядра и итоговый конфиг видны
в разделе «Диагностика». Есть плитка в шторке и импорт по ссылке
`sublab://import?url=<ссылка на подписку>`.

## Сборка

Нужны Go (версия из `core/go.mod` подтянется сама), JDK 17, Android SDK
(platform 35, build-tools 35) и NDK.

```bash
export ANDROID_HOME=~/Android/Sdk
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
./mobile/build-core.sh                         # → mobile/android/app/libs/libcore.aar
cd mobile/android && ./gradlew assembleRelease # → app/build/outputs/apk/release/
```

APK собирается отдельно под `arm64-v8a`, `armeabi-v7a`, `x86_64` и один
универсальный. Без `mobile/android/keystore.properties` релиз подписывается
debug-ключом; для своей подписи положите рядом файл:

```properties
storeFile=release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

То же самое без локального SDK делает workflow `.github/workflows/mobile-apk.yml`
(запускается вручную и на изменения в `mobile/`, только сборка и тесты, без деплоя):
APK появляется в артефактах запуска.

## Тесты

```bash
cd mobile/core
go test -tags with_gvisor ./...   # разбор подписок; конфиги проверяются загрузчиками xray-core и mihomo
sudo ./e2e.sh                     # оба ядра через настоящий TUN, с переключением xray → mihomo → xray
```
