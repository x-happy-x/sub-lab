import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { produceOutput } from "./subscription.js";

const uuid = "11111111-2222-3333-4444-555555555555";
const line = (name, host) => `vless://${uuid}@${host}:443?type=tcp&security=none#${encodeURIComponent(name)}`;
const PLAIN = [line("RU Москва", "10.0.0.1"), line("NL Амстердам", "10.0.0.2")].join("\n");

test("json output understands a base64 subscription", async () => {
  const base64 = Buffer.from(PLAIN, "utf8").toString("base64");

  const fromPlain = await produceOutput(PLAIN, "json", { app: "happ" });
  const fromBase64 = await produceOutput(base64, "json", { app: "happ" });

  assert.equal(fromPlain.ok, true);
  assert.equal(fromBase64.ok, true);
  // Провайдеры часто отдают подписку в base64; раньше из неё собирался
  // пустой список, потому что JSON-ветка не декодировала тело.
  assert.equal(JSON.parse(fromBase64.body).length, 2);
  assert.equal(JSON.parse(fromBase64.body).length, JSON.parse(fromPlain.body).length);
  assert.deepEqual(
    JSON.parse(fromBase64.body).map((item) => item.remarks),
    ["RU Москва", "NL Амстердам"],
  );
});

test("raw and clash keep working for base64 sources", async () => {
  const base64 = Buffer.from(PLAIN, "utf8").toString("base64");
  const raw = await produceOutput(base64, "raw", { app: "happ" });
  const clash = await produceOutput(base64, "clash", { app: "happ" });
  assert.equal(raw.ok, true);
  assert.equal(clash.ok, true);
  assert.match(clash.body, /NL Амстердам/);
});

test("an HTML answer says what actually went wrong", async () => {
  const cases = [
    ["<html><head><title>502 Bad Gateway</title></head><body>x</body></html>", /страницей 502/],
    ["<html><head><title>504 Gateway Timeout</title></head><body>x</body></html>", /страницей 504/],
    ['<iframe src="https://cdn.example.net/new/403.html"></iframe>', /защиты от ботов/],
    ["<!DOCTYPE html><html><head><title>403 - Forbidden</title></head><body>x</body></html>", /защиты от ботов/],
    ["<!DOCTYPE html><html><head><title>Привет</title></head><body>ok</body></html>", /HTML-страница/],
  ];
  for (const [body, expected] of cases) {
    const result = await produceOutput(body, "raw");
    assert.equal(result.ok, false);
    assert.match(result.error, expected, `для ответа ${body.slice(0, 40)}`);
  }
});

test("refresh path reports the HTML reason instead of crashing", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html><head><title>502 Bad Gateway</title></head><body>x</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const { fetchWithNode } = await import("./subscription.js");
    const fetched = await fetchWithNode(`http://127.0.0.1:${port}/x`, {});
    // Путь обновления кэша разбирает тело сам — раньше он падал на
    // необъявленной переменной вместо того, чтобы назвать причину.
    const result = await produceOutput(fetched.body, "clash", {});
    assert.equal(result.ok, false);
    assert.match(result.error, /страницей 502/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
