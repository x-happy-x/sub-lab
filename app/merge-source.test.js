import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildMergedResponseHeaders,
  dedupeServerNames,
  filterRawBody,
  mergeUserinfo,
  nameFromRawLine,
} from "./merge-source.js";

const uuid = "11111111-2222-3333-4444-555555555555";
const line = (name, host) => `vless://${uuid}@${host}:443?type=tcp&security=none#${encodeURIComponent(name)}`;

const BODY = [
  line("RU Москва 1", "10.0.0.1"),
  line("Белые IP · LTE", "10.0.0.2"),
  line("Whitelist Питер", "10.0.0.3"),
  line("NL Амстердам", "10.0.0.4"),
].join("\n");

test("merge filter keeps only servers matching the pattern", () => {
  const selected = filterRawBody(BODY, { pattern: "whitelist|бел[ыо]", onEmpty: "all" });
  assert.equal(selected.total, 4);
  assert.equal(selected.matched, 2);
  assert.equal(selected.fellBack, false);
  assert.deepEqual(selected.lines.map(nameFromRawLine), ["Белые IP · LTE", "Whitelist Питер"]);
});

test("merge filter ignores case and an empty pattern takes everything", () => {
  assert.equal(filterRawBody(BODY, { pattern: "МОСКВА" }).matched, 1);
  const all = filterRawBody(BODY, { pattern: "" });
  assert.equal(all.matched, 4);
  assert.equal(all.filtered, false);
});

test("merge filter falls back by the chosen rule when nothing matches", () => {
  const takeAll = filterRawBody(BODY, { pattern: "нет-такого", onEmpty: "all" });
  assert.equal(takeAll.lines.length, 4);
  assert.equal(takeAll.fellBack, true);

  const skip = filterRawBody(BODY, { pattern: "нет-такого", onEmpty: "skip" });
  assert.equal(skip.lines.length, 0);
  assert.equal(skip.fellBack, true);

  assert.throws(
    () => filterRawBody(BODY, { pattern: "нет-такого", onEmpty: "error" }, "Провайдер A"),
    /Провайдер A/,
  );
});

test("a broken pattern does not break the merge", () => {
  const selected = filterRawBody(BODY, { pattern: "([", onEmpty: "error" });
  assert.equal(selected.lines.length, 4);
  assert.equal(selected.filtered, false);
});

test("subscription userinfo is summed and the longest expiry wins", () => {
  const merged = mergeUserinfo([
    "upload=1000; download=2000; total=10000; expire=2000000000",
    "upload=500; download=1500; total=5000; expire=1900000000",
  ]);
  // Срок берём самый дальний: объединение живо, пока жив хотя бы один
  // источник, а по ближайшему оно «кончалось» вместе с первой же подпиской.
  assert.equal(merged, "upload=1500; download=3500; total=15000; expire=2000000000");

  // Безлимитный источник делает безлимитным всё объединение.
  assert.match(mergeUserinfo(["upload=1; download=1; total=100", "upload=1; download=1; total=0; expire=5"]), /total=0/);
  assert.equal(mergeUserinfo(["", "   "]), "");
});

test("merged headers stay latin1 and carry the merge title", () => {
  const headers = buildMergedResponseHeaders(
    [
      { "subscription-userinfo": "upload=1; download=2; total=3; expire=2000000000", "profile-update-interval": "24" },
      { "subscription-userinfo": "upload=1; download=2; total=3; expire=1900000000", "profile-update-interval": "12" },
    ],
    { title: "Домашнее объединение" },
  );
  assert.equal(headers["profile-update-interval"], "12");
  assert.match(headers["profile-title"], /^base64:/);
  assert.equal(
    Buffer.from(headers["profile-title"].slice("base64:".length), "base64").toString("utf8"),
    "Домашнее объединение",
  );
  // Заголовок обязан быть latin1, иначе Node уронит ответ на writeHead.
  for (const value of Object.values(headers)) {
    assert.match(String(value), /^[\x20-\x7e]*$/);
  }

  const ascii = buildMergedResponseHeaders([], { title: "Home merge" });
  assert.equal(ascii["profile-title"], "Home merge");
  assert.equal(ascii["subscription-userinfo"], undefined);
});

