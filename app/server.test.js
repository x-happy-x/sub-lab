import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOutput,
  renderHomePage,
  readProfileFile,
  pickUserAgentProfile,
  resolveRequestConfig,
  produceOutput,
} from "./server.js";

test("normalizeOutput supports aliases", () => {
  assert.equal(normalizeOutput("yml"), "clash");
  assert.equal(normalizeOutput("yaml"), "clash");
  assert.equal(normalizeOutput("clash"), "clash");
  assert.equal(normalizeOutput("raw"), "raw");
  assert.equal(normalizeOutput("source"), "raw");
  assert.equal(normalizeOutput("unknown"), null);
});

test("profiles are loaded from base and ua directories", () => {
  const base = readProfileFile("xiaomi");
  assert.ok(base);
  assert.equal(base.headers["x-device-os"], "Android");

  const ua = readProfileFile("ua-flclashx-android");
  assert.ok(ua);
  assert.equal(ua.headers["user-agent"], "FlClash X/v0.3.2 Platform/android");
});

test("ua profile selection prefers app+device and falls back to ua-default", () => {
  const specific = pickUserAgentProfile("flclashx", "android");
  assert.deepEqual(specific, { ok: true, profileName: "ua-flclashx-android" });

  const fallback = pickUserAgentProfile("unknown-app", "android");
  assert.deepEqual(fallback, { ok: true, profileName: "ua-default" });
});

test("request config merges base and auto ua profiles with output alias", () => {
  const reqUrl = new URL(
    "http://localhost/last?app=flclashx&device=android&output=yml&profile=xiaomi&sub_url=https://example.com/sub",
  );
  const result = resolveRequestConfig(reqUrl, {});
  assert.equal(result.ok, true);
  assert.equal(result.output, "clash");
  assert.deepEqual(result.profileNames, ["xiaomi", "ua-flclashx-android"]);
  assert.equal(result.forwardHeaders["x-device-os"], "Android");
  assert.equal(result.forwardHeaders["user-agent"], "FlClash X/v0.3.2 Platform/android");
});

test("produceOutput returns expected content types for raw and clash", async () => {
  const rawResult = await produceOutput("vless://example", "raw");
  assert.equal(rawResult.ok, true);
  assert.equal(rawResult.contentType, "text/plain; charset=utf-8");

  const yamlInput = "proxies:\n  - name: test\n    type: ss\n    server: 1.1.1.1\n    port: 443\n";
  const clashResult = await produceOutput(yamlInput, "clash");
  assert.equal(clashResult.ok, true);
  assert.equal(clashResult.contentType, "text/yaml; charset=utf-8");
});

test("home page contains form, qr and app buttons", () => {
  const html = renderHomePage();
  assert.ok(html.includes("Sub Mirror"));
  assert.ok(html.includes('id="sub_url"'));
  assert.ok(html.includes('id="output"'));
  assert.ok(html.includes('id="openHapp"'));
  assert.ok(html.includes('id="openFl"'));
  assert.ok(html.includes("api.qrserver.com"));
});
