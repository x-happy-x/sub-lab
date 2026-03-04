import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  SUB_URL_DEFAULT,
  CONVERTER_URL,
  SOURCE_URL,
  PROFILE_ROOT_DIRS,
  HEADER_POLICY_DEFAULT,
  OUTPUT_RAW,
  OUTPUT_CLASH,
  OUTPUT_DEFAULT,
  OUT_RAW,
  OUT_YAML,
  OUT_STATUS,
  OUT_CONVERTED,
  SOURCE_PATH,
  CACHE_DIR,
  normalizeOutput,
} from "./config.js";

function isHtml(s) {
  const t = s.trim().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html");
}

function looksLikeClashProviderYaml(s) {
  return /^\s*proxies\s*:\s*$/m.test(s);
}

function looksLikeUriListOrBase64(s) {
  const t = s.trim();
  return (
    t.startsWith("vmess://") ||
    t.startsWith("vless://") ||
    t.startsWith("ss://") ||
    (/^[A-Za-z0-9+/=\r\n]+$/.test(t) && t.length > 200)
  );
}

function extractConvertibleSource(rawText) {
  const t = rawText.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return rawText;
  try {
    const parsed = JSON.parse(t);
    const cryptoLink = parsed?.happ?.cryptoLink;
    if (typeof cryptoLink === "string" && cryptoLink.trim()) {
      return cryptoLink.trim();
    }
  } catch {
    // ignore JSON parse errors; fall back to raw text
  }
  return rawText;
}

function decodeBase64IfNeeded(text) {
  const t = text.trim();
  if (t.includes("://")) return text;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(t) || t.length < 200) return text;
  try {
    const decoded = Buffer.from(t.replace(/\s+/g, ""), "base64").toString("utf8");
    return decoded && decoded.trim() ? decoded : text;
  } catch {
    return text;
  }
}

function extractVlessLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("vless://"));
}

function hasAnySubscriptions(text) {
  const t = text.trim();
  if (!t) return false;
  if (looksLikeClashProviderYaml(t)) {
    return /-\s*name\s*:/m.test(t);
  }
  const decoded = looksLikeUriListOrBase64(t) ? decodeBase64IfNeeded(t) : t;
  const prefixes = ["vless://", "vmess://", "ss://", "ssr://", "trojan://"];
  return decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && prefixes.some((prefix) => line.startsWith(prefix))).length > 0;
}

function buildYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(obj)) {
    return obj
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const head = `${pad}-`;
          const body = buildYaml(item, indent + 1);
          return body ? `${head}\n${body}` : head;
        }
        return `${pad}- ${String(item)}`;
      })
      .join("\n");
  }
  if (typeof obj !== "object" || obj === null) {
    return `${pad}${String(obj)}`;
  }
  return Object.entries(obj)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${pad}${key}:\n${buildYaml(value, indent + 1)}`;
      }
      if (typeof value === "object" && value !== null) {
        const body = buildYaml(value, indent + 1);
        return body ? `${pad}${key}:\n${body}` : `${pad}${key}: {}`;
      }
      return `${pad}${key}: ${String(value)}`;
    })
    .join("\n");
}

function vlessToProxy(line) {
  const url = new URL(line);
  const params = url.searchParams;
  const name = decodeURIComponent(url.hash.replace(/^#/, "")) || `${url.hostname}:${url.port || 443}`;
  const network = params.get("type") || "tcp";
  const security = params.get("security") || "none";
  const proxy = {
    name: JSON.stringify(name),
    type: "vless",
    server: url.hostname,
    port: Number(url.port || 443),
    uuid: url.username,
    udp: true,
  };

  if (network && network !== "tcp") proxy.network = network;
  if (security && security !== "none") proxy.tls = true;

  const sni = params.get("sni");
  if (sni) proxy.servername = sni;

  const fp = params.get("fp");
  if (fp) proxy["client-fingerprint"] = fp;

  const flow = params.get("flow");
  if (flow) proxy.flow = flow;

  if (security === "reality") {
    const pbk = params.get("pbk");
    const sid = params.get("sid");
    const reality = {};
    if (pbk) reality["public-key"] = pbk;
    if (sid) reality["short-id"] = sid;
    if (Object.keys(reality).length) proxy["reality-opts"] = reality;
  }

  if (network === "ws") {
    const path = params.get("path");
    const host = params.get("host");
    const ws = {};
    if (path) ws.path = path;
    if (host) ws.headers = { Host: host };
    if (Object.keys(ws).length) proxy["ws-opts"] = ws;
  }

  if (network === "xhttp") {
    const path = params.get("path");
    const host = params.get("host");
    const mode = params.get("mode");
    const httpOpts = {};
    if (path) httpOpts.path = [path];
    if (host) httpOpts.headers = { Host: [host] };
    if (mode) httpOpts.mode = mode;
    if (Object.keys(httpOpts).length) {
      proxy.network = "http";
      proxy["http-opts"] = httpOpts;
    }
  }

  return proxy;
}

function convertVlessListToClash(text) {
  const lines = extractVlessLines(text);
  if (lines.length === 0) return null;
  const proxies = lines.map(vlessToProxy);
  const yaml = `proxies:\n${buildYaml(proxies, 1)}`;
  return yaml;
}

function writeStatus(obj) {
  fs.writeFileSync(OUT_STATUS, JSON.stringify(obj, null, 2));
}

function logRequest(info) {
  const entry = { ts: new Date().toISOString(), ...info };
  console.log(JSON.stringify(entry));
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
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

function writeCacheMeta(key, meta) {
  fs.writeFileSync(cacheMetaPathForKey(key), JSON.stringify(meta, null, 2));
}

function serveStaticFile(res, entry) {
  try {
    const body = fs.readFileSync(entry.path);
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("failed to read file");
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function firstHeaderValue(v) {
  if (Array.isArray(v)) return v[0];
  if (typeof v !== "string") return v;
  const first = v.split(",")[0];
  return first ? first.trim() : v;
}

function parseBool(v, fallback = false) {
  const value = firstHeaderValue(v);
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function sanitizeForwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "host" || key === "connection" || key === "content-length") continue;
    if (
      key === "x-sub-url" ||
      key === "x-use-converter" ||
      key === "x-output" ||
      key === "x-app" ||
      key === "x-device" ||
      key === "x-profile" ||
      key === "x-profiles"
    ) {
      continue;
    }
    const value = firstHeaderValue(v);
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function parseOptionalBool(v) {
  const value = firstHeaderValue(v);
  if (value === undefined || value === null || value === "") return undefined;
  return parseBool(value, false);
}

function parseOptionalOutput(v) {
  const value = firstHeaderValue(v);
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeOutput(value);
}

function unquoteYamlValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  return value;
}

function parseProfileYaml(content) {
  const profile = {
    subUrl: "",
    output: undefined,
    headerPolicy: HEADER_POLICY_DEFAULT,
    allowHwidOverride: true,
    headers: {},
    requiredHeaders: [],
  };
  let section = "";
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const raw = line.replace(/\t/g, "  ");
    const commentCut = raw.indexOf("#");
    const cleaned = commentCut >= 0 ? raw.slice(0, commentCut) : raw;
    const trimmed = cleaned.trim();
    if (!trimmed) continue;

    const indent = cleaned.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) {
      section = "";
      const keyMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
      if (!keyMatch) continue;
      const key = keyMatch[1];
      const value = unquoteYamlValue((keyMatch[2] || "").trim());

      if (key === "sub_url") {
        profile.subUrl = value;
      } else if (key === "output") {
        if (value !== "") {
          const normalizedOutput = normalizeOutput(value);
          if (normalizedOutput) profile.output = normalizedOutput;
        }
      } else if (key === "use_converter") {
        if (value !== "") profile.output = parseBool(value, false) ? OUTPUT_CLASH : OUTPUT_RAW;
      } else if (key === "header_policy") {
        if (value) profile.headerPolicy = value.toLowerCase();
      } else if (key === "allow_hwid_override") {
        if (value !== "") profile.allowHwidOverride = parseBool(value, true);
      } else if (key === "headers" || key === "required_headers") {
        section = key;
      }
      continue;
    }

    if (section === "headers") {
      const pair = trimmed.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
      if (!pair) continue;
      profile.headers[pair[1].toLowerCase()] = unquoteYamlValue((pair[2] || "").trim());
      continue;
    }

    if (section === "required_headers") {
      const item = trimmed.match(/^-\s*(.+)$/);
      if (!item) continue;
      profile.requiredHeaders.push(unquoteYamlValue(item[1].trim()).toLowerCase());
    }
  }
  return profile;
}

function profileSearchDirs(profileName) {
  const isUaProfile = String(profileName || "").startsWith("ua-");
  const dirs = [];
  for (const root of PROFILE_ROOT_DIRS) {
    dirs.push(path.join(root, isUaProfile ? "ua" : "base"));
    dirs.push(root);
  }
  return dirs.filter((dir, i, arr) => arr.indexOf(dir) === i);
}

function resolveProfilePath(profileName) {
  for (const dir of profileSearchDirs(profileName)) {
    const ymlPath = path.join(dir, `${profileName}.yml`);
    const yamlPath = path.join(dir, `${profileName}.yaml`);
    if (fs.existsSync(ymlPath)) return ymlPath;
    if (fs.existsSync(yamlPath)) return yamlPath;
  }
  return "";
}

function readProfileFile(profileName) {
  const filePath = resolveProfilePath(profileName);
  if (!filePath) return null;
  const content = fs.readFileSync(filePath, "utf8");
  return parseProfileYaml(content);
}

function profileExists(profileName) {
  return Boolean(resolveProfilePath(profileName));
}

function sanitizeProfileToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (!/^[a-zA-Z0-9._-]+$/.test(token)) return "";
  return token;
}

function pickProfileNames(reqUrl, reqHeaders, forcedProfileName = "") {
  const rawNames = [
    ...reqUrl.searchParams.getAll("profile"),
    ...reqUrl.searchParams.getAll("profiles"),
    firstHeaderValue(reqHeaders["x-profile"]) || "",
    firstHeaderValue(reqHeaders["x-profiles"]) || "",
  ];
  if (forcedProfileName) {
    rawNames.push(forcedProfileName);
  }
  const out = [];
  for (const raw of rawNames) {
    for (const part of String(raw || "").split(",")) {
      const name = part.trim();
      if (!name) continue;
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function pickUserAgentProfile(app, device) {
  const appToken = sanitizeProfileToken(app);
  const deviceToken = sanitizeProfileToken(device);
  if (!appToken && !deviceToken) {
    return profileExists("ua-default")
      ? { ok: true, profileName: "ua-default" }
      : { ok: true, profileName: "" };
  }
  if (!appToken && deviceToken) {
    return { ok: false, error: "app is required when device is provided" };
  }

  const candidates = [];
  if (appToken && deviceToken) candidates.push(`ua-${appToken}-${deviceToken}`);
  if (appToken) candidates.push(`ua-${appToken}`);
  candidates.push("ua-default");

  for (const candidate of candidates) {
    if (profileExists(candidate)) {
      return { ok: true, profileName: candidate };
    }
  }
  return {
    ok: false,
    error: `user-agent profile not found for app=${appToken}${deviceToken ? ` device=${deviceToken}` : ""}`,
  };
}

function mergeProfiles(profileNames) {
  const merged = {
    subUrl: "",
    output: undefined,
    headerPolicy: HEADER_POLICY_DEFAULT,
    allowHwidOverride: true,
    headers: {},
    requiredHeaders: [],
  };
  for (const name of profileNames) {
    const profile = readProfileFile(name);
    if (!profile) {
      return { ok: false, error: `profile not found: ${name}` };
    }
    if (profile.subUrl) merged.subUrl = profile.subUrl;
    if (profile.output) merged.output = profile.output;
    if (profile.headerPolicy) merged.headerPolicy = profile.headerPolicy;
    merged.allowHwidOverride = profile.allowHwidOverride !== false;
    merged.headers = { ...merged.headers, ...profile.headers };
    for (const key of profile.requiredHeaders) {
      if (!merged.requiredHeaders.includes(key)) merged.requiredHeaders.push(key);
    }
  }
  const validPolicies = new Set(["prefer_request", "file_only", "require_request"]);
  if (!validPolicies.has(merged.headerPolicy)) {
    return { ok: false, error: `unsupported header_policy: ${merged.headerPolicy}` };
  }
  return { ok: true, profile: merged };
}

function resolveForwardHeaders(reqHeaders, profile, hwidOverride) {
  const incoming = sanitizeForwardHeaders(reqHeaders);
  const fromProfile = { ...profile.headers };
  if (hwidOverride && profile.allowHwidOverride !== false) {
    fromProfile["x-hwid"] = hwidOverride;
  }

  if (profile.headerPolicy === "require_request") {
    for (const required of profile.requiredHeaders) {
      if (!incoming[required]) {
        return { ok: false, error: `required header is missing: ${required}` };
      }
    }
  }

  if (profile.headerPolicy === "file_only") {
    return { ok: true, headers: { ...incoming, ...fromProfile } };
  }
  return { ok: true, headers: { ...fromProfile, ...incoming } };
}

function resolveRequestConfig(reqUrl, reqHeaders, forcedProfileName = "") {
  const profileNames = pickProfileNames(reqUrl, reqHeaders, forcedProfileName);
  const app = sanitizeProfileToken(
    reqUrl.searchParams.get("app") ?? firstHeaderValue(reqHeaders["x-app"]),
  );
  const device = sanitizeProfileToken(
    reqUrl.searchParams.get("device") ?? firstHeaderValue(reqHeaders["x-device"]),
  );
  const uaProfile = pickUserAgentProfile(app, device);
  if (!uaProfile.ok) {
    return { ok: false, status: 400, error: uaProfile.error };
  }
  if (uaProfile.profileName && !profileNames.includes(uaProfile.profileName)) {
    profileNames.push(uaProfile.profileName);
  }

  const merged = mergeProfiles(profileNames);
  if (!merged.ok) {
    return { ok: false, status: 400, error: merged.error };
  }

  const subFromQuery = reqUrl.searchParams.get("sub_url");
  const subFromHeader = firstHeaderValue(reqHeaders["x-sub-url"]);
  const subUrl = subFromQuery || subFromHeader || merged.profile.subUrl || SUB_URL_DEFAULT;

  const outputFromQuery = reqUrl.searchParams.get("output");
  const outputFromHeader = reqHeaders["x-output"];
  const explicitOutput = parseOptionalOutput(outputFromQuery ?? outputFromHeader);
  if ((outputFromQuery || outputFromHeader) && !explicitOutput) {
    return { ok: false, status: 400, error: "unsupported output (use: clash|yml|yaml|raw)" };
  }

  const legacyFromQuery = reqUrl.searchParams.get("use_converter");
  const legacyFromHeader = reqHeaders["x-use-converter"];
  const explicitLegacyUseConverter = parseOptionalBool(legacyFromQuery ?? legacyFromHeader);
  const output =
    explicitOutput ??
    (explicitLegacyUseConverter !== undefined
      ? explicitLegacyUseConverter
        ? OUTPUT_CLASH
        : OUTPUT_RAW
      : merged.profile.output || OUTPUT_DEFAULT);

  const hwidOverride =
    reqUrl.searchParams.get("hwid") ?? firstHeaderValue(reqHeaders["x-hwid"]);
  const resolvedHeaders = resolveForwardHeaders(reqHeaders, merged.profile, hwidOverride);
  if (!resolvedHeaders.ok) {
    return { ok: false, status: 400, error: resolvedHeaders.error };
  }

  return {
    ok: true,
    subUrl,
    output,
    app,
    device,
    profileNames,
    forwardHeaders: resolvedHeaders.headers,
  };
}

function sanitizeUpstreamResponseHeaders(headers) {
  const out = {};
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
    "content-type",
  ]);
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    const key = k.toLowerCase();
    if (blocked.has(key)) continue;
    out[key] = String(v);
  }
  return out;
}

async function convertViaSubconverter(rawText) {
  if (!CONVERTER_URL) {
    throw new Error("CONVERTER_URL is not set");
  }
  fs.writeFileSync(SOURCE_PATH, rawText);

  const target = "clash";
  const finalUrl = `${CONVERTER_URL}?target=${encodeURIComponent(target)}&url=${encodeURIComponent(
    SOURCE_URL,
  )}&list=true`;

  const res = await fetch(finalUrl);
  const text = await res.text();
  fs.writeFileSync(OUT_CONVERTED, text);
  return text;
}

async function fetchWithNode(subUrl, forwardHeaders) {
  const resp = await fetch(subUrl, {
    headers: forwardHeaders,
    redirect: "follow",
  });
  const body = await resp.text();
  const responseHeaders = Object.fromEntries(resp.headers.entries());
  const responseStatus = resp.status;
  const responseUrl = resp.url;
  return { body, responseHeaders, responseStatus, responseUrl };
}

async function produceOutput(rawText, output) {
  if (!rawText || rawText.trim().length === 0) {
    return { ok: false, error: "empty response" };
  }
  if (isHtml(rawText)) {
    return { ok: false, error: "got HTML (anti-bot page)" };
  }

  if (output === OUTPUT_RAW) {
    if (!hasAnySubscriptions(rawText)) {
      return { ok: false, error: "no subscriptions" };
    }
    const contentType = looksLikeClashProviderYaml(rawText)
      ? "text/yaml; charset=utf-8"
      : "text/plain; charset=utf-8";
    return { ok: true, body: rawText, contentType, conversion: "none-raw" };
  }

  if (output !== OUTPUT_CLASH) {
    return { ok: false, error: `unsupported output: ${output}` };
  }

  let out = rawText;
  let conversion = "none";

  if (!looksLikeClashProviderYaml(rawText)) {
    let convertible = extractConvertibleSource(rawText);
    if (looksLikeUriListOrBase64(convertible)) {
      convertible = decodeBase64IfNeeded(convertible);
    }
    out = await convertViaSubconverter(convertible);
    conversion = "subconverter";

    if (!looksLikeClashProviderYaml(out)) {
      const fallback = convertVlessListToClash(convertible);
      if (fallback) {
        out = fallback;
        conversion = "vless-fallback";
      }
    }
  }

  if (!looksLikeClashProviderYaml(out)) {
    return { ok: false, error: "output has no proxies" };
  }
  if (!hasAnySubscriptions(out)) {
    return { ok: false, error: "no subscriptions" };
  }
  return { ok: true, body: out, contentType: "text/yaml; charset=utf-8", conversion };
}

async function refreshCache(subUrl, output, profileNames, forwardHeaders) {
  const fetched = await fetchWithNode(subUrl, forwardHeaders);
  const produced = await produceOutput(fetched.body, output);
  if (!produced.ok) {
    return produced;
  }
  const upstreamHeaders = sanitizeUpstreamResponseHeaders(fetched.responseHeaders);
  ensureCacheDir();
  const cacheKeyValue = cacheKey(subUrl, output, profileNames.join(","));
  const cachePath = cachePathForKey(cacheKeyValue);
  fs.writeFileSync(`${cachePath}.tmp`, produced.body);
  fs.renameSync(`${cachePath}.tmp`, cachePath);
  writeCacheMeta(cacheKeyValue, { contentType: produced.contentType, responseHeaders: upstreamHeaders });
  return {
    ok: true,
    body: produced.body,
    contentType: produced.contentType,
    responseHeaders: upstreamHeaders,
    conversion: produced.conversion,
  };
}

async function handleSubscription(req, res, forcedProfileName = "") {
  const startedAtMs = Date.now();
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const config = resolveRequestConfig(reqUrl, req.headers, forcedProfileName);
  const output = config.ok ? config.output : OUTPUT_DEFAULT;

  if (!config.ok) {
    res.writeHead(config.status || 400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(config.error || "invalid request");
    logRequest({
      route: "/sub",
      status: config.status || 400,
      profiles: forcedProfileName ? [forcedProfileName] : [],
      output,
      durationMs: Date.now() - startedAtMs,
      error: config.error || "invalid request",
    });
    return;
  }

  const { subUrl, profileNames, forwardHeaders, app, device } = config;

  if (!subUrl) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("SUB_URL is required (use ?sub_url= or X-Sub-Url header)");
    logRequest({
      route: "/sub",
      status: 400,
      profiles: profileNames,
      output,
      app,
      device,
      durationMs: Date.now() - startedAtMs,
      error: "missing sub_url",
    });
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    const fetched = await fetchWithNode(subUrl, forwardHeaders);
    const raw = fetched.body;
    const upstreamHeaders = sanitizeUpstreamResponseHeaders(fetched.responseHeaders);

    fs.writeFileSync(OUT_RAW, raw);

    if (!raw || raw.trim().length === 0) {
      writeStatus({
        ok: false,
        startedAt,
        error: "empty response",
        subUrl,
        output,
        profiles: profileNames,
        app,
        device,
        responseStatus: fetched.responseStatus,
        responseUrl: fetched.responseUrl,
        responseHeaders: fetched.responseHeaders,
      });
      throw new Error("empty response");
    }

    if (isHtml(raw)) {
      writeStatus({
        ok: false,
        startedAt,
        error: "got HTML (anti-bot page)",
        subUrl,
        output,
        profiles: profileNames,
        app,
        device,
        responseStatus: fetched.responseStatus,
        responseUrl: fetched.responseUrl,
        responseHeaders: fetched.responseHeaders,
        sha1: sha1(raw),
      });
      throw new Error("got HTML (anti-bot page)");
    }

    const produced = await produceOutput(raw, output);
    if (!produced.ok) {
      writeStatus({
        ok: false,
        startedAt,
        error: produced.error,
        subUrl,
        output,
        profiles: profileNames,
        app,
        device,
        responseStatus: fetched.responseStatus,
        responseUrl: fetched.responseUrl,
        responseHeaders: fetched.responseHeaders,
        outputSha1: sha1(raw),
      });
      throw new Error(produced.error);
    }

    const out = produced.body;
    const cacheContentType = produced.contentType;
    const savedPath = cacheContentType.startsWith("text/yaml") ? OUT_YAML : OUT_RAW;
    fs.writeFileSync(`${savedPath}.tmp`, out);
    fs.renameSync(`${savedPath}.tmp`, savedPath);
    ensureCacheDir();
    const cacheKeyValue = cacheKey(subUrl, output, profileNames.join(","));
    const cachePath = cachePathForKey(cacheKeyValue);
    fs.writeFileSync(`${cachePath}.tmp`, out);
    fs.renameSync(`${cachePath}.tmp`, cachePath);
    writeCacheMeta(cacheKeyValue, {
      contentType: cacheContentType,
      responseHeaders: upstreamHeaders,
    });

    writeStatus({
      ok: true,
      startedAt,
      saved: savedPath,
      cached: cachePath,
      sha1: sha1(out),
      bytes: out.length,
      subUrl,
      output,
      profiles: profileNames,
      app,
      device,
      responseStatus: fetched.responseStatus,
      responseUrl: fetched.responseUrl,
      responseHeaders: fetched.responseHeaders,
      forwardedHeaders: forwardHeaders,
      conversion: produced.conversion,
    });

    res.writeHead(200, {
      ...upstreamHeaders,
      "Content-Type": cacheContentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(out);
    logRequest({
      route: "/sub",
      status: 200,
      profiles: profileNames,
      output,
      app,
      device,
      contentType: cacheContentType,
      responseStatus: fetched.responseStatus,
      conversion: produced.conversion,
      bytes: out.length,
      durationMs: Date.now() - startedAtMs,
    });
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`failed to fetch subscription: ${e?.message || e}`);
    logRequest({
      route: "/sub",
      status: 502,
      profiles: profileNames,
      output,
      app,
      device,
      durationMs: Date.now() - startedAtMs,
      error: e?.message || String(e),
    });
  }
}

async function handleLast(req, res, forcedProfileName = "") {
  const startedAtMs = Date.now();
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const config = resolveRequestConfig(reqUrl, req.headers, forcedProfileName);
  const output = config.ok ? config.output : OUTPUT_DEFAULT;

  if (!config.ok) {
    res.writeHead(config.status || 400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(config.error || "invalid request");
    logRequest({
      route: "/last",
      status: config.status || 400,
      profiles: forcedProfileName ? [forcedProfileName] : [],
      output,
      durationMs: Date.now() - startedAtMs,
      error: config.error || "invalid request",
    });
    return;
  }

  const { subUrl, profileNames, forwardHeaders, app, device } = config;

  if (!subUrl) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("SUB_URL is required (use ?sub_url= or X-Sub-Url header)");
    logRequest({
      route: "/last",
      status: 400,
      profiles: profileNames,
      output,
      app,
      device,
      durationMs: Date.now() - startedAtMs,
      error: "missing sub_url",
    });
    return;
  }

  let refreshed = null;
  try {
    refreshed = await refreshCache(subUrl, output, profileNames, forwardHeaders);
  } catch {
    refreshed = null;
  }
  if (refreshed && refreshed.ok) {
    res.writeHead(200, {
      ...refreshed.responseHeaders,
      "Content-Type": refreshed.contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(refreshed.body);
    logRequest({
      route: "/last",
      status: 200,
      profiles: profileNames,
      output,
      app,
      device,
      cache: "refreshed",
      contentType: refreshed.contentType,
      bytes: refreshed.body.length,
      durationMs: Date.now() - startedAtMs,
    });
    return;
  }
  if (refreshed && !refreshed.ok) {
    logRequest({
      route: "/last",
      status: 200,
      profiles: profileNames,
      output,
      app,
      device,
      cache: "refresh-failed",
      durationMs: Date.now() - startedAtMs,
      error: refreshed.error,
    });
  }

  const key = cacheKey(subUrl, output, profileNames.join(","));
  const path = cachePathForKey(key);
  try {
    let contentType = "text/yaml; charset=utf-8";
    let responseHeaders = {};
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPathForKey(key), "utf8"));
      if (meta && typeof meta.contentType === "string") {
        contentType = meta.contentType;
      }
      if (meta && typeof meta.responseHeaders === "object" && meta.responseHeaders) {
        responseHeaders = meta.responseHeaders;
      }
    } catch {
      // ignore missing/invalid metadata
    }
    const body = fs.readFileSync(path);
    res.writeHead(200, {
      ...responseHeaders,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
    if (!refreshed || refreshed.ok !== true) {
      logRequest({
        route: "/last",
        status: 200,
        profiles: profileNames,
        output,
        app,
        device,
        cache: "hit",
        contentType,
        bytes: body.length,
        durationMs: Date.now() - startedAtMs,
      });
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("no cached subscription for provided parameters");
      logRequest({
        route: "/last",
        status: 404,
        profiles: profileNames,
        output,
        app,
        device,
        cache: "miss",
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("failed to read cached subscription");
    logRequest({
      route: "/last",
      status: 500,
      profiles: profileNames,
      output,
      app,
      device,
      durationMs: Date.now() - startedAtMs,
      error: err?.message || String(err),
    });
  }
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleEcho(req, res) {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  try {
    const rawBody = await readRequestBody(req);
    const bodyText = rawBody.toString("utf8");
    const query = {};
    for (const [k, v] of reqUrl.searchParams.entries()) {
      if (query[k] === undefined) {
        query[k] = v;
      } else if (Array.isArray(query[k])) {
        query[k].push(v);
      } else {
        query[k] = [query[k], v];
      }
    }
    const payload = {
      ok: true,
      method: req.method || "GET",
      path: reqUrl.pathname,
      query,
      headers: req.headers,
      body: bodyText,
      bodyBase64: rawBody.toString("base64"),
      bodyBytes: rawBody.length,
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(e?.message || "failed to read request body");
  }
}

export {
  parseProfileYaml,
  readProfileFile,
  profileExists,
  pickUserAgentProfile,
  resolveRequestConfig,
  produceOutput,
  handleSubscription,
  handleLast,
  handleEcho,
  serveStaticFile,
};
