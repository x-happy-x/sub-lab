import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { previewMergeItems } from "./subscription.js";

const uuid = "11111111-2222-3333-4444-555555555555";
const NAMES = ["RU Москва", "NL Амстердам", "DE Франкфурт", "FI Хельсинки"];
const PLAIN = NAMES
  .map((name, index) => `vless://${uuid}@10.0.0.${index + 1}:443?type=tcp&security=none#${encodeURIComponent(name)}`)
  .join("\n");

/** Провайдер, отдающий подписку так, как её шлёт большинство: одной строкой base64. */
function startProvider(body, contentType = "text/plain") {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("источник в base64 отдаёт в объединение все свои серверы", async () => {
  const base64 = Buffer.from(PLAIN, "utf8").toString("base64");
  const { srv, origin } = await startProvider(base64);

  try {
    const [result] = await previewMergeItems([{ sub_url: `${origin}/sub`, endpoint: "sub", output: "raw" }]);
    assert.equal(result.ok, true, result.error);
    // Раньше здесь была ровно одна строка — сама base64-простыня. В интерфейсе
    // это выглядело как «один непонятный сервер».
    assert.equal(result.names.length, NAMES.length);
    assert.deepEqual(result.names, NAMES);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("обычный список по-прежнему разбирается как раньше", async () => {
  const { srv, origin } = await startProvider(PLAIN);

  try {
    const [result] = await previewMergeItems([{ sub_url: `${origin}/sub`, endpoint: "sub", output: "raw" }]);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.names, NAMES);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("регулярка работает и по декодированным именам", async () => {
  const base64 = Buffer.from(PLAIN, "utf8").toString("base64");
  const { srv, origin } = await startProvider(base64);

  try {
    const [result] = await previewMergeItems([{
      sub_url: `${origin}/sub`,
      endpoint: "sub",
      output: "raw",
      filter: { pattern: "Амстердам|Хельсинки", onEmpty: "all" },
    }]);
    assert.equal(result.ok, true, result.error);
    // Предпросмотр отдаёт все имена, отбор по регулярке рисует интерфейс, но
    // без декодирования отбирать было бы не из чего.
    assert.ok(result.names.includes("NL Амстердам"));
    assert.ok(result.names.includes("FI Хельсинки"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
