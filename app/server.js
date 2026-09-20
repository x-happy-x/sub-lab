import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CACHE_DIR,
  PORT,
  PUBLIC_BASE_URL,
  SYNC_API_TOKEN,
  STATIC_FILES,
  OUTPUT_DEFAULT,
  normalizeOutput,
} from "./config.js";
import { renderHomePage } from "./home-page.js";
import { renderAccessNotice } from "./access-notice.js";
import { PING_MODES, pingTargets } from "./ping.js";
import {
  PARAM_KEYS,
  sanitizeParams,
  normalizeTags,
  createShortLink,
  getShortLink,
  getPublicShortLink,
  updateShortLink,
  buildQueryFromParams,
} from "./short-links.js";
import {
  incrementShortLinkHits,
  getShortLinkPermissions,
  listShortLinksByTagForActor,
  getShortLinkRow,
  listShortLinksGrantedTo,
  getFavoritesRow,
  listShortLinkAccess,
  replaceShortLinkAccess,
  setFavoritesRow,
  recordShortLinkUserVisit,
  collectUsageStats,
  listShortLinkUsers,
  updateShortLinkUserPolicy,
  setShortLinkUserBlocked,
  deleteShortLinkUser,
  buildSubscriptionFeedKey,
  getSubscriptionFeedByKey,
  getSubscriptionOverridesForFeed,
  upsertSubscriptionFeed,
  upsertSubscriptionOverrides,
  exportSyncBundle,
  importSyncBundle,
  listAllShortLinkRows,
  listSyncPeers,
  getSyncPeer,
  getSyncPeerWithToken,
  createSyncPeer,
  updateSyncPeer,
  deleteSyncPeer,
  recordSyncPeerRun,
} from "./sqlite-store.js";
import {
  createMockSource,
  getMockSource,
  updateMockSource,
  appendMockLog,
  clearMockLogs,
  listPresets,
} from "./mock-sources.js";
import {
  listEditorCatalog,
  readProfileForEdit,
  saveProfileForEdit,
  deleteProfileForEdit,
} from "./profile-editor.js";
import {
  parseProfileYaml,
  getUaCatalogOptions,
  readProfileFile,
  profileExists,
  pickUserAgentProfile,
  resolveAppKeyFromUserAgent,
  resolveOutputFromUserAgent,
  previewMergeItems,
  buildNormalizedModelFromSource,
  resolveLocalSourcePath,
  resolveRequestConfig,
  produceOutput,
  fetchWithNode,
  applyOverridesToNormalized,
  decryptHappLink,
  handleSubscription,
  handleLast,
  handleEcho,
  loadLatestStoredSnapshotBundle,
  persistSuccessfulSourceSnapshot,
  renderOutputFromNormalized,
  serveStaticFile,
} from "./subscription.js";
import {
  createLocalSource,
  createMergedSource,
  updateMergedSource,
  getMergedSource,
  getLocalSource,
} from "./local-sources.js";
import { getAppsCatalog, getAppGuide } from "./apps-catalog.js";
import { parseBulkProxyText } from "./proxy-import.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
// Ключ приложения в account: так называются группы в LLDAP (`sub_mirror_admin`
// и прочие), поэтому переименование сервиса его не касается.
const ACCOUNT_APP = "sub_mirror";
const ACCOUNT_URL = String(process.env.ACCOUNT_URL || "http://account:4160").replace(/\/+$/, "");
const ACCOUNT_SERVICE_TOKEN = String(process.env.ACCOUNT_SERVICE_TOKEN || "");
/**
 * Cookie сессии в браузере.
 *
 * Имя обязано быть своим у каждого приложения: cookie не разделяются по
 * портам, а все домашние сервисы живут на одном хосте. С общим именем вход в
 * соседнее приложение молча подменял сессию здесь — и в интерфейсе появлялся
 * чужой пользователь с его ролью.
 */
const SESSION_COOKIE = String(process.env.SESSION_COOKIE || "sub_lab_session").trim() || "sub_lab_session";
/** Имя cookie, которое ждёт внутренний API account. Оно общее для всех приложений. */
const ACCOUNT_SESSION_COOKIE = String(process.env.ACCOUNT_SESSION_COOKIE || "kartoteka_session").trim()
  || "kartoteka_session";
/** Cookie прежней общей сессии: гасим её, чтобы она не всплывала из другого приложения. */
const LEGACY_SESSION_COOKIES = ["kartoteka_session"].filter((name) => name !== SESSION_COOKIE);
const AUTH_STATE_COOKIE = "sub_lab_auth_state";
const ACCOUNT_HOST_PREFIX = String(process.env.ACCOUNT_HOST_PREFIX || "account").trim().toLowerCase() || "account";
const SUB_LAB_HOST_PREFIX = String(process.env.SUB_LAB_HOST_PREFIX || process.env.SUB_MIRROR_HOST_PREFIX || "sub").trim().toLowerCase() || "sub";
const ACCOUNT_LOCAL_PORT = Number(process.env.ACCOUNT_LOCAL_PORT || 4161);
const SUB_LAB_LOCAL_PORT = Number(process.env.SUB_LAB_LOCAL_PORT || process.env.SUB_MIRROR_LOCAL_PORT || 4192);
const PROXY_HOST = String(process.env.PROXY_HOST || "").trim().toLowerCase();
const FRONTEND_DIST_CANDIDATES = [
  path.resolve(SERVER_DIR, "../frontend-dist"),
  path.resolve(SERVER_DIR, "../frontend/dist"),
];

function resolveFrontendDist() {
  for (const dir of FRONTEND_DIST_CANDIDATES) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return "";
}

const FRONTEND_DIST = resolveFrontendDist();

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".map") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveFile(res, filePath) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeForFile(filePath),
      "Cache-Control": "no-store",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function serveFrontendIndex(res) {
  if (!FRONTEND_DIST) return false;
  return serveFile(res, path.join(FRONTEND_DIST, "index.html"));
}

function serveFrontendAsset(reqPath, res) {
  if (!FRONTEND_DIST) return false;
  const decodedPath = decodeURIComponent(reqPath || "/");
  const normalized = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.resolve(FRONTEND_DIST, `.${normalized}`);
  if (!absolute.startsWith(FRONTEND_DIST)) return false;
  if (!fs.existsSync(absolute)) return false;
  if (!fs.statSync(absolute).isFile()) return false;
  return serveFile(res, absolute);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload, null, 2));
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function parseBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Страница с короткой человеческой ошибкой: одна карточка и необязательная кнопка. */
function renderProblemPage(title, message, action = null) {
  const button = action
    ? `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
    : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f1ec; --surface: #fff; --line: rgba(35,28,21,.1);
    --ink: #1c1917; --muted: #6d665d; --accent: #c25a35;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131211; --surface: #1d1b19; --line: rgba(240,228,214,.12); --ink: #f0ebe4; --muted: #a49c92; --accent: #e08a5f; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh; display: grid; place-items: center;
    padding: 24px; background: var(--bg); color: var(--ink);
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.55;
  }
  .card {
    width: min(460px, 100%); padding: 28px;
    border: 1px solid var(--line); border-radius: 18px; background: var(--surface);
    box-shadow: 0 18px 44px rgba(31,25,18,.1);
  }
  h1 { margin: 0 0 8px; font-size: 21px; letter-spacing: -.02em; }
  p { margin: 0 0 18px; color: var(--muted); font-size: 14px; white-space: pre-wrap; }
  p:last-child { margin-bottom: 0; }
  a.btn {
    display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 16px;
    border-radius: 13px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; text-decoration: none;
  }
</style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${button}
  </main>
</body>
</html>`;
}

function sendProblemPage(res, status, title, message, extraHeaders = {}, action = null) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(renderProblemPage(title, message, action));
}

function sendAuthProblem(res, status, title, message, extraHeaders = {}) {
  sendProblemPage(res, status, title, message, extraHeaders, {
    href: "/auth/start?return=/",
    label: "Попробовать войти снова",
  });
}

function cookieValue(name, value, { maxAge, expires, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value || ""))}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (expires) parts.push(`Expires=${expires instanceof Date ? expires.toUTCString() : String(expires)}`);
  return parts.join("; ");
}

function clearCookieValue(name) {
  return cookieValue(name, "", { maxAge: 0 });
}

/** Своя cookie плюс общая старая: иначе вход в соседнее приложение вернёт чужую сессию. */
function clearSessionCookies() {
  return [SESSION_COOKIE, ...LEGACY_SESSION_COOKIES].map(clearCookieValue);
}

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}

function splitHost(host) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(host || ""));
  return { hostname: (match?.[1] || "").toLowerCase(), port: match?.[2] || "" };
}

function isAddressHost(hostname) {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || !hostname.includes(".");
}

function defaultPort(proto, port) {
  return (proto === "https" && port === "443") || (proto === "http" && port === "80");
}

function browserOf(req) {
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const incomingHost = firstHeader(req.headers.host).toLowerCase();
  const mapped = !forwardedHost && PUBLIC_BASE_URL && incomingHost === PROXY_HOST;
  const publicUrl = mapped ? new URL(PUBLIC_BASE_URL) : null;
  const rawHost = (publicUrl?.host || forwardedHost || incomingHost || `127.0.0.1:${SUB_LAB_LOCAL_PORT}`).toLowerCase();
  let { hostname, port } = splitHost(rawHost);
  const address = isAddressHost(hostname);
  let proto = publicUrl?.protocol.slice(0, -1) || firstHeader(req.headers["x-forwarded-proto"]).toLowerCase();
  if (proto !== "http" && proto !== "https") {
    const direct = address || /\.(local|lan|home\.arpa)$/.test(hostname) || [ACCOUNT_LOCAL_PORT, SUB_LAB_LOCAL_PORT].includes(Number(port));
    proto = direct ? "http" : "https";
  }
  const forwardedPort = firstHeader(req.headers["x-forwarded-port"]);
  if (!port && forwardedHost && /^\d+$/.test(forwardedPort)) port = forwardedPort;
  if (defaultPort(proto, port)) port = "";
  const host = port ? `${hostname}:${port}` : hostname;
  return { hostname, port, proto, address, host, origin: `${proto}://${host}` };
}

function appOrigin(req, app) {
  const b = browserOf(req);
  const ports = { account: ACCOUNT_LOCAL_PORT, sub_mirror: SUB_LAB_LOCAL_PORT };
  const prefixes = { account: ACCOUNT_HOST_PREFIX, sub_mirror: SUB_LAB_HOST_PREFIX };
  if (b.address) return `http://${b.hostname}:${ports[app]}`;
  const labels = b.hostname.split(".");
  const rest = Object.values(prefixes).includes(labels[0]) ? labels.slice(1) : labels;
  const hostname = [prefixes[app], ...rest].join(".");
  const knownPort = [ACCOUNT_LOCAL_PORT, SUB_LAB_LOCAL_PORT].includes(Number(b.port));
  const port = !b.port ? "" : knownPort ? String(ports[app]) : b.port;
  return `${b.proto}://${hostname}${port ? `:${port}` : ""}`;
}

function selfOrigin(req) {
  return appOrigin(req, ACCOUNT_APP);
}

function accountBrowserOrigin(req) {
  return appOrigin(req, "account");
}

function safeReturnPath(raw) {
  const text = String(raw || "/");
  return /^\/(?![/\\])/.test(text) ? text : "/";
}

function authStartLocation(req, returnPath = "/") {
  const state = crypto.randomBytes(24).toString("base64url");
  const accountUrl = new URL("/authorize", accountBrowserOrigin(req));
  accountUrl.searchParams.set("app", ACCOUNT_APP);
  accountUrl.searchParams.set("redirect_uri", `${selfOrigin(req)}/auth/callback`);
  accountUrl.searchParams.set("state", state);
  const payload = `${state}:${Buffer.from(safeReturnPath(returnPath)).toString("base64url")}`;
  return {
    location: accountUrl.href,
    cookie: cookieValue(AUTH_STATE_COOKIE, payload, { maxAge: 5 * 60 }),
  };
}

function accountLogoutLocation(req) {
  const url = new URL("/logout", accountBrowserOrigin(req));
  url.searchParams.set("return", `${selfOrigin(req)}/`);
  return url.href;
}

