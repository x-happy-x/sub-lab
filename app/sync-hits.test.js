import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-hits-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");

const ADMIN = { username: "admin", role: "admin" };
const REMOTE_ORIGIN = "11111111-2222-3333-4444-555555555555";

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Выгрузка «чужой» панели: те же ссылки, но просмотры под своим origin. */
function remoteBundle(hits) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    installationId: REMOTE_ORIGIN,
    data: {
      shortLinks: [{
        id: "shared1",
        params: { endpoint: "last", sub_url: "https://example.com/s" },
        title: "общая",
        ownerUsername: "admin",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        hits,
      }],
      dailyHits: [{ shortLinkId: "shared1", day: today(), origin: REMOTE_ORIGIN, hits }],
      hitTotals: [{ shortLinkId: "shared1", origin: REMOTE_ORIGIN, hits, updatedAt: new Date().toISOString() }],
    },
  };
}

test.before(async () => {
  await store.createShortLinkRow("shared1", {
    title: "общая",
    ownerUsername: "admin",
    params: { endpoint: "last", sub_url: "https://example.com/s" },
  });
  for (let i = 0; i < 4; i += 1) await store.incrementShortLinkHits("shared1");
});

test("свои просмотры считаются под своей установкой", async () => {
  const id = await store.getInstallationId();
  assert.match(id, /^[0-9a-f-]{36}$/);

  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 4);
  assert.equal(stats.daily.at(-1).hits, 4);
});

test("чужие просмотры прибавляются, а не затирают свои", async () => {
  const report = await store.importSyncBundle(remoteBundle(10));
  assert.ok(report.hitCounters >= 2);

  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  // 4 своих + 10 чужих. Раньше MAX по одному столбцу давал бы 10: десять
  // просмотров на той панели «съедали» бы четыре на этой.
  assert.equal(stats.totals.hits, 14);
  assert.equal(stats.daily.at(-1).hits, 14);
  assert.equal(stats.topLinks.find((row) => row.id === "shared1").hits, 14);
});

test("повторный импорт тех же данных ничего не удваивает", async () => {
  await store.importSyncBundle(remoteBundle(10));
  await store.importSyncBundle(remoteBundle(10));

  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 14);
});

test("выросший чужой счётчик подхватывается, упавший — нет", async () => {
  await store.importSyncBundle(remoteBundle(25));
  let stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 29);

  // Старая выгрузка может приехать после свежей — откатывать по ней нельзя.
  await store.importSyncBundle(remoteBundle(11));
  stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 29);
});

test("свои счётчики из чужой выгрузки игнорируются", async () => {
  const localOrigin = await store.getInstallationId();
  // Удалённая панель вернёт нам наши же строки — они всегда не свежее наших.
  await store.importSyncBundle({
    data: {
      dailyHits: [{ shortLinkId: "shared1", day: today(), origin: localOrigin, hits: 999 }],
      hitTotals: [{ shortLinkId: "shared1", origin: localOrigin, hits: 999, updatedAt: new Date().toISOString() }],
    },
  });
  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 29);
});

test("новые просмотры после синхронизации идут поверх общей суммы", async () => {
  await store.incrementShortLinkHits("shared1");
  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.hits, 30);
});

test("выгрузка несёт счётчики с пометкой установки", async () => {
  const bundle = await store.exportSyncBundle({ profiles: false });
  const localOrigin = await store.getInstallationId();
  assert.equal(bundle.installationId, localOrigin);

  const own = bundle.data.hitTotals.find((row) => row.origin === localOrigin && row.shortLinkId === "shared1");
  const alien = bundle.data.hitTotals.find((row) => row.origin === REMOTE_ORIGIN && row.shortLinkId === "shared1");
  assert.equal(own.hits, 5);
  assert.equal(alien.hits, 25);
  // Чужие строки тоже уезжают: через нас они доберутся до третьей панели.
  assert.ok(bundle.data.dailyHits.some((row) => row.origin === REMOTE_ORIGIN));
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
