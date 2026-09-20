import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

test("usage stats aggregate hits, devices and breakdowns per actor", async () => {
  const dataDir = path.resolve(process.cwd(), ".tmp-test-data", `stats-${crypto.randomBytes(4).toString("hex")}`);
  process.env.SUB_LAB_DATA_DIR = dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });

  const {
    createShortLinkRow,
    incrementShortLinkHits,
    recordShortLinkUserVisit,
    replaceShortLinkAccess,
    collectUsageStats,
  } = await import("./sqlite-store.js");

  const owned = await createShortLinkRow("own-link", { params: { sub_url: "https://example.com/a" }, title: "Своя", ownerUsername: "owner" });
  const foreign = await createShortLinkRow("foreign-link", { params: { sub_url: "https://example.com/b" }, title: "Чужая", ownerUsername: "someone" });
  const shared = await createShortLinkRow("shared-link", { params: { sub_url: "https://example.com/c" }, title: "Выданная", ownerUsername: "someone" });
  await replaceShortLinkAccess(shared.id, [{ username: "owner", accessLevel: "view" }]);

  await incrementShortLinkHits(owned.id);
  await incrementShortLinkHits(owned.id);
  await incrementShortLinkHits(foreign.id);

  await recordShortLinkUserVisit(owned.id, "hwid-1", { deviceOs: "Android", app: "happ" });
  await recordShortLinkUserVisit(owned.id, "hwid-2", { deviceOs: "Android", app: "v2raytun" });
  await recordShortLinkUserVisit(foreign.id, "hwid-3", { deviceOs: "Windows", app: "happ" });

  const ownerStats = await collectUsageStats({ username: "owner", role: "editor" }, { days: 30 });
  assert.equal(ownerStats.scope, "own");
  // Своя ссылка и выданная в доступ — чужая не считается.
  assert.equal(ownerStats.totals.subscriptions, 2);
  assert.equal(ownerStats.totals.hits, 2);
  assert.equal(ownerStats.totals.hitsPeriod, 2);
  assert.equal(ownerStats.totals.devices, 2);
  assert.equal(ownerStats.totals.activeDevices24h, 2);
  assert.deepEqual(ownerStats.byOs, [{ label: "Android", count: 2 }]);
  assert.equal(ownerStats.daily.length, 30);
  assert.equal(ownerStats.daily[ownerStats.daily.length - 1].hits, 2);
  assert.equal(ownerStats.daily[ownerStats.daily.length - 1].newDevices, 2);
  assert.equal(ownerStats.topLinks[0].id, owned.id);

  const adminStats = await collectUsageStats({ username: "root", role: "admin" }, { days: 7 });
  assert.equal(adminStats.scope, "all");
  assert.equal(adminStats.totals.subscriptions, 3);
  assert.equal(adminStats.totals.hits, 3);
  assert.equal(adminStats.totals.devices, 3);
  assert.equal(adminStats.daily.length, 7);

  const anonymous = await collectUsageStats({}, { days: 30 });
  assert.equal(anonymous.totals.subscriptions, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
