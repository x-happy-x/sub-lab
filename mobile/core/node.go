package libcore

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/metacubex/mihomo/common/convert"
	"gopkg.in/yaml.v3"
)

// Node — один сервер подписки в виде, понятном обоим ядрам.
//
// Clash хранит прокси в формате mihomo (`proxies:` из YAML), Xray — готовый
// outbound для xray-core. Одно из полей может быть пустым, если протокол
// поддерживает только одно ядро: такой сервер виден в списке, но запуск на
// «чужом» ядре вернёт понятную ошибку.
type Node struct {
	Name   string         `json:"name"`
	Type   string         `json:"type"`
	Server string         `json:"server"`
	Port   int            `json:"port"`
	Clash  map[string]any `json:"clash,omitempty"`
	Xray   map[string]any `json:"xray,omitempty"`
}

// Supports сообщает, умеет ли ядро запускать этот сервер.
func (n *Node) Supports(engine string) bool {
	switch engine {
	case EngineXray:
		return n.Xray != nil
	case EngineMihomo:
		return n.Clash != nil
	}
	return false
}

// ParseSubscription разбирает тело подписки в список серверов (JSON-массив Node).
//
// Понимает три формата, которые отдают панели и sub-lab:
//   - Clash/mihomo YAML с секцией `proxies`;
//   - Xray JSON: полный конфиг или массив конфигов (sub-lab `?type=json`);
//   - ссылки vless://, vmess://, trojan://, ss://, hysteria2:// и т.п.,
//     в том числе завёрнутые в base64.
func ParseSubscription(body string) (string, error) {
	nodes, err := parseNodes([]byte(body))
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(nodes)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func parseNodes(body []byte) ([]*Node, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(string(body), "\ufeff"))
	if trimmed == "" {
		return nil, errors.New("пустая подписка")
	}

	var nodes []*Node
	var err error
	switch {
	case strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "["):
		nodes, err = parseXrayJSON([]byte(trimmed))
	case looksLikeClash(trimmed):
		nodes, err = parseClashYAML([]byte(trimmed))
	default:
		nodes, err = parseShareLinks([]byte(trimmed))
	}
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return nil, errors.New("в подписке нет серверов")
	}
	uniqueNames(nodes)
	return nodes, nil
}

func looksLikeClash(body string) bool {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "proxies:") {
			return true
		}
	}
	return false
}

func parseClashYAML(body []byte) ([]*Node, error) {
	var doc struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("не удалось разобрать Clash YAML: %w", err)
	}
	nodes := make([]*Node, 0, len(doc.Proxies))
	for _, proxy := range doc.Proxies {
		if node := nodeFromClash(normalizeYAML(proxy).(map[string]any)); node != nil {
			nodes = append(nodes, node)
		}
	}
	return nodes, nil
}

func parseShareLinks(body []byte) ([]*Node, error) {
	proxies, err := convert.ConvertsV2Ray(body)
	if err != nil {
		return nil, fmt.Errorf("не удалось разобрать ссылки подписки: %w", err)
	}
	nodes := make([]*Node, 0, len(proxies))
	for _, proxy := range proxies {
		if node := nodeFromClash(proxy); node != nil {
			nodes = append(nodes, node)
		}
	}
	return nodes, nil
}

func parseXrayJSON(body []byte) ([]*Node, error) {
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("не удалось разобрать Xray JSON: %w", err)
	}
	var configs []map[string]any
	switch value := raw.(type) {
	case map[string]any:
		configs = append(configs, value)
	case []any:
		for _, item := range value {
			if config, ok := item.(map[string]any); ok {
				configs = append(configs, config)
			}
		}
	}

	var nodes []*Node
	for index, config := range configs {
		// Одиночный outbound (без обёртки конфига) тоже принимаем.
		if _, ok := config["protocol"]; ok {
			if node := nodeFromXray(config, ""); node != nil {
				nodes = append(nodes, node)
			}
			continue
		}
		outbounds, _ := config["outbounds"].([]any)
		remarks := stringOf(config["remarks"])
		for _, item := range outbounds {
			outbound, ok := item.(map[string]any)
			if !ok || !isProxyOutbound(outbound) {
				continue
			}
			name := remarks
			if name == "" {
				name = stringOf(outbound["tag"])
			}
			if name == "" {
				name = fmt.Sprintf("Сервер %d", index+1)
			}
			if node := nodeFromXray(outbound, name); node != nil {
				nodes = append(nodes, node)
			}
			// Из полного конфига берём первый прокси-outbound: остальные —
			// обычно цепочки и фрагменты, которые без него не работают.
			break
		}
	}
	return nodes, nil
}

