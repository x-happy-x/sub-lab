package libcore

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// clashToXray собирает outbound xray-core из прокси в формате mihomo.
func clashToXray(proxy map[string]any) (map[string]any, error) {
	server := stringOf(proxy["server"])
	port := intOf(proxy["port"])
	if server == "" || port == 0 {
		return nil, fmt.Errorf("у сервера нет адреса или порта")
	}

	outbound := map[string]any{}
	kind := stringOf(proxy["type"])
	switch kind {
	case "vless":
		user := map[string]any{
			"id":         stringOf(proxy["uuid"]),
			"encryption": orDefault(stringOf(proxy["encryption"]), "none"),
		}
		if flow := stringOf(proxy["flow"]); flow != "" {
			user["flow"] = flow
		}
		outbound["protocol"] = "vless"
		outbound["settings"] = map[string]any{"vnext": []any{map[string]any{
			"address": server, "port": port, "users": []any{user},
		}}}
	case "vmess":
		user := map[string]any{
			"id":       stringOf(proxy["uuid"]),
			"alterId":  intOf(proxy["alterId"]),
			"security": orDefault(stringOf(proxy["cipher"]), "auto"),
		}
		outbound["protocol"] = "vmess"
		outbound["settings"] = map[string]any{"vnext": []any{map[string]any{
			"address": server, "port": port, "users": []any{user},
		}}}
	case "trojan":
		outbound["protocol"] = "trojan"
		outbound["settings"] = map[string]any{"servers": []any{map[string]any{
			"address": server, "port": port, "password": stringOf(proxy["password"]),
		}}}
	case "ss":
		if plugin := stringOf(proxy["plugin"]); plugin != "" {
			return nil, fmt.Errorf("плагин shadowsocks %q не поддерживается xray", plugin)
		}
		entry := map[string]any{
			"address":  server,
			"port":     port,
			"method":   stringOf(proxy["cipher"]),
			"password": stringOf(proxy["password"]),
		}
		if boolOf(proxy["udp-over-tcp"]) {
			entry["uot"] = true
		}
		outbound["protocol"] = "shadowsocks"
		outbound["settings"] = map[string]any{"servers": []any{entry}}
	case "hysteria2":
		if obfs := stringOf(proxy["obfs"]); obfs != "" {
			return nil, fmt.Errorf("обфускация hysteria2 %q не поддерживается xray", obfs)
		}
		outbound["protocol"] = "hysteria"
		outbound["settings"] = map[string]any{"version": 2, "address": server, "port": port}
		tls := map[string]any{"serverName": orDefault(stringOf(proxy["sni"]), server)}
		if alpn := stringsOf(proxy["alpn"]); len(alpn) > 0 {
			tls["alpn"] = alpn
		} else {
			tls["alpn"] = []string{"h3"}
		}
		outbound["streamSettings"] = map[string]any{
			"network":          "hysteria",
			"security":         "tls",
			"tlsSettings":      tls,
			"hysteriaSettings": map[string]any{"version": 2, "auth": stringOf(proxy["password"])},
		}
		return outbound, nil
	default:
		return nil, fmt.Errorf("протокол %q не поддерживается xray", kind)
	}

	stream, err := clashStreamToXray(proxy, kind)
	if err != nil {
		return nil, err
	}
	if stream != nil {
		outbound["streamSettings"] = stream
	}
	return outbound, nil
}

