import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-tomb-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");

// Выдуманная шкала времени соседней панели. Все отметки заведомо позже
// «сейчас», чтобы локальная ссылка (её updated_at — текущее время) была
// старше приезжающих событий и правило «кто новее, тот и прав» проверялось,
// а не обходилось стороной.
const CREATED = "2027-01-01T00:00:00.000Z";
const DELETED = "2027-02-01T00:00:00.000Z";
const RECREATED = "2027-03-01T00:00:00.000Z";

/** Выгрузка соседней панели: одна ссылка и, при желании, надгробие к ней. */
function bundle({ link = null, grave = null } = {}) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      shortLinks: link ? [link] : [],
      deletedShortLinks: grave ? [grave] : [],
    },
  };
}

const liveLink = (updatedAt) => ({
  id: "shared",
  params: { endpoint: "last", sub_url: "https://example.com/s" },
  title: "общая",
  ownerUsername: "petya",
  createdAt: CREATED,
  updatedAt,
});

test("надгробие из выгрузки удаляет ссылку у нас", async () => {
  await store.createShortLinkRow("shared", {
    title: "общая",
    ownerUsername: "petya",
    params: { endpoint: "last", sub_url: "https://example.com/s" },
  });
  await store.incrementShortLinkHits("shared");
  assert.ok(await store.getShortLinkRow("shared"));

  const report = await store.importSyncBundle(bundle({ grave: { id: "shared", deletedAt: DELETED } }));
  assert.equal(report.deletedShortLinks, 1);
  assert.equal(await store.getShortLinkRow("shared"), null);
  // Надгробие оседает у нас, иначе третья панель его не увидит.
  assert.ok(await store.getShortLinkTombstone("shared"));
});

test("удалённая ссылка не возвращается из той же выгрузки", async () => {
  // Обычный случай: на той стороне выгрузку собрали раньше, чем до неё
  // доехало наше удаление, поэтому в ней ссылка ещё живая.
  await store.importSyncBundle(bundle({ link: liveLink(CREATED), grave: { id: "shared", deletedAt: DELETED } }));
  assert.equal(await store.getShortLinkRow("shared"), null);

  // И на следующем круге, когда надгробия в выгрузке уже нет, тоже.
  await store.importSyncBundle(bundle({ link: liveLink(CREATED) }));
  assert.equal(await store.getShortLinkRow("shared"), null);
});

test("заведённую заново ссылку надгробие не трогает", async () => {
  // Правка позже удаления — значит, ссылку сознательно создали снова.
  await store.importSyncBundle(bundle({ link: liveLink(RECREATED) }));
  const revived = await store.getShortLinkRow("shared");
  assert.ok(revived, "ссылка новее надгробия должна приехать");
  assert.equal(revived.title, "общая");

  // Старое надгробие, приехавшее следом, не должно её снести.
  await store.importSyncBundle(bundle({ grave: { id: "shared", deletedAt: DELETED } }));
  assert.ok(await store.getShortLinkRow("shared"));
});

test("наше удаление уезжает в выгрузке", async () => {
  await store.deleteShortLinkRow("shared", { deletedBy: "admin" });
  const exported = await store.exportSyncBundle({ profiles: false });
  const grave = exported.data.deletedShortLinks.find((row) => row.id === "shared");
  assert.ok(grave);
  assert.equal(grave.deletedBy, "admin");
  assert.equal(exported.data.shortLinks.some((row) => row.id === "shared"), false);
});

test("мусорные надгробия игнорируются", async () => {
  await store.createShortLinkRow("alive", {
    title: "жива",
    ownerUsername: "petya",
    params: { endpoint: "last", sub_url: "https://example.com/s" },
  });
  await store.importSyncBundle({
    data: { deletedShortLinks: [{ id: "" }, { id: "../etc/passwd" }, { id: "нетакой" }, null] },
  });
  assert.ok(await store.getShortLinkRow("alive"));
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
