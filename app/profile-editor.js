import fs from "node:fs";
import path from "node:path";
import { PROFILE_ROOT_DIRS } from "./config.js";

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

function listEditorCatalog() {
  const profiles = listProfilesByKind("profiles");
  return { profiles, base: profiles, ua: [] };
}

function readProfileForEdit(kind, name) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const filePath = findProfilePath(k, n);
  if (!filePath) return { ok: false, status: 404, error: "profile not found" };
  const content = fs.readFileSync(filePath, "utf8");
  return { ok: true, kind: k, name: n, filePath, content };
}

function saveProfileForEdit(kind, name, content) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const body = String(content || "");
  if (!body.trim()) return { ok: false, status: 400, error: "profile content is empty" };
  ensureDirs();
  const target = path.join(EDIT_ROOT, `${n}.yml`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  return { ok: true, kind: k, name: n, filePath: target };
}

function deleteProfileForEdit(kind, name) {
  const k = sanitizeKind(kind);
  const n = sanitizeName(name);
  if (!k || !n) return { ok: false, status: 400, error: "invalid kind or profile name" };
  const target = path.join(EDIT_ROOT, `${n}.yml`);
  try {
    fs.unlinkSync(target);
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
