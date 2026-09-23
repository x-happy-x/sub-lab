import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-devices-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");

const ADMIN = { username: "admin", role: "admin" };
const PHONE = "hwid-phone";
const LAPTOP = "hwid-laptop";

test.before(async () => {
  for (const id of ["sub-a", "sub-b", "sub-c"]) {
    await store.createShortLinkRow(id, {
      title: id,
      ownerUsername: "admin",
      params: { endpoint: "last", sub_url: "https://example.com/s" },
    });
  }
  // Один и тот же телефон подключён к трём подпискам, ноутбук — к одной.
  await store.recordShortLinkUserVisit("sub-a", PHONE, { deviceOs: "Android", app: "happ", deviceModel: "Pixel" });
  await store.recordShortLinkUserVisit("sub-b", PHONE, { deviceOs: "Android", app: "happ", deviceModel: "Pixel" });
  await store.recordShortLinkUserVisit("sub-c", PHONE, { deviceOs: "Android", app: "v2rayng", deviceModel: "Pixel" });
  await store.recordShortLinkUserVisit("sub-a", LAPTOP, { deviceOs: "Windows", app: "flclashx", deviceModel: "ThinkPad" });
});

test("одно устройство на трёх подписках — это одно устройство", async () => {
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  // Строк в базе четыре, устройств — два. Раньше считались строки.
  assert.equal(stats.totals.devices, 2);
  assert.equal(stats.totals.activeDevices24h, 2);
});

test("и в «новых» оно тоже одно", async () => {
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  assert.equal(stats.totals.newDevicesPeriod, 2);
  assert.equal(stats.daily.at(-1).newDevices, 2);
});

test("разбивка по ОС и приложениям считает устройства, а не подключения", async () => {
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  const byOs = new Map(stats.byOs.map((row) => [row.label, row.count]));
  assert.equal(byOs.get("Android"), 1);
  assert.equal(byOs.get("Windows"), 1);

  // Приложение берётся из самого свежего захода — им был v2rayng на sub-c.
  const byApp = new Map(stats.byApp.map((row) => [row.label, row.count]));
  assert.equal(byApp.get("v2rayng"), 1);
  assert.equal(byApp.get("happ"), undefined);
  assert.equal(byApp.get("flclashx"), 1);
});

test("в ленте последних устройство встречается один раз", async () => {
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  const hwids = stats.recentDevices.map((row) => row.hwid);
  assert.equal(hwids.length, new Set(hwids).size);
  const phone = stats.recentDevices.find((row) => row.hwid === PHONE);
  assert.equal(phone.links, 3);
  assert.equal(stats.recentDevices.find((row) => row.hwid === LAPTOP).links, 1);
});

test("подписка по-прежнему знает своё число устройств", async () => {
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  const byLink = new Map(stats.topLinks.map((row) => [row.id, row.devices]));
  // Тут дублей нет и быть не должно: для подписки телефон — её устройство.
  assert.equal(byLink.get("sub-a"), 2);
  assert.equal(byLink.get("sub-b"), 1);
});

test("блокировка на одной подписке помечает устройство целиком", async () => {
  await store.setShortLinkUserBlocked("sub-b", PHONE, true, "перебор");
  const stats = await store.collectUsageStats(ADMIN, { days: 30 });
  assert.equal(stats.totals.blockedDevices, 1);
  assert.equal(stats.recentDevices.find((row) => row.hwid === PHONE).blocked, true);
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});

test("счётчики устройств для карточек", async () => {
  const counts = new Map(
    (await store.listShortLinkUserCounts(["sub-a", "sub-b", "sub-c", "нет-такой"]))
      .map((row) => [row.shortLinkId, row]),
  );

  // На sub-a телефон и ноутбук, телефон на sub-b заблокирован предыдущим тестом.
  assert.equal(counts.get("sub-a").total, 2);
  assert.equal(counts.get("sub-a").active, 2);
  assert.equal(counts.get("sub-a").blocked, 0);

  assert.equal(counts.get("sub-b").total, 1);
  assert.equal(counts.get("sub-b").blocked, 1);
  assert.equal(counts.get("sub-b").active, 0);

  // Несуществующая ссылка отдаёт нули, а не выпадает из ответа.
  assert.equal(counts.get("нет-такой").total, 0);
});

test("лимит, опущенный задним числом, даёт «сверх лимита»", async () => {
  // Лимит проверяется при регистрации, поэтому лишние устройства появляются
  // только так: их зарегистрировали, когда лимит был больше.
  await store.updateShortLinkUserPolicy("sub-a", { maxUsers: 1 });
  const [row] = await store.listShortLinkUserCounts(["sub-a"]);
  assert.equal(row.maxUsers, 1);
  assert.equal(row.active, 2);
  assert.equal(row.overLimit, 1);

  await store.updateShortLinkUserPolicy("sub-a", { maxUsers: 0 });
  const [noLimit] = await store.listShortLinkUserCounts(["sub-a"]);
  assert.equal(noLimit.overLimit, 0, "без лимита лишних быть не может");
});
