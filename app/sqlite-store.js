import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const DB_PATH = "/data/sub-mirror.sqlite";
const ADMIN_SEED_PATH = process.env.ADMIN_SEED_PATH || "";
let sqlModulePromise = null;
let dbPromise = null;

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function loadSqlModule() {
  if (!sqlModulePromise) {
    const baseDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(baseDir, "node_modules/sql.js/dist"),
      path.resolve(process.cwd(), "node_modules/sql.js/dist"),
      path.resolve(baseDir, "../app/node_modules/sql.js/dist"),
    ];
    sqlModulePromise = initSqlJs({
      locateFile: (file) => {
        for (const dir of candidates) {
          const full = path.resolve(dir, file);
          if (fs.existsSync(full)) return full;
        }
        return path.resolve(candidates[0], file);
      },
    });
  }
  return sqlModulePromise;
}

function runMigrations(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS short_links (
      id TEXT PRIMARY KEY,
      params_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS favorites_store (
      account_key TEXT PRIMARY KEY,
      favorites_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS short_link_user_policy (
      short_link_id TEXT PRIMARY KEY,
      max_users INTEGER NOT NULL DEFAULT 0,
      blocked_message TEXT NOT NULL DEFAULT '',
      limit_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS short_link_users (
      short_link_id TEXT NOT NULL,
      hwid TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT NOT NULL DEFAULT '',
      last_ip TEXT NOT NULL DEFAULT '',
      last_user_agent TEXT NOT NULL DEFAULT '',
      last_device_model TEXT NOT NULL DEFAULT '',
      last_device_os TEXT NOT NULL DEFAULT '',
      last_app TEXT NOT NULL DEFAULT '',
      last_device TEXT NOT NULL DEFAULT '',
      last_accept_language TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (short_link_id, hwid)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS short_link_user_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_link_id TEXT NOT NULL,
      hwid TEXT NOT NULL,
      event_type TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      device_model TEXT NOT NULL DEFAULT '',
      device_os TEXT NOT NULL DEFAULT '',
      app TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      accept_language TEXT NOT NULL DEFAULT ''
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_short_link_users_short_link ON short_link_users (short_link_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_short_link_users_last_seen ON short_link_users (short_link_id, last_seen_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_short_link_user_history_lookup ON short_link_user_history (short_link_id, hwid, changed_at DESC)");

  const infoStmt = db.prepare("PRAGMA table_info(auth_sessions)");
  const columns = new Set();
  while (infoStmt.step()) {
    const row = infoStmt.getAsObject();
    columns.add(String(row.name || ""));
  }
  infoStmt.free();
  if (!columns.has("username")) {
    db.run("ALTER TABLE auth_sessions ADD COLUMN username TEXT NOT NULL DEFAULT ''");
  }
}

function saveDb(db) {
  ensureDataDir();
  const tmp = `${DB_PATH}.tmp`;
  const data = db.export();
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_PATH);
}

function rowFromStmt(stmt) {
  if (!stmt.step()) return null;
  const row = stmt.getAsObject();
  return row || null;
}

function nowIso() {
  return new Date().toISOString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHwid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 256);
}

function normalizeRole(value) {
  return String(value || "user").trim().toLowerCase() === "admin" ? "admin" : "user";
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  return /^[a-z0-9._-]{3,64}$/.test(username);
}

function hashPassword(password) {
  const input = String(password || "");
  if (!input) throw new Error("password is required");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(input, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const input = String(password || "");
  const encoded = String(passwordHash || "");
  if (!input || !encoded.startsWith("scrypt$")) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(input, salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseAdminSeedFile() {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ADMIN_SEED_PATH ? path.resolve(ADMIN_SEED_PATH) : "",
    path.resolve(process.cwd(), "resources/admin.json"),
    path.resolve(baseDir, "../resources/admin.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.users)) return parsed.users;
      return [parsed];
    } catch {
      return [];
    }
  }
  return [];
}

function toPublicUser(row) {
  return {
    username: String(row.username || ""),
    role: normalizeRole(row.role),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function getUserRowByUsername(db, username) {
  const stmt = db.prepare(`
    SELECT username, password_hash, role, created_at, updated_at
    FROM users
    WHERE username = ?
    LIMIT 1
  `);
  stmt.bind([normalizeUsername(username)]);
  const row = rowFromStmt(stmt);
  stmt.free();
  return row;
}

function createUserInternal(db, input, allowExisting = false) {
  const username = normalizeUsername(input?.username);
  const password = String(input?.password || "");
  const role = normalizeRole(input?.role);
  if (!validateUsername(username)) {
    throw new Error("invalid username (use 3-64 chars: a-z 0-9 . _ -)");
  }
  if (password.length < 6) {
    throw new Error("password must contain at least 6 chars");
  }
  const existing = getUserRowByUsername(db, username);
  if (existing && !allowExisting) {
    throw new Error("username already exists");
  }
  const ts = nowIso();
  if (existing && allowExisting) {
    const stmt = db.prepare(`
      UPDATE users
      SET password_hash = ?, role = ?, updated_at = ?
      WHERE username = ?
    `);
    stmt.run([hashPassword(password), role, ts, username]);
    stmt.free();
    return toPublicUser({
      username,
      role,
      created_at: existing.created_at,
      updated_at: ts,
    });
  }

  const stmt = db.prepare(`
    INSERT INTO users (username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run([username, hashPassword(password), role, ts, ts]);
  stmt.free();
  return toPublicUser({
    username,
    role,
    created_at: ts,
    updated_at: ts,
  });
}

function ensureSeedAdminUsers(db) {
  const seedUsers = parseAdminSeedFile();
  if (!Array.isArray(seedUsers) || seedUsers.length === 0) return;
  for (const item of seedUsers) {
    const role = normalizeRole(item?.role);
    if (role !== "admin") continue;
    const username = normalizeUsername(item?.username);
    const hasPassword = String(item?.password || "");
    if (!validateUsername(username) || hasPassword.length < 6) continue;
    if (getUserRowByUsername(db, username)) continue;
    createUserInternal(
      db,
      { username, password: hasPassword, role: "admin" },
      false,
    );
  }
}

function cleanupExpiredSessions(db) {
  const stmt = db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?");
  stmt.run([nowSec()]);
  stmt.free();
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQL = await loadSqlModule();
      ensureDataDir();
      const db = fs.existsSync(DB_PATH)
        ? new SQL.Database(new Uint8Array(fs.readFileSync(DB_PATH)))
        : new SQL.Database();
      runMigrations(db);
      cleanupExpiredSessions(db);
      ensureSeedAdminUsers(db);
      saveDb(db);
      return db;
    })();
  }
  return dbPromise;
}

async function createShortLinkRow(id, params) {
  const db = await getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO short_links (id, params_json, created_at, updated_at, hits)
    VALUES (?, ?, ?, ?, 0)
  `);
  stmt.run([id, JSON.stringify(params || {}), now, now]);
  stmt.free();
  saveDb(db);
  return { id, params, createdAt: now, updatedAt: now, hits: 0 };
}

async function getShortLinkRow(id) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT id, params_json, created_at, updated_at, hits
    FROM short_links
    WHERE id = ?
    LIMIT 1
  `);
  stmt.bind([id]);
  const row = rowFromStmt(stmt);
  stmt.free();
  if (!row) return null;
  let params = {};
  try {
    params = JSON.parse(String(row.params_json || "{}"));
  } catch {
    params = {};
  }
  return {
    id: String(row.id),
    params,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    hits: Number(row.hits || 0),
  };
}

async function updateShortLinkRow(id, params) {
  const db = await getDb();
  const existing = await getShortLinkRow(id);
  if (!existing) return null;
  const nextParams = { ...existing.params, ...params };
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE short_links
    SET params_json = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run([JSON.stringify(nextParams), now, id]);
  stmt.free();
  saveDb(db);
  return {
    ...existing,
    params: nextParams,
    updatedAt: now,
  };
}

async function incrementShortLinkHits(id) {
  const db = await getDb();
  const stmt = db.prepare("UPDATE short_links SET hits = hits + 1 WHERE id = ?");
  stmt.run([id]);
  stmt.free();
  saveDb(db);
}

async function createAuthSessionForUser(username, ttlSec = 60 * 60 * 24 * 30) {
  const db = await getDb();
  const login = normalizeUsername(username);
  const userRow = getUserRowByUsername(db, login);
  if (!userRow) throw new Error("user not found");
  const now = nowSec();
  const expiresAt = now + Math.max(60, Number(ttlSec || 0));
  const token = crypto.randomBytes(24).toString("base64url");
  const stmt = db.prepare(`
    INSERT INTO auth_sessions (token, username, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run([token, login, now, expiresAt]);
  stmt.free();
  saveDb(db);
  return { token, createdAt: now, expiresAt };
}

async function getAuthSession(token) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT s.token, s.username, s.created_at, s.expires_at, u.role
    FROM auth_sessions s
    LEFT JOIN users u ON u.username = s.username
    WHERE token = ?
    LIMIT 1
  `);
  stmt.bind([token]);
  const row = rowFromStmt(stmt);
  stmt.free();
  if (!row) return null;
  const now = nowSec();
  const expiresAt = Number(row.expires_at || 0);
  if (expiresAt <= now || !row.username || !row.role) {
    await deleteAuthSession(token);
    return null;
  }
  return {
    token: String(row.token || ""),
    username: normalizeUsername(row.username),
    role: normalizeRole(row.role),
    createdAt: Number(row.created_at || 0),
    expiresAt,
  };
}

async function deleteAuthSession(token) {
  const db = await getDb();
  const stmt = db.prepare("DELETE FROM auth_sessions WHERE token = ?");
  stmt.run([token]);
  stmt.free();
  saveDb(db);
}

async function hasUsers() {
  const db = await getDb();
  const stmt = db.prepare("SELECT COUNT(1) AS c FROM users");
  const row = rowFromStmt(stmt);
  stmt.free();
  return Number(row?.c || 0) > 0;
}

async function verifyUserCredentials(username, password) {
  const db = await getDb();
  const login = normalizeUsername(username);
  const row = getUserRowByUsername(db, login);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toPublicUser(row);
}

async function listUsers() {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT username, role, created_at, updated_at
    FROM users
    ORDER BY username ASC
  `);
  const rows = [];
  while (stmt.step()) {
    rows.push(toPublicUser(stmt.getAsObject()));
  }
  stmt.free();
  return rows;
}

async function createUser(input) {
  const db = await getDb();
  const user = createUserInternal(db, input, false);
  saveDb(db);
  return user;
}

async function updateUser(username, patch) {
  const db = await getDb();
  const login = normalizeUsername(username);
  const existing = getUserRowByUsername(db, login);
  if (!existing) return null;

  const nextRole = patch?.role ? normalizeRole(patch.role) : normalizeRole(existing.role);
  const nextPasswordHash =
    typeof patch?.password === "string" && patch.password.length > 0
      ? hashPassword(patch.password)
      : String(existing.password_hash || "");
  if (typeof patch?.password === "string" && patch.password.length > 0 && patch.password.length < 6) {
    throw new Error("password must contain at least 6 chars");
  }

  const ts = nowIso();
  const stmt = db.prepare(`
    UPDATE users
    SET password_hash = ?, role = ?, updated_at = ?
    WHERE username = ?
  `);
  stmt.run([nextPasswordHash, nextRole, ts, login]);
  stmt.free();
  saveDb(db);
  return toPublicUser({
    username: login,
    role: nextRole,
    created_at: existing.created_at,
    updated_at: ts,
  });
}

async function deleteUser(username) {
  const db = await getDb();
  const login = normalizeUsername(username);
  const existing = getUserRowByUsername(db, login);
  if (!existing) return false;

  const sessionStmt = db.prepare("DELETE FROM auth_sessions WHERE username = ?");
  sessionStmt.run([login]);
  sessionStmt.free();
  const userStmt = db.prepare("DELETE FROM users WHERE username = ?");
  userStmt.run([login]);
  userStmt.free();
  saveDb(db);
  return true;
}

async function getFavoritesRow(accountKey) {
  const key = String(accountKey || "").trim();
  if (!key) return [];
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT favorites_json
    FROM favorites_store
    WHERE account_key = ?
    LIMIT 1
  `);
  stmt.bind([key]);
  const row = rowFromStmt(stmt);
  stmt.free();
  if (!row) return [];
  try {
    const parsed = JSON.parse(String(row.favorites_json || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setFavoritesRow(accountKey, favorites) {
  const key = String(accountKey || "").trim();
  if (!key) throw new Error("account key is required");
  const list = Array.isArray(favorites)
    ? favorites.filter((x) => x && typeof x === "object").slice(0, 200)
    : [];
  const db = await getDb();
  const now = nowIso();
  const stmt = db.prepare(`
    INSERT INTO favorites_store (account_key, favorites_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_key) DO UPDATE SET
      favorites_json = excluded.favorites_json,
      updated_at = excluded.updated_at
  `);
  stmt.run([key, JSON.stringify(list), now]);
  stmt.free();
  saveDb(db);
  return list;
}

function defaultShortLinkPolicy() {
  return {
    maxUsers: 0,
    blockedMessage: "Доступ к подписке заблокирован",
    limitMessage: "Достигнут лимит пользователей для этой подписки",
    updatedAt: "",
  };
}

function normalizeShortLinkPolicy(input) {
  const maxRaw = Number(input?.maxUsers ?? input?.max_users ?? 0);
  const maxUsers = Number.isFinite(maxRaw) ? Math.max(0, Math.floor(maxRaw)) : 0;
  const blockedMessage = String(input?.blockedMessage ?? input?.blocked_message ?? "").trim();
  const limitMessage = String(input?.limitMessage ?? input?.limit_message ?? "").trim();
  return {
    maxUsers,
    blockedMessage,
    limitMessage,
  };
}

function mapUserInfo(input) {
  return {
    ip: String(input?.ip || "").trim().slice(0, 128),
    userAgent: String(input?.userAgent || "").trim().slice(0, 512),
    deviceModel: String(input?.deviceModel || "").trim().slice(0, 256),
    deviceOs: String(input?.deviceOs || "").trim().slice(0, 128),
    app: String(input?.app || "").trim().slice(0, 128),
    device: String(input?.device || "").trim().slice(0, 128),
    acceptLanguage: String(input?.acceptLanguage || "").trim().slice(0, 128),
  };
}

function getShortLinkUserPolicyRow(db, shortLinkId) {
  const stmt = db.prepare(`
    SELECT short_link_id, max_users, blocked_message, limit_message, updated_at
    FROM short_link_user_policy
    WHERE short_link_id = ?
    LIMIT 1
  `);
  stmt.bind([String(shortLinkId || "")]);
  const row = rowFromStmt(stmt);
  stmt.free();
  if (!row) return null;
  return {
    shortLinkId: String(row.short_link_id || ""),
    maxUsers: Math.max(0, Number(row.max_users || 0)),
    blockedMessage: String(row.blocked_message || ""),
    limitMessage: String(row.limit_message || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function upsertShortLinkUserPolicyRow(db, shortLinkId, policyPatch = {}) {
  const id = String(shortLinkId || "").trim();
  if (!id) throw new Error("short link id is required");
  const current = getShortLinkUserPolicyRow(db, id);
  const defaults = defaultShortLinkPolicy();
  const patch = normalizeShortLinkPolicy(policyPatch);
  const next = {
    maxUsers: patch.maxUsers,
    blockedMessage: patch.blockedMessage || current?.blockedMessage || defaults.blockedMessage,
    limitMessage: patch.limitMessage || current?.limitMessage || defaults.limitMessage,
  };
  const ts = nowIso();
  const stmt = db.prepare(`
    INSERT INTO short_link_user_policy (short_link_id, max_users, blocked_message, limit_message, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(short_link_id) DO UPDATE SET
      max_users = excluded.max_users,
      blocked_message = excluded.blocked_message,
      limit_message = excluded.limit_message,
      updated_at = excluded.updated_at
  `);
  stmt.run([id, next.maxUsers, next.blockedMessage, next.limitMessage, ts]);
  stmt.free();
  return {
    shortLinkId: id,
    maxUsers: next.maxUsers,
    blockedMessage: next.blockedMessage,
    limitMessage: next.limitMessage,
    updatedAt: ts,
  };
}

function getShortLinkUserRow(db, shortLinkId, hwid) {
  const stmt = db.prepare(`
    SELECT short_link_id, hwid, first_seen_at, last_seen_at, blocked, block_reason,
           last_ip, last_user_agent, last_device_model, last_device_os, last_app, last_device, last_accept_language
    FROM short_link_users
    WHERE short_link_id = ? AND hwid = ?
    LIMIT 1
  `);
  stmt.bind([String(shortLinkId || ""), normalizeHwid(hwid)]);
  const row = rowFromStmt(stmt);
  stmt.free();
  return row || null;
}

function insertShortLinkUserHistory(db, shortLinkId, hwid, eventType, info, changedAt = nowIso()) {
  const data = mapUserInfo(info);
  const stmt = db.prepare(`
    INSERT INTO short_link_user_history (
      short_link_id, hwid, event_type, changed_at,
      ip, user_agent, device_model, device_os, app, device, accept_language
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    String(shortLinkId || ""),
    normalizeHwid(hwid),
    String(eventType || "change"),
    String(changedAt || nowIso()),
    data.ip,
    data.userAgent,
    data.deviceModel,
    data.deviceOs,
    data.app,
    data.device,
    data.acceptLanguage,
  ]);
  stmt.free();
}

function hasTrackedUserInfoChange(row, info) {
  const next = mapUserInfo(info);
  return (
    String(row?.last_ip || "") !== next.ip ||
    String(row?.last_user_agent || "") !== next.userAgent ||
    String(row?.last_device_model || "") !== next.deviceModel ||
    String(row?.last_device_os || "") !== next.deviceOs ||
    String(row?.last_app || "") !== next.app ||
    String(row?.last_device || "") !== next.device ||
    String(row?.last_accept_language || "") !== next.acceptLanguage
  );
}

async function recordShortLinkUserVisit(shortLinkId, hwid, info) {
  const db = await getDb();
  const id = String(shortLinkId || "").trim();
  if (!id) throw new Error("short link id is required");
  const normalizedHwid = normalizeHwid(hwid);
  if (!normalizedHwid) {
    return { ok: true, skipped: true, reason: "empty hwid" };
  }
  const policy = getShortLinkUserPolicyRow(db, id) || {
    shortLinkId: id,
    ...defaultShortLinkPolicy(),
  };
  const userInfo = mapUserInfo(info);
  const now = nowIso();
  const existing = getShortLinkUserRow(db, id, normalizedHwid);

  if (existing) {
    const changed = hasTrackedUserInfoChange(existing, userInfo);
    if (changed) {
      insertShortLinkUserHistory(db, id, normalizedHwid, "changed", userInfo, now);
    }
    const stmt = db.prepare(`
      UPDATE short_link_users
      SET last_seen_at = ?,
          last_ip = ?,
          last_user_agent = ?,
          last_device_model = ?,
          last_device_os = ?,
          last_app = ?,
          last_device = ?,
          last_accept_language = ?
      WHERE short_link_id = ? AND hwid = ?
    `);
    stmt.run([
      now,
      userInfo.ip,
      userInfo.userAgent,
      userInfo.deviceModel,
      userInfo.deviceOs,
      userInfo.app,
      userInfo.device,
      userInfo.acceptLanguage,
      id,
      normalizedHwid,
    ]);
    stmt.free();
    saveDb(db);

    if (Number(existing.blocked || 0) > 0) {
      return {
        ok: false,
        code: "blocked",
        message: String(existing.block_reason || policy.blockedMessage || defaultShortLinkPolicy().blockedMessage),
      };
    }
    return { ok: true, code: "ok" };
  }

  if (policy.maxUsers > 0) {
    const countStmt = db.prepare(`
      SELECT COUNT(1) AS c
      FROM short_link_users
      WHERE short_link_id = ? AND blocked = 0
    `);
    countStmt.bind([id]);
    const row = rowFromStmt(countStmt);
    countStmt.free();
    const activeUsers = Math.max(0, Number(row?.c || 0));
    if (activeUsers >= policy.maxUsers) {
      return {
        ok: false,
        code: "limit",
        message: String(policy.limitMessage || defaultShortLinkPolicy().limitMessage),
      };
    }
  }

  const insertStmt = db.prepare(`
    INSERT INTO short_link_users (
      short_link_id, hwid, first_seen_at, last_seen_at, blocked, block_reason,
      last_ip, last_user_agent, last_device_model, last_device_os, last_app, last_device, last_accept_language
    )
    VALUES (?, ?, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run([
    id,
    normalizedHwid,
    now,
    now,
    userInfo.ip,
    userInfo.userAgent,
    userInfo.deviceModel,
    userInfo.deviceOs,
    userInfo.app,
    userInfo.device,
    userInfo.acceptLanguage,
  ]);
  insertStmt.free();
  insertShortLinkUserHistory(db, id, normalizedHwid, "first_seen", userInfo, now);
  saveDb(db);
  return { ok: true, code: "ok" };
}

async function listShortLinkUsers(shortLinkId) {
  const db = await getDb();
  const id = String(shortLinkId || "").trim();
  if (!id) throw new Error("short link id is required");
  const policy = getShortLinkUserPolicyRow(db, id) || {
    shortLinkId: id,
    ...defaultShortLinkPolicy(),
  };

  const usersStmt = db.prepare(`
    SELECT short_link_id, hwid, first_seen_at, last_seen_at, blocked, block_reason,
           last_ip, last_user_agent, last_device_model, last_device_os, last_app, last_device, last_accept_language
    FROM short_link_users
    WHERE short_link_id = ?
    ORDER BY last_seen_at DESC
  `);
  usersStmt.bind([id]);
  const users = [];
  while (usersStmt.step()) {
    const row = usersStmt.getAsObject();
    users.push({
      hwid: String(row.hwid || ""),
      firstSeenAt: String(row.first_seen_at || ""),
      lastSeenAt: String(row.last_seen_at || ""),
      blocked: Number(row.blocked || 0) > 0,
      blockReason: String(row.block_reason || ""),
      lastSeen: {
        ip: String(row.last_ip || ""),
        userAgent: String(row.last_user_agent || ""),
        deviceModel: String(row.last_device_model || ""),
        deviceOs: String(row.last_device_os || ""),
        app: String(row.last_app || ""),
        device: String(row.last_device || ""),
        acceptLanguage: String(row.last_accept_language || ""),
      },
      history: [],
    });
  }
  usersStmt.free();

  const historyStmt = db.prepare(`
    SELECT hwid, event_type, changed_at, ip, user_agent, device_model, device_os, app, device, accept_language
    FROM short_link_user_history
    WHERE short_link_id = ?
    ORDER BY changed_at DESC, id DESC
  `);
  historyStmt.bind([id]);
  const historyByHwid = new Map();
  while (historyStmt.step()) {
    const row = historyStmt.getAsObject();
    const hwidValue = String(row.hwid || "");
    if (!historyByHwid.has(hwidValue)) historyByHwid.set(hwidValue, []);
    historyByHwid.get(hwidValue).push({
      eventType: String(row.event_type || "changed"),
      changedAt: String(row.changed_at || ""),
      ip: String(row.ip || ""),
      userAgent: String(row.user_agent || ""),
      deviceModel: String(row.device_model || ""),
      deviceOs: String(row.device_os || ""),
      app: String(row.app || ""),
      device: String(row.device || ""),
      acceptLanguage: String(row.accept_language || ""),
    });
  }
  historyStmt.free();

  for (const item of users) {
    item.history = historyByHwid.get(item.hwid) || [];
  }

  const blockedCount = users.filter((x) => x.blocked).length;
  return {
    shortLinkId: id,
    policy: {
      maxUsers: policy.maxUsers,
      blockedMessage: policy.blockedMessage || defaultShortLinkPolicy().blockedMessage,
      limitMessage: policy.limitMessage || defaultShortLinkPolicy().limitMessage,
      updatedAt: policy.updatedAt || "",
    },
    summary: {
      usersCount: users.length,
      blockedCount,
      activeCount: users.length - blockedCount,
    },
    users,
  };
}

async function updateShortLinkUserPolicy(shortLinkId, policyPatch) {
  const db = await getDb();
  const row = upsertShortLinkUserPolicyRow(db, shortLinkId, policyPatch);
  saveDb(db);
  return {
    shortLinkId: row.shortLinkId,
    maxUsers: row.maxUsers,
    blockedMessage: row.blockedMessage,
    limitMessage: row.limitMessage,
    updatedAt: row.updatedAt,
  };
}

async function setShortLinkUserBlocked(shortLinkId, hwid, blocked, blockReason = "") {
  const db = await getDb();
  const id = String(shortLinkId || "").trim();
  const normalizedHwid = normalizeHwid(hwid);
  if (!id || !normalizedHwid) throw new Error("invalid short link id or hwid");
  const existing = getShortLinkUserRow(db, id, normalizedHwid);
  if (!existing) return null;
  const nextBlocked = blocked ? 1 : 0;
  const reason = blocked ? String(blockReason || "").trim().slice(0, 500) : "";
  const stmt = db.prepare(`
    UPDATE short_link_users
    SET blocked = ?, block_reason = ?
    WHERE short_link_id = ? AND hwid = ?
  `);
  stmt.run([nextBlocked, reason, id, normalizedHwid]);
  stmt.free();
  saveDb(db);
  return {
    shortLinkId: id,
    hwid: normalizedHwid,
    blocked: nextBlocked > 0,
    blockReason: reason,
  };
}

async function deleteShortLinkUser(shortLinkId, hwid) {
  const db = await getDb();
  const id = String(shortLinkId || "").trim();
  const normalizedHwid = normalizeHwid(hwid);
  if (!id || !normalizedHwid) throw new Error("invalid short link id or hwid");
  const userStmt = db.prepare("DELETE FROM short_link_users WHERE short_link_id = ? AND hwid = ?");
  userStmt.run([id, normalizedHwid]);
  userStmt.free();
  const historyStmt = db.prepare("DELETE FROM short_link_user_history WHERE short_link_id = ? AND hwid = ?");
  historyStmt.run([id, normalizedHwid]);
  historyStmt.free();
  saveDb(db);
  return true;
}

export {
  createShortLinkRow,
  getShortLinkRow,
  updateShortLinkRow,
  incrementShortLinkHits,
  createAuthSessionForUser,
  getAuthSession,
  deleteAuthSession,
  hasUsers,
  verifyUserCredentials,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getFavoritesRow,
  setFavoritesRow,
  recordShortLinkUserVisit,
  listShortLinkUsers,
  updateShortLinkUserPolicy,
  setShortLinkUserBlocked,
  deleteShortLinkUser,
};
