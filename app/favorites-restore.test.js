import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Роли раздаёт account, поэтому на время теста он подменяется заглушкой:
 * токен запроса и есть имя пользователя, роль берётся из таблицы ниже.
 */
const ROLES = { editor: "editor", watcher: "viewer", stranger: "editor", owner: "editor", boss: "admin" };

let accountStub = null;
let appServer = null;
let appPort = 0;
let tempDir = "";

function startAccountStub() {
  const server = http.createServer((req, res) => {
    const cookie = String(req.headers.cookie || "");
    const match = cookie.match(/kartoteka_session=([^;]+)/);
    const login = match ? decodeURIComponent(match[1]) : String(req.headers["x-auth-token"] || "");
    const role = ROLES[login];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(
      role ? { ok: true, user: { login, name: login, access: { sub_mirror: { role } } } } : { ok: true, user: null },
    ));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function api(pathname, { method = "GET", token = "", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers["X-Auth-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: resp.status, json, text };
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-favorites-"));
  accountStub = await startAccountStub();
  process.env.SUB_LAB_DATA_DIR = tempDir;
  process.env.ACCOUNT_URL = `http://127.0.0.1:${accountStub.address().port}`;
  process.env.PORT = "0";
  const { startServer } = await import("./server.js");
  appServer = startServer();
  await new Promise((resolve) => appServer.once("listening", resolve));
  appPort = appServer.address().port;
});

after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (accountStub) await new Promise((resolve) => accountStub.close(resolve));
  delete process.env.SUB_LAB_DATA_DIR;
  delete process.env.ACCOUNT_URL;
  delete process.env.PORT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const backup = [
  {
    title: "Blanc",
    url: "https://old-host.example/l/priv-eu-08",
    shortId: "priv-eu-08",
    hidden: false,
    tags: [],
    payload: { endpoint: "last", sub_url: "https://example.com/s/one", output: "json", output_auto: "1" },
    labels: ["auto:json"],
    ts: 1788340782588,
  },
  {
    title: "Щука VPN",
    url: "https://old-host.example/l/priv-eu-07",
    shortId: "priv-eu-07",
    hidden: false,
    tags: [],
    payload: { endpoint: "last", sub_url: "https://example.com/s/two", output: "json", output_auto: "1" },
    labels: ["auto:json"],
    ts: 1788594169053,
  },
];

test("наблюдатель не восстанавливает резервную копию", async () => {
  const denied = await api("/api/favorites/restore", { method: "POST", token: "watcher", body: { favorites: backup } });
  assert.equal(denied.status, 403, denied.text);
});

test("резервная копия восстанавливается вместе с пропавшими короткими ссылками", async () => {
  const restored = await api("/api/favorites/restore", { method: "POST", token: "editor", body: { favorites: backup } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.report.created, 2, "обе короткие ссылки созданы заново");
  assert.equal(restored.json.report.skipped, 0);
  assert.equal(restored.json.favorites.length, 2, "список вернулся целиком");

  const listed = await api("/api/favorites", { token: "editor" });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    listed.json.favorites.map((item) => item.shortId).sort(),
    ["priv-eu-07", "priv-eu-08"],
    "после перезагрузки страницы подписки на месте",
  );

  // Короткая ссылка открывается без входа: ради этого её и создают.
  const anonymous = await fetch(`http://127.0.0.1:${appPort}/l/priv-eu-08`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(anonymous.status, 200, "страница подключения доступна без авторизации");
});

test("чужая подписка из копии пропускается, своя создаётся", async () => {
  const foreign = await api("/api/favorites/restore", {
    method: "POST",
    token: "stranger",
    body: {
      favorites: [
        { ...backup[0] },
        {
          title: "Своя",
          url: "",
          shortId: "stranger-own",
          payload: { endpoint: "last", sub_url: "https://example.com/s/three", output: "yml" },
          labels: [],
          ts: 1,
        },
      ],
    },
  });
  assert.equal(foreign.status, 200, foreign.text);
  assert.equal(foreign.json.report.skipped, 1, "чужая подписка пропущена");
  assert.equal(foreign.json.report.created, 1);
  assert.deepEqual(foreign.json.favorites.map((item) => item.shortId), ["stranger-own"]);
});

test("выданная подписка видна наблюдателю и не попадает в его сохранённый список", async () => {
  const created = await api("/api/short-links", {
    method: "POST",
    token: "owner",
    body: { title: "Общая", endpoint: "last", output: "yml", sub_url: "https://example.com/s/shared" },
  });
  assert.equal(created.status, 201, created.text);
  const shortId = created.json.link.id;

  const emptyForViewer = await api("/api/favorites", { token: "watcher" });
  assert.deepEqual(emptyForViewer.json.favorites, [], "без выдачи наблюдателю показывать нечего");

  // Доступ раздаёт админ: у редактора-владельца такого права нет.
  const granted = await api(`/api/short-links/${shortId}/access`, {
    method: "PUT",
    token: "boss",
    body: { grants: [{ username: "watcher", accessLevel: "view" }] },
  });
  assert.equal(granted.status, 200, granted.text);

  const viewerList = await api("/api/favorites", { token: "watcher" });
  assert.equal(viewerList.json.favorites.length, 1, "выданная подписка появилась сама");
  assert.equal(viewerList.json.favorites[0].derived, true);
  assert.equal(viewerList.json.favorites[0].permissions.canEdit, false);

  await api("/api/favorites", { method: "PUT", token: "watcher", body: { favorites: viewerList.json.favorites } });
  const afterSave = await api("/api/favorites", { token: "watcher" });
  assert.equal(afterSave.json.favorites.length, 1, "выданная подписка не удваивается после сохранения");
  assert.equal(afterSave.json.favorites[0].derived, true, "и остаётся вычисляемой");
});
