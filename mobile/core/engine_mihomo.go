package libcore

import (
	"fmt"
	"strings"
	"sync"
	"time"

	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/listener"
	LC "github.com/metacubex/mihomo/listener/config"
	mlog "github.com/metacubex/mihomo/log"
	"github.com/metacubex/mihomo/tunnel/statistic"
	"golang.org/x/sys/unix"
	"gopkg.in/yaml.v3"
)

const mihomoGroup = "PROXY"

type mihomoEngine struct {
	logs     *logRing
	stopLogs func()
}

// buildMihomoConfig собирает конфиг mihomo: TUN по fd, fake-ip DNS и одну
// группу с выбранным сервером.
func buildMihomoConfig(node *Node, options *Options, fd int) (map[string]any, error) {
	if node.Clash == nil {
		return nil, fmt.Errorf("сервер «%s» (%s) не поддерживается ядром Mihomo", node.Name, node.Type)
	}
	proxy := deepCopy(node.Clash).(map[string]any)
	proxy["name"] = node.Name

	dns := dnsHost(options.DNS)
	nameserver := options.DNS
	if !strings.Contains(nameserver, "://") {
		nameserver = dns
	}

	var rules []string
	if options.BypassLAN {
		for _, cidr := range privateCIDRs {
			kind := "IP-CIDR"
			if strings.Contains(cidr, ":") {
				kind = "IP-CIDR6"
			}
			rules = append(rules, fmt.Sprintf("%s,%s,DIRECT,no-resolve", kind, cidr))
		}
	}
	if options.DirectRU {
		for _, suffix := range ruSuffixes {
			rules = append(rules, "DOMAIN-SUFFIX,"+suffix+",DIRECT")
		}
	}
	rules = append(rules, "MATCH,"+mihomoGroup)

	return map[string]any{
		"mode":              "rule",
		"log-level":         mihomoLogLevel(options.LogLevel),
		"ipv6":              options.IPv6,
		"allow-lan":         false,
		"unified-delay":     true,
		"tcp-concurrent":    true,
		"find-process-mode": "off",
		"profile": map[string]any{
			"store-selected": false,
			"store-fake-ip":  false,
		},
		"dns": map[string]any{
			"enable":                  true,
			"ipv6":                    options.IPv6,
			"enhanced-mode":           "fake-ip",
			"fake-ip-range":           "198.18.0.1/16",
			"default-nameserver":      []string{dns},
			"nameserver":              []string{nameserver},
			"proxy-server-nameserver": []string{dns},
		},
		"tun": map[string]any{
			"enable":                true,
			"stack":                 "gvisor",
			"file-descriptor":       fd,
			"mtu":                   options.MTU,
			"auto-route":            false,
			"auto-detect-interface": false,
			"dns-hijack":            []string{"any:53"},
		},
		"proxies": []any{proxy},
		"proxy-groups": []any{map[string]any{
			"name":    mihomoGroup,
			"type":    "select",
			"proxies": []string{node.Name},
		}},
		"rules": rules,
	}, nil
}

func mihomoLogLevel(level string) string {
	if level == "warning" || level == "error" || level == "info" || level == "debug" {
		return level
	}
	return "warning"
}

func startMihomo(node *Node, options *Options, fd int) (*mihomoEngine, error) {
	// mihomo сам закрывает fd при остановке TUN, поэтому получает копию.
	tunFd, err := unix.Dup(fd)
	if err != nil {
		return nil, fmt.Errorf("не удалось скопировать fd туннеля: %w", err)
	}
	config, err := buildMihomoConfig(node, options, tunFd)
	if err != nil {
		_ = unix.Close(tunFd)
		return nil, err
	}
	payload, err := yaml.Marshal(config)
	if err != nil {
		_ = unix.Close(tunFd)
		return nil, err
	}
	if homeDir != "" {
		C.SetHomeDir(homeDir)
	}

	engine := &mihomoEngine{logs: newLogRing(400)}
	engine.stopLogs = engine.collectLogs()

	parsed, err := executor.ParseWithBytes(payload)
	if err != nil {
		engine.stopLogs()
		_ = unix.Close(tunFd)
		return nil, fmt.Errorf("mihomo не принял конфиг: %w", err)
	}
	// mihomo не пересоздаёт TUN, если конфиг совпал с прошлым, а после Stop
	// прошлый TUN уже закрыт. Копия fd часто получает тот же номер, так что
	// без сброса новый запуск остался бы без TUN.
	listener.LastTunConf = LC.Tun{}
	executor.ApplyConfig(parsed, true)
	return engine, nil
}

func (e *mihomoEngine) collectLogs() func() {
	subscription := mlog.Subscribe()
	var once sync.Once
	done := make(chan struct{})
	go func() {
		for {
			select {
			case event, ok := <-subscription:
				if !ok {
					return
				}
				e.logs.Add(fmt.Sprintf("%s [%s] %s", time.Now().Format("15:04:05"), event.LogLevel, event.Payload))
			case <-done:
				return
			}
		}
	}()
	return func() {
		once.Do(func() {
			close(done)
			mlog.UnSubscribe(subscription)
		})
	}
}

func (e *mihomoEngine) Stop() error {
	statistic.DefaultManager.Range(func(connection statistic.Tracker) bool {
		_ = connection.Close()
		return true
	})
	executor.Shutdown()
	e.stopLogs()
	return nil
}

func (e *mihomoEngine) Logs() string {
	return e.logs.String()
}
