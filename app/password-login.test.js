import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Вход по паролю для Android-клиента: account подменяется заглушкой, которая
 * принимает пароль на /api/auth/login и выдаёт сессию cookie, как настоящий.
 */
const USERS = {
  alice: { password: "secret", role: "viewer" },
  nobody: { password: "secret", role: null },
};

let accountStub = null;
let appServer = null;
let appPort = 0;
let tempDir = "";

function accountUser(login) {
  const role = USERS[login]?.role;
  return { login, name: login, access: role ? { sub_mirror: { role } } : {} };
}

function startAccountStub() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/login") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const user = USERS[body.login];
        if (!user || user.password !== body.password) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Неверный логин или пароль" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `kartoteka_session=tok-${body.login}; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT`,
        });
        res.end(JSON.stringify({ user: accountUser(body.login) }));
      });
      return;
    }
    const match = String(req.headers.cookie || "").match(/kartoteka_session=tok-([^;]+)/);
    const login = match ? decodeURIComponent(match[1]) : "";
    res.writeHead(login ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user: login ? accountUser(login) : null }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function api(pathname, { method = "GET", bearer = "", body } = {}) {
  const headers = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-password-"));
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

test("вход по паролю отдаёт токен, с которым работает Bearer", async () => {
  const login = await api("/api/auth/password", { method: "POST", body: { login: "alice", password: "secret" } });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.token, "tok-alice");
  assert.equal(login.json.expires, "2037-10-21T07:28:00.000Z");
  assert.equal(login.json.user.username, "alice");

  const favorites = await api("/api/favorites", { bearer: login.json.token });
  assert.equal(favorites.status, 200, favorites.text);
  assert.deepEqual(favorites.json.favorites, []);
});

test("неверный пароль — 401 с текстом account", async () => {
  const denied = await api("/api/auth/password", { method: "POST", body: { login: "alice", password: "nope" } });
  assert.equal(denied.status, 401, denied.text);
  assert.equal(denied.json.error, "Неверный логин или пароль");
});

test("без роли sub_mirror токен не выдаётся", async () => {
  const denied = await api("/api/auth/password", { method: "POST", body: { login: "nobody", password: "secret" } });
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.json.accessRequired, true);
  assert.equal(denied.json.token, undefined);
});

test("пустые логин или пароль — 400", async () => {
  const bad = await api("/api/auth/password", { method: "POST", body: { login: "alice" } });
  assert.equal(bad.status, 400, bad.text);
});
