import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { normalizePingMode, normalizeTargets, pingTargets, summarize } from "./ping.js";

test("ping modes and targets are normalized", () => {
  assert.equal(normalizePingMode("TLS"), "tls");
  assert.equal(normalizePingMode("что-то"), "tcp");

  const targets = normalizeTargets([
    { host: " example.com ", port: "8443", name: "Сервер" },
    { host: "", port: 443 },
    { host: "10.0.0.1" },
    null,
  ]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].host, "example.com");
  assert.equal(targets[0].port, 8443);
  // Без порта берём 443, имя по умолчанию — сам адрес.
  assert.equal(targets[1].port, 443);
  assert.equal(targets[1].name, "10.0.0.1");
});

test("summary reports best, average and loss", () => {
  const good = summarize([{ ok: true, ms: 10 }, { ok: true, ms: 30 }, { ok: false, ms: 0, error: "timeout" }]);
  assert.equal(good.ok, true);
  assert.equal(good.best, 10);
  assert.equal(good.worst, 30);
  assert.equal(good.average, 20);
  assert.equal(good.loss, 33);

  const dead = summarize([{ ok: false, ms: 0, error: "ECONNREFUSED" }]);
  assert.equal(dead.ok, false);
  assert.equal(dead.loss, 100);
  assert.equal(dead.error, "ECONNREFUSED");
});

test("tcp ping separates a live port from a dead one", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await pingTargets({
      targets: [
        { id: "alive", name: "живой", host: "127.0.0.1", port },
        { id: "dead", name: "мёртвый", host: "127.0.0.1", port: 1 },
      ],
      mode: "tcp",
      attempts: 2,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    const alive = result.results.find((row) => row.id === "alive");
    const dead = result.results.find((row) => row.id === "dead");
    assert.equal(alive.ok, true);
    assert.equal(alive.loss, 0);
    assert.equal(alive.samples.length, 2);
    assert.equal(dead.ok, false);
    assert.equal(dead.loss, 100);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ping without targets is rejected", async () => {
  const result = await pingTargets({ targets: [] });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
