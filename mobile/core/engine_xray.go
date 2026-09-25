package libcore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/xtls/xray-core/common/platform"
	"github.com/xtls/xray-core/core"
	_ "github.com/xtls/xray-core/main/distro/all"
	"golang.org/x/sys/unix"
)

const (
	xrayProxyTag = "proxy"
	xrayTunTag   = "tun"
)

type xrayEngine struct {
	instance *core.Instance
	tunFd    int
	logPath  string
}

// buildXrayConfig собирает полный конфиг xray-core: TUN-вход по fd от
// VpnService, выбранный сервер и правила обхода.
func buildXrayConfig(node *Node, options *Options, logPath string) (map[string]any, error) {
	if node.Xray == nil {
		return nil, fmt.Errorf("сервер «%s» (%s) не поддерживается ядром Xray", node.Name, node.Type)
	}
	proxy := deepCopy(node.Xray).(map[string]any)
	proxy["tag"] = xrayProxyTag

	var rules []any
	if options.BypassLAN {
		rules = append(rules, map[string]any{"type": "field", "ip": privateCIDRs, "outboundTag": "direct"})
	}
	if options.DirectRU {
		domains := make([]string, 0, len(ruSuffixes))
		for _, suffix := range ruSuffixes {
			domains = append(domains, "domain:"+suffix)
		}
		rules = append(rules, map[string]any{"type": "field", "domain": domains, "outboundTag": "direct"})
	}
	if !options.IPv6 {
		rules = append(rules, map[string]any{"type": "field", "ip": []string{"::/0"}, "outboundTag": "block"})
	}
	rules = append(rules, map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": xrayProxyTag})

	logConfig := map[string]any{"loglevel": options.LogLevel, "access": "none"}
	if logPath != "" {
		logConfig["error"] = logPath
	}

	return map[string]any{
		"log": logConfig,
		"dns": map[string]any{"servers": []any{dnsHost(options.DNS)}},
		"inbounds": []any{map[string]any{
			"tag":      xrayTunTag,
			"port":     0,
			"protocol": "tun",
			"settings": map[string]any{"name": "xray0", "MTU": options.MTU},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []string{"http", "tls", "quic"},
				"routeOnly":    true,
			},
		}},
		"outbounds": []any{
			proxy,
			map[string]any{"tag": "direct", "protocol": "freedom"},
			map[string]any{"tag": "block", "protocol": "blackhole"},
		},
		"routing": map[string]any{"domainStrategy": "AsIs", "rules": rules},
	}, nil
}

func startXray(node *Node, options *Options, fd int) (*xrayEngine, error) {
	logPath := ""
	if homeDir != "" {
		logPath = filepath.Join(homeDir, "xray.log")
		_ = os.WriteFile(logPath, nil, 0o600)
	}
	config, err := buildXrayConfig(node, options, logPath)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}

	// xray-core закрывать fd не умеет, поэтому отдаём ему копию и закрываем
	// её сами после остановки; оригинал остаётся за VpnService.
	tunFd, err := unix.Dup(fd)
	if err != nil {
		return nil, fmt.Errorf("не удалось скопировать fd туннеля: %w", err)
	}
	if err := os.Setenv(platform.TunFdKey, strconv.Itoa(tunFd)); err != nil {
		_ = unix.Close(tunFd)
		return nil, err
	}

	instance, err := core.StartInstance("json", payload)
	if err != nil {
		_ = unix.Close(tunFd)
		return nil, fmt.Errorf("xray не запустился: %w", err)
	}
	return &xrayEngine{instance: instance, tunFd: tunFd, logPath: logPath}, nil
}

func (e *xrayEngine) Stop() error {
	err := e.instance.Close()
	if fenceErr := fenceTunFd(e.tunFd); fenceErr != nil && err == nil {
		err = fenceErr
	}
	return err
}

// fenceTunFd выводит из игры копию fd, которую держал xray-core.
//
// TUN-вход xray-core не умеет закрываться: после instance.Close() его gVisor
// продолжает ждать пакеты на этом номере fd. Если номер просто закрыть, его
// займёт fd следующего запуска, и старый стек начнёт воровать пакеты у нового
// ядра. Поэтому номер навсегда занимается /dev/null, открытым только на
// запись: старый стек просыпается на первом пакете, получает EBADF и
// завершается, а номер больше никому не достаётся (одна «утечка» fd на запуск).
func fenceTunFd(fd int) error {
	null, err := unix.Open("/dev/null", unix.O_WRONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return unix.Close(fd)
	}
	defer unix.Close(null)
	if err := unix.Dup3(null, fd, unix.O_CLOEXEC); err != nil && !errors.Is(err, unix.EBADF) {
		return err
	}
	return nil
}

func (e *xrayEngine) Logs() string {
	if e.logPath == "" {
		return ""
	}
	return tailFile(e.logPath, 64*1024)
}