async function accountRequest(pathname, { method = "GET", token = "", body, service = false } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Cookie = `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`;
  if (service) headers["X-Service-Token"] = ACCOUNT_SERVICE_TOKEN;
  const payload = body === undefined ? "" : JSON.stringify(body);
  if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
  const url = new URL(pathname, `${ACCOUNT_URL}/`);
  const transport = url.protocol === "https:" ? https : http;
  const { statusCode, text } = await new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers,
        timeout: 8000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          statusCode: Number(response.statusCode || 0),
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("account request timeout")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (statusCode < 200 || statusCode >= 300) {
    const message = json.error || json.message || `account request failed (${statusCode})`;
    const error = new Error(message);
    error.status = statusCode;
    throw error;
  }
  return json;
}

async function accountMe(token) {
  if (!token) return null;
  try {
    const json = await accountRequest("/api/auth/me", { token });
    return json.user || null;
  } catch {
    return null;
  }
}

function accountRole(user) {
  return String(user?.access?.[ACCOUNT_APP]?.role || "none").toLowerCase();
}

function authUserFromAccount(user) {
  const role = accountRole(user);
  const username = String(user?.login || "").trim().toLowerCase();
  if (!username || role === "none") return null;
  return {
    username,
    name: String(user?.name || ""),
    role: role === "admin" ? "admin" : "user",
    accountRole: role,
    canEdit: role === "editor" || role === "admin",
  };
}

function accountUserForUi(user) {
  const mapped = authUserFromAccount(user);
  if (!mapped) return null;
  return {
    username: mapped.username,
    name: mapped.name,
    role: mapped.role,
    accountRole: mapped.accountRole,
  };
}

function fixedTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function resolveSyncToken(req) {
  return String(req.headers["x-sync-token"] || "").trim() || parseBearerToken(req);
}

function isSyncTokenValid(req) {
  return Boolean(SYNC_API_TOKEN) && fixedTimeEqual(resolveSyncToken(req), SYNC_API_TOKEN);
}

function requireSyncToken(req, res) {
  if (!SYNC_API_TOKEN) {
    sendJson(res, 503, { ok: false, error: "sync API is disabled" });
    return false;
  }
  if (!isSyncTokenValid(req)) {
    sendJson(res, 401, { ok: false, error: "invalid sync token" });
    return false;
  }
  return true;
}

async function requireAdminOrSyncToken(req, res) {
  if (isSyncTokenValid(req)) return true;
  const state = await requireAdmin(req, res);
  return Boolean(state);
}

async function resolveAuthToken(req) {
  const cookieToken = parseCookies(req)[SESSION_COOKIE] || "";
  const headerToken = String(req.headers["x-auth-token"] || "").trim();
  const bearerToken = parseBearerToken(req);
  return cookieToken || headerToken || bearerToken;
}

async function getAuthState(req) {
  const token = await resolveAuthToken(req);
  if (!token) return { enabled: true, authenticated: false, token: "", user: null };
  const accountUser = await accountMe(token);
  const user = authUserFromAccount(accountUser);
  return {
    enabled: true,
    authenticated: Boolean(user),
    denied: Boolean(accountUser && !user),
    token,
    accountUser,
    user,
  };
}

async function requireApiAuth(req, res) {
  const state = await getAuthState(req);
  if (state.authenticated) return true;
  if (state.denied) {
    sendJson(res, 403, { ok: false, error: "forbidden", accessRequired: true });
    return false;
  }
  sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
  return false;
}

async function requireAdmin(req, res) {
  const state = await getAuthState(req);
  if (!state.authenticated) {
    if (state.denied) {
      sendJson(res, 403, { ok: false, error: "forbidden", accessRequired: true });
      return null;
    }
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return null;
  }
  if (!state.user || state.user.role !== "admin") {
    sendJson(res, 403, { ok: false, error: "forbidden", adminRequired: true });
    return null;
  }
  return state;
}

async function requireEditorAuth(req, res) {
  const state = await getAuthState(req);
  if (!state.authenticated) {
    if (state.denied) {
      sendJson(res, 403, { ok: false, error: "forbidden", accessRequired: true });
      return null;
    }
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return null;
  }
  if (!state.user?.canEdit) {
    sendJson(res, 403, { ok: false, error: "forbidden", editorRequired: true });
    return null;
  }
  return state;
}

function authActorFromState(state) {
  if (!state?.authenticated || !state?.user) return { username: "", role: "user" };
  return {
    username: String(state.user.username || ""),
    role: String(state.user.role || "user"),
  };
}

function canAccessMockSource(source, actor) {
  const ownerUsername = String(source?.meta?.ownerUsername || "").trim().toLowerCase();
  const username = String(actor?.username || "").trim().toLowerCase();
  const role = String(actor?.role || "user").trim().toLowerCase();
  if (!ownerUsername) return true;
  if (role === "admin") return true;
  return Boolean(username) && username === ownerUsername;
}

async function requireShortLinkPermission(req, res, id, mode = "view") {
  const state = await getAuthState(req);
  if (state.enabled && !state.authenticated) {
    if (state.denied) {
      sendJson(res, 403, { ok: false, error: "forbidden", accessRequired: true });
      return null;
    }
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return null;
  }
  const permission = await getShortLinkPermissions(id, authActorFromState(state));
  if (!permission?.link) {
    sendJson(res, 404, { ok: false, error: "short link not found" });
    return null;
  }
  if (mode === "manage" && !permission.canManageAccess) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return null;
  }
  if ((mode === "manage" || mode === "edit") && state.enabled && !state.user?.canEdit) {
    sendJson(res, 403, { ok: false, error: "forbidden", editorRequired: true });
    return null;
  }
  if (mode === "edit" && !permission.canEdit) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return null;
  }
  if (mode === "view" && !permission.canView) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return null;
  }
  return { state, permission };
}

async function readRawBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body too large (max ${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
  const raw = (await readRawBody(req, maxBytes)).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function shortLinkPublicUrls(req, id, params) {
  const origin = resolvePublicOrigin(req);
  const endpoint = params.endpoint === "sub" ? "sub" : "last";
  return {
    id,
    shortUrl: `${origin}/l/${id}`,
    editUrl: `${origin}/?sid=${id}`,
    resolvedUrl: `${origin}/${endpoint}?${buildQueryFromParams(params).toString()}`,
  };
}

function resolvePublicOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers.host || "").split(",")[0].trim() || "localhost";
  const proto = forwardedProto === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function cacheKey(subUrl, output, profileKey = "") {
  return sha1(`${subUrl}|${output}|${profileKey}`);
}

function cachePathForKey(key) {
  return `${CACHE_DIR}/${key}.yaml`;
}

function cacheMetaPathForKey(key) {
  return `${CACHE_DIR}/${key}.json`;
}

function decodeBase64IfNeeded(text) {
  const value = String(text || "").trim();
  if (!value || value.includes("://")) return String(text || "");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value) || value.length < 120) return String(text || "");
  try {
    const decoded = Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
    return decoded && decoded.trim() ? decoded : String(text || "");
  } catch {
    return String(text || "");
  }
}

function detectSourceFormat(rawText, contentType = "") {
  const text = String(rawText || "").trim();
  if (!text) return "empty";
  const ct = String(contentType || "").toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || ct.includes("text/html")) return "html";
  if (ct.includes("application/json")) return "json";
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // continue
    }
  }
  if (/^\s*proxies\s*:\s*$/m.test(text)) return "yml";
  if (/^(vmess|vless|ss|ssr|trojan):\/\//m.test(text)) return "raw";
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 120) {
    const decoded = decodeBase64IfNeeded(text);
    if (decoded !== text && /^(vmess|vless|ss|ssr|trojan):\/\//m.test(decoded)) return "raw(base64)";
  }
  return "unknown";
}

function decodeUriTitle(uri) {
  const item = String(uri || "").trim();
  if (!/^(vmess|vless|ss|ssr|trojan):\/\//.test(item)) return "";
  let title = "";
  try {
    const hashIndex = item.indexOf("#");
    if (hashIndex >= 0) {
      title = decodeURIComponent(item.slice(hashIndex + 1));
    }
  } catch {
    title = "";
  }
  return title || item.slice(0, 80);
}

function parseYamlProxyNames(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  const seen = new Set();
  let inProxies = false;
  let inProxyItem = false;
  let proxyItemIndent = -1;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!inProxies) {
      if (/^proxies\s*:\s*$/i.test(trimmed)) inProxies = true;
      continue;
    }

    const newTopLevel = rawLine.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (newTopLevel && !rawLine.startsWith(" ") && !rawLine.startsWith("-")) break;

    const itemMatch = rawLine.match(/^(\s*)-\s*(.*)$/);
    if (itemMatch) {
      inProxyItem = true;
      proxyItemIndent = itemMatch[1].length;
      const inline = String(itemMatch[2] || "").trim();
      const inlineName = inline.match(/^name\s*:\s*(.+)\s*$/);
      if (!inlineName) continue;
      let name = String(inlineName[1] || "").trim();
      if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
        name = name.slice(1, -1);
      }
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      continue;
    }

    if (!inProxyItem) continue;
    const indent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= proxyItemIndent) {
      inProxyItem = false;
      proxyItemIndent = -1;
      continue;
    }

    const match = rawLine.match(/^\s*name\s*:\s*(.+)\s*$/);
    if (!match) continue;
    let name = String(match[1] || "").trim();
    if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }

  return out;
}

function parseJsonServerEntries(text) {
  const out = [];
  const seen = new Set();
  const pushEntry = (name, uri = "") => {
    const safeName = String(name || "").trim();
    const safeUri = String(uri || "").trim();
    if (!safeName) return;
    const key = `${safeName}|${safeUri}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: safeName, uri: safeUri });
  };

  function visit(node, parentName = "") {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentName);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && /^(vmess|vless|ss|ssr|trojan):\/\//.test(node.trim())) {
        pushEntry(decodeUriTitle(node), node);
      }
      return;
    }

    if (typeof node.uri === "string" && /^(vmess|vless|ss|ssr|trojan):\/\//.test(node.uri.trim())) {
      pushEntry(node.name || decodeUriTitle(node.uri), node.uri);
    }
    if (typeof node.url === "string" && /^(vmess|vless|ss|ssr|trojan):\/\//.test(node.url.trim())) {
      pushEntry(node.name || decodeUriTitle(node.url), node.url);
    }
    if (typeof node.name === "string" && !Array.isArray(node.proxies) && !Array.isArray(node.outbounds)) {
      pushEntry(node.name, "");
    }

    if (Array.isArray(node.proxies)) {
      for (const proxy of node.proxies) {
        if (proxy && typeof proxy === "object" && typeof proxy.name === "string") {
          pushEntry(proxy.name, proxy.uri || proxy.url || "");
        }
      }
    }

    if (Array.isArray(node.outbounds)) {
      const baseName = String(node.remarks || parentName || "").trim();
      for (const outbound of node.outbounds) {
        if (!outbound || typeof outbound !== "object") continue;
        const protocol = String(outbound.protocol || outbound.type || "").trim().toLowerCase();
        if (!["vless", "vmess", "ss", "ssr", "trojan"].includes(protocol)) continue;
        const tag = String(outbound.tag || outbound.name || protocol).trim();
        const name = [baseName, tag].filter(Boolean).join(" ").trim() || tag || protocol;
        pushEntry(name, "");
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value, String(node.remarks || parentName || "").trim());
    }
  }

  try {
    visit(JSON.parse(String(text || "")));
  } catch {
    return [];
  }

  return out;
}

function parseServerEntriesFromText(rawText) {
  const text = String(rawText || "");
  if (!text.trim()) return [];
  const out = [];
  const seen = new Set();
  const pushEntry = (name, uri = "") => {
    const safeName = String(name || "").trim();
    const safeUri = String(uri || "").trim();
    if (!safeName) return;
    const key = `${safeName}|${safeUri}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: safeName, uri: safeUri });
  };

  const format = detectSourceFormat(text);
  if (format === "yml") {
    for (const name of parseYamlProxyNames(text)) {
      pushEntry(name, "");
    }
    return out;
  }
  if (format === "json") {
    return parseJsonServerEntries(text);
  }

  const decoded = decodeBase64IfNeeded(text);
  for (const line of decoded.split(/\r?\n/)) {
    const uri = line.trim();
    if (!/^(vmess|vless|ss|ssr|trojan):\/\//.test(uri)) continue;
    pushEntry(decodeUriTitle(uri), uri);
  }
  return out;
}

