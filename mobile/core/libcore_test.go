package libcore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/metacubex/mihomo/hub/executor"
	"github.com/xtls/xray-core/core"
	"gopkg.in/yaml.v3"
)

var shareLinks = `vless://2b1a5c6e-1111-4222-8333-944455556666@reality.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw&sid=6ba85179e30d4fc2&type=tcp#Нидерланды
vless://2b1a5c6e-1111-4222-8333-944455556666@ws.example.com:443?encryption=none&security=tls&sni=ws.example.com&type=ws&host=ws.example.com&path=%2Fws%3Fed%3D2048#WS
vless://2b1a5c6e-1111-4222-8333-944455556666@xh.example.com:443?encryption=none&security=tls&sni=xh.example.com&type=xhttp&path=%2Fxh&mode=auto#XHTTP
vmess://` + vmessLink + `
trojan://secret@trojan.example.com:443?sni=trojan.example.com&type=grpc&serviceName=tun#Trojan
ss://` + ssUser + `@ss.example.com:8388#SS
hysteria2://pass@hy.example.com:443?sni=hy.example.com#Hy2
tuic://2b1a5c6e-1111-4222-8333-944455556666:pw@tuic.example.com:443?alpn=h3#TUIC`

var (
	vmessLink = base64.StdEncoding.EncodeToString([]byte(`{"v":"2","ps":"VMess","add":"vm.example.com","port":"443","id":"2b1a5c6e-1111-4222-8333-944455556666","aid":"0","net":"ws","type":"none","host":"vm.example.com","path":"/vm","tls":"tls","sni":"vm.example.com"}`))
	ssUser    = base64.RawURLEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:sspass"))
)

func parse(t *testing.T, body string) []*Node {
	t.Helper()
	nodes, err := parseNodes([]byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return nodes
}

func byName(t *testing.T, nodes []*Node, name string) *Node {
	t.Helper()
	for _, node := range nodes {
		if node.Name == name {
			return node
		}
	}
	t.Fatalf("нет сервера %q", name)
	return nil
}

func nodeJSON(t *testing.T, node *Node) string {
	t.Helper()
	payload, err := json.Marshal(node)
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}

// Конфиг xray должен проходить собственный загрузчик xray-core.
func assertXrayAccepts(t *testing.T, node *Node) {
	t.Helper()
	config, err := BuildConfig(EngineXray, nodeJSON(t, node), `{"bypassLan":true,"directRu":true}`)
	if err != nil {
		t.Fatalf("%s: BuildConfig xray: %v", node.Name, err)
	}
	if _, err := core.LoadConfig("json", bytes.NewReader([]byte(config))); err != nil {
		t.Fatalf("%s: xray-core отверг конфиг: %v\n%s", node.Name, err, config)
	}
}

// Конфиг mihomo должен проходить парсер mihomo, включая разбор прокси.
func assertMihomoAccepts(t *testing.T, node *Node) {
	t.Helper()
	options, _ := parseOptions(`{"bypassLan":true,"directRu":true}`)
	config, err := buildMihomoConfig(node, options, 0)
	if err != nil {
		t.Fatalf("%s: build mihomo: %v", node.Name, err)
	}
	payload, err := yaml.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executor.ParseWithBytes(payload); err != nil {
		t.Fatalf("%s: mihomo отверг конфиг: %v\n%s", node.Name, err, payload)
	}
}

func TestShareLinksWorkOnBothEngines(t *testing.T) {
	nodes := parse(t, shareLinks)
	if len(nodes) != 8 {
		t.Fatalf("ожидалось 8 серверов, получено %d", len(nodes))
	}
	for _, name := range []string{"Нидерланды", "WS", "XHTTP", "VMess", "Trojan", "SS", "Hy2"} {
		node := byName(t, nodes, name)
		assertXrayAccepts(t, node)
		assertMihomoAccepts(t, node)
	}

	tuic := byName(t, nodes, "TUIC")
	if tuic.Supports(EngineXray) || !tuic.Supports(EngineMihomo) {
		t.Fatalf("TUIC должен работать только на mihomo")
	}
	assertMihomoAccepts(t, tuic)
	if _, err := BuildConfig(EngineXray, nodeJSON(t, tuic), ""); err == nil {
		t.Fatal("xray не должен собирать конфиг для TUIC")
	}
}

func TestRealityFieldsSurviveConversion(t *testing.T) {
	node := byName(t, parse(t, shareLinks), "Нидерланды")
	stream := mapOf(node.Xray["streamSettings"])
	reality := mapOf(stream["realitySettings"])
	if stream["security"] != "reality" || reality["publicKey"] != "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw" || reality["shortId"] != "6ba85179e30d4fc2" {
		t.Fatalf("reality потерялся: %#v", stream)
	}
	user := xrayUser(mapOf(node.Xray["settings"]))
	if user["flow"] != "xtls-rprx-vision" {
		t.Fatalf("flow потерялся: %#v", user)
	}
}

func TestWebSocketEarlyData(t *testing.T) {
	node := byName(t, parse(t, shareLinks), "WS")
	ws := mapOf(mapOf(node.Xray["streamSettings"])["wsSettings"])
	if ws["path"] != "/ws?ed=2048" || ws["host"] != "ws.example.com" {
		t.Fatalf("ws: %#v", ws)
	}
}

func TestBase64Subscription(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(shareLinks))
	if nodes := parse(t, encoded); len(nodes) != 8 {
		t.Fatalf("base64: получено %d серверов", len(nodes))
	}
}

