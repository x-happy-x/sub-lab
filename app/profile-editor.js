import fs from "node:fs";
import path from "node:path";
import { PROFILE_ROOT_DIRS } from "./config.js";
import {
  deleteProfileFileRecord,
  getProfileFileRecord,
  listProfileFileRecords,
  upsertProfileFileRecord,
} from "./sqlite-store.js";

const EDIT_ROOT = "/data/profiles";
const VALID_KIND = new Set(["profiles", "base"]);

function uniq(list) {
  return list.filter((item, idx) => list.indexOf(item) === idx);
}

function ensureDirs() {
  for (const dir of [EDIT_ROOT, path.join(EDIT_ROOT, "profiles")]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (!VALID_KIND.has(k)) return "";
  return k === "base" ? "profiles" : k;
}

function sanitizeName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!/^[a-zA-Z0-9._-]+$/.test(n)) return "";
  return n;
}

function normalizeActor(actor) {
  return {
    username: String(actor?.username || "").trim().toLowerCase(),
    role: String(actor?.role || "user").trim().toLowerCase() === "admin" ? "admin" : "user",
  };
}

function isPathInEditRoot(filePath) {
  const absolute = path.resolve(String(filePath || ""));
  const root = path.resolve(EDIT_ROOT);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

function listProfilesByKind(kind) {
  const out = new Set();
  const dirs = [];

  if (kind === "profiles") {
    dirs.push(EDIT_ROOT);
    dirs.push(path.join(EDIT_ROOT, "base"));
  }
  for (const root of PROFILE_ROOT_DIRS) {
    dirs.push(path.join(root, kind));
    if (kind === "profiles") dirs.push(path.join(root, "base"));
    dirs.push(root);
  }

  for (const dir of uniq(dirs)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^(.+)\.(yml|yaml)$/i);
      if (!m) continue;
      const profileName = m[1];
      out.add(profileName);
    }
  }
  return Array.from(out).sort();
}

function findProfilePath(kind, name) {
  const searchDirs = [EDIT_ROOT];
  for (const root of PROFILE_ROOT_DIRS) {
    searchDirs.push(path.join(root, kind));
    searchDirs.push(root);
  }

  for (const dir of uniq(searchDirs)) {
    for (const ext of ["yml", "yaml"]) {
      const p = path.join(dir, `${name}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

async function listEditorCatalog(actor) {
  const profiles = listProfilesByKind("profiles");
  const user = normalizeActor(actor);
  const isAdmin = user.role === "admin";
  const metadataList = await listProfileFileRecords();
  const metadataMap = new Map(metadataList.map((item) => [item.name, item]));
  const items = [];
  for (const name of profiles) {
    const filePath = findProfilePath("profiles", name);
    const editable = filePath ? isPathInEditRoot(filePath) : false;
    const record = metadataMap.get(name) || null;
    const ownerUsername = record?.ownerUsername || "";
    const visibility = editable
      ? (ownerUsername ? "private" : "shared")
      : "shared";
    const canView = !editable || !ownerUsername || isAdmin || ownerUsername === user.username;
    if (!canView) continue;
    items.push({
      name,
      ownerUsername,
      editable,
      visibility,
      source: editable ? "custom" : "builtin",
    });
  }
  const visibleNames = items.map((item) => item.name);
  return { profiles: visibleNames, base: visibleNames, ua: [], items };
}

async function readProfileForEdit(kind, name, actor) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const filePath = findProfilePath(k, n);
  if (!filePath) return { ok: false, status: 404, error: "profile not found" };
  const user = normalizeActor(actor);
  if (isPathInEditRoot(filePath)) {
    const record = await getProfileFileRecord(n);
    const ownerUsername = record?.ownerUsername || "";
    if (ownerUsername && user.role !== "admin" && ownerUsername !== user.username) {
      return { ok: false, status: 403, error: "forbidden" };
    }
  }
  const content = fs.readFileSync(filePath, "utf8");
  const record = await getProfileFileRecord(n);
  return { ok: true, kind: k, name: n, filePath, content, ownerUsername: record?.ownerUsername || "" };
}

async function saveProfileForEdit(kind, name, content, actor) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const body = String(content || "");
  if (!body.trim()) return { ok: false, status: 400, error: "profile content is empty" };
  const user = normalizeActor(actor);
  if (!user.username) return { ok: false, status: 401, error: "unauthorized" };
  const existingPath = findProfilePath(k, n);
  const existingRecord = await getProfileFileRecord(n);
  const currentOwner = existingRecord?.ownerUsername || "";
  if (currentOwner && user.role !== "admin" && currentOwner !== user.username) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (existingPath && isPathInEditRoot(existingPath) && !currentOwner && user.role !== "admin") {
    return { ok: false, status: 403, error: "only admin can override shared profile names" };
  }
  if (existingPath && !isPathInEditRoot(existingPath) && user.role !== "admin") {
    return { ok: false, status: 403, error: "only admin can override shared profile names" };
  }
  ensureDirs();
  const target = path.join(EDIT_ROOT, `${n}.yml`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  const meta = await upsertProfileFileRecord(n, currentOwner || user.username);
  return { ok: true, kind: k, name: n, filePath: target, ownerUsername: meta.ownerUsername };
}

async function deleteProfileForEdit(kind, name, actor) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const user = normalizeActor(actor);
  const record = await getProfileFileRecord(n);
  const ownerUsername = record?.ownerUsername || "";
  if (ownerUsername && user.role !== "admin" && ownerUsername !== user.username) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  const target = path.join(EDIT_ROOT, `${n}.yml`);
  if (!ownerUsername && fs.existsSync(target) && user.role !== "admin") {
    return { ok: false, status: 403, error: "only admin can delete shared profiles" };
  }
  try {
    fs.unlinkSync(target);
    await deleteProfileFileRecord(n);
    return { ok: true, kind: k, name: n, filePath: target };
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { ok: false, status: 404, error: "editable profile not found in /data/profiles" };
    }
    return { ok: false, status: 500, error: e?.message || "failed to delete profile" };
  }
}

export {
  listEditorCatalog,
  readProfileForEdit,
  saveProfileForEdit,
  deleteProfileForEdit,
};
