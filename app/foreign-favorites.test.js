import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-foreign-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");
const { foreignFavorites } = await import("./server.js");

const req = { headers: { host: "sub.example.com" }, socket: {} };

test.before(async () => {
  await store.createShortLinkRow("own001", { title: "моя", ownerUsername: "admin", params: { endpoint: "last" } });
  await store.createShortLinkRow("alien1", { title: "петина", ownerUsername: "petya", params: { endpoint: "last" } });
  await store.createShortLinkRow("alien2", { title: "васина", ownerUsername: "vasya", params: { endpoint: "sub" } });
});

test("обычный пользователь чужого не видит", async () => {
  assert.deepEqual(await foreignFavorites(req, { username: "petya", role: "user" }, []), []);
  assert.deepEqual(await foreignFavorites(req, { username: "", role: "user" }, []), []);
  assert.deepEqual(await foreignFavorites(req, null, []), []);
});

test("админ видит все ссылки, чужие помечены владельцем", async () => {
  const list = await foreignFavorites(req, { username: "admin", role: "admin" }, []);
  const byId = new Map(list.map((item) => [item.shortId, item]));

  assert.equal(byId.size, 3);
  // Своя ссылка остаётся своей, даже если её нет в личном списке.
  assert.equal(byId.get("own001").foreign, false);
  assert.equal(byId.get("alien1").foreign, true);
  assert.equal(byId.get("alien1").ownerUsername, "petya");
  assert.equal(byId.get("alien2").foreign, true);

  // derived — чтобы запись не осела в личном списке админа при сохранении.
  for (const item of list) assert.equal(item.derived, true);
});

test("то, что уже есть в списке, вторым экземпляром не приезжает", async () => {
  const known = [{ shortId: "alien1" }, { shortId: "own001" }];
  const list = await foreignFavorites(req, { username: "admin", role: "admin" }, known);
  assert.deepEqual(list.map((item) => item.shortId), ["alien2"]);
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
