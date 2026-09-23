import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-del-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");
const { foreignFavorites } = await import("./server.js");

const ADMIN = { username: "admin", role: "admin" };
const req = { headers: { host: "sub.example.com" }, socket: {} };

test.before(async () => {
  for (const [id, owner] of [["keepme", "admin"], ["dropme", "petya"], ["alien", "vasya"]]) {
    await store.createShortLinkRow(id, {
      title: id,
      ownerUsername: owner,
      params: { endpoint: "last", sub_url: "https://example.com/s" },
    });
    await store.incrementShortLinkHits(id);
    await store.incrementShortLinkHits(id);
    await store.replaceShortLinkAccess(id, [{ username: "vasya", accessLevel: "view" }]);
    await store.recordShortLinkUserVisit(id, "hwid-1", { ip: "10.0.0.1", userAgent: "Happ/1.0" });
    await store.updateShortLinkUserPolicy(id, { maxUsers: 3, blockedMessage: "стоп" });
  }
});

test("удаление уносит всё, что было привязано к ссылке", async () => {
  const removed = await store.deleteShortLinkRow("dropme");
  assert.equal(removed.access, 1);
  assert.equal(removed.users, 1);
  assert.equal(removed.policy, 1);
  assert.ok(removed.dailyHits >= 1);
  assert.ok(removed.hitTotals >= 1);

  assert.equal(await store.getShortLinkRow("dropme"), null);
  assert.deepEqual(await store.listShortLinkAccess("dropme"), []);
  assert.deepEqual((await store.listShortLinkUsers("dropme")).users, []);
});

test("соседняя ссылка не пострадала", async () => {
  const kept = await store.getShortLinkRow("keepme");
  assert.equal(kept.id, "keepme");
  assert.equal((await store.listShortLinkAccess("keepme")).length, 1);
  assert.equal((await store.listShortLinkUsers("keepme")).users.length, 1);

  const stats = await store.collectUsageStats(ADMIN, { days: 7 });
  assert.equal(stats.totals.subscriptions, 2);
  // Счётчики удалённой ссылки тоже ушли: иначе статистика показывала бы
  // просмотры того, чего уже нет.
  assert.equal(stats.totals.hits, 4);
  assert.equal(stats.topLinks.some((row) => row.id === "dropme"), false);
});

test("удалённая ссылка пропадает из админского обзора", async () => {
  const list = await foreignFavorites(req, ADMIN, []);
  // Своих ссылок в обзоре нет вовсе, а удалённая чужая из него ушла.
  assert.deepEqual(list.map((row) => row.shortId), ["alien"]);
});

test("повторное удаление и мусор на входе не ломают ничего", async () => {
  const again = await store.deleteShortLinkRow("dropme");
  assert.equal(again.access, 0);
  await assert.rejects(() => store.deleteShortLinkRow(""), /invalid short link id/);
  assert.equal((await store.getShortLinkRow("keepme")).id, "keepme");
});

test("в выгрузке остаётся только надгробие", async () => {
  const bundle = await store.exportSyncBundle({ profiles: false });
  assert.equal(bundle.data.shortLinks.some((row) => row.id === "dropme"), false);
  assert.equal(bundle.data.hitTotals.some((row) => row.shortLinkId === "dropme"), false);
  assert.equal(bundle.data.dailyHits.some((row) => row.shortLinkId === "dropme"), false);

  // Само надгробие ехать обязано: по нему вторая панель удалит ссылку у себя
  // и перестанет присылать её обратно.
  const grave = bundle.data.deletedShortLinks.find((row) => row.id === "dropme");
  assert.ok(grave, "надгробие должно попасть в выгрузку");
  assert.ok(grave.deletedAt);
});

test("надгробие снимается, если ссылку завели заново", async () => {
  assert.ok(await store.getShortLinkTombstone("dropme"));
  await store.createShortLinkRow("dropme", {
    title: "снова",
    ownerUsername: "petya",
    params: { endpoint: "last", sub_url: "https://example.com/s" },
  });
  assert.equal(await store.getShortLinkTombstone("dropme"), null);
  await store.deleteShortLinkRow("dropme");
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
