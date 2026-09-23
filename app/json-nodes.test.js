import test from "node:test";
import assert from "node:assert/strict";

import { produceOutput } from "./subscription.js";

/**
 * Xray-подписка с записью, внутри которой основной узел и два кандидата.
 *
 * Именно из-за таких записей «группами» в JSON разъезжалось: групп в этом
 * формате нет, и каждый кандидат становился отдельным конфигом.
 */
const BUNDLE = JSON.stringify([
  {
    remarks: "Балансировщик",
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: { vnext: [{ address: "10.0.0.1", port: 443, users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none" }] }] },
        streamSettings: { network: "tcp", security: "none" },
      },
      {
        tag: "proxy-2",
        protocol: "vless",
        settings: { vnext: [{ address: "10.0.0.2", port: 443, users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none" }] }] },
        streamSettings: { network: "tcp", security: "none" },
      },
      {
        tag: "proxy-3",
        protocol: "vless",
        settings: { vnext: [{ address: "10.0.0.3", port: 443, users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none" }] }] },
        streamSettings: { network: "tcp", security: "none" },
      },
      { tag: "direct", protocol: "freedom" },
    ],
  },
]);

const uuid = "11111111-2222-3333-4444-555555555555";
const RAW = [
  `vless://${uuid}@10.0.0.1:443?type=tcp&security=none#RU`,
  `vless://${uuid}@10.0.0.2:443?type=tcp&security=none#NL`,
].join("\n");

async function countJson(source, nodes) {
  const result = await produceOutput(source, "json", { app: "happ", nodesMode: nodes });
  assert.equal(result.ok, true, result.error);
  const parsed = JSON.parse(result.body);
  return Array.isArray(parsed) ? parsed.length : 0;
}

test("«группами» в JSON сворачивает запись так же, как «свернуть»", async () => {
  const collapsed = await countJson(BUNDLE, "collapse");
  const grouped = await countJson(BUNDLE, "group");
  const expanded = await countJson(BUNDLE, "expand");

  assert.equal(grouped, collapsed, "«группами» не должно разъезжаться на кандидатов");
  assert.ok(expanded > collapsed, "«развернуть» обязано остаться собой");
});

test("на плоской подписке режимы ничего не меняют", async () => {
  // Записей с кандидатами нет — сворачивать нечего, все режимы равны.
  const collapsed = await countJson(RAW, "collapse");
  assert.equal(await countJson(RAW, "group"), collapsed);
  assert.equal(await countJson(RAW, "expand"), collapsed);
});

test("clash по-прежнему различает «группами» и «свернуть»", async () => {
  // Там группы есть, и режим обязан работать как раньше.
  const collapsed = await produceOutput(BUNDLE, "clash", { app: "happ", nodesMode: "collapse" });
  const grouped = await produceOutput(BUNDLE, "clash", { app: "happ", nodesMode: "group" });
  assert.equal(collapsed.ok, true, collapsed.error);
  assert.equal(grouped.ok, true, grouped.error);
  assert.notEqual(grouped.body, collapsed.body);
});