func TestClashSubscription(t *testing.T) {
	body := `
mixed-port: 7890
proxies:
  - name: "Германия"
    type: vless
    server: de.example.com
    port: 443
    uuid: 2b1a5c6e-1111-4222-8333-944455556666
    network: grpc
    tls: true
    servername: de.example.com
    client-fingerprint: chrome
    grpc-opts:
      grpc-service-name: grpc
  - name: "Германия"
    type: ss
    server: de2.example.com
    port: 8388
    cipher: aes-256-gcm
    password: pw
proxy-groups:
  - name: PROXY
    type: select
    proxies: [Германия]
`
	nodes := parse(t, body)
	if len(nodes) != 2 || nodes[1].Name != "Германия (2)" {
		t.Fatalf("имена: %v, %v", nodes[0].Name, nodes[1].Name)
	}
	for _, node := range nodes {
		assertXrayAccepts(t, node)
		assertMihomoAccepts(t, node)
	}
}

func TestXrayJSONSubscription(t *testing.T) {
	body := `[{
  "remarks": "🇫🇮 Финляндия",
  "outbounds": [
    {"tag": "proxy", "protocol": "vless",
     "settings": {"vnext": [{"address": "fi.example.com", "port": 443,
       "users": [{"id": "2b1a5c6e-1111-4222-8333-944455556666", "encryption": "none", "flow": "xtls-rprx-vision"}]}]},
     "streamSettings": {"network": "tcp", "security": "reality",
       "realitySettings": {"serverName": "www.google.com", "publicKey": "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw", "shortId": "ab", "fingerprint": "chrome"}}},
    {"tag": "direct", "protocol": "freedom"}
  ]
}, {
  "remarks": "Старый TLS",
  "outbounds": [
    {"protocol": "trojan",
     "settings": {"servers": [{"address": "tr.example.com", "port": 443, "password": "pw"}]},
     "streamSettings": {"network": "ws", "security": "tls",
       "tlsSettings": {"serverName": "tr.example.com", "allowInsecure": true},
       "wsSettings": {"path": "/tr?ed=2560", "host": "tr.example.com"}}}
  ]
}]`
	nodes := parse(t, body)
	if len(nodes) != 2 {
		t.Fatalf("ожидалось 2 сервера, получено %d", len(nodes))
	}
	finland := byName(t, nodes, "🇫🇮 Финляндия")
	if finland.Server != "fi.example.com" || finland.Port != 443 || finland.Type != "vless" {
		t.Fatalf("finland: %#v", finland)
	}
	for _, node := range nodes {
		assertXrayAccepts(t, node)
		assertMihomoAccepts(t, node)
	}
	ws := mapOf(byName(t, nodes, "Старый TLS").Clash["ws-opts"])
	if ws["path"] != "/tr" || ws["max-early-data"] != 2560 {
		t.Fatalf("early data: %#v", ws)
	}
}

func TestEmptySubscription(t *testing.T) {
	if _, err := ParseSubscription("   "); err == nil {
		t.Fatal("пустая подписка должна давать ошибку")
	}
}

func TestDnsHost(t *testing.T) {
	cases := map[string]string{
		"1.1.1.1":                          "1.1.1.1",
		"8.8.8.8:53":                       "8.8.8.8",
		"https://1.1.1.1/dns-query":        "1.1.1.1",
		"tls://dns.google":                 "dns.google",
		"[2606:4700:4700::1111]:53":        "2606:4700:4700::1111",
		"https://dns.google:443/dns-query": "dns.google",
	}
	for input, want := range cases {
		if got := dnsHost(input); got != want {
			t.Errorf("dnsHost(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestXrayDisplayVersion(t *testing.T) {
	if got := xrayDisplayVersion("1.260327.0"); got != "26.3.27" {
		t.Fatalf("got %q", got)
	}
	if !strings.Contains(Version(), "mihomo") {
		t.Fatalf("Version: %q", Version())
	}
}

func TestLogRing(t *testing.T) {
	ring := newLogRing(3)
	for _, line := range []string{"a", "b", "c", "d"} {
		ring.Add(line)
	}
	if got := ring.String(); got != "b\nc\nd" {
		t.Fatalf("got %q", got)
	}
}
