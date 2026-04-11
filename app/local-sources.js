import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOCAL_SOURCES_DIR = "/data/local-sources";

function ensureLocalSourcesDir() {
  if (!fs.existsSync(LOCAL_SOURCES_DIR)) {
    fs.mkdirSync(LOCAL_SOURCES_DIR, { recursive: true });
  }
}

function sanitizeLocalSourceName(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.slice(0, 160);
}

function normalizeLocalSourceBody(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function resolveLocalSourceFilePath(id) {
  const token = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return "";
  return path.join(LOCAL_SOURCES_DIR, `${token}.txt`);
}

function resolveLocalSourceMetaPath(id) {
  const token = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return "";
  return path.join(LOCAL_SOURCES_DIR, `${token}.json`);
}

function createLocalSource(input) {
  const body = normalizeLocalSourceBody(input?.body);
  if (!body) return { ok: false, status: 400, error: "source body is required" };

  ensureLocalSourcesDir();
  const id = crypto.randomBytes(6).toString("base64url");
  const filePath = resolveLocalSourceFilePath(id);
  const metaPath = resolveLocalSourceMetaPath(id);
  const name = sanitizeLocalSourceName(input?.name) || `source-${id}`;
  const now = new Date().toISOString();

  fs.writeFileSync(filePath, `${body}\n`, "utf8");
  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    kind: "text",
    name,
    createdAt: now,
    updatedAt: now,
    size: Buffer.byteLength(body, "utf8"),
  }, null, 2));

  return {
    ok: true,
    source: {
      id,
      name,
      body,
      createdAt: now,
      updatedAt: now,
      size: Buffer.byteLength(body, "utf8"),
    },
  };
}

function createMergedSource(input) {
  const items = Array.isArray(input?.items)
    ? input.items.filter((item) => item && typeof item === "object")
    : [];
  if (items.length === 0) return { ok: false, status: 400, error: "merge items are required" };

  ensureLocalSourcesDir();
  const id = crypto.randomBytes(6).toString("base64url");
  const metaPath = resolveLocalSourceMetaPath(id);
  const name = sanitizeLocalSourceName(input?.name) || `merge-${id}`;
  const now = new Date().toISOString();

  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    kind: "merge",
    name,
    createdAt: now,
    updatedAt: now,
    items,
  }, null, 2));

  return {
    ok: true,
    source: {
      id,
      kind: "merge",
      name,
      items,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function getLocalSource(id) {
  const filePath = resolveLocalSourceFilePath(id);
  const metaPath = resolveLocalSourceMetaPath(id);
  if (!filePath || !metaPath || !fs.existsSync(filePath) || !fs.existsSync(metaPath)) {
    return { ok: false, status: 404, error: "local source not found" };
  }
  try {
    const body = fs.readFileSync(filePath, "utf8");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (String(meta.kind || "text") !== "text") {
      return { ok: false, status: 400, error: "local source is not a text source" };
    }
    return {
      ok: true,
      source: {
        id: String(meta.id || id),
        name: String(meta.name || id),
        body,
        createdAt: String(meta.createdAt || ""),
        updatedAt: String(meta.updatedAt || ""),
        size: Number(meta.size || Buffer.byteLength(body, "utf8")),
      },
    };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || "failed to read local source" };
  }
}

function getMergedSource(id) {
  const metaPath = resolveLocalSourceMetaPath(id);
  if (!metaPath || !fs.existsSync(metaPath)) {
    return { ok: false, status: 404, error: "merged source not found" };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (String(meta.kind || "") !== "merge") {
      return { ok: false, status: 400, error: "local source is not a merged source" };
    }
    return {
      ok: true,
      source: {
        id: String(meta.id || id),
        kind: "merge",
        name: String(meta.name || id),
        items: Array.isArray(meta.items) ? meta.items : [],
        createdAt: String(meta.createdAt || ""),
        updatedAt: String(meta.updatedAt || ""),
      },
    };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || "failed to read merged source" };
  }
}

export {
  createLocalSource,
  createMergedSource,
  getLocalSource,
  getMergedSource,
  resolveLocalSourceFilePath,
};
