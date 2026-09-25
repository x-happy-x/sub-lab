//go:build e2e && linux

// Сквозная проверка обоих ядер через настоящий TUN. Нужны root и /dev/net/tun:
//
//	sudo ./e2e.sh
//
// Схема: HTTP-запрос на 198.51.100.10 → маршрут в TUN → ядро (xray или mihomo)
// → локальный xray-сервер (shadowsocks / vless) → freedom с redirect на
// локальный HTTP-сервер, который отвечает "pong".
package libcore

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/vishvananda/netlink"
	"github.com/xtls/xray-core/core"
	"golang.org/x/sys/unix"
)

const (
	e2eDevice = "sltest0"
	e2eUUID   = "2b1a5c6e-1111-4222-8333-944455556666"
	e2eTarget = "198.51.100.10"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func openTestTun(t *testing.T) int {
	t.Helper()
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Skipf("нет /dev/net/tun: %v", err)
	}
	ifr, err := unix.NewIfreq(e2eDevice)
	if err != nil {
		t.Fatal(err)
	}
	ifr.SetUint16(unix.IFF_TUN | unix.IFF_NO_PI)
	if err := unix.IoctlIfreq(fd, unix.TUNSETIFF, ifr); err != nil {
		t.Skipf("TUNSETIFF: %v (нужен root)", err)
	}
	link, err := netlink.LinkByName(e2eDevice)
	if err != nil {
		t.Fatal(err)
	}
	address, _ := netlink.ParseAddr("172.19.0.1/30")
	if err := netlink.AddrAdd(link, address); err != nil {
		t.Fatal(err)
	}
	if err := netlink.LinkSetMTU(link, 1500); err != nil {
		t.Fatal(err)
	}
	if err := netlink.LinkSetUp(link); err != nil {
		t.Fatal(err)
	}
	_, dst, _ := net.ParseCIDR(e2eTarget + "/32")
	if err := netlink.RouteAdd(&netlink.Route{LinkIndex: link.Attrs().Index, Dst: dst}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(fd) })
	return fd
}

func startUpstream(t *testing.T, httpAddr string, ssPort, vlessPort int) {
	t.Helper()
	config := fmt.Sprintf(`{
  "log": {"loglevel": "warning"},
  "inbounds": [
    {"listen": "127.0.0.1", "port": %d, "protocol": "shadowsocks",
     "settings": {"method": "aes-128-gcm", "password": "e2e-pass", "network": "tcp,udp"}},
    {"listen": "127.0.0.1", "port": %d, "protocol": "vless",
     "settings": {"clients": [{"id": %q}], "decryption": "none"}}
  ],
  "outbounds": [{"protocol": "freedom", "settings": {"redirect": %q}}]
}`, ssPort, vlessPort, e2eUUID, httpAddr)
	instance, err := core.StartInstance("json", []byte(config))
	if err != nil {
		t.Fatalf("upstream: %v", err)
	}
	t.Cleanup(func() { _ = instance.Close() })
}

func TestEndToEnd(t *testing.T) {
	if err := Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}

	httpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go http.Serve(httpListener, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "pong")
	}))
	defer httpListener.Close()

	ssPort, vlessPort := freePort(t), freePort(t)
	startUpstream(t, httpListener.Addr().String(), ssPort, vlessPort)
	fd := openTestTun(t)

	ssUserInfo := base64.RawURLEncoding.EncodeToString([]byte("aes-128-gcm:e2e-pass"))
	links := fmt.Sprintf("ss://%s@127.0.0.1:%d#ss\nvless://%s@127.0.0.1:%d?type=tcp&security=none&encryption=none#vless",
		ssUserInfo, ssPort, e2eUUID, vlessPort)
	nodesJSON, err := ParseSubscription(links)
	if err != nil {
		t.Fatal(err)
	}
	var nodes []json.RawMessage
	if err := json.Unmarshal([]byte(nodesJSON), &nodes); err != nil {
		t.Fatal(err)
	}

	client := &http.Client{
		Timeout:   8 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil},
	}
	// Ядро меняется без переоткрытия TUN — ровно как при переключении в приложении.
	for _, engineName := range []string{EngineXray, EngineMihomo, EngineXray} {
		for index, node := range nodes {
			label := fmt.Sprintf("%s/%d", engineName, index)
			if err := Start(engineName, string(node), int32(fd), `{"dns":"1.1.1.1","logLevel":"warning"}`); err != nil {
				t.Fatalf("%s: Start: %v", label, err)
			}
			if ActiveEngine() != engineName {
				t.Fatalf("%s: ActiveEngine = %q", label, ActiveEngine())
			}

			var body string
			deadline := time.Now().Add(10 * time.Second)
			for {
				response, err := client.Get("http://" + e2eTarget + ":8080/")
				if err == nil {
					data, _ := io.ReadAll(response.Body)
					response.Body.Close()
					body = string(data)
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("%s: запрос через туннель не прошёл: %v\nжурнал:\n%s", label, err, Logs())
				}
				time.Sleep(300 * time.Millisecond)
			}
			if strings.TrimSpace(body) != "pong" {
				t.Fatalf("%s: неожиданный ответ %q", label, body)
			}
			t.Logf("%s: ok", label)
		}
	}
	if err := Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if IsRunning() {
		t.Fatal("ядро всё ещё запущено после Stop")
	}
	// После остановки TUN никто не обслуживает: запрос обязан не пройти.
	client.Timeout = 2 * time.Second
	if response, err := client.Get("http://" + e2eTarget + ":8080/"); err == nil {
		response.Body.Close()
		t.Fatal("после Stop трафик всё ещё проходит через туннель")
	}
}
