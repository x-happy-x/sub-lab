import crypto from "node:crypto";
import {
  createShortLinkRow,
  getShortLinkRow,
  getShortLinkPermissions,
  renameShortLinkRow,
  updateShortLinkRow,
} from "./sqlite-store.js";

const VALID_ENDPOINTS = new Set(["last", "sub"]);
const PARAM_KEYS = ["sub_url", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups", "endpoint"];
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function sanitizeParams(input) {
  const out = {};
  for (const key of PARAM_KEYS) {
    const value = input?.[key];
    if (value === undefined || value === null) continue;
    const v = String(value).trim();
    if (!v) continue;
    out[key] = v;
  }
  const endpoint = out.endpoint || "last";
  out.endpoint = VALID_ENDPOINTS.has(endpoint) ? endpoint : "last";
  return out;
}

async function generateId() {
  for (let i = 0; i < 20; i += 1) {
    const id = crypto.randomBytes(5).toString("base64url");
    const existing = await getShortLinkRow(id);
    if (!existing) return id;
  }
  return crypto.randomBytes(8).toString("hex");
}

function normalizeRequestedId(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!ID_PATTERN.test(token)) return null;
  return token.slice(0, 80);
}

async function createShortLink(params) {
  const sanitized = sanitizeParams(params?.params || params);
  if (!sanitized.sub_url) {
    return { ok: false, status: 400, error: "sub_url is required" };
  }
  const requestedId = normalizeRequestedId(params?.id ?? params?.shortId ?? params?.slug);
  if (requestedId === null) {
    return { ok: false, status: 400, error: "invalid short link id" };
  }
  const id = requestedId || await generateId();
  if (await getShortLinkRow(id)) {
    return { ok: false, status: 409, error: "short link id already exists" };
  }
  const link = await createShortLinkRow(id, {
    params: sanitized,
    title: params?.title,
    ownerUsername: params?.ownerUsername,
    hidden: Boolean(params?.hidden),
  });
  return { ok: true, link };
}

async function getShortLink(id, actor = null) {
  const token = String(id || "").trim();
  if (!ID_PATTERN.test(token)) {
    return { ok: false, status: 400, error: "invalid short link id" };
  }
  const permission = await getShortLinkPermissions(token, actor);
  if (!permission?.link) {
    return { ok: false, status: 404, error: "short link not found" };
  }
  if (!permission.canView) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return {
    ok: true,
    link: permission.link,
    permissions: {
      canView: permission.canView,
      canEdit: permission.canEdit,
      canManageAccess: permission.canManageAccess,
      accessLevel: permission.accessLevel || "",
    },
  };
}

async function getPublicShortLink(id) {
  const token = String(id || "").trim();
  if (!ID_PATTERN.test(token)) {
    return { ok: false, status: 400, error: "invalid short link id" };
  }
  const link = await getShortLinkRow(token);
  if (!link) {
    return { ok: false, status: 404, error: "short link not found" };
  }
  if (link.hidden) {
    return { ok: false, status: 404, error: "short link not found" };
  }
  return { ok: true, link };
}

async function updateShortLink(id, params, actor = null) {
  const existing = await getShortLink(id, actor);
  if (!existing.ok) return existing;
  if (!existing.permissions?.canEdit) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const sanitized = sanitizeParams(params?.params || params);
  if (!sanitized.sub_url && !existing.link.params.sub_url) {
    return { ok: false, status: 400, error: "sub_url is required" };
  }

  let token = existing.link.id;
  const requestedId = params?.id !== undefined || params?.shortId !== undefined || params?.slug !== undefined
    ? normalizeRequestedId(params?.id ?? params?.shortId ?? params?.slug)
    : "";
  if (requestedId === null) {
    return { ok: false, status: 400, error: "invalid short link id" };
  }
  if (requestedId && requestedId !== token) {
    try {
      const renamed = await renameShortLinkRow(token, requestedId);
      if (!renamed) return { ok: false, status: 404, error: "short link not found" };
      token = renamed.id;
    } catch (e) {
      if (e?.code === "SQLITE_CONSTRAINT") {
        return { ok: false, status: 409, error: "short link id already exists" };
      }
      throw e;
    }
  }
  let current = await updateShortLinkRow(token, sanitized, {
    title: params?.title,
    hidden: params?.hidden,
  });
  if (!current) {
    return { ok: false, status: 404, error: "short link not found" };
  }

  current.params.endpoint = VALID_ENDPOINTS.has(current.params.endpoint)
    ? current.params.endpoint
    : "last";
  current = (await updateShortLinkRow(token, { endpoint: current.params.endpoint })) || current;
  return { ok: true, link: current };
}

function buildQueryFromParams(params) {
  const qp = new URLSearchParams();
  const source = sanitizeParams(params || {});
  for (const key of ["sub_url", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups"]) {
    if (source[key]) qp.set(key, source[key]);
  }
  return qp;
}

export {
  PARAM_KEYS,
  sanitizeParams,
  createShortLink,
  getShortLink,
  getPublicShortLink,
  updateShortLink,
  buildQueryFromParams,
};
