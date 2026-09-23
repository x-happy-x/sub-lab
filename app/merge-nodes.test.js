import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { previewMergeItems } from "./subscription.js";

/**
 * Xray-подписка с записью, внутри которой несколько кандидатов.
 *
 * Именно такие записи и «приходят свёрнутыми»: наружу торчит одно имя, а
 * реальных узлов внутри три.
 */
const BUNDLE = [
  {
    remarks: "Балансировщик",
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: {
          vnext: [{
            address: "10.0.0.1",
            port: 443,
            users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none" }],
          }],
        },
        streamSettings: { network: "tcp", security: "none" },
      },
      {
        tag: "proxy-2",
        protocol: "vless",
        settings: {
          vnext: [{
            address: "10.0.0.2",
            port: 443,
            users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none" }],
          }],
        },
        streamSettings: { network: "tcp", security: "none" },
      },
      { tag: "direct", protocol: "freedom" },
    ],
  },
];

function startProvider() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(BUNDLE));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const item = (nodes) => ({
  sub_url: `${globalThis.__origin}/sub`,
  endpoint: "sub",
  output: "raw",
  nodes,
});

test.before(async () => {
  const { srv, origin } = await startProvider();
  globalThis.__srv = srv;
  globalThis.__origin = origin;
});

test("режим узлов у источника объединения доезжает до разбора", async () => {
  const [collapsed, expanded] = await previewMergeItems([item("collapse"), item("expand")]);

  assert.equal(collapsed.ok, true, collapsed.error);
  assert.equal(expanded.ok, true, expanded.error);

  // Сворачивание оставляет одну строку на запись — так было всегда.
  assert.equal(collapsed.names.length, 1);
  // А разворачивание обязано дать все узлы записи. Раньше оба режима давали
  // одно и то же: `nodes` терялся по дороге к разбору источника.
  assert.ok(expanded.names.length > collapsed.names.length,
    `ожидали больше серверов при «развернуть», получили ${expanded.names.length} против ${collapsed.names.length}`);
});

test("пустой режим ведёт себя как «свернуть»", async () => {
  const [empty, collapsed] = await previewMergeItems([item(""), item("collapse")]);
  assert.equal(empty.ok, true, empty.error);
  assert.deepEqual(empty.names, collapsed.names);
});

test("«группами» внутри объединения сворачивает запись", async () => {
  // В объединении групп нет ни в json, ни в clash: оно склеивается из плоских
  // списков. Раньше запись с кандидатами рассыпалась на них по отдельности —
  // «Автовыбор Белые списки» превращался в кучу строк.
  const [collapsed, grouped, expanded] = await previewMergeItems([
    item("collapse"), item("group"), item("expand"),
  ]);

  assert.equal(collapsed.ok, true, collapsed.error);
  assert.equal(grouped.ok, true, grouped.error);
  assert.equal(expanded.ok, true, expanded.error);

  assert.equal(grouped.names.length, collapsed.names.length, "«группами» не должно рассыпаться");
  assert.deepEqual(grouped.names, collapsed.names);
  // «Развернуть» выбирают ради всех узлов — его не трогаем.
  assert.ok(expanded.names.length > collapsed.names.length);
});

test.after(() => {
  if (globalThis.__srv) globalThis.__srv.close();
});
