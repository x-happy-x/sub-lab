import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Хранилище выбирает каталог при первом импорте, поэтому подменяем его до него.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-sync-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");

test("пир заводится, токен наружу не уходит", async () => {
  const peer = await store.createSyncPeer({
    label: "дом",
    remoteUrl: "https://sub.example.com/",
    remoteToken: "s3cret",
    intervalMinutes: 15,
  });

  assert.equal(peer.label, "дом");
  // Хвостовой слэш срезаем, иначе адрес выгрузки собрался бы с двойным.
  assert.equal(peer.remoteUrl, "https://sub.example.com");
  assert.equal(peer.hasToken, true);
  assert.equal(peer.intervalMinutes, 15);
  assert.equal(peer.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(peer, "remoteToken"), false);

  const listed = await store.listSyncPeers();
  assert.equal(listed.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "remoteToken"), false);

  const withToken = await store.getSyncPeerWithToken(peer.id);
  assert.equal(withToken.remoteToken, "s3cret");
});

test("пустой токен в правке означает «оставить прежний»", async () => {
  const peer = await store.createSyncPeer({
    remoteUrl: "https://a.example.com",
    remoteToken: "keep-me",
  });

  const updated = await store.updateSyncPeer(peer.id, { label: "переименован", intervalMinutes: 60 });
  assert.equal(updated.label, "переименован");
  assert.equal(updated.intervalMinutes, 60);
  assert.equal(updated.hasToken, true);

  const withToken = await store.getSyncPeerWithToken(peer.id);
  assert.equal(withToken.remoteToken, "keep-me");

  const replaced = await store.updateSyncPeer(peer.id, { remoteToken: "new-one" });
  assert.equal(replaced.hasToken, true);
  assert.equal((await store.getSyncPeerWithToken(peer.id)).remoteToken, "new-one");

  await store.deleteSyncPeer(peer.id);
  assert.equal(await store.getSyncPeer(peer.id), null);
});

test("адрес без схемы и без токена не принимается", async () => {
  await assert.rejects(
    () => store.createSyncPeer({ remoteUrl: "ftp://sub.example.com", remoteToken: "x" }),
    /http or https/,
  );
  await assert.rejects(
    () => store.createSyncPeer({ remoteUrl: "https://sub.example.com" }),
    /remoteToken is required/,
  );
  await assert.rejects(() => store.createSyncPeer({ remoteToken: "x" }), /remoteUrl is required/);
});

test("итог прогона запоминается, дата успеха не сбрасывается ошибкой", async () => {
  const peer = await store.createSyncPeer({
    remoteUrl: "https://b.example.com",
    remoteToken: "t",
  });

  const ok = await store.recordSyncPeerRun(peer.id, {
    status: "ok",
    report: { shortLinks: 3 },
    synced: true,
  });
  assert.equal(ok.lastStatus, "ok");
  assert.equal(ok.lastReport.shortLinks, 3);
  assert.ok(ok.lastSyncedAt);

  const failed = await store.recordSyncPeerRun(peer.id, { status: "error", error: "нет связи" });
  assert.equal(failed.lastStatus, "error");
  assert.equal(failed.lastError, "нет связи");
  // Последний успех — отдельная отметка: по ней видно, насколько данные свежие,
  // даже когда очередная попытка упала.
  assert.equal(failed.lastSyncedAt, ok.lastSyncedAt);
  assert.notEqual(failed.lastAttemptAt, "");
});

test("админский обзор возвращает ссылки всех владельцев", async () => {
  await store.createShortLinkRow("aaa111", { title: "своя", ownerUsername: "admin", params: { endpoint: "last" } });
  await store.createShortLinkRow("bbb222", { title: "чужая", ownerUsername: "petya", params: { endpoint: "last" } });

  const rows = await store.listAllShortLinkRows();
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("aaa111").ownerUsername, "admin");
  assert.equal(byId.get("bbb222").ownerUsername, "petya");
  assert.equal(byId.get("bbb222").title, "чужая");
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Каталог временный: если Windows держит файл, уборка не критична.
  }
});
