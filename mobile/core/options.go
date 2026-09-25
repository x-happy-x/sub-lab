package libcore

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Options — настройки подключения, общие для обоих ядер.
type Options struct {
	// DNS — сервер для запросов внутри туннеля и для резолва адресов серверов.
	DNS string `json:"dns"`
	// MTU интерфейса TUN; должно совпадать с тем, что выставил VpnService.
	MTU int `json:"mtu"`
	// BypassLAN пускает локальные сети мимо прокси.
	BypassLAN bool `json:"bypassLan"`
	// DirectRU пускает домены .ru/.рф/.su мимо прокси.
	DirectRU bool `json:"directRu"`
	// IPv6 включает IPv6 внутри туннеля.
	IPv6 bool `json:"ipv6"`
	// LogLevel: debug, info, warning, error.
	LogLevel string `json:"logLevel"`
}

var privateCIDRs = []string{
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"224.0.0.0/4",
	"fc00::/7",
	"fe80::/10",
}

var ruSuffixes = []string{"ru", "xn--p1ai", "su"}

func parseOptions(optionsJSON string) (*Options, error) {
	options := &Options{}
	if strings.TrimSpace(optionsJSON) != "" {
		if err := json.Unmarshal([]byte(optionsJSON), options); err != nil {
			return nil, fmt.Errorf("некорректные настройки: %w", err)
		}
	}
	if options.DNS == "" {
		options.DNS = "1.1.1.1"
	}
	if options.MTU <= 0 {
		options.MTU = 1500
	}
	switch options.LogLevel {
	case "debug", "info", "warning", "error":
	default:
		options.LogLevel = "warning"
	}
	return options, nil
}

// dnsHost убирает схему и порт: ядрам и резолверу нужен голый адрес.
func dnsHost(dns string) string {
	host := dns
	if index := strings.Index(host, "://"); index >= 0 {
		host = host[index+3:]
	}
	host = strings.TrimSuffix(host, "/dns-query")
	if strings.HasPrefix(host, "[") {
		if end := strings.Index(host, "]"); end > 0 {
			return host[1:end]
		}
	}
	if strings.Count(host, ":") == 1 {
		host = host[:strings.Index(host, ":")]
	}
	return host
}