func isProxyOutbound(outbound map[string]any) bool {
	switch stringOf(outbound["protocol"]) {
	case "vless", "vmess", "trojan", "shadowsocks", "hysteria", "wireguard", "socks", "http":
		return true
	}
	return false
}

func nodeFromClash(proxy map[string]any) *Node {
	kind := stringOf(proxy["type"])
	if kind == "" {
		return nil
	}
	node := &Node{
		Name:   stringOf(proxy["name"]),
		Type:   kind,
		Server: stringOf(proxy["server"]),
		Port:   intOf(proxy["port"]),
		Clash:  proxy,
	}
	if outbound, err := clashToXray(proxy); err == nil {
		node.Xray = outbound
	}
	if node.Name == "" {
		node.Name = fmt.Sprintf("%s:%d", node.Server, node.Port)
	}
	return node
}

func nodeFromXray(outbound map[string]any, name string) *Node {
	address, port := xrayEndpoint(outbound)
	proxy, err := xrayToClash(outbound)
	node := &Node{
		Name:   name,
		Type:   xrayTypeName(stringOf(outbound["protocol"])),
		Server: address,
		Port:   port,
		Xray:   cleanXrayOutbound(outbound),
	}
	if err == nil {
		node.Clash = proxy
	}
	if node.Name == "" {
		node.Name = fmt.Sprintf("%s:%d", address, port)
	}
	if node.Clash != nil {
		node.Clash["name"] = node.Name
	}
	return node
}

func xrayTypeName(protocol string) string {
	if protocol == "shadowsocks" {
		return "ss"
	}
	return protocol
}

// cleanXrayOutbound убирает то, что мешает встроить outbound в наш конфиг:
// тег (ставим свой) и ссылки на соседние outbounds, которых у нас не будет.
func cleanXrayOutbound(outbound map[string]any) map[string]any {
	copied := deepCopy(outbound).(map[string]any)
	delete(copied, "tag")
	if stream, ok := copied["streamSettings"].(map[string]any); ok {
		if sockopt, ok := stream["sockopt"].(map[string]any); ok {
			delete(sockopt, "dialerProxy")
		}
		// allowInsecure xray-core больше не принимает и падает на старте.
		if tls, ok := stream["tlsSettings"].(map[string]any); ok {
			delete(tls, "allowInsecure")
		}
	}
	delete(copied, "proxySettings")
	return copied
}

func uniqueNames(nodes []*Node) {
	seen := map[string]int{}
	for _, node := range nodes {
		name := node.Name
		if count, ok := seen[name]; ok {
			count++
			seen[name] = count
			node.Name = fmt.Sprintf("%s (%d)", name, count)
		} else {
			seen[name] = 1
		}
		if node.Clash != nil {
			node.Clash["name"] = node.Name
		}
	}
}

func decodeNode(nodeJSON string) (*Node, error) {
	var node Node
	if err := json.Unmarshal([]byte(nodeJSON), &node); err != nil {
		return nil, fmt.Errorf("некорректный сервер: %w", err)
	}
	return &node, nil
}

// normalizeYAML приводит map[any]any и прочие артефакты YAML к JSON-совместимому виду.
func normalizeYAML(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = normalizeYAML(item)
		}
		return typed
	case map[any]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[fmt.Sprint(key)] = normalizeYAML(item)
		}
		return out
	case []any:
		for index, item := range typed {
			typed[index] = normalizeYAML(item)
		}
		return typed
	}
	return value
}

func deepCopy(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = deepCopy(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = deepCopy(item)
		}
		return out
	}
	return value
}

func stringOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	}
	return fmt.Sprint(value)
}

func intOf(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case uint64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	}
	return 0
}

func boolOf(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, _ := strconv.ParseBool(typed)
		return parsed
	case float64:
		return typed != 0
	case int:
		return typed != 0
	}
	return false
}

func mapOf(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func stringsOf(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := stringOf(item); text != "" {
				out = append(out, text)
			}
		}
		return out
	case string:
		if typed == "" {
			return nil
		}
		parts := strings.Split(typed, ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
		return out
	}
	return nil
}

// firstString берёт первый элемент, если значение — список (как `path` в http-opts).
func firstString(value any) string {
	if list := stringsOf(value); len(list) > 0 {
		if _, isString := value.(string); !isString {
			return list[0]
		}
	}
	return stringOf(value)
}