function parseServersFromText(rawText) {
  return parseServerEntriesFromText(rawText).map((entry) => entry.name);
}

function normalizeOutputFormatToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (token.startsWith("raw")) return "raw";
  if (token.startsWith("json")) return "json";
  if (token === "yaml" || token.startsWith("yml")) return "yml";
  return "";
}

function sanitizeHeaderMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || "").trim().toLowerCase();
    if (!k) continue;
    out[k] = String(value ?? "");
  }
  return out;
}

function decodeMaybeBase64Header(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("base64:")) return raw;
  try {
    return Buffer.from(raw.slice(7), "base64").toString("utf8").trim();
  } catch {
    return raw;
  }
}

function parseContentDispositionFilename(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const utf8 = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      return utf8[1].trim();
    }
  }
  const simple = raw.match(/filename\s*=\s*\"?([^\";]+)\"?/i);
  return simple?.[1] ? String(simple[1]).trim() : "";
}

function parseSubscriptionUserinfo(value) {
  const out = { upload: 0, download: 0, total: 0, expire: 0 };
  const raw = String(value || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=").map((x) => String(x || "").trim().toLowerCase());
    if (!k) continue;
    const n = Number(v || "0");
    if (!Number.isFinite(n)) continue;
    if (k === "upload") out.upload = Math.max(0, n);
    if (k === "download") out.download = Math.max(0, n);
    if (k === "total") out.total = Math.max(0, n);
    if (k === "expire") out.expire = Math.max(0, n);
  }
  return out;
}

function firstHeaderString(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0] || "").trim() : "";
  }
  return String(value || "").trim();
}

function detectClientIp(req) {
  const xff = firstHeaderString(req.headers["x-forwarded-for"]);
  if (xff) return xff.split(",")[0].trim();
  const xri = firstHeaderString(req.headers["x-real-ip"]);
  if (xri) return xri;
  return String(req.socket?.remoteAddress || "").trim();
}

function resolveRawRequestHwid(reqUrl, reqHeaders, shortParams) {
  const fromQuery = String(reqUrl.searchParams.get("hwid") || "").trim();
  const fromHeader = firstHeaderString(reqHeaders["x-hwid"]);
  const fromShort = String(shortParams?.hwid || "").trim();
  const value = fromQuery || fromHeader || fromShort;
  return value.slice(0, 256);
}

