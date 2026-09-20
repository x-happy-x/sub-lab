import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchRemoteBundle, summarizeSyncBundle } from "./server.js";

/** Поддельная удалённая установка: отдаёт выгрузку только по верному токену. */
function startRemote(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

const BUNDLE = {
  exportedAt: "2026-09-20T10:00:00.000Z",
  data: {
    shortLinks: [{ id: "abc" }, { id: "def" }],
    access: [],
    favorites: [{ accountKey: "u" }],
  },
};

test("выгрузка забирается с токеном в заголовке", async () => {
  const seen = { auth: "", url: "" };
  const { server, origin } = await startRemote((req, res) => {
    seen.auth = String(req.headers.authorization || "");
    seen.url = String(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bundle: BUNDLE }));
  });

  try {
    const result = await fetchRemoteBundle({ remoteUrl: origin, remoteToken: "tok", profiles: false });
    assert.equal(result.bundle.exportedAt, BUNDLE.exportedAt);
    assert.equal(seen.auth, "Bearer tok");
    // Секрет уезжает заголовком: в адресе его быть не должно.
    assert.equal(seen.url.includes("tok"), false);
    assert.equal(seen.url, "/api/sync/export?profiles=0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("профили запрашиваются, когда их попросили", async () => {
  let url = "";
  const { server, origin } = await startRemote((req, res) => {
    url = String(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bundle: BUNDLE }));
  });

  try {
    await fetchRemoteBundle({ remoteUrl: origin, remoteToken: "tok", profiles: true });
    assert.equal(url, "/api/sync/export");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("чужая ошибка доезжает текстом, а не «не получилось»", async () => {
  const { server, origin } = await startRemote((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid sync token" }));
  });

  try {
    await assert.rejects(
      () => fetchRemoteBundle({ remoteUrl: origin, remoteToken: "wrong", profiles: false }),
      (e) => {
        assert.match(e.message, /invalid sync token/);
        assert.equal(e.status, 401);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ответ не про синхронизацию не принимается за выгрузку", async () => {
  const { server, origin } = await startRemote((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>login</body></html>");
  });

  try {
    await assert.rejects(
      () => fetchRemoteBundle({ remoteUrl: origin, remoteToken: "tok", profiles: false }),
      /remote sync export failed/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("адрес с путём и хвостовым слэшем собирается без двойного", async () => {
  let url = "";
  const { server, origin } = await startRemote((req, res) => {
    url = String(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bundle: BUNDLE }));
  });

  try {
    await fetchRemoteBundle({ remoteUrl: `${origin}/panel/`, remoteToken: "tok", profiles: false });
    assert.equal(url, "/panel/api/sync/export?profiles=0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("сводка считает только то, что реально приехало", () => {
  assert.deepEqual(summarizeSyncBundle(BUNDLE), { shortLinks: 2, access: 0, favorites: 1 });
  assert.deepEqual(summarizeSyncBundle(null), {});
});