test("merged source keeps its id and filters across edits", async () => {
  const dataDir = path.resolve(process.cwd(), ".tmp-test-data", `merge-${crypto.randomBytes(4).toString("hex")}`);
  process.env.SUB_LAB_DATA_DIR = dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });

  const { createMergedSource, updateMergedSource, getMergedSource } = await import("./local-sources.js");

  const created = createMergedSource({
    name: "Домашнее",
    items: [
      { sub_url: "https://example.com/a", output: "raw", title: "A", filter: { pattern: "бел[ыо]", onEmpty: "skip" } },
      { sub_url: "https://example.com/b", output: "raw", title: "B" },
      { output: "raw", title: "без источника" },
    ],
  });
  assert.equal(created.ok, true);
  // Запись без sub_url отбрасывается: тянуть нечего.
  assert.equal(created.source.items.length, 2);
  assert.equal(created.source.items[0].filter.pattern, "бел[ыо]");
  assert.equal(created.source.items[0].filter.onEmpty, "skip");
  // Умолчание для записи без фильтра.
  assert.equal(created.source.items[1].filter.onEmpty, "all");

  const updated = updateMergedSource(created.source.id, {
    name: "Домашнее",
    items: [{ sub_url: "https://example.com/c", output: "raw", title: "C", filter: { pattern: "lte|4g", onEmpty: "error" } }],
  });
  assert.equal(updated.source.id, created.source.id, "адрес подписки не должен меняться");
  assert.equal(updated.source.items.length, 1);
  assert.equal(updated.source.createdAt, created.source.createdAt);

  const read = getMergedSource(created.source.id);
  assert.equal(read.source.items[0].sub_url, "https://example.com/c");
  assert.equal(read.source.items[0].filter.onEmpty, "error");

  assert.equal(updateMergedSource(created.source.id, { items: [] }).ok, false);
  assert.equal(updateMergedSource("no-such-merge", { items: [{ sub_url: "https://example.com/x" }] }).ok, false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("duplicate server names get numbered so clients can tell them apart", () => {
  const lines = [
    line("NL Амстердам", "10.0.0.1"),
    line("NL Амстердам", "10.0.0.2"),
    line("RU Москва", "10.0.0.3"),
    line("nl амстердам", "10.0.0.4"),
  ];
  const names = dedupeServerNames(lines).map(nameFromRawLine);
  assert.deepEqual(names, ["NL Амстердам", "NL Амстердам (2)", "RU Москва", "nl амстердам (3)"]);
  // Адрес и ключи трогать нельзя — меняется только подпись.
  assert.equal(dedupeServerNames(lines)[1].split("#")[0], lines[1].split("#")[0]);

  // Если номер уже занят, берём следующий свободный.
  const collide = [line("Сервер (2)", "10.0.0.1"), line("Сервер", "10.0.0.2"), line("Сервер", "10.0.0.3")];
  assert.deepEqual(dedupeServerNames(collide).map(nameFromRawLine), ["Сервер (2)", "Сервер", "Сервер (3)"]);
});

test("merge survives a dead source and fails only when nothing is left", async () => {
  const dataDir = path.resolve(process.cwd(), ".tmp-test-data", `merge-live-${crypto.randomBytes(4).toString("hex")}`);
  process.env.SUB_LAB_DATA_DIR = dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });

  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "subscription-userinfo": "upload=1; download=2; total=100; expire=2000000000",
      });
      return res.end([line("RU Москва", "10.0.0.1"), line("NL Амстердам", "10.0.0.2")].join("\n"));
    }
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html><body>502 Bad Gateway</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const { createMergedSource } = await import("./local-sources.js");
    const { fetchWithNode } = await import("./subscription.js");
    const alive = { sub_url: `http://127.0.0.1:${port}/ok`, output: "raw", title: "Живой" };
    const dead = { sub_url: `http://127.0.0.1:${port}/down`, output: "raw", title: "Упавший" };

    const mixed = createMergedSource({ name: "Смесь", items: [dead, alive] });
    const result = await fetchWithNode(`merge:${mixed.source.id}`, {});
    // Упавший провайдер не должен утаскивать за собой рабочие источники.
    assert.equal(result.body.split("\n").filter(Boolean).length, 2);
    assert.deepEqual(result.skipped.map((row) => row.label), ["Упавший"]);
    // Заголовки собираются по тем источникам, что ответили.
    assert.match(result.responseHeaders["subscription-userinfo"], /total=100/);

    const allDead = createMergedSource({ name: "Всё лежит", items: [dead] });
    await assert.rejects(
      () => fetchWithNode(`merge:${allDead.source.id}`, {}),
      /ни один источник не отдал серверы/,
      "пустую подписку отдавать нельзя — приложение затрёт рабочий список",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
