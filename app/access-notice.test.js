import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renderAccessNotice } from "./access-notice.js";

test("access notice renders one random server named with the policy text", () => {
  const message = "Подписка приостановлена: оплатите доступ";

  const raw = renderAccessNotice(message, "raw");
  const lines = raw.body.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "в raw должен быть ровно один сервер");
  assert.equal(raw.body.includes(encodeURIComponent(message)), true);
  // Адрес из документационной сети: подключиться по нему нельзя.
  assert.match(raw.body, /@203\.0\.113\.\d+:\d+\?/);

  const clash = renderAccessNotice(message, "clash");
  assert.equal(clash.contentType, "text/yaml; charset=utf-8");
  assert.equal(clash.body.includes(message), true);
  assert.equal(clash.body.split("\n").filter((line) => line.trim().startsWith("- name:")).length, 2,
    "один прокси и одна строка в группе выбора");

  const json = renderAccessNotice(message, "json");
  const configs = JSON.parse(json.body);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].remarks, message);

  const base64 = renderAccessNotice(message, "raw_base64");
  assert.equal(Buffer.from(base64.body, "base64").toString("utf8").startsWith("vless://"), true);

  // Каждый ответ получает свои случайные адрес и ключи.
  const first = renderAccessNotice(message, "raw").body;
  const second = renderAccessNotice(message, "raw").body;
  assert.notEqual(first, second);
});

test("access notice falls back to a default text", () => {
  const raw = renderAccessNotice("", "raw");
  assert.equal(raw.body.includes(encodeURIComponent("Доступ к подписке ограничен")), true);
});

test("visit without hwid reports the link policy back to the caller", async () => {
  const dataDir = path.resolve(process.cwd(), ".tmp-test-data", `notice-${crypto.randomBytes(4).toString("hex")}`);
  process.env.SUB_LAB_DATA_DIR = dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });

  const {
    createShortLinkRow,
    updateShortLinkUserPolicy,
    recordShortLinkUserVisit,
    setShortLinkUserBlocked,
  } = await import("./sqlite-store.js");

  await createShortLinkRow("limited", { params: { sub_url: "https://example.com/a" }, title: "Limited" });
  await updateShortLinkUserPolicy("limited", { maxUsers: 2, blockedMessage: "Только из приложения" });

  const skipped = await recordShortLinkUserVisit("limited", "", { deviceOs: "Windows" });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "empty hwid");
  assert.equal(skipped.policy.maxUsers, 2);
  assert.equal(skipped.policy.blockedMessage, "Только из приложения");

  await createShortLinkRow("plain", { params: { sub_url: "https://example.com/b" }, title: "Plain" });
  const plain = await recordShortLinkUserVisit("plain", "", {});
  assert.equal(plain.policy.maxUsers, 0);

  // Заблокированное устройство отдаёт текст блокировки, а не ошибку транспорта.
  await recordShortLinkUserVisit("limited", "hw-1", { deviceOs: "Android" });
  await setShortLinkUserBlocked("limited", "hw-1", true, "Оплата не прошла");
  const blocked = await recordShortLinkUserVisit("limited", "hw-1", { deviceOs: "Android" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "blocked");
  assert.equal(blocked.message, "Оплата не прошла");

  // Третье устройство упирается в лимит.
  await recordShortLinkUserVisit("limited", "hw-2", {});
  await recordShortLinkUserVisit("limited", "hw-3", {});
  const over = await recordShortLinkUserVisit("limited", "hw-4", {});
  assert.equal(over.ok, false);
  assert.equal(over.code, "limit");

  fs.rmSync(dataDir, { recursive: true, force: true });
});
