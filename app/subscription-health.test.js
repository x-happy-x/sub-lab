import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-health-"));
process.env.SUB_LAB_DATA_DIR = DATA_DIR;

const store = await import("./sqlite-store.js");
const { checkShortLinkHealth } = await import("./subscription-health.js");

const uuid = "11111111-2222-3333-4444-555555555555";
const server = (name) => `vless://${uuid}@10.0.0.1:443?type=tcp&security=none#${encodeURIComponent(name)}`;

/** Поддельный провайдер: сам решает, что отдать на запрос подписки. */
function startProvider(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function linkTo(id, subUrl) {
  await store.deleteShortLinkRow(id).catch(() => {});
  await store.createShortLinkRow(id, {
    title: id,
    ownerUsername: "admin",
    params: { endpoint: "sub", sub_url: subUrl, output: "raw" },
  });
}

test("живая подписка: серверы, срок, трафик и ссылка на продление", async () => {
  const expire = Math.floor(Date.now() / 1000) + 30 * 86400;
  const { srv, origin } = await startProvider((req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "subscription-userinfo": `upload=100; download=900; total=5000; expire=${expire}`,
      "support-url": "https://example.com/support",
      "profile-web-page-url": "https://example.com/renew",
      "profile-title": `base64:${Buffer.from("Провайдер", "utf8").toString("base64")}`,
    });
    res.end([server("RU Москва"), server("NL Амстердам")].join("\n"));
  });

  try {
    await linkTo("alive", `${origin}/sub`);
    const health = await checkShortLinkHealth("alive");
    assert.equal(health.ok, true);
    assert.equal(health.unreachable, false);
    assert.equal(health.servers, 2);
    assert.equal(health.upload, 100);
    assert.equal(health.download, 900);
    assert.equal(health.total, 5000);
    assert.equal(health.expireAt, expire * 1000);
    assert.equal(health.webPageUrl, "https://example.com/renew");
    assert.equal(health.supportUrl, "https://example.com/support");
    // Заголовок приезжает в base64, когда в названии есть кириллица.
    assert.equal(health.providerTitle, "Провайдер");
    assert.equal(health.error, "");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("base64-подписка считается так же, как обычная", async () => {
  const body = Buffer.from([server("A"), server("B"), server("C")].join("\n"), "utf8").toString("base64");
  const { srv, origin } = await startProvider((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });

  try {
    await linkTo("b64", `${origin}/sub`);
    const health = await checkShortLinkHealth("b64");
    assert.equal(health.ok, true);
    assert.equal(health.servers, 3);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("страница вместо подписки — это не «жива»", async () => {
  const { srv, origin } = await startProvider((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>502 Bad Gateway</title></head><body>x</body></html>");
  });

  try {
    await linkTo("html", `${origin}/sub`);
    const health = await checkShortLinkHealth("html");
    assert.equal(health.ok, false);
    assert.equal(health.unreachable, false);
    assert.equal(health.servers, 0);
    // Причина должна быть внятной, а не «ноль серверов».
    assert.match(health.error, /страницей 502/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("обрыв связи не объявляет подписку мёртвой и хранит прошлые цифры", async () => {
  const expire = Math.floor(Date.now() / 1000) + 10 * 86400;
  const { srv, origin } = await startProvider((req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "subscription-userinfo": `upload=0; download=42; total=100; expire=${expire}`,
      "profile-web-page-url": "https://example.com/renew",
    });
    res.end(server("RU"));
  });

  await linkTo("flaky", `${origin}/sub`);
  const good = await checkShortLinkHealth("flaky");
  assert.equal(good.ok, true);
  await new Promise((resolve) => srv.close(resolve));

  // Провайдер выключен — соединение отклоняется.
  const broken = await checkShortLinkHealth("flaky");
  assert.equal(broken.ok, false);
  assert.equal(broken.unreachable, true);
  assert.match(broken.error, /не дозвонились/);
  // Срок и трафик остаются от прошлой удачной проверки: разовая авария у нас
  // не должна стирать то, что мы про подписку знаем.
  assert.equal(broken.expireAt, expire * 1000);
  assert.equal(broken.download, 42);
  assert.equal(broken.webPageUrl, "https://example.com/renew");
});

test("недостижимые перепроверяются раньше остальных", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  for (const [id, unreachable] of [["was-down", true], ["was-fine", false]]) {
    await store.createShortLinkRow(id, {
      title: id,
      ownerUsername: "admin",
      params: { endpoint: "sub", sub_url: "https://example.com/s" },
    });
    await store.upsertShortLinkHealth({
      shortLinkId: id,
      checkedAt: twoHoursAgo,
      ok: !unreachable,
      unreachable,
      servers: unreachable ? 0 : 3,
    });
  }

  // Сутки ещё не прошли, но до «was-down» мы не достучались — её пробуем снова
  // через час, а благополучную ждём положенные сутки.
  const due = await store.listShortLinksDueForHealthCheck(24, 50, 1);
  assert.equal(due.includes("was-down"), true);
  assert.equal(due.includes("was-fine"), false);

  // Если окно перепроверки поднять до суток, разницы между ними нет.
  const later = await store.listShortLinksDueForHealthCheck(24, 50, 24);
  assert.equal(later.includes("was-down"), false);
});

test("мусорный адрес объясняется по-человечески", async () => {
  await linkTo("junk", "DAS");
  const health = await checkShortLinkHealth("junk");
  assert.equal(health.ok, false);
  assert.match(health.error, /не похож на ссылку/);
});

test("объединение проверяется наравне с остальными", async () => {
  await store.createShortLinkRow("merged", {
    title: "объединение",
    ownerUsername: "admin",
    params: { endpoint: "last", sub_url: "merge:нет-такого" },
  });
  // Состава нет, поэтому результат отрицательный — но именно результат, а не
  // «пропущено»: раньше объединения вообще не проверялись.
  const health = await checkShortLinkHealth("merged");
  assert.ok(health, "объединение должно получать запись о проверке");
  assert.equal(health.ok, false);
  assert.notEqual(health.error, "");
});

test.after(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Временный каталог: на Windows файл базы может быть ещё занят.
  }
});
