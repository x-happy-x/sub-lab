import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-remember-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const sub = await import("./subscription.js");

const uuid = "11111111-2222-3333-4444-555555555555";
const BUNDLE = JSON.stringify([{
  remarks: "Запись",
  outbounds: [{
    tag: "proxy",
    protocol: "vless",
    settings: { vnext: [{ address: "10.0.0.1", port: 443, users: [{ id: uuid, encryption: "none" }] }] },
    streamSettings: { network: "tcp", security: "none" },
  }],
}]);

/**
 * Провайдер, который сначала отвечает json, а потом «падает».
 *
 * Ровно этот случай и ломал формат: сегодня источник json, завтра он не
 * отвечает — и клиенту, у которого формат зависит от источника, уезжал raw.
 */
function startFlakyProvider() {
  let alive = true;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (!alive) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(BUNDLE);
    });
    srv.listen(0, "127.0.0.1", () => resolve({
      srv,
      origin: `http://127.0.0.1:${srv.address().port}`,
      kill() { alive = false; },
    }));
  });
}

test("пока провайдер отвечает, формат определяется по нему", async () => {
  const { srv, origin } = await startFlakyProvider();
  try {
    const got = await sub.fetchWithNode(`${origin}/sub`, {});
    const output = sub.finalizeOutputBySource(
      "raw", true, `${origin}/sub`, got.body, got.responseHeaders?.["content-type"] || "",
    );
    assert.equal(output, "json");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("объединение остаётся json, даже когда спрашивать нечего", () => {
  assert.equal(sub.finalizeOutputBySource("raw", true, "merge:abc", "", ""), "json");
});

test("клиентам, чей формат от источника не зависит, память не нужна", () => {
  assert.equal(sub.finalizeOutputBySource("clash", false, "https://x.example.com/s", BUNDLE, "application/json"), "clash");
});

test("формат берётся из памяти, когда провайдер молчит", async () => {
  const store = await import("./sqlite-store.js");
  const subUrl = "https://remembered.example.com/s";
  const context = { subUrl, app: "happ", device: "", profileNames: [], forwardHeaders: {} };

  // Памяти ещё нет — остаёмся при том, что дали изначально.
  assert.equal(await sub.lastKnownSourceFormat(context), "");
  assert.equal(await sub.outputFromRememberedSource("raw", true, context), "raw");

  const feed = await store.upsertSubscriptionFeed({ subUrl, app: "happ", device: "", profileNames: [] });
  const bodyPath = path.join(DATA_DIR, "body.json");
  fs.writeFileSync(bodyPath, BUNDLE);
  await store.createSourceSnapshot({
    feedId: feed.id,
    bodyPath,
    responseStatus: 200,
    responseUrl: subUrl,
    sourceFormat: "json",
  });

  // Теперь знаем, чем источник был в прошлый раз.
  assert.equal(await sub.lastKnownSourceFormat(context), "json");
  assert.equal(await sub.outputFromRememberedSource("raw", true, context), "json");
  // Клиента, чей формат от источника не зависит, память не трогает.
  assert.equal(await sub.outputFromRememberedSource("clash", false, context), "clash");
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
