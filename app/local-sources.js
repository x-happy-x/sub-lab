import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import crypto from "node:crypto";
import { normalizeMergeFilter } from "./merge-source.js";

const LOCAL_SOURCES_DIR = path.join(DATA_DIR, "local-sources");

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

const MERGE_ITEM_KEYS = ["sub_url", "endpoint", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups", "nodes"];

/**
 * Элемент объединения: параметры источника плюс отбор серверов.
 *
 * Выходной формат и заголовки у каждого источника свои — их и сохраняем как
 * есть. Сверху лежит `filter`: регулярка по имени сервера и поведение, если
 * под неё ничего не подошло.
 */
function normalizeMergeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = {};
  for (const key of MERGE_ITEM_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    item[key] = String(value);
  }
  if (!item.sub_url) return null;
  item.title = sanitizeLocalSourceName(raw.title);
  item.shortId = String(raw.shortId || "").trim().slice(0, 64);
  item.filter = normalizeMergeFilter(raw.filter);
  return item;
}

function normalizeMergeItems(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeMergeItem).filter(Boolean);
}

function writeMergedSource(id, { name, items, createdAt, updatedAt }) {
  const metaPath = resolveLocalSourceMetaPath(id);
  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    kind: "merge",
    name,
    createdAt,
    updatedAt,
    items,
  }, null, 2));
  return { id, kind: "merge", name, items, createdAt, updatedAt };
}

function createMergedSource(input) {
  const items = normalizeMergeItems(input?.items);
  if (items.length === 0) return { ok: false, status: 400, error: "merge items are required" };

  ensureLocalSourcesDir();
  const id = crypto.randomBytes(6).toString("base64url");
  const name = sanitizeLocalSourceName(input?.name) || `merge-${id}`;
  const now = new Date().toISOString();

  return { ok: true, source: writeMergedSource(id, { name, items, createdAt: now, updatedAt: now }) };
}

/**
 * Пересобрать состав объединения, не меняя его идентификатор.
 *
 * Короткая ссылка смотрит на `merge:<id>`, поэтому состав правится на месте:
 * иначе каждая правка выдавала бы пользователям новый адрес подписки.
 */
function updateMergedSource(id, input) {
  const existing = getMergedSource(id);
  if (!existing.ok) return existing;
  const items = normalizeMergeItems(input?.items);
  if (items.length === 0) return { ok: false, status: 400, error: "merge items are required" };

  ensureLocalSourcesDir();
  const name = sanitizeLocalSourceName(input?.name) || existing.source.name;
  const now = new Date().toISOString();

  return {
    ok: true,
    source: writeMergedSource(existing.source.id, {
      name,
      items,
      createdAt: existing.source.createdAt || now,
      updatedAt: now,
    }),
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
        items: normalizeMergeItems(meta.items),
        createdAt: String(meta.createdAt || ""),
        updatedAt: String(meta.updatedAt || ""),
      },
    };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || "failed to read merged source" };
  }
}

/**
 * Все объединения этой установки — для синхронизации.
 *
 * Состав объединения лежит файлом рядом с данными, а не в базе, поэтому в
 * выгрузку он не попадал: на второй панели короткая ссылка `merge:<id>` была,
 * а собирать по ней было нечего — подписка отвечала 404.
 */
function listMergedSources() {
  ensureLocalSourcesDir();
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(LOCAL_SOURCES_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const found = getMergedSource(name.slice(0, -".json".length));
    if (found.ok) out.push(found.source);
  }
  return out;
}

/**
 * Записать объединение, приехавшее с другой панели.
 *
 * Своё не затираем тем, что старее: у объединения есть собственная отметка
 * времени, и правка на этой стороне не должна пропадать из-за обмена.
 */
function importMergedSource(raw) {
  const id = String(raw?.id || "").trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const incomingUpdatedAt = String(raw?.updatedAt || "");
  const existing = getMergedSource(id);
  if (existing.ok && existing.source.updatedAt && existing.source.updatedAt >= incomingUpdatedAt) {
    return false;
  }
  ensureLocalSourcesDir();
  writeMergedSource(id, {
    name: sanitizeLocalSourceName(raw?.name) || id,
    items: normalizeMergeItems(raw?.items),
    createdAt: String(raw?.createdAt || incomingUpdatedAt || ""),
    updatedAt: incomingUpdatedAt,
  });
  return true;
}

export {
  createLocalSource,
  createMergedSource,
  updateMergedSource,
  normalizeMergeItems,
  getLocalSource,
  getMergedSource,
  listMergedSources,
  importMergedSource,
  resolveLocalSourceFilePath,
};
