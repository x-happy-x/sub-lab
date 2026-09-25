// Package libcore — нативное ядро мобильного клиента sub-lab.
//
// Собирается через gomobile в один .aar, внутри которого живут сразу оба
// ядра — xray-core и mihomo — и переключаются на лету. Экспортируемые функции
// пакета — всё API, которое видит Android-приложение (класс libcore.Libcore).
package libcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

const (
	EngineXray   = "xray"
	EngineMihomo = "mihomo"
)

type engine interface {
	Stop() error
	Logs() string
}

var (
	mu           sync.Mutex
	active       engine
	activeEngine string
	homeDir      string
	lastError    string
)

// Init задаёт рабочий каталог (кэш mihomo, журнал xray). Вызывать один раз
// при старте приложения, до Start.
func Init(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	homeDir = dir
	return nil
}

// Start поднимает выбранное ядро поверх TUN из VpnService.
//
// engine — "xray" или "mihomo"; nodeJSON — один элемент из ParseSubscription;
// fd — дескриптор TUN (владение остаётся у вызывающего); optionsJSON — Options.
// Если ядро уже запущено, оно останавливается: так переключаются ядро и сервер.
func Start(engineName string, nodeJSON string, fd int32, optionsJSON string) error {
	mu.Lock()
	defer mu.Unlock()

	node, err := decodeNode(nodeJSON)
	if err != nil {
		return rememberError(err)
	}
	options, err := parseOptions(optionsJSON)
	if err != nil {
		return rememberError(err)
	}
	if fd <= 0 {
		return rememberError(errors.New("нет дескриптора TUN"))
	}

	stopLocked()
	useResolver(options.DNS)

	var started engine
	switch engineName {
	case EngineXray:
		started, err = startXray(node, options, int(fd))
	case EngineMihomo:
		started, err = startMihomo(node, options, int(fd))
	default:
		err = fmt.Errorf("неизвестное ядро %q", engineName)
	}
	if err != nil {
		return rememberError(err)
	}
	active = started
	activeEngine = engineName
	lastError = ""
	return nil
}

// Stop останавливает текущее ядро. Безопасно вызывать повторно.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()
	return stopLocked()
}

func stopLocked() error {
	if active == nil {
		return nil
	}
	err := active.Stop()
	active = nil
	activeEngine = ""
	return err
}

// IsRunning — запущено ли какое-нибудь ядро.
func IsRunning() bool {
	mu.Lock()
	defer mu.Unlock()
	return active != nil
}

// ActiveEngine — имя запущенного ядра или пустая строка.
func ActiveEngine() string {
	mu.Lock()
	defer mu.Unlock()
	return activeEngine
}

// LastError — текст последней ошибки запуска.
func LastError() string {
	mu.Lock()
	defer mu.Unlock()
	return lastError
}

// Logs — хвост журнала текущего ядра.
func Logs() string {
	mu.Lock()
	defer mu.Unlock()
	if active == nil {
		return ""
	}
	return active.Logs()
}

// BuildConfig показывает конфиг, который получит ядро (для экрана «Конфиг»).
func BuildConfig(engineName string, nodeJSON string, optionsJSON string) (string, error) {
	node, err := decodeNode(nodeJSON)
	if err != nil {
		return "", err
	}
	options, err := parseOptions(optionsJSON)
	if err != nil {
		return "", err
	}
	var config map[string]any
	switch engineName {
	case EngineXray:
		config, err = buildXrayConfig(node, options, "")
	case EngineMihomo:
		config, err = buildMihomoConfig(node, options, 0)
	default:
		err = fmt.Errorf("неизвестное ядро %q", engineName)
	}
	if err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

// Supports — умеет ли ядро запустить этот сервер.
func Supports(engineName string, nodeJSON string) bool {
	node, err := decodeNode(nodeJSON)
	if err != nil {
		return false
	}
	return node.Supports(engineName)
}

// TcpPing меряет время TCP-рукопожатия с сервером в миллисекундах; -1 — недоступен.
func TcpPing(host string, port int32, timeoutMs int32) int32 {
	if timeoutMs <= 0 {
		timeoutMs = 3000
	}
	address := net.JoinHostPort(host, fmt.Sprint(port))
	started := time.Now()
	connection, err := net.DialTimeout("tcp", address, time.Duration(timeoutMs)*time.Millisecond)
	if err != nil {
		return -1
	}
	elapsed := time.Since(started)
	_ = connection.Close()
	if elapsed < time.Millisecond {
		return 1
	}
	return int32(elapsed / time.Millisecond)
}

// Version — версии встроенных ядер, например "xray 26.3.27 · mihomo 1.19.31".
func Version() string {
	return fmt.Sprintf("xray %s · mihomo %s", XrayVersion(), MihomoVersion())
}

// XrayVersion — версия xray-core.
func XrayVersion() string {
	return moduleVersion("github.com/xtls/xray-core")
}

// MihomoVersion — версия mihomo.
func MihomoVersion() string {
	return moduleVersion("github.com/metacubex/mihomo")
}

func moduleVersion(path string) string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "?"
	}
	for _, dep := range info.Deps {
		if dep.Path != path {
			continue
		}
		version := strings.TrimPrefix(dep.Version, "v")
		// xray-core публикуется как v1.YYMMDD.N — показываем привычное 26.3.27.
		if path == "github.com/xtls/xray-core" {
			return xrayDisplayVersion(version)
		}
		return version
	}
	return "?"
}

func xrayDisplayVersion(version string) string {
	parts := strings.Split(version, ".")
	if len(parts) != 3 || parts[0] != "1" || len(parts[1]) != 6 {
		return version
	}
	date := parts[1]
	trim := func(value string) string {
		value = strings.TrimLeft(value, "0")
		if value == "" {
			return "0"
		}
		return value
	}
	return fmt.Sprintf("%s.%s.%s", trim(date[0:2]), trim(date[2:4]), trim(date[4:6]))
}

// useResolver направляет системный резолвер Go на заданный DNS: на Android
// у Go нет /etc/resolv.conf, и без этого не резолвятся адреса серверов.
func useResolver(dns string) {
	address := net.JoinHostPort(dnsHost(dns), "53")
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, network, address)
		},
	}
}

func rememberError(err error) error {
	lastError = err.Error()
	return err
}