func clashStreamToXray(proxy map[string]any, kind string) (map[string]any, error) {
	network := orDefault(stringOf(proxy["network"]), "tcp")
	stream := map[string]any{}

	switch network {
	case "tcp":
		stream["network"] = "raw"
	case "ws":
		opts := mapOf(proxy["ws-opts"])
		path := orDefault(stringOf(opts["path"]), "/")
		host := stringOf(mapOf(opts["headers"])["Host"])
		if boolOf(opts["v2ray-http-upgrade"]) {
			stream["network"] = "httpupgrade"
			stream["httpupgradeSettings"] = map[string]any{"path": path, "host": host}
			break
		}
		if early := intOf(opts["max-early-data"]); early > 0 {
			path = appendQuery(path, "ed", strconv.Itoa(early))
		}
		stream["network"] = "ws"
		stream["wsSettings"] = map[string]any{"path": path, "host": host}
	case "grpc":
		opts := mapOf(proxy["grpc-opts"])
		stream["network"] = "grpc"
		stream["grpcSettings"] = map[string]any{"serviceName": stringOf(opts["grpc-service-name"])}
	case "xhttp":
		opts := mapOf(proxy["xhttp-opts"])
		settings := map[string]any{"path": orDefault(stringOf(opts["path"]), "/")}
		if host := stringOf(opts["host"]); host != "" {
			settings["host"] = host
		}
		if mode := stringOf(opts["mode"]); mode != "" {
			settings["mode"] = mode
		}
		stream["network"] = "xhttp"
		stream["xhttpSettings"] = settings
	case "http":
		opts := mapOf(proxy["http-opts"])
		request := map[string]any{"path": orList(stringsOf(opts["path"]), "/")}
		if headers := mapOf(opts["headers"]); headers != nil {
			request["headers"] = headers
		}
		stream["network"] = "raw"
		stream["rawSettings"] = map[string]any{"header": map[string]any{"type": "http", "request": request}}
	default:
		return nil, fmt.Errorf("транспорт %q не поддерживается xray", network)
	}

	serverName := orDefault(stringOf(proxy["servername"]), stringOf(proxy["sni"]))
	fingerprint := stringOf(proxy["client-fingerprint"])
	if reality := mapOf(proxy["reality-opts"]); reality != nil {
		stream["security"] = "reality"
		stream["realitySettings"] = map[string]any{
			"serverName":  serverName,
			"publicKey":   stringOf(reality["public-key"]),
			"shortId":     stringOf(reality["short-id"]),
			"fingerprint": orDefault(fingerprint, "chrome"),
		}
		return stream, nil
	}

	// trojan в mihomo всегда поверх TLS, у остальных — по флагу.
	if kind == "trojan" || boolOf(proxy["tls"]) {
		tls := map[string]any{}
		if serverName != "" {
			tls["serverName"] = serverName
		}
		if alpn := stringsOf(proxy["alpn"]); len(alpn) > 0 {
			tls["alpn"] = alpn
		}
		if fingerprint != "" {
			tls["fingerprint"] = fingerprint
		}
		// allowInsecure удалён из xray-core; вместо него — пин сертификата.
		if pin := stringOf(proxy["fingerprint"]); pin != "" {
			tls["pinnedPeerCertSha256"] = pin
		}
		stream["security"] = "tls"
		stream["tlsSettings"] = tls
	}
	return stream, nil
}

// xrayToClash — обратное преобразование: outbound xray-core в прокси mihomo.
func xrayToClash(outbound map[string]any) (map[string]any, error) {
	protocol := stringOf(outbound["protocol"])
	settings := mapOf(outbound["settings"])
	address, port := xrayEndpoint(outbound)
	if address == "" || port == 0 {
		return nil, fmt.Errorf("у outbound нет адреса или порта")
	}
	proxy := map[string]any{"server": address, "port": port, "udp": true}

	switch protocol {
	case "vless":
		user := xrayUser(settings)
		proxy["type"] = "vless"
		proxy["uuid"] = stringOf(user["id"])
		if flow := stringOf(user["flow"]); flow != "" {
			proxy["flow"] = flow
		}
		if encryption := stringOf(user["encryption"]); encryption != "" && encryption != "none" {
			proxy["encryption"] = encryption
		}
	case "vmess":
		user := xrayUser(settings)
		proxy["type"] = "vmess"
		proxy["uuid"] = stringOf(user["id"])
		proxy["alterId"] = intOf(user["alterId"])
		proxy["cipher"] = orDefault(stringOf(user["security"]), "auto")
	case "trojan":
		server := xrayServer(settings)
		proxy["type"] = "trojan"
		proxy["password"] = stringOf(server["password"])
	case "shadowsocks":
		server := xrayServer(settings)
		proxy["type"] = "ss"
		proxy["cipher"] = stringOf(server["method"])
		proxy["password"] = stringOf(server["password"])
		if boolOf(server["uot"]) {
			proxy["udp-over-tcp"] = true
		}
	case "hysteria":
		stream := mapOf(outbound["streamSettings"])
		tls := mapOf(stream["tlsSettings"])
		proxy["type"] = "hysteria2"
		proxy["password"] = stringOf(mapOf(stream["hysteriaSettings"])["auth"])
		if sni := stringOf(tls["serverName"]); sni != "" {
			proxy["sni"] = sni
		}
		if alpn := stringsOf(tls["alpn"]); len(alpn) > 0 {
			proxy["alpn"] = alpn
		}
		return proxy, nil
	default:
		return nil, fmt.Errorf("протокол %q не поддерживается mihomo", protocol)
	}

	if err := xrayStreamToClash(mapOf(outbound["streamSettings"]), proxy); err != nil {
		return nil, err
	}
	return proxy, nil
}

