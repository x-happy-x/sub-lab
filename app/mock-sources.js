import fs from "node:fs";
import crypto from "node:crypto";

const STORE_PATH = "/data/mock-sources.json";
const MAX_LOGS = 200;

const PRESETS = {
  no_subscriptions: {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body: "no subscriptions here",
  },
  stub_raw: {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body: [
      "vless://11111111-1111-1111-1111-111111111111@example.com:443?security=tls&type=ws&path=%2F#Stub-1",
      "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@203.0.113.10:443#Stub-2",
    ].join("\n"),
  },
  stub_clash: {
    status: 200,
    contentType: "text/yaml; charset=utf-8",
    body: [
      "proxies:",
      "  - name: stub-ss",
      "    type: ss",
      "    server: 203.0.113.10",
      "    port: 443",
      "    cipher: aes-256-gcm",
      "    password: password",
    ].join("\n"),
  },
  antibot_html: {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body><h1>Just a moment...</h1></body></html>",
  },
};

function ensureStoreDir() {
  if (!fs.existsSync("/data")) {
    fs.mkdirSync("/data", { recursive: true });
  }
}

function emptyStore() {
  return { version: 1, sources: {} };
}

function readStore() {
  ensureStoreDir();
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.sources !== "object") {
      return emptyStore();
    }
    return { version: 1, sources: parsed.sources };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  ensureStoreDir();
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function normalizeHeaders(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").trim().toLowerCase();
    if (!key || /[^a-z0-9-]/.test(key)) continue;
    const value = String(v ?? "").trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function sanitizeConfig(input, prev = null) {
  const presetName = String(input?.preset || prev?.preset || "stub_raw").trim();
  const preset = PRESETS[presetName] || PRESETS.stub_raw;

  const statusRaw = Number(input?.status ?? prev?.status ?? preset.status);
  const status = Number.isInteger(statusRaw) && statusRaw >= 100 && statusRaw <= 599 ? statusRaw : 200;

  const contentType = String(
    input?.contentType ?? prev?.contentType ?? preset.contentType ?? "text/plain; charset=utf-8",
  ).trim() || "text/plain; charset=utf-8";

  const body = String(input?.body ?? prev?.body ?? preset.body ?? "");
  const delayMsRaw = Number(input?.delayMs ?? prev?.delayMs ?? 0);
  const delayMs = Number.isFinite(delayMsRaw) && delayMsRaw >= 0 && delayMsRaw <= 30000
    ? Math.floor(delayMsRaw)
    : 0;

  const headers = normalizeHeaders(input?.headers ?? prev?.headers ?? {});

  return {
    preset: PRESETS[presetName] ? presetName : "stub_raw",
    status,
    contentType,
    body,
    headers,
    delayMs,
  };
}

function createMockSource(config) {
  const store = readStore();
  const id = crypto.randomBytes(5).toString("base64url");
  const now = new Date().toISOString();
  store.sources[id] = {
    id,
    createdAt: now,
    updatedAt: now,
    config: sanitizeConfig(config),
    logs: [],
  };
  writeStore(store);
  return { ok: true, source: store.sources[id] };
}

function getMockSource(id) {
  const token = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, status: 400, error: "invalid mock source id" };
  }
  const store = readStore();
  const source = store.sources[token];
  if (!source) {
    return { ok: false, status: 404, error: "mock source not found" };
  }
  return { ok: true, source };
}

function updateMockSource(id, patch) {
  const existing = getMockSource(id);
  if (!existing.ok) return existing;

  const store = readStore();
  const source = store.sources[existing.source.id];
  if (!source) {
    return { ok: false, status: 404, error: "mock source not found" };
  }

  source.config = sanitizeConfig(patch, source.config);
  source.updatedAt = new Date().toISOString();
  writeStore(store);
  return { ok: true, source };
}

function appendMockLog(id, entry) {
  const existing = getMockSource(id);
  if (!existing.ok) return existing;

  const store = readStore();
  const source = store.sources[existing.source.id];
  if (!source) {
    return { ok: false, status: 404, error: "mock source not found" };
  }

  source.logs = Array.isArray(source.logs) ? source.logs : [];
  source.logs.unshift({ ts: new Date().toISOString(), ...entry });
  if (source.logs.length > MAX_LOGS) {
    source.logs.length = MAX_LOGS;
  }
  writeStore(store);
  return { ok: true };
}

function clearMockLogs(id) {
  const existing = getMockSource(id);
  if (!existing.ok) return existing;

  const store = readStore();
  const source = store.sources[existing.source.id];
  if (!source) {
    return { ok: false, status: 404, error: "mock source not found" };
  }
  source.logs = [];
  source.updatedAt = new Date().toISOString();
  writeStore(store);
  return { ok: true, source };
}

function listPresets() {
  return Object.keys(PRESETS);
}

export {
  createMockSource,
  getMockSource,
  updateMockSource,
  appendMockLog,
  clearMockLogs,
  listPresets,
};