function resolveRawClientInfo(req, reqUrl, shortParams) {
  const headers = sanitizeHeaderMap(req.headers || {});
  const hwid = resolveRawRequestHwid(reqUrl, req.headers || {}, shortParams);
  return {
    hwid,
    info: {
      ip: detectClientIp(req),
      userAgent: firstHeaderString(req.headers["user-agent"]),
      deviceModel: firstHeaderString(req.headers["x-device-model"]) || firstHeaderString(req.headers["sec-ch-ua-model"]),
      deviceOs: firstHeaderString(req.headers["x-device-os"]) || firstHeaderString(req.headers["sec-ch-ua-platform"]),
      app: String(reqUrl.searchParams.get("app") || shortParams?.app || headers["x-app"] || "").trim(),
      device: String(reqUrl.searchParams.get("device") || shortParams?.device || headers["x-device"] || "").trim(),
      acceptLanguage: firstHeaderString(req.headers["accept-language"]),
    },
  };
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(2)} ${units[idx]}`;
}

/**
 * Пинг серверов подписки.
 *
 * Клиента протоколов у панели нет, поэтому меряем то же, что меряет телефон до
 * поднятия туннеля: DNS, TCP-рукопожатие и TLS до самой точки входа. Этого
 * хватает, чтобы понять, жив ли сервер и далеко ли он, — но это не скорость
 * внутри туннеля.
 */
async function handlePing(req, res) {
  try {
    const body = await readJsonBody(req, 1024 * 1024);
    const mode = String(body?.mode || "tcp");
    const attempts = Number(body?.attempts || 1);
    const timeoutMs = Number(body?.timeoutMs || 3000);

    let targets = Array.isArray(body?.targets) ? body.targets : [];
    if (targets.length === 0) {
      const params = {};
      const source = body && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
      for (const key of [...PARAM_KEYS, "endpoint"]) {
        if (source[key] === undefined || source[key] === null) continue;
        params[key] = String(source[key]).trim();
      }
      if (!params.sub_url) {
        sendJson(res, 400, { ok: false, error: "sub_url or targets are required" });
        return;
      }
      const requestUrl = new URL("http://localhost/sub");
      for (const [k, v] of Object.entries(params)) {
        if (v) requestUrl.searchParams.set(k, v);
      }
      const config = resolveRequestConfig(requestUrl, {});
      if (!config.ok) {
        sendJson(res, config.status || 400, { ok: false, error: config.error || "invalid request" });
        return;
      }
      const fetched = await fetchWithNode(config.subUrl, config.forwardHeaders);
      const normalized = buildNormalizedModelFromSource(
        fetched.body,
        fetched.responseHeaders?.["content-type"] || "",
      );
      targets = [];
      for (const entry of normalized.model.entries) {
        if (entry.enabled === false) continue;
        for (const node of entry.nodes) {
          if (!node.endpoint?.host) continue;
          targets.push({
            id: node.id || `${entry.id}:${targets.length}`,
            name: node.name || entry.name,
            host: node.endpoint.host,
            port: node.endpoint.port || 443,
            sni: node.security?.sni || "",
          });
        }
      }
    }

    const result = await pingTargets({ targets, mode, attempts, timeoutMs });
    if (!result.ok) {
      sendJson(res, result.status || 400, result);
      return;
    }
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "ping failed" });
  }
}

async function handleSubscriptionTest(req, res) {
  try {
    const body = await readJsonBody(req, 1024 * 1024);
    const params = {};
    const source = body && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : body;
    for (const key of [...PARAM_KEYS, "endpoint"]) {
      if (source[key] === undefined || source[key] === null) continue;
      params[key] = String(source[key]).trim();
    }
    if (!params.output) params.output = "yml";
    if (!params.endpoint) params.endpoint = "last";

    const requestUrl = new URL("http://localhost/sub");
    for (const [k, v] of Object.entries(params)) {
      if (v) requestUrl.searchParams.set(k, v);
    }
    const reqHeaders = sanitizeHeaderMap(body?.headers || body?.forwardHeaders || {});
    const config = resolveRequestConfig(requestUrl, reqHeaders);
    if (!config.ok) {
      sendJson(res, config.status || 400, { ok: false, error: config.error || "invalid request" });
      return;
    }

    const { subUrl, output, profileNames, forwardHeaders, app, device, clashGroups } = config;
    if (!subUrl) {
      sendJson(res, 400, { ok: false, error: "sub_url is required" });
      return;
    }

    const fetched = await fetchWithNode(subUrl, forwardHeaders);
    const produced = await produceOutput(fetched.body, output, { app, clashGroups });

    const key = cacheKey(subUrl, output, profileNames.join(","));
    const cachePath = cachePathForKey(key);
    const cacheMetaPath = cacheMetaPathForKey(key);
    const cacheExists = fs.existsSync(cachePath);
    let cacheBytes = 0;
    let cacheBody = "";
    let cacheMeta = null;
    if (cacheExists) {
      try {
        const raw = fs.readFileSync(cachePath);
        cacheBytes = raw.length;
        cacheBody = raw.toString("utf8");
      } catch {
        cacheBytes = 0;
        cacheBody = "";
      }
    }
    if (fs.existsSync(cacheMetaPath)) {
      try {
        cacheMeta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
      } catch {
        cacheMeta = null;
      }
    }

    let cacheValidation = { ok: false, error: "cache not found" };
    if (cacheExists && cacheBody) {
      const check = await produceOutput(cacheBody, output, { app, clashGroups });
      if (check.ok) {
        cacheValidation = {
          ok: true,
          contentType: check.contentType,
          conversion: check.conversion,
          detectedFormat: detectSourceFormat(cacheBody, check.contentType),
          servers: parseServersFromText(check.body).slice(0, 200),
        };
      } else {
        cacheValidation = { ok: false, error: check.error || "cache conversion failed" };
      }
    }

    const sourceFormat = detectSourceFormat(
      fetched.body,
      fetched.responseHeaders?.["content-type"] || fetched.responseHeaders?.["Content-Type"] || "",
    );
    const upstreamServers = parseServersFromText(fetched.body).slice(0, 200);
    const response = {
      ok: true,
      request: {
        endpoint: params.endpoint === "sub" ? "sub" : "last",
        subUrl,
        output,
        app,
        device,
        profiles: profileNames,
      },
      headers: {
        custom: reqHeaders,
        forwarded: forwardHeaders,
        upstream: fetched.responseHeaders || {},
      },
      upstream: {
        status: fetched.responseStatus,
        url: fetched.responseUrl,
        bodyBytes: Buffer.byteLength(String(fetched.body || ""), "utf8"),
        sourceFormat,
        servers: upstreamServers,
        body: String(fetched.body || ""),
      },
      conversion: produced.ok
        ? {
            ok: true,
            contentType: produced.contentType,
            conversion: produced.conversion,
            outputFormat: detectSourceFormat(produced.body, produced.contentType),
            servers: parseServersFromText(produced.body).slice(0, 200),
            body: String(produced.body || ""),
          }
        : {
            ok: false,
            error: produced.error || "conversion failed",
            body: "",
          },
      cache: {
        key,
        exists: cacheExists,
        path: cachePath,
        metaPath: cacheMetaPath,
        bytes: cacheBytes,
        meta: cacheMeta,
        bodySha1: cacheBody ? sha1(cacheBody) : "",
        validation: cacheValidation,
      },
    };
    sendJson(res, 200, response);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "subscription test failed" });
  }
}

async function handleCreateShortLink(req, res) {
  try {
    const state = await getAuthState(req);
    const body = await readJsonBody(req);
    const picked = {};
    for (const key of PARAM_KEYS) {
      if (body[key] !== undefined) picked[key] = body[key];
    }
    const created = await createShortLink({
      params: picked,
      title: body?.title,
      ownerUsername: state.user?.username || "",
      id: body?.id ?? body?.shortId ?? body?.slug,
      hidden: Boolean(body?.hidden),
      tags: body?.tags,
    });
    if (!created.ok) {
      sendJson(res, created.status || 400, created);
      return;
    }
    sendJson(res, 201, {
      ok: true,
      link: created.link,
      urls: shortLinkPublicUrls(req, created.link.id, created.link.params),
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleUpdateShortLink(req, res, id) {
  try {
    const state = await getAuthState(req);
    const body = await readJsonBody(req);
    const picked = {};
    for (const key of PARAM_KEYS) {
      if (body[key] !== undefined) picked[key] = body[key];
    }
    const updated = await updateShortLink(id, {
      params: sanitizeParams(picked),
      title: body?.title,
      id: body?.id ?? body?.shortId ?? body?.slug,
      hidden: body?.hidden === undefined ? undefined : Boolean(body.hidden),
      tags: body?.tags,
    }, authActorFromState(state));
    if (!updated.ok) {
      sendJson(res, updated.status || 400, updated);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      link: updated.link,
      urls: shortLinkPublicUrls(req, updated.link.id, updated.link.params),
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleGetShortLink(req, res, id) {
  const state = await getAuthState(req);
  const found = await getShortLink(id, authActorFromState(state));
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    link: found.link,
    permissions: found.permissions,
    urls: shortLinkPublicUrls(req, found.link.id, found.link.params),
  });
}

function buildFeedKeyFromShortLinkParams(params) {
  const requestUrl = new URL("http://localhost/sub");
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    requestUrl.searchParams.set(key, String(value));
  }
  const config = resolveRequestConfig(requestUrl, {});
  if (!config.ok) throw new Error(config.error || "invalid request config");
  return buildSubscriptionFeedKey({
    subUrl: config.subUrl,
    app: config.app,
    device: config.device,
    profiles: config.profileNames,
    hwid: String(config.forwardHeaders?.["x-hwid"] || "").trim(),
  });
}

async function handleGetShortLinkOverrides(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "view");
  if (!access) return;
  try {
    const found = { link: access.permission.link };
    const feedKey = buildFeedKeyFromShortLinkParams(found.link.params || {});
    const feed = await getSubscriptionFeedByKey(feedKey);
    const overrides = feed ? await getSubscriptionOverridesForFeed(feed.id) : null;
    sendJson(res, 200, {
      ok: true,
      shortLinkId: found.link.id,
      feed: feed ? {
        id: feed.id,
        feedKey: feed.feedKey,
        subUrl: feed.subUrl,
        app: feed.app,
        device: feed.device,
        profileNames: feed.profileNames,
        hwid: feed.hwid,
      } : null,
      overrides: overrides ? overrides.overrides : {},
      overrideVersion: overrides?.version || 0,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to resolve overrides" });
  }
}

async function handlePutShortLinkOverrides(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "edit");
  if (!access) return;
  try {
    const found = { link: access.permission.link };
    const feedKey = buildFeedKeyFromShortLinkParams(found.link.params || {});
    const configUrl = new URL("http://localhost/sub");
    for (const [key, value] of Object.entries(found.link.params || {})) {
      if (value === undefined || value === null || value === "") continue;
      configUrl.searchParams.set(key, String(value));
    }
    const config = resolveRequestConfig(configUrl, {});
    if (!config.ok) {
      sendJson(res, config.status || 400, { ok: false, error: config.error || "invalid request config" });
      return;
    }
    const feed = await getSubscriptionFeedByKey(feedKey) || await upsertSubscriptionFeed({
      feedKey,
      subUrl: config.subUrl,
      app: config.app,
      device: config.device,
      profiles: config.profileNames,
      hwid: String(config.forwardHeaders?.["x-hwid"] || "").trim(),
    });
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const overrides = body?.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
      ? body.overrides
      : {};
    const saved = await upsertSubscriptionOverrides(feed.id, overrides);
    sendJson(res, 200, {
      ok: true,
      shortLinkId: found.link.id,
      feed: {
        id: feed.id,
        feedKey: feed.feedKey,
      },
      overrides: saved.overrides,
      overrideVersion: saved.version,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to save overrides" });
  }
}

async function handlePreviewShortLinkOverrides(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "view");
  if (!access) return;
  try {
    const found = { link: access.permission.link };
    const params = found.link.params || {};
    const body = await readJsonBody(req, 512 * 1024);
    const overrides = body?.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
      ? body.overrides
      : {};
    const configUrl = new URL("http://localhost/sub");
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") continue;
      configUrl.searchParams.set(key, String(value));
    }
    const config = resolveRequestConfig(configUrl, {});
    if (!config.ok) {
      sendJson(res, config.status || 400, { ok: false, error: config.error || "invalid request config" });
      return;
    }
    let bundle = await loadLatestStoredSnapshotBundle({
      subUrl: config.subUrl,
      app: config.app,
      device: config.device,
      profileNames: config.profileNames,
      forwardHeaders: config.forwardHeaders,
    });
    if (!bundle?.normalizedSnapshot?.normalizedPath) {
      const fetched = await fetchWithNode(config.subUrl, config.forwardHeaders);
      await persistSuccessfulSourceSnapshot({
        subUrl: config.subUrl,
        app: config.app,
        device: config.device,
        profileNames: config.profileNames,
        forwardHeaders: config.forwardHeaders,
        fetched,
        route: "/api/short-links/:id/overrides/preview",
        requestedOutput: normalizeOutput(String(params.output || "yml")) || "clash",
        requesterId: `short-link-preview:${found.link.id}`,
      });
      bundle = await loadLatestStoredSnapshotBundle({
        subUrl: config.subUrl,
        app: config.app,
        device: config.device,
        profileNames: config.profileNames,
        forwardHeaders: config.forwardHeaders,
      });
    }
    if (!bundle?.normalizedSnapshot?.normalizedPath) {
      sendJson(res, 404, { ok: false, error: "no stored snapshot available for preview" });
      return;
    }
    const output = normalizeOutput(String(params.output || "yml")) || "clash";
    const normalized = JSON.parse(fs.readFileSync(bundle.normalizedSnapshot.normalizedPath, "utf8"));
    const effective = applyOverridesToNormalized(normalized, overrides);
    const rendered = await renderOutputFromNormalized(effective, output, { app: String(params.app || "") });
    if (!rendered.ok) {
      sendJson(res, 400, { ok: false, error: rendered.error || "preview render failed" });
      return;
    }
    const previewBody = String(rendered.body || "");
    sendJson(res, 200, {
      ok: true,
      output,
      contentType: rendered.contentType || "",
      conversion: rendered.conversion || "",
      servers: parseServersFromText(previewBody).slice(0, 200),
      body: previewBody,
      bodyBytes: Buffer.byteLength(previewBody, "utf8"),
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to render preview" });
  }
}

async function handleCreateLocalSource(req, res) {
  try {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const created = createLocalSource(body || {});
    if (!created.ok) {
      sendJson(res, created.status || 400, created);
      return;
    }
    sendJson(res, 201, {
      ok: true,
      source: created.source,
      subUrl: `local:${created.source.id}`,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleGetMergedSource(req, res, id) {
  const found = getMergedSource(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  sendJson(res, 200, { ok: true, source: found.source, subUrl: `merge:${found.source.id}` });
}

async function handleUpdateMergedSource(req, res, id) {
  try {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const updated = updateMergedSource(id, body || {});
    if (!updated.ok) {
      sendJson(res, updated.status || 400, updated);
      return;
    }
    sendJson(res, 200, { ok: true, source: updated.source, subUrl: `merge:${updated.source.id}` });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

/** Имена серверов каждого источника — для проверки регулярок в окне объединения. */
async function handlePreviewMergedSource(req, res) {
  try {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const items = Array.isArray(body?.items) ? body.items.slice(0, 40) : [];
    const results = await previewMergeItems(items);
    sendJson(res, 200, { ok: true, results });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleCreateMergedSource(req, res) {
  try {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const created = createMergedSource(body || {});
    if (!created.ok) {
      sendJson(res, created.status || 400, created);
      return;
    }
    sendJson(res, 201, {
      ok: true,
      source: created.source,
      subUrl: `merge:${created.source.id}`,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleGetLocalSource(req, res, id) {
  const found = getLocalSource(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  sendJson(res, 200, { ok: true, source: found.source, subUrl: `local:${found.source.id}` });
}

async function handleParseBulkImport(req, res) {
  try {
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const text = String(body?.text || "");
    const items = parseBulkProxyText(text);
    sendJson(res, 200, { ok: true, items });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleHappDecrypt(req, res) {
  try {
    const body = await readJsonBody(req, 256 * 1024);
    const subUrl = String(body?.subUrl || body?.sub_url || "").trim();
    if (!subUrl) {
      sendJson(res, 400, { ok: false, error: "subUrl is required" });
      return;
    }
    const result = await decryptHappLink(subUrl);
    sendJson(res, 200, {
      ok: true,
      originalUrl: result.originalUrl,
      resolvedUrl: result.resolvedUrl,
      changed: result.changed,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "happ decrypt failed" });
  }
}

async function handleGetShortLinkUsers(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "view");
  if (!access) return;
  try {
    const data = await listShortLinkUsers(access.permission.link.id);
    sendJson(res, 200, { ok: true, users: data });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "failed to load short link users" });
  }
}

async function handleUpdateShortLinkUsersPolicy(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "edit");
  if (!access) return;
  try {
    const body = await readJsonBody(req);
    const updated = await updateShortLinkUserPolicy(access.permission.link.id, {
      maxUsers: body?.maxUsers,
      blockedMessage: body?.blockedMessage,
      limitMessage: body?.limitMessage,
    });
    sendJson(res, 200, { ok: true, policy: updated });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to update policy" });
  }
}

async function handleUpdateShortLinkUser(req, res, id, hwidToken) {
  const access = await requireShortLinkPermission(req, res, id, "edit");
  if (!access) return;
  let hwid = "";
  try {
    hwid = decodeURIComponent(String(hwidToken || ""));
  } catch {
    hwid = String(hwidToken || "");
  }
  try {
    const body = await readJsonBody(req);
    const updated = await setShortLinkUserBlocked(
      access.permission.link.id,
      hwid,
      Boolean(body?.blocked),
      String(body?.blockReason || ""),
    );
    if (!updated) {
      sendJson(res, 404, { ok: false, error: "user not found" });
      return;
    }
    sendJson(res, 200, { ok: true, user: updated });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to update user" });
  }
}

async function handleDeleteShortLinkUser(req, res, id, hwidToken) {
  const access = await requireShortLinkPermission(req, res, id, "edit");
  if (!access) return;
  let hwid = "";
  try {
    hwid = decodeURIComponent(String(hwidToken || ""));
  } catch {
    hwid = String(hwidToken || "");
  }
  try {
    await deleteShortLinkUser(access.permission.link.id, hwid);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to delete user" });
  }
}

async function handlePublicShortLink(req, res, id) {
  const found = await getPublicShortLink(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    link: found.link,
    urls: shortLinkPublicUrls(req, found.link.id, found.link.params),
  });
}

async function handlePublicShortLinkMeta(req, res, id) {
  const found = await getPublicShortLink(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  try {
    const params = found.link.params || {};
    const requestUrl = new URL("http://localhost/sub");
    for (const [k, v] of Object.entries(params)) {
      if (!v) continue;
      requestUrl.searchParams.set(k, String(v));
    }
    const typeOverride = resolveShortLinkTypeOverride(new URL(req.url || "/", "http://localhost"));
    if (typeOverride) requestUrl.searchParams.set("output", typeOverride);
    const config = resolveRequestConfig(requestUrl, {});
    if (!config.ok) {
      sendJson(res, config.status || 400, { ok: false, error: config.error || "invalid request config" });
      return;
    }

    const fetched = await fetchWithNode(config.subUrl, config.forwardHeaders);
    const upstreamHeaders = fetched.responseHeaders || {};
    const userinfo = parseSubscriptionUserinfo(
      upstreamHeaders["subscription-userinfo"] || upstreamHeaders["Subscription-Userinfo"] || "",
    );
    const expireAt = userinfo.expire > 0 ? userinfo.expire * 1000 : 0;
    const now = Date.now();
    const daysLeft = expireAt > 0 ? Math.ceil((expireAt - now) / (1000 * 60 * 60 * 24)) : 0;
    const active = expireAt <= 0 || expireAt > now;
    const providerName = decodeMaybeBase64Header(
      upstreamHeaders["profile-title"] ||
      upstreamHeaders["Profile-Title"] ||
      "",
    ) || String(
      upstreamHeaders.provider ||
      upstreamHeaders.Provider ||
      "",
    ).trim() || "Неизвестный провайдер";
    const userName = parseContentDispositionFilename(
      upstreamHeaders["content-disposition"] || upstreamHeaders["Content-Disposition"] || "",
    ) || found.link.id;
    const sourceFormat = detectSourceFormat(
      fetched.body,
      upstreamHeaders["content-type"] || upstreamHeaders["Content-Type"] || "",
    );
    const servers = parseServersFromText(fetched.body);
    let serverEntries = parseServerEntriesFromText(fetched.body);
    if (serverEntries.length === 0 || serverEntries.every((row) => !row.uri)) {
      const convertedRaw = await produceOutput(fetched.body, "raw");
      if (convertedRaw.ok) {
        const convertedEntries = parseServerEntriesFromText(convertedRaw.body);
        if (convertedEntries.length > 0) {
          serverEntries = convertedEntries;
        }
      }
    }
    const used = Math.max(0, userinfo.upload + userinfo.download);
    const totalText = userinfo.total > 0 ? humanBytes(userinfo.total) : "∞";
    const trafficText = `${humanBytes(used)} / ${totalText}`;
    const forwardHeaders = sanitizeHeaderMap(config.forwardHeaders || {});
    const deviceModel =
      String(
        forwardHeaders["x-device-model"] ||
        forwardHeaders["sec-ch-ua-model"] ||
        config.device ||
        "",
      ).trim();
    const userAgent = String(forwardHeaders["user-agent"] || "").trim();

    sendJson(res, 200, {
      ok: true,
      meta: {
        providerName,
        userName,
        active,
        statusText: active ? "Активна" : "Истекла",
        expiresAt: expireAt || null,
        daysLeft: expireAt > 0 ? daysLeft : null,
        trafficText,
        usedBytes: used,
        totalBytes: userinfo.total,
        provider: String(upstreamHeaders.provider || upstreamHeaders.Provider || ""),
        sourceFormat,
        sourceFormatToken: normalizeOutputFormatToken(sourceFormat),
        serversCount: servers.length,
        serverEntries: serverEntries.slice(0, 300),
        app: config.app || "",
        device: config.device || "",
        deviceModel,
        userAgent,
        profiles: config.profileNames || [],
      },
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "meta fetch failed" });
  }
}

function wantsHtmlSharePage(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  return accept.includes("text/html");
}

function resolveShortLinkTypeOverride(reqUrl) {
  const type = String(reqUrl?.searchParams?.get("type") || "").trim().toLowerCase();
  if (type === "raw") return "raw";
  if (type === "yml" || type === "yaml" || type === "clash") return "yml";
  return "";
}

/**
 * Формат, в котором короткая ссылка отдаёт подписку прямо сейчас.
 *
 * Повторяет выбор обычного резолва: `?type=` сильнее всего, дальше сохранённый
 * в ссылке формат, а при `output_auto` формат подбирается по User-Agent.
 * Нужен до похода в апстрим — чтобы ответ-заглушку отдать в том же виде,
 * которого ждёт приложение.
 */
function resolveShortLinkOutput(req, reqUrl, params, typeOverride) {
  if (typeOverride) return normalizeOutput(typeOverride) || OUTPUT_DEFAULT;
  const stored = normalizeOutput(String(params?.output || "")) || OUTPUT_DEFAULT;
  const autoRaw = String(params?.output_auto || "").trim().toLowerCase();
  const auto = autoRaw === "1" || autoRaw === "true" || autoRaw === "yes" || autoRaw === "on";
  const userAgent = String(firstHeaderString(req.headers["user-agent"]) || "").trim();
  if (!auto || !userAgent) return stored;
  return resolveOutputFromUserAgent(userAgent, stored).output || stored;
}

async function handleShortLinkResolve(req, res, id) {
  const found = await getPublicShortLink(id);
  if (!found.ok) {
    res.writeHead(found.status || 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(found.error || "short link not found");
    return;
  }

  try {
    const reqUrl = new URL(req.url || "/", "http://localhost");
    const client = resolveRawClientInfo(req, reqUrl, found.link.params || {});
    const visit = await recordShortLinkUserVisit(found.link.id, client.hwid, client.info);
    if (!visit.ok && (visit.code === "blocked" || visit.code === "limit")) {
      const message = String(visit.message || "Доступ к подписке ограничен");
      const typeOverride = resolveShortLinkTypeOverride(reqUrl);
      // Браузеру показываем причину страницей, приложению — подпиской из одного
      // узла: текст встанет именем сервера и человек прочитает его в клиенте.
      if (!typeOverride && wantsHtmlSharePage(req)) {
        sendProblemPage(res, 403, visit.code === "limit" ? "Лимит устройств" : "Доступ ограничен", message);
        return;
      }
      const output = resolveShortLinkOutput(req, reqUrl, found.link.params || {}, typeOverride);
      const notice = renderAccessNotice(message, output);
      res.writeHead(200, { "Content-Type": notice.contentType, "Cache-Control": "no-store" });
      res.end(notice.body);
      return;
    }
    // Ссылка с лимитом устройств без hwid бессмысленна: посчитать такое
    // подключение не во что, и лимит обходится одним запросом без заголовка.
    // Страницу подключения при этом не трогаем — её открывают из браузера,
    // где hwid взяться неоткуда.
    if (visit.skipped && visit.reason === "empty hwid" && Number(visit.policy?.maxUsers || 0) > 0) {
      const typeOverride = resolveShortLinkTypeOverride(reqUrl);
      if (typeOverride || !wantsHtmlSharePage(req)) {
        const message = String(visit.policy?.blockedMessage || "Доступ к подписке ограничен");
        sendProblemPage(res, 403, "Нужен идентификатор устройства", message);
        return;
      }
    }
  } catch (e) {
    console.error("[WARN] short-link user tracking failed:", e?.message || e);
  }

  await incrementShortLinkHits(found.link.id);

  const reqUrl = new URL(req.url || "/", "http://localhost");
  const typeOverride = resolveShortLinkTypeOverride(reqUrl);
  if (!typeOverride && wantsHtmlSharePage(req)) {
    if (!serveFrontendIndex(res)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHomePage());
    }
    return;
  }

  const endpoint = found.link.params.endpoint === "sub" ? "/sub" : "/last";
  const params = { ...(found.link.params || {}) };
  try {
    if (typeOverride) params.output = typeOverride;
  } catch {
    // ignore malformed query and keep original params
  }
  const qs = buildQueryFromParams(params).toString();
  const originalUrl = req.url;
  req.url = `${endpoint}?${qs}`;
  const handler = endpoint === "/sub" ? handleSubscription : handleLast;
  void handler(req, res).finally(() => {
    req.url = originalUrl;
  });
}

function mockSourcePublicUrls(req, id) {
  const origin = resolvePublicOrigin(req);
  return {
    id,
    sourceUrl: `${origin}/mock/${id}`,
    logsUrl: `${origin}/api/mock-sources/${id}/logs`,
  };
}

async function handleCreateMockSource(req, res) {
  try {
    const body = await readJsonBody(req);
    const state = await getAuthState(req);
    const created = createMockSource(body);
    if (!created.ok) {
      sendJson(res, created.status || 400, created);
      return;
    }
    if (state.enabled && state.user?.username) {
      const updated = updateMockSource(created.source.id, {
        ownerUsername: state.user.username,
        mode: body?.mode,
        label: body?.label,
      });
      if (updated.ok) created.source = updated.source;
    }
    sendJson(res, 201, {
      ok: true,
      source: created.source,
      urls: mockSourcePublicUrls(req, created.source.id),
      presets: listPresets(),
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleGetMockSource(req, res, id) {
  const found = getMockSource(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  const state = await getAuthState(req);
  if (!canAccessMockSource(found.source, authActorFromState(state))) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    source: {
      id: found.source.id,
      createdAt: found.source.createdAt,
      updatedAt: found.source.updatedAt,
      meta: found.source.meta || {},
      config: found.source.config,
      logsCount: Array.isArray(found.source.logs) ? found.source.logs.length : 0,
    },
    urls: mockSourcePublicUrls(req, found.source.id),
    presets: listPresets(),
  });
}

async function handleUpdateMockSource(req, res, id) {
  try {
    const state = await getAuthState(req);
    const found = getMockSource(id);
    if (!found.ok) {
      sendJson(res, found.status || 404, found);
      return;
    }
    if (!canAccessMockSource(found.source, authActorFromState(state))) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    const body = await readJsonBody(req);
    const updated = updateMockSource(id, body);
    if (!updated.ok) {
      sendJson(res, updated.status || 400, updated);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      source: updated.source,
      urls: mockSourcePublicUrls(req, updated.source.id),
      presets: listPresets(),
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleGetMockLogs(req, res, id) {
  const found = getMockSource(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  const state = await getAuthState(req);
  if (!canAccessMockSource(found.source, authActorFromState(state))) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    id: found.source.id,
    logs: Array.isArray(found.source.logs) ? found.source.logs : [],
  });
}

async function handleClearMockLogs(req, res, id) {
  const state = await getAuthState(req);
  const found = getMockSource(id);
  if (!found.ok) {
    sendJson(res, found.status || 404, found);
    return;
  }
  if (!canAccessMockSource(found.source, authActorFromState(state))) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  const cleared = clearMockLogs(id);
  if (!cleared.ok) {
    sendJson(res, cleared.status || 404, cleared);
    return;
  }
  sendJson(res, 200, { ok: true, id: cleared.source.id, logs: [] });
}

async function handleMockSourceRequest(req, res, id, reqUrl) {
  const found = getMockSource(id);
  if (!found.ok) {
    res.writeHead(found.status || 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(found.error || "mock source not found");
    return;
  }

  const source = found.source;
  const rawBody = await readRawBody(req, 1024 * 1024).catch(() => Buffer.from(""));
  const bodyText = rawBody.toString("utf8");
  const query = {};
  for (const [k, v] of reqUrl.searchParams.entries()) {
    if (query[k] === undefined) query[k] = v;
    else if (Array.isArray(query[k])) query[k].push(v);
    else query[k] = [query[k], v];
  }

  appendMockLog(id, {
    method: req.method || "GET",
    path: reqUrl.pathname,
    query,
    headers: req.headers,
    body: bodyText,
    bodyBase64: rawBody.toString("base64"),
    bodyBytes: rawBody.length,
  });

  const cfg = source.config || {};
  if (cfg.delayMs && cfg.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
  }

  const headers = {
    "Content-Type": cfg.contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...(cfg.headers && typeof cfg.headers === "object" ? cfg.headers : {}),
  };
  const status = Number(cfg.status) || 200;
  res.writeHead(status, headers);
  res.end(String(cfg.body ?? ""));
}

async function handleProfileEditorList(req, res) {
  const state = await getAuthState(req);
  sendJson(res, 200, { ok: true, catalog: await listEditorCatalog(authActorFromState(state)) });
}

async function handleProfileEditorRead(req, reqUrl, res) {
  const state = await getAuthState(req);
  const kind = reqUrl.searchParams.get("kind") || "";
  const name = reqUrl.searchParams.get("name") || "";
  const out = await readProfileForEdit(kind, name, authActorFromState(state));
  if (!out.ok) {
    sendJson(res, out.status || 400, out);
    return;
  }
  sendJson(res, 200, out);
}

async function handleProfileEditorSave(req, res) {
  try {
    const state = await getAuthState(req);
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const out = await saveProfileForEdit(body.kind, body.name, body.content, authActorFromState(state));
    if (!out.ok) {
      sendJson(res, out.status || 400, out);
      return;
    }
    sendJson(res, 200, { ...out, catalog: await listEditorCatalog(authActorFromState(state)) });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

async function handleProfileEditorDelete(req, reqUrl, res) {
  const state = await getAuthState(req);
  const kind = reqUrl.searchParams.get("kind") || "";
  const name = reqUrl.searchParams.get("name") || "";
  const out = await deleteProfileForEdit(kind, name, authActorFromState(state));
  if (!out.ok) {
    sendJson(res, out.status || 400, out);
    return;
  }
  sendJson(res, 200, { ...out, catalog: await listEditorCatalog(authActorFromState(state)) });
}

async function handleAuthMe(req, res) {
  const state = await getAuthState(req);
  const start = authStartLocation(req, "/");
  sendJson(res, 200, {
    ok: true,
    config: {
      publicBaseUrl: resolvePublicOrigin(req),
      accountUrl: accountBrowserOrigin(req),
      loginUrl: start.location,
      logoutUrl: accountLogoutLocation(req),
    },
    auth: {
      enabled: state.enabled,
      authenticated: state.authenticated,
      denied: Boolean(state.denied),
      user: state.user || null,
    },
  });
}

async function handleAuthLogin(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const start = authStartLocation(req, body?.return || "/");
  sendJson(res, 200, { ok: true, redirect: start.location }, { "Set-Cookie": start.cookie });
}

async function handleAuthLogout(req, res) {
  sendJson(
    res,
    200,
    { ok: true, redirect: accountLogoutLocation(req), auth: { enabled: true, authenticated: false, user: null } },
    { "Set-Cookie": clearSessionCookies() },
  );
}

async function handleAuthStart(req, reqUrl, res) {
  const start = authStartLocation(req, reqUrl.searchParams.get("return") || "/");
  redirect(res, start.location, { "Set-Cookie": [start.cookie, ...clearSessionCookies()] });
}

async function handleAuthCallback(req, reqUrl, res) {
  const code = String(reqUrl.searchParams.get("code") || "");
  const state = String(reqUrl.searchParams.get("state") || "");
  const cookie = String(parseCookies(req)[AUTH_STATE_COOKIE] || "");
  const [expectedState, returnEncoded = ""] = cookie.split(":");
  if (!code || !state || state !== expectedState) {
    sendAuthProblem(res, 400, "Вход не завершён", "Account вернул недействительный state. Начните вход заново.", {
      "Set-Cookie": [clearCookieValue(AUTH_STATE_COOKIE), ...clearSessionCookies()],
    });
    return;
  }
  let returnPath = "/";
  try {
    returnPath = safeReturnPath(Buffer.from(returnEncoded, "base64url").toString("utf8"));
  } catch {
    returnPath = "/";
  }
  try {
    const json = await accountRequest("/api/service/exchange", {
      method: "POST",
      service: true,
      body: {
        app: ACCOUNT_APP,
        code,
        redirectUri: `${selfOrigin(req)}/auth/callback`,
      },
    });
    const accountUser = await accountMe(json.token || "");
    const appUser = authUserFromAccount(accountUser);
    if (!appUser) {
      const login = accountUser?.login ? ` для ${accountUser.login}` : "";
      sendAuthProblem(res, 403, "Нет доступа к Sub Lab", `В account не назначена роль sub_mirror${login}.`, {
        "Set-Cookie": [clearCookieValue(AUTH_STATE_COOKIE), ...clearSessionCookies()],
      });
      return;
    }
    const expires = json.expires ? new Date(json.expires) : undefined;
    redirect(res, returnPath, {
      "Set-Cookie": [
        cookieValue(SESSION_COOKIE, json.token || "", { expires }),
        ...LEGACY_SESSION_COOKIES.map(clearCookieValue),
        clearCookieValue(AUTH_STATE_COOKIE),
      ],
    });
  } catch (e) {
    console.warn(`account callback failed: ${e?.message || e}`);
    sendAuthProblem(res, 502, "Account не подтвердил вход", e?.message || "Не удалось обменять код входа на сессию.", {
      "Set-Cookie": [clearCookieValue(AUTH_STATE_COOKIE), ...clearSessionCookies()],
    });
  }
}

/**
 * Сводная статистика для страницы «Статистика».
 *
 * Выборка подписок совпадает со списком на главной: админ видит панель целиком,
 * остальные — свои ссылки и выданные им доступы.
 */
async function handleStats(req, url, res) {
  const state = await getAuthState(req);
  if (!state.authenticated || !state.user) {
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return;
  }
  try {
    const days = Number(url?.searchParams?.get("days") || 30);
    const stats = await collectUsageStats(state.user, { days });
    sendJson(res, 200, { ok: true, stats });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "stats unavailable" });
  }
}

async function handleAdminUsersList(req, res) {
  const state = await requireAdmin(req, res);
  if (!state) return;
  try {
    const json = await accountRequest("/api/users", { token: state.token });
    const users = (Array.isArray(json.users) ? json.users : [])
      .map(accountUserForUi)
      .filter(Boolean);
    sendJson(res, 200, { ok: true, users, source: "account" });
  } catch (e) {
    sendJson(res, e?.status || 502, { ok: false, error: e?.message || "account users unavailable" });
  }
}

async function handleAdminUsersCreate(req, res) {
  const state = await requireAdmin(req, res);
  if (!state) return;
  sendJson(res, 410, { ok: false, error: "users and roles are managed in account" });
}

async function handleAdminUsersUpdate(req, res, username) {
  const state = await requireAdmin(req, res);
  if (!state) return;
  void username;
  sendJson(res, 410, { ok: false, error: "users and roles are managed in account" });
}

async function handleAdminUsersDelete(req, res, username) {
  const state = await requireAdmin(req, res);
  if (!state) return;
  void username;
  sendJson(res, 410, { ok: false, error: "users and roles are managed in account" });
}

async function handleSearchByTag(req, reqUrl, res) {
  try {
    const state = await getAuthState(req);
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const tags = normalizeTags(reqUrl.searchParams.get("tag") || body?.tag || body?.tags);
    const tag = tags[0] || "";
    if (!tag) {
      sendJson(res, 400, { ok: false, error: "tag is required" });
      return;
    }
    const rows = await listShortLinksByTagForActor(tag, authActorFromState(state));
    const subscriptions = rows.map((row) => {
      const urls = shortLinkPublicUrls(req, row.link.id, row.link.params);
      return {
        id: row.link.id,
        title: row.link.title,
        tags: row.link.tags,
        params: row.link.params,
        url: urls.shortUrl,
        shortUrl: urls.shortUrl,
        resolvedUrl: urls.resolvedUrl,
        permissions: row.permissions,
      };
    });
    sendJson(res, 200, {
      ok: true,
      tag,
      subscriptions,
      items: subscriptions,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "search failed" });
  }
}

async function handleGetShortLinkAccess(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "manage");
  if (!access) return;
  const grants = await listShortLinkAccess(id);
  sendJson(res, 200, {
    ok: true,
    shortLinkId: access.permission.link.id,
    ownerUsername: access.permission.link.ownerUsername || "",
    grants,
  });
}

async function handlePutShortLinkAccess(req, res, id) {
  const access = await requireShortLinkPermission(req, res, id, "manage");
  if (!access) return;
  try {
    const body = await readJsonBody(req);
    const ownerUsername = String(access.permission.link.ownerUsername || "").trim().toLowerCase();
    const grantsInput = Array.isArray(body?.grants) ? body.grants : [];
    const grants = grantsInput.filter((item) => String(item?.username || "").trim().toLowerCase() !== ownerUsername);
    const saved = await replaceShortLinkAccess(id, grants);
    sendJson(res, 200, {
      ok: true,
      shortLinkId: access.permission.link.id,
      ownerUsername,
      grants: saved,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to update access" });
  }
}

/** Права на запись избранного: своя строка списка, чужая короткая ссылка или потерянная. */
function favoritePermissions(permission) {
  if (!permission) {
    // Короткой ссылки больше нет: это всё ещё запись владельца списка, поэтому
    // она остаётся видимой и редактируемой — сохранение создаст ссылку заново.
    return { canView: true, canEdit: true, canManageAccess: false, accessLevel: "edit", missing: true };
  }
  return {
    canView: permission.canView,
    canEdit: permission.canEdit,
    canManageAccess: permission.canManageAccess,
    accessLevel: permission.accessLevel || "",
  };
}

/**
 * Отсев записей, к которым у пользователя нет доступа.
 *
 * Пропавшая короткая ссылка — не потеря доступа: раньше такие записи молча
 * исчезали, и восстановление резервной копии на чистой базе давало пустой
 * список. Теперь исчезает только то, что закрыл владелец.
 */
async function filterFavoritesByAccess(list, actor) {
  const input = Array.isArray(list) ? list : [];
  const output = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const shortId = String(item.shortId || "").trim();
    if (!shortId) {
      output.push({
        ...item,
        permissions: { canView: true, canEdit: true, canManageAccess: false, accessLevel: "edit" },
      });
      continue;
    }
    const permission = await getShortLinkPermissions(shortId, actor);
    if (permission && !permission.canView) continue;
    output.push({ ...item, permissions: favoritePermissions(permission) });
  }
  return output;
}

/**
 * Подписки, выданные пользователю через доступ к короткой ссылке.
 *
 * Они не хранятся в его списке — иначе наблюдатель, который ничего не создаёт,
 * видел бы пустой кабинет. Список собирается на каждый запрос и помечается
 * `derived`, чтобы сохранение его не записывало.
 */
async function grantedFavorites(req, actor, existing) {
  const username = String(actor?.username || "").trim().toLowerCase();
  if (!username) return [];
  const known = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((item) => String(item?.shortId || "").trim())
      .filter(Boolean),
  );
  const rows = await listShortLinksGrantedTo(username);
  const out = [];
  for (const row of rows) {
    if (known.has(row.link.id)) continue;
    const urls = shortLinkPublicUrls(req, row.link.id, row.link.params || {});
    out.push({
      title: row.link.title || row.link.id,
      url: urls.shortUrl,
      shortId: row.link.id,
      hidden: Boolean(row.link.hidden),
      tags: Array.isArray(row.link.tags) ? row.link.tags : [],
      payload: row.link.params || {},
      labels: [],
      ts: Date.parse(row.link.updatedAt || row.link.createdAt || "") || 0,
      derived: true,
      permissions: {
        canView: true,
        canEdit: row.accessLevel === "edit",
        canManageAccess: false,
        accessLevel: row.accessLevel || "view",
      },
    });
  }
  return out;
}

async function resolveFavoritesAccountKey(req) {
  const state = await getAuthState(req);
  if (state.enabled) return String(state.user?.username || "").trim();
  return "public";
}

/**
 * Подписки остальных пользователей — только для админа.
 *
 * Открыть чужую ссылку админ мог и раньше, но в списке её не было: приходилось
 * знать идентификатор. Отдаём такие записи отдельно и помечаем `foreign`, чтобы
 * интерфейс по умолчанию их прятал и не выдавал за свои.
 */
async function foreignFavorites(req, actor, known) {
  if (!actor || actor.role !== "admin") return [];
  const username = String(actor.username || "").trim().toLowerCase();
  const seen = new Set(
    (Array.isArray(known) ? known : [])
      .map((item) => String(item?.shortId || "").trim())
      .filter(Boolean),
  );
  const links = await listAllShortLinkRows();
  const out = [];
  for (const link of links) {
    if (!link?.id || seen.has(link.id)) continue;
    const urls = shortLinkPublicUrls(req, link.id, link.params || {});
    out.push({
      title: link.title || link.id,
      url: urls.shortUrl,
      shortId: link.id,
      hidden: Boolean(link.hidden),
      tags: Array.isArray(link.tags) ? link.tags : [],
      payload: link.params || {},
      labels: [],
      ts: Date.parse(link.updatedAt || link.createdAt || "") || 0,
      // derived: в свой список такие записи не сохраняются, иначе чужая
      // подписка осела бы у админа при первом же сохранении.
      derived: true,
      foreign: link.ownerUsername !== username,
      ownerUsername: link.ownerUsername || "",
      permissions: {
        canView: true,
        canEdit: true,
        canManageAccess: true,
        accessLevel: "edit",
      },
    });
  }
  return out;
}

async function handleFavoritesGet(req, res) {
  const key = await resolveFavoritesAccountKey(req);
  if (!key) {
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return;
  }
  const state = await getAuthState(req);
  const actor = authActorFromState(state);
  const own = await filterFavoritesByAccess(await getFavoritesRow(key), actor);
  const shared = await grantedFavorites(req, actor, own);
  const foreign = await foreignFavorites(req, actor, [...own, ...shared]);
  sendJson(res, 200, { ok: true, favorites: [...own, ...shared, ...foreign] });
}

async function handleFavoritesPut(req, res) {
  const key = await resolveFavoritesAccountKey(req);
  if (!key) {
    sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
    return;
  }
  try {
    const state = await getAuthState(req);
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const actor = authActorFromState(state);
    const incoming = Array.isArray(body?.favorites) ? body.favorites : [];
    // Выданные подписки собираются на лету, в чужом списке их хранить нечего.
    const own = incoming.filter((item) => !item?.derived);
    const saved = await setFavoritesRow(key, await filterFavoritesByAccess(own, actor));
    const shared = await grantedFavorites(req, actor, saved);
    const foreign = await foreignFavorites(req, actor, [...saved, ...shared]);
    sendJson(res, 200, { ok: true, favorites: [...saved, ...shared, ...foreign] });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "invalid request" });
  }
}

/**
 * Восстановление списка подписок из резервной копии.
 *
 * Копия хранит и короткие ссылки. Если их в базе уже нет — например, копию
 * переносят на чистую установку, — ссылки создаются заново с теми же
 * идентификаторами, иначе восстановленный список указывал бы в никуда.
 */
async function handleFavoritesRestore(req, res) {
  const state = await requireEditorAuth(req, res);
  if (!state) return;
  const key = String(state.user?.username || "").trim() || "public";
  try {
    const body = await readJsonBody(req, 8 * 1024 * 1024);
    const items = Array.isArray(body?.favorites) ? body.favorites : (Array.isArray(body?.items) ? body.items : []);
    const actor = authActorFromState(state);
    const restored = [];
    const report = { total: items.length, created: 0, kept: 0, skipped: 0, skippedTitles: [] };
    for (const item of items) {
      if (!item || typeof item !== "object" || item.derived) continue;
      const shortId = String(item.shortId || "").trim();
      const params = { ...(item.payload || {}) };
      if (!shortId) {
        restored.push({ ...item, permissions: undefined });
        report.kept += 1;
        continue;
      }
      const existing = await getShortLinkRow(shortId);
      if (existing) {
        const permission = await getShortLinkPermissions(shortId, actor);
        if (!permission?.canView) {
          report.skipped += 1;
          report.skippedTitles.push(String(item.title || shortId));
          continue;
        }
        const urls = shortLinkPublicUrls(req, existing.id, existing.params || {});
        restored.push({ ...item, url: urls.shortUrl, permissions: undefined });
        report.kept += 1;
        continue;
      }
      const created = await createShortLink({
        id: shortId,
        params,
        title: String(item.title || ""),
        ownerUsername: actor.username,
        hidden: Boolean(item.hidden),
        tags: Array.isArray(item.tags) ? item.tags : [],
      });
      if (!created.ok) {
        report.skipped += 1;
        report.skippedTitles.push(String(item.title || shortId));
        continue;
      }
      const urls = shortLinkPublicUrls(req, created.link.id, created.link.params || {});
      restored.push({ ...item, url: urls.shortUrl, permissions: undefined });
      report.created += 1;
    }
    const saved = await setFavoritesRow(key, await filterFavoritesByAccess(restored, actor));
    const shared = await grantedFavorites(req, actor, saved);
    const foreign = await foreignFavorites(req, actor, [...saved, ...shared]);
    sendJson(res, 200, { ok: true, favorites: [...saved, ...shared, ...foreign], report });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "restore failed" });
  }
}

function normalizeRemoteSyncUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("remoteUrl is required");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("remoteUrl must use http or https");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

async function handleSyncExport(req, res) {
  if (!requireSyncToken(req, res)) return;
  try {
    const bundle = await exportSyncBundle({
      profiles: String(new URL(req.url || "/", "http://localhost").searchParams.get("profiles") || "1") !== "0",
    });
    sendJson(res, 200, { ok: true, bundle });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "sync export failed" });
  }
}

async function handleSyncImport(req, res) {
  if (!(await requireAdminOrSyncToken(req, res))) return;
  try {
    const body = await readJsonBody(req, 25 * 1024 * 1024);
    const result = await importSyncBundle(body?.bundle || body, { dryRun: Boolean(body?.dryRun) });
    sendJson(res, 200, { ok: true, imported: result, dryRun: Boolean(body?.dryRun) });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "sync import failed" });
  }
}

/**
 * Забрать выгрузку с удалённой установки.
 *
 * Токен уезжает заголовком, а не в адресе: ссылки попадают в логи прокси,
 * а секрету там не место.
 */
async function fetchRemoteBundle({ remoteUrl, remoteToken, profiles = true, timeoutMs = 120000 }) {
  const remote = normalizeRemoteSyncUrl(remoteUrl);
  const token = String(remoteToken || "").trim();
  if (!token) throw new Error("remoteToken is required");
  const exportUrl = new URL(remote.toString());
  exportUrl.pathname = `${exportUrl.pathname}/api/sync/export`.replace(/\/{2,}/g, "/");
  if (!profiles) exportUrl.searchParams.set("profiles", "0");
  const resp = await fetch(exportUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.ok || !json?.bundle) {
    const error = new Error(json?.error || `remote sync export failed (${resp.status})`);
    error.status = resp.status && resp.status >= 400 ? resp.status : 502;
    throw error;
  }
  return { remote, bundle: json.bundle };
}

/** Что лежит в выгрузке — показываем до импорта, чтобы проверка была нагляднее. */
function summarizeSyncBundle(bundle) {
  const data = bundle?.data && typeof bundle.data === "object" ? bundle.data : {};
  const out = {};
  for (const key of ["shortLinks", "access", "favorites", "userPolicies", "linkUsers", "userHistory", "subscriptionOverrides", "profileFiles"]) {
    if (Array.isArray(data[key])) out[key] = data[key].length;
  }
  return out;
}

const syncPeerRunning = new Set();

/**
 * Один прогон синхронизации с пиром.
 *
 * Связь односторонняя: мы забираем и накатываем, удалённая установка об этом
 * не знает и ничего у себя не меняет.
 */
async function runSyncPeer(peer, { dryRun = false } = {}) {
  if (!peer?.id) throw new Error("peer not found");
  if (syncPeerRunning.has(peer.id)) throw new Error("синхронизация с этим сервером уже идёт");
  syncPeerRunning.add(peer.id);
  try {
    const { remote, bundle } = await fetchRemoteBundle({
      remoteUrl: peer.remoteUrl,
      remoteToken: peer.remoteToken,
      profiles: peer.includeProfiles,
    });
    const imported = await importSyncBundle(bundle, { dryRun });
    const report = { ...imported, available: summarizeSyncBundle(bundle), exportedAt: bundle?.exportedAt || "" };
    const saved = await recordSyncPeerRun(peer.id, {
      status: dryRun ? "dry-run" : "ok",
      error: "",
      report,
      synced: !dryRun,
    });
    return { ok: true, peer: saved, remoteUrl: remote.origin, imported, report, dryRun };
  } catch (e) {
    const message = e?.message || "sync failed";
    const saved = await recordSyncPeerRun(peer.id, { status: "error", error: message });
    const error = new Error(message);
    error.status = e?.status || 502;
    error.peer = saved;
    throw error;
  } finally {
    syncPeerRunning.delete(peer.id);
  }
}

async function handleListSyncPeers(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    sendJson(res, 200, { ok: true, peers: await listSyncPeers(), syncApiEnabled: Boolean(SYNC_API_TOKEN) });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || "failed to list peers" });
  }
}

async function handleCreateSyncPeer(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJsonBody(req, 256 * 1024);
    sendJson(res, 200, { ok: true, peer: await createSyncPeer(body) });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to create peer" });
  }
}

async function handleUpdateSyncPeer(req, res, id) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJsonBody(req, 256 * 1024);
    const peer = await updateSyncPeer(id, body);
    if (!peer) {
      sendJson(res, 404, { ok: false, error: "peer not found" });
      return;
    }
    sendJson(res, 200, { ok: true, peer });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to update peer" });
  }
}

async function handleDeleteSyncPeer(req, res, id) {
  if (!(await requireAdmin(req, res))) return;
  try {
    await deleteSyncPeer(id);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "failed to delete peer" });
  }
}

/**
 * Проверка связи до сохранения пира.
 *
 * Ничего не импортирует: только сообщает, ответила ли удалённая установка и
 * что в её выгрузке лежит.
 */
async function handleTestSyncPeer(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJsonBody(req, 256 * 1024);
    let remoteUrl = String(body?.remoteUrl || body?.remote_url || "").trim();
    let remoteToken = String(body?.remoteToken || body?.remote_token || "").trim();
    const peerId = String(body?.id || "").trim();
    if (peerId) {
      const stored = await getSyncPeerWithToken(peerId);
      if (!stored) {
        sendJson(res, 404, { ok: false, error: "peer not found" });
        return;
      }
      if (!remoteUrl) remoteUrl = stored.remoteUrl;
      if (!remoteToken) remoteToken = stored.remoteToken;
    }
    const { remote, bundle } = await fetchRemoteBundle({ remoteUrl, remoteToken, profiles: false, timeoutMs: 30000 });
    sendJson(res, 200, {
      ok: true,
      remoteUrl: remote.origin,
      exportedAt: bundle?.exportedAt || "",
      available: summarizeSyncBundle(bundle),
    });
  } catch (e) {
    sendJson(res, e?.status && e.status >= 400 && e.status < 600 ? e.status : 400, {
      ok: false,
      error: e?.message || "sync test failed",
    });
  }
}

async function handleRunSyncPeer(req, res, id) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJsonBody(req, 256 * 1024).catch(() => ({}));
    const peer = await getSyncPeerWithToken(id);
    if (!peer) {
      sendJson(res, 404, { ok: false, error: "peer not found" });
      return;
    }
    const result = await runSyncPeer(peer, { dryRun: Boolean(body?.dryRun) });
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e?.status && e.status >= 400 && e.status < 600 ? e.status : 400, {
      ok: false,
      error: e?.message || "sync failed",
      peer: e?.peer || null,
    });
  }
}

/**
 * Расписание: раз в минуту смотрим, кому пора.
 *
 * Интервал считаем от последней попытки, а не от успеха — иначе упавший пир
 * долбился бы на каждом тике.
 */
function startSyncPeerScheduler() {
  const tick = async () => {
    let peers = [];
    try {
      peers = await listSyncPeers();
    } catch {
      return;
    }
    const now = Date.now();
    for (const peer of peers) {
      if (!peer.enabled || peer.intervalMinutes <= 0) continue;
      if (syncPeerRunning.has(peer.id)) continue;
      const last = Date.parse(peer.lastAttemptAt || "") || 0;
      if (last && now - last < peer.intervalMinutes * 60000) continue;
      try {
        const full = await getSyncPeerWithToken(peer.id);
        if (!full) continue;
        const result = await runSyncPeer(full, {});
        console.log(`[INFO] синхронизация с ${peer.remoteUrl}: ${JSON.stringify(result.imported)}`);
      } catch (e) {
        console.log(`[WARN] синхронизация с ${peer.remoteUrl} не удалась: ${e?.message || e}`);
      }
    }
  };
  const timer = setInterval(() => { void tick(); }, 60000);
  if (typeof timer.unref === "function") timer.unref();
  const first = setTimeout(() => { void tick(); }, 15000);
  if (typeof first.unref === "function") first.unref();
}

async function handleSyncPull(req, res) {
  if (!(await requireAdminOrSyncToken(req, res))) return;
  try {
    const body = await readJsonBody(req, 256 * 1024);
    const remote = normalizeRemoteSyncUrl(body?.remoteUrl || body?.remote_url);
    const remoteToken = String(body?.remoteToken || body?.remote_token || SYNC_API_TOKEN || "").trim();
    if (!remoteToken) {
      sendJson(res, 400, { ok: false, error: "remoteToken is required" });
      return;
    }
    const exportUrl = new URL(remote.toString());
    exportUrl.pathname = `${exportUrl.pathname}/api/sync/export`.replace(/\/{2,}/g, "/");
    const resp = await fetch(exportUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${remoteToken}`,
      },
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json?.ok) {
      sendJson(res, resp.status || 502, {
        ok: false,
        error: json?.error || `remote sync export failed (${resp.status})`,
      });
      return;
    }
    const result = await importSyncBundle(json.bundle, { dryRun: Boolean(body?.dryRun) });
    sendJson(res, 200, {
      ok: true,
      remoteUrl: remote.origin,
      imported: result,
      dryRun: Boolean(body?.dryRun),
      exportedAt: json.bundle?.exportedAt || "",
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e?.message || "sync pull failed" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const routePath = url.pathname;
  const shortResolveMatch = routePath.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  const publicShortApiMatch = routePath.match(/^\/api\/public-short-links\/([A-Za-z0-9_-]+)$/);
  const publicShortMetaApiMatch = routePath.match(/^\/api\/public-short-links\/([A-Za-z0-9_-]+)\/meta$/);
  const shortApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)$/);
  const shortAccessApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)\/access$/);
  const shortOverridesApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)\/overrides$/);
  const shortOverridesPreviewApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)\/overrides\/preview$/);
  const shortUsersApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)\/users$/);
  const shortUserApiMatch = routePath.match(/^\/api\/short-links\/([A-Za-z0-9_-]+)\/users\/([^/]+)$/);
  const localSourceApiMatch = routePath.match(/^\/api\/local-sources\/([A-Za-z0-9_-]+)$/);
  const mergedSourceApiMatch = routePath.match(/^\/api\/merged-sources\/([A-Za-z0-9_-]+)$/);
  const mockApiMatch = routePath.match(/^\/api\/mock-sources\/([A-Za-z0-9_-]+)$/);
  const mockLogsMatch = routePath.match(/^\/api\/mock-sources\/([A-Za-z0-9_-]+)\/logs$/);
  const adminUserApiMatch = routePath.match(/^\/api\/admin\/users\/([a-zA-Z0-9._-]+)$/);
  const mockResolveMatch = routePath.match(/^\/mock\/([A-Za-z0-9_-]+)$/);
  const syncPeerApiMatch = routePath.match(/^\/api\/sync\/peers\/([A-Za-z0-9-]+)$/);
  const syncPeerRunApiMatch = routePath.match(/^\/api\/sync\/peers\/([A-Za-z0-9-]+)\/pull$/);

  if (req.method === "GET" && routePath === "/api/auth/me") {
    await handleAuthMe(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/auth/start") {
    await handleAuthStart(req, url, res);
    return;
  }
  if (req.method === "GET" && routePath === "/auth/callback") {
    await handleAuthCallback(req, url, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/auth/login") {
    await handleAuthLogin(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/auth/logout") {
    await handleAuthLogout(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/sync/peers") {
    await handleListSyncPeers(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/sync/peers") {
    await handleCreateSyncPeer(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/sync/peers/test") {
    await handleTestSyncPeer(req, res);
    return;
  }
  if (req.method === "POST" && syncPeerRunApiMatch) {
    await handleRunSyncPeer(req, res, syncPeerRunApiMatch[1]);
    return;
  }
  if (req.method === "PUT" && syncPeerApiMatch) {
    await handleUpdateSyncPeer(req, res, syncPeerApiMatch[1]);
    return;
  }
  if (req.method === "DELETE" && syncPeerApiMatch) {
    await handleDeleteSyncPeer(req, res, syncPeerApiMatch[1]);
    return;
  }
  if (req.method === "GET" && routePath === "/api/sync/export") {
    await handleSyncExport(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/sync/import") {
    await handleSyncImport(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/sync/pull") {
    await handleSyncPull(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/favorites") {
    if (!(await requireApiAuth(req, res))) return;
    await handleFavoritesGet(req, res);
    return;
  }
  if (req.method === "PUT" && routePath === "/api/favorites") {
    if (!(await requireApiAuth(req, res))) return;
    await handleFavoritesPut(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/favorites/restore") {
    await handleFavoritesRestore(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/search") {
    if (!(await requireApiAuth(req, res))) return;
    await handleSearchByTag(req, url, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/stats") {
    await handleStats(req, url, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/admin/users") {
    await handleAdminUsersList(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/admin/users") {
    await handleAdminUsersCreate(req, res);
    return;
  }
  if (req.method === "PUT" && adminUserApiMatch) {
    await handleAdminUsersUpdate(req, res, adminUserApiMatch[1]);
    return;
  }
  if (req.method === "DELETE" && adminUserApiMatch) {
    await handleAdminUsersDelete(req, res, adminUserApiMatch[1]);
    return;
  }

  if (req.method === "GET" && routePath === "/") {
    const state = await getAuthState(req);
    if (!state.authenticated) {
      if (state.denied) {
        sendAuthProblem(res, 403, "Нет доступа к Sub Lab", "В account для этой учётной записи не назначена роль sub_mirror.", {
          "Set-Cookie": clearSessionCookies(),
        });
        return;
      }
      const start = authStartLocation(req, "/");
      redirect(res, start.location, { "Set-Cookie": [start.cookie, ...clearSessionCookies()] });
      return;
    }
    if (!serveFrontendIndex(res)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHomePage());
    }
    return;
  }
  if (req.method === "GET" && routePath === "/stats") {
    const state = await getAuthState(req);
    if (!state.authenticated) {
      if (state.denied) {
        sendAuthProblem(res, 403, "Нет доступа к Sub Lab", "В account для этой учётной записи не назначена роль sub_mirror.", {
          "Set-Cookie": clearSessionCookies(),
        });
        return;
      }
      const start = authStartLocation(req, "/stats");
      redirect(res, start.location, { "Set-Cookie": [start.cookie, ...clearSessionCookies()] });
      return;
    }
    if (!serveFrontendIndex(res)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHomePage());
    }
    return;
  }
  if (req.method === "GET" && routePath === "/admin") {
    const state = await getAuthState(req);
    if (!state.authenticated) {
      if (state.denied) {
        sendAuthProblem(res, 403, "Нет доступа к Sub Lab", "В account для этой учётной записи не назначена роль sub_mirror.", {
          "Set-Cookie": clearSessionCookies(),
        });
        return;
      }
      const start = authStartLocation(req, "/admin");
      redirect(res, start.location, { "Set-Cookie": [start.cookie, ...clearSessionCookies()] });
      return;
    }
    if (state.user?.role !== "admin") {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (!serveFrontendIndex(res)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHomePage());
    }
    return;
  }
  if (req.method === "GET" && routePath === "/sub") {
    void handleSubscription(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/last") {
    void handleLast(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/subscription.yaml") {
    void handleSubscription(req, res);
    return;
  }
  if (routePath === "/debug/echo") {
    void handleEcho(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/profile-editor/list") {
    if (!(await requireApiAuth(req, res))) return;
    await handleProfileEditorList(req, res);
    return;
  }
  if (req.method === "GET" && publicShortMetaApiMatch) {
    await handlePublicShortLinkMeta(req, res, publicShortMetaApiMatch[1]);
    return;
  }
  if (req.method === "GET" && publicShortApiMatch) {
    await handlePublicShortLink(req, res, publicShortApiMatch[1]);
    return;
  }
  if (req.method === "GET" && routePath === "/api/ua-catalog") {
    if (!(await requireApiAuth(req, res))) return;
    const { options, defaultUa } = getUaCatalogOptions();
    sendJson(res, 200, { ok: true, options, defaultUa });
    return;
  }
  if (req.method === "GET" && routePath === "/api/apps") {
    const catalog = getAppsCatalog();
    sendJson(res, 200, {
      ok: true,
      apps: catalog.apps,
      shareLinks: catalog.shareLinks,
      items: catalog.items,
      recommendedByOs: catalog.recommendedByOs,
      orderByOs: catalog.orderByOs,
    });
    return;
  }
  if (req.method === "GET" && routePath === "/api/apps/guide") {
    const app = String(url.searchParams.get("app") || "");
    const os = String(url.searchParams.get("os") || "");
    const result = getAppGuide(app, os);
    if (!result.ok) {
      sendJson(res, result.status || 404, result);
      return;
    }
    sendJson(res, 200, { ok: true, guide: result.guide });
    return;
  }
  if (req.method === "GET" && routePath === "/api/profile-editor/file") {
    if (!(await requireApiAuth(req, res))) return;
    await handleProfileEditorRead(req, url, res);
    return;
  }
  if (req.method === "PUT" && routePath === "/api/profile-editor/file") {
    if (!(await requireEditorAuth(req, res))) return;
    void handleProfileEditorSave(req, res);
    return;
  }
  if (req.method === "DELETE" && routePath === "/api/profile-editor/file") {
    if (!(await requireEditorAuth(req, res))) return;
    await handleProfileEditorDelete(req, url, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/sub-test") {
    if (!(await requireApiAuth(req, res))) return;
    void handleSubscriptionTest(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/ping") {
    if (!(await requireApiAuth(req, res))) return;
    await handlePing(req, res);
    return;
  }
  if (req.method === "GET" && routePath === "/api/ping/modes") {
    if (!(await requireApiAuth(req, res))) return;
    sendJson(res, 200, { ok: true, modes: PING_MODES });
    return;
  }
  if (req.method === "POST" && routePath === "/api/local-sources") {
    if (!(await requireEditorAuth(req, res))) return;
    void handleCreateLocalSource(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/merged-sources") {
    if (!(await requireEditorAuth(req, res))) return;
    void handleCreateMergedSource(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/merged-sources/preview") {
    if (!(await requireEditorAuth(req, res))) return;
    await handlePreviewMergedSource(req, res);
    return;
  }
  if (req.method === "GET" && mergedSourceApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    await handleGetMergedSource(req, res, mergedSourceApiMatch[1]);
    return;
  }
  if (req.method === "PUT" && mergedSourceApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    await handleUpdateMergedSource(req, res, mergedSourceApiMatch[1]);
    return;
  }
  if (req.method === "POST" && routePath === "/api/import/parse") {
    if (!(await requireApiAuth(req, res))) return;
    void handleParseBulkImport(req, res);
    return;
  }
  if (req.method === "POST" && routePath === "/api/happ-decrypt") {
    if (!(await requireApiAuth(req, res))) return;
    void handleHappDecrypt(req, res);
    return;
  }
  if (req.method === "GET" && localSourceApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetLocalSource(req, res, localSourceApiMatch[1]);
    return;
  }
  if (req.method === "POST" && routePath === "/api/short-links") {
    if (!(await requireEditorAuth(req, res))) return;
    void handleCreateShortLink(req, res);
    return;
  }
  if (req.method === "GET" && shortApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetShortLink(req, res, shortApiMatch[1]);
    return;
  }
  if (req.method === "GET" && shortAccessApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetShortLinkAccess(req, res, shortAccessApiMatch[1]);
    return;
  }
  if (req.method === "PUT" && shortAccessApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    await handlePutShortLinkAccess(req, res, shortAccessApiMatch[1]);
    return;
  }
  if (req.method === "GET" && shortOverridesApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetShortLinkOverrides(req, res, shortOverridesApiMatch[1]);
    return;
  }
  if (req.method === "PUT" && shortOverridesApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    await handlePutShortLinkOverrides(req, res, shortOverridesApiMatch[1]);
    return;
  }

  if (req.method === "POST" && shortOverridesPreviewApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handlePreviewShortLinkOverrides(req, res, shortOverridesPreviewApiMatch[1]);
    return;
  }
  if (req.method === "GET" && shortUsersApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetShortLinkUsers(req, res, shortUsersApiMatch[1]);
    return;
  }
  if (req.method === "PATCH" && shortUsersApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    void handleUpdateShortLinkUsersPolicy(req, res, shortUsersApiMatch[1]);
    return;
  }
  if (req.method === "PATCH" && shortUserApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    void handleUpdateShortLinkUser(req, res, shortUserApiMatch[1], shortUserApiMatch[2]);
    return;
  }
  if (req.method === "DELETE" && shortUserApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    void handleDeleteShortLinkUser(req, res, shortUserApiMatch[1], shortUserApiMatch[2]);
    return;
  }
  if (req.method === "PUT" && shortApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    void handleUpdateShortLink(req, res, shortApiMatch[1]);
    return;
  }
  if (req.method === "GET" && shortResolveMatch) {
    await handleShortLinkResolve(req, res, shortResolveMatch[1]);
    return;
  }
  if (req.method === "POST" && routePath === "/api/mock-sources") {
    if (!(await requireEditorAuth(req, res))) return;
    void handleCreateMockSource(req, res);
    return;
  }
  if (req.method === "GET" && mockApiMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetMockSource(req, res, mockApiMatch[1]);
    return;
  }
  if (req.method === "PUT" && mockApiMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    void handleUpdateMockSource(req, res, mockApiMatch[1]);
    return;
  }
  if (req.method === "GET" && mockLogsMatch) {
    if (!(await requireApiAuth(req, res))) return;
    await handleGetMockLogs(req, res, mockLogsMatch[1]);
    return;
  }
  if (req.method === "POST" && mockLogsMatch) {
    if (!(await requireEditorAuth(req, res))) return;
    await handleClearMockLogs(req, res, mockLogsMatch[1]);
    return;
  }
  if (mockResolveMatch) {
    void handleMockSourceRequest(req, res, mockResolveMatch[1], url);
    return;
  }

  const staticEntry = STATIC_FILES.get(routePath);
  if (req.method === "GET" && staticEntry) {
    serveStaticFile(res, staticEntry);
    return;
  }

  if (req.method === "GET" && routePath.startsWith("/assets/")) {
    if (serveFrontendAsset(routePath, res)) return;
  }
  if (req.method === "GET" && /\.(css|js|map|svg|png|jpg|jpeg|webp|ico|woff2)$/i.test(routePath)) {
    if (serveFrontendAsset(routePath, res)) return;
  }

  if (req.method === "GET" && routePath === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && FRONTEND_DIST) {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/html")) {
      if (serveFrontendIndex(res)) return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

/**
 * Глобальный fetch появился в Node 18. На Node 16 сервер поднимался как ни в
 * чём не бывало и падал только при загрузке подписки («fetch is not defined»),
 * поэтому требование проверяем на старте.
 */
function requireModernNode() {
  if (typeof fetch === "function") return;
  console.error(`[FATAL] нужен Node 18 или новее, запущен ${process.version}`);
  process.exit(1);
}

function startServer() {
  requireModernNode();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[OK] listening on :${PORT}`);
  });
  startSyncPeerScheduler();
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(path.join(SERVER_DIR, "server.js"));
if (isMain) {
  startServer();
}

export {
  SESSION_COOKIE,
  ACCOUNT_SESSION_COOKIE,
  authUserFromAccount,
  normalizeOutput,
  renderHomePage,
  parseServersFromText,
  parseProfileYaml,
  readProfileFile,
  profileExists,
  pickUserAgentProfile,
  resolveAppKeyFromUserAgent,
  resolveOutputFromUserAgent,
  resolveLocalSourcePath,
  resolveRequestConfig,
  resolveShortLinkTypeOverride,
  produceOutput,
  fetchWithNode,
  fetchRemoteBundle,
  summarizeSyncBundle,
  foreignFavorites,
  startServer,
};