func xrayStreamToClash(stream map[string]any, proxy map[string]any) error {
	network := strings.ToLower(orDefault(stringOf(stream["network"]), "raw"))
	switch network {
	case "raw", "tcp":
		raw := mapOf(stream["rawSettings"])
		if raw == nil {
			raw = mapOf(stream["tcpSettings"])
		}
		header := mapOf(raw["header"])
		if stringOf(header["type"]) == "http" {
			request := mapOf(header["request"])
			opts := map[string]any{"path": orList(stringsOf(request["path"]), "/")}
			if headers := mapOf(request["headers"]); headers != nil {
				opts["headers"] = headers
			}
			proxy["network"] = "http"
			proxy["http-opts"] = opts
		} else {
			proxy["network"] = "tcp"
		}
	case "ws", "websocket":
		ws := mapOf(stream["wsSettings"])
		path, early := splitEarlyData(orDefault(stringOf(ws["path"]), "/"))
		opts := map[string]any{"path": path}
		host := stringOf(ws["host"])
		if host == "" {
			host = stringOf(mapOf(ws["headers"])["Host"])
		}
		if host != "" {
			opts["headers"] = map[string]any{"Host": host}
		}
		if early > 0 {
			opts["max-early-data"] = early
			opts["early-data-header-name"] = "Sec-WebSocket-Protocol"
		}
		proxy["network"] = "ws"
		proxy["ws-opts"] = opts
	case "httpupgrade":
		upgrade := mapOf(stream["httpupgradeSettings"])
		opts := map[string]any{"path": orDefault(stringOf(upgrade["path"]), "/"), "v2ray-http-upgrade": true}
		if host := stringOf(upgrade["host"]); host != "" {
			opts["headers"] = map[string]any{"Host": host}
		}
		proxy["network"] = "ws"
		proxy["ws-opts"] = opts
	case "grpc":
		grpc := mapOf(stream["grpcSettings"])
		proxy["network"] = "grpc"
		proxy["grpc-opts"] = map[string]any{"grpc-service-name": stringOf(grpc["serviceName"])}
	case "xhttp", "splithttp":
		xhttp := mapOf(stream["xhttpSettings"])
		if xhttp == nil {
			xhttp = mapOf(stream["splithttpSettings"])
		}
		opts := map[string]any{"path": orDefault(stringOf(xhttp["path"]), "/")}
		if host := stringOf(xhttp["host"]); host != "" {
			opts["host"] = host
		}
		if mode := stringOf(xhttp["mode"]); mode != "" {
			opts["mode"] = mode
		}
		proxy["network"] = "xhttp"
		proxy["xhttp-opts"] = opts
	default:
		return fmt.Errorf("транспорт %q не поддерживается mihomo", network)
	}

	switch stringOf(stream["security"]) {
	case "reality":
		reality := mapOf(stream["realitySettings"])
		proxy["tls"] = true
		if name := stringOf(reality["serverName"]); name != "" {
			proxy["servername"] = name
		}
		publicKey := orDefault(stringOf(reality["publicKey"]), stringOf(reality["password"]))
		proxy["reality-opts"] = map[string]any{
			"public-key": publicKey,
			"short-id":   stringOf(reality["shortId"]),
		}
		proxy["client-fingerprint"] = orDefault(stringOf(reality["fingerprint"]), "chrome")
	case "tls":
		tls := mapOf(stream["tlsSettings"])
		proxy["tls"] = true
		if name := stringOf(tls["serverName"]); name != "" {
			if proxy["type"] == "trojan" {
				proxy["sni"] = name
			} else {
				proxy["servername"] = name
			}
		}
		if alpn := stringsOf(tls["alpn"]); len(alpn) > 0 {
			proxy["alpn"] = alpn
		}
		if fingerprint := stringOf(tls["fingerprint"]); fingerprint != "" {
			proxy["client-fingerprint"] = fingerprint
		}
		if boolOf(tls["allowInsecure"]) {
			proxy["skip-cert-verify"] = true
		}
	}
	return nil
}

// xrayEndpoint достаёт адрес и порт из vnext/servers или из «плоских» настроек.
func xrayEndpoint(outbound map[string]any) (string, int) {
	settings := mapOf(outbound["settings"])
	if settings == nil {
		return "", 0
	}
	for _, key := range []string{"vnext", "servers"} {
		if list, ok := settings[key].([]any); ok && len(list) > 0 {
			entry := mapOf(list[0])
			return stringOf(entry["address"]), intOf(entry["port"])
		}
	}
	return stringOf(settings["address"]), intOf(settings["port"])
}

func xrayUser(settings map[string]any) map[string]any {
	if list, ok := settings["vnext"].([]any); ok && len(list) > 0 {
		if users, ok := mapOf(list[0])["users"].([]any); ok && len(users) > 0 {
			return mapOf(users[0])
		}
	}
	// Новый «плоский» формат: id/flow/encryption прямо в settings.
	return settings
}

func xrayServer(settings map[string]any) map[string]any {
	if list, ok := settings["servers"].([]any); ok && len(list) > 0 {
		return mapOf(list[0])
	}
	return settings
}

func splitEarlyData(path string) (string, int) {
	parsed, err := url.Parse(path)
	if err != nil {
		return path, 0
	}
	query := parsed.Query()
	early, _ := strconv.Atoi(query.Get("ed"))
	if early == 0 {
		return path, 0
	}
	query.Del("ed")
	parsed.RawQuery = query.Encode()
	return parsed.String(), early
}

func appendQuery(path, key, value string) string {
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + key + "=" + url.QueryEscape(value)
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func orList(values []string, fallback string) []string {
	if len(values) == 0 {
		return []string{fallback}
	}
	return values
}
