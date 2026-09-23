import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-merges-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;
process.env.DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");
const local = await import("./local-sources.js");

const item = (url) => ({ sub_url: url, endpoint: "sub", output: "raw" });

/** Отметка в прошлом: «сейчас» у локальной правки должно оказаться новее. */
const PAST = "2020-01-01T00:00:00.000Z";

test("состав объединения уезжает в выгрузке", async () => {
  const created = local.createMergedSource({
    name: "Роутер",
    items: [item("https://a.example.com/s"), item("https://b.example.com/s")],
  });
  assert.equal(created.ok, true, created.error);

  const bundle = await store.exportSyncBundle({ profiles: false });
  const sent = bundle.data.mergedSources.find((row) => row.id === created.source.id);
  // Без этого на второй панели короткая ссылка merge:<id> вела в никуда:
  // сама ссылка синхронизировалась, а собирать по ней было нечего.
  assert.ok(sent, "объединение должно попасть в выгрузку");
  assert.equal(sent.name, "Роутер");
  assert.equal(sent.items.length, 2);
});

test("приехавший состав появляется у нас", async () => {
  const report = await store.importSyncBundle({
    data: {
      mergedSources: [{
        id: "fromPeer",
        name: "С той стороны",
        items: [item("https://c.example.com/s")],
        createdAt: PAST,
        updatedAt: PAST,
      }],
    },
  });
  assert.equal(report.mergedSources, 1);

  const found = local.getMergedSource("fromPeer");
  assert.equal(found.ok, true);
  assert.equal(found.source.name, "С той стороны");
  assert.equal(found.source.items.length, 1);
});

test("свежая правка на этой стороне не затирается старой выгрузкой", async () => {
  local.updateMergedSource("fromPeer", {
    name: "Правили здесь",
    items: [item("https://d.example.com/s"), item("https://e.example.com/s")],
  });

  await store.importSyncBundle({
    data: {
      mergedSources: [{
        id: "fromPeer",
        name: "Старое имя",
        items: [item("https://c.example.com/s")],
        updatedAt: PAST,
      }],
    },
  });

  const found = local.getMergedSource("fromPeer");
  assert.equal(found.source.name, "Правили здесь");
  assert.equal(found.source.items.length, 2);
});

test("мусор в составе не валит импорт", async () => {
  const report = await store.importSyncBundle({
    data: { mergedSources: [null, { id: "" }, { id: "../побег" }, { id: "ok-id", name: "Ок", items: [], updatedAt: PAST }] },
  });
  assert.equal(report.mergedSources, 1);
  assert.equal(local.getMergedSource("../побег").ok, false);
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
