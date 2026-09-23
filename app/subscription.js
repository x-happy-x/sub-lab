import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUB_URL_DEFAULT,
  CONVERTER_URL,
  SOURCE_URL,
  PROFILE_ROOT_DIRS,
  HEADER_POLICY_DEFAULT,
  OUTPUT_RAW,
  OUTPUT_RAW_BASE64,
  OUTPUT_JSON,
  OUTPUT_CLASH,
  OUTPUT_CLASH_PROVIDER,
  OUTPUT_DEFAULT,
  OUT_RAW,
  OUT_YAML,
  OUT_STATUS,
  OUT_CONVERTED,
  SOURCE_PATH,
  CACHE_DIR,
  DATA_DIR,
  normalizeOutput,
} from "./config.js";
import { resolveLocalSourceFilePath } from "./local-sources.js";
import { getMergedSource } from "./local-sources.js";
import { buildMergedResponseHeaders, dedupeServerNames, filterRawBody, nameFromRawLine, rawLines } from "./merge-source.js";
import { parseBulkProxyText } from "./proxy-import.js";
import {
  NODES_MODES,
  NODES_COLLAPSE,
  NODES_GROUP,
  NODES_EXPAND,
  PARSER_VERSION,
  NODES_MODE_DEFAULT,
  normalizeNodesMode,
} from "./model/normalized.js";
import { decodeBase64IfNeeded, detectSourceFormat, parseSource } from "./model/parse-source.js";
import { buildClashProxiesAndGroups, renderOutput, renderRaw } from "./model/render.js";
import {
  buildRawUriFromProxy,
  buildYaml,
  convertClashYamlToRawUris,
  extractTopLevelYamlSection,
  formatYamlScalar,
  looksLikeClashProviderYaml,
  looksLikeFullClashConfig,
  parseClashProxyGroups,
  parseClashProxyList,
  parseClashRules,
  parseInlineYamlMap,
  parseYamlListBlocks,
  parseYamlProxyBlock,
  patchClashProxyGroupsInOriginalText,
  replaceTopLevelYamlSection,
  shouldWrapClashProviderForFlClash,
  unquoteYamlValue,
} from "./model/yaml.js";
import {
  buildSubscriptionFeedKey,
  getSubscriptionFeedByKey,
  upsertSubscriptionFeed,
  createSourceSnapshot,
  createNormalizedSnapshot,
  getLatestSourceSnapshotForFeed,
  getNormalizedSnapshotBySourceSnapshotId,
  getSubscriptionOverridesForFeed,
} from "./sqlite-store.js";
import {
  writeRawSourceSnapshotBody,
  writeNormalizedSnapshotFile,
  readSnapshotFile,
  pruneStoredSnapshots,
} from "./source-snapshots.js";
import { getAppsCatalog } from "./apps-catalog.js";
import { decryptHappCrypt5, isEncryptedHappLink } from "./happ-crypt5.js";

const UA_CATALOG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/ua-catalog.json");
const LOCAL_SOURCE_ROOTS = [
  process.cwd(),
  DATA_DIR,
  "/resources",
].map((root) => path.resolve(root));

/**
 * Расшифровать `happ://crypt5/...`.
 *
 * Обычная ссылка проходит насквозь: вызывающей стороне удобнее не разбираться,
 * зашифровано там что-то или нет.
 */
async function decryptHappLink(subUrl) {
  const raw = String(subUrl || "").trim();
  if (!isEncryptedHappLink(raw)) {
    return {
      ok: true,
      changed: false,
      originalUrl: raw,
      resolvedUrl: raw,
      output: raw,
    };
  }
  const resolvedUrl = decryptHappCrypt5(raw);
  return {
    ok: true,
    changed: resolvedUrl !== raw,
    originalUrl: raw,
    resolvedUrl,
    output: resolvedUrl,
  };
}

function isHtml(s) {
  const t = s.trim().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html") || t.startsWith("<iframe");
}

/**
 * Почему вместо подписки пришла страница.
 *
 * Провайдеры отдают HTML в двух совсем разных случаях: их антибот не пустил
 * нас, или у них самих лежит бэкенд. Общее «anti-bot page» на оба случая
 * уводило в неверную сторону — по нему нельзя понять, чинить заголовки или
 * ждать провайдера.
 */
function describeHtmlResponse(rawText) {
  const text = String(rawText || "");
  const head = text.trim().slice(0, 600).toLowerCase();
  const title = /<title>([^<]{1,120})<\/title>/i.exec(text)?.[1]?.trim();
  const serverError = /\b(50[0234])\b/.exec(title || head)?.[1];
  if (serverError) {
    return `провайдер ответил страницей ${serverError}${title ? ` («${title}»)` : ""} — у него проблема на стороне сервера`;
  }
  if (/403|forbidden|access denied|доступ запрещ/i.test(title || head) || /ddos|cloudflare|mitigation|captcha|challenge/i.test(head)) {
    return `провайдер вернул страницу защиты от ботов${title ? ` («${title}»)` : ""} — запрос не прошёл его фильтр`;
  }
  return `вместо подписки пришла HTML-страница${title ? ` («${title}»)` : ""}`;
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

function extractConvertibleSource(rawText, options = {}) {
  const t = rawText.trim();
  if ((!t.startsWith("{") || !t.endsWith("}")) && (!t.startsWith("[") || !t.endsWith("]"))) return rawText;
  try {
    const parsed = JSON.parse(t);
    const cryptoLink = parsed?.happ?.cryptoLink;
    if (typeof cryptoLink === "string" && cryptoLink.trim()) {
      return cryptoLink.trim();
    }
  } catch {
    // ignore JSON parse errors; fall back to raw text
  }
  // Бандл Xray разворачивается через нормализованную модель: один конфиг —
  // одна ссылка, служебные outbound-ы внутрь ссылки не попадают.
  const model = parseSource(rawText);
  if (model.meta.sourceFormat !== "json" || model.entries.length === 0) return rawText;
  const links = renderRaw(model, normalizeNodesMode(options.nodesMode));
  return links || rawText;
}

function parseJsonText(rawText, fallback = null) {
  try {
    return JSON.parse(String(rawText || ""));
  } catch {
    return fallback;
  }
}

function buildNormalizedModelFromSource(rawText, contentType = "") {
  const model = parseSource(rawText, contentType);
  return {
    sourceFormat: model.meta.sourceFormat,
    model,
    warnings: model.meta.warnings,
    lossFlags: model.meta.lossFlags,
  };
}

function sourceFormatMatchesOutput(sourceFormat, output) {
  const format = String(sourceFormat || "").trim().toLowerCase();
  const target = String(output || "").trim().toLowerCase();
  if (!format || !target) return false;
  if ((format === "yml" || format === "yaml") && target === OUTPUT_CLASH) return true;
  if (format === "json" && target === OUTPUT_JSON) return true;
  if (format === "raw" && target === OUTPUT_RAW) return true;
  if (format === "raw(base64)" && target === OUTPUT_RAW_BASE64) return true;
  return false;
}

function hasMeaningfulOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") return false;
  return Object.keys(overrides).length > 0;
}

function applyNodeOverrides(node, override = {}) {
  const next = JSON.parse(JSON.stringify(node || {}));
  if (typeof override.name === "string" && override.name.trim()) next.name = override.name.trim();
  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if (typeof override.host === "string") next.endpoint.host = override.host.trim();
  if (override.port !== undefined && override.port !== null && Number.isFinite(Number(override.port))) {
    next.endpoint.port = Math.max(0, Number(override.port));
  }
  if (typeof override.uuid === "string") next.auth.uuid = override.uuid.trim();
  if (typeof override.password === "string") next.auth.password = override.password;
  if (typeof override.network === "string") next.transport.network = override.network.trim();
  if (typeof override.path === "string") next.transport.path = override.path;
  if (typeof override.hostHeader === "string") next.transport.host = override.hostHeader;
  if (typeof override.serviceName === "string") next.transport.serviceName = override.serviceName;
  if (typeof override.security === "string") next.security.mode = override.security.trim();
  if (typeof override.sni === "string") next.security.sni = override.sni;
  if (typeof override.fp === "string") next.security.fp = override.fp;
  if (typeof override.pbk === "string") next.security.pbk = override.pbk;
  if (typeof override.sid === "string") next.security.sid = override.sid;
  return next;
}

/**
 * Правки поверх модели.
 *
 * Узлы адресуются по id и по имени внутри своей записи; правки записи
 * (`entries.byId`) переименовывают и выключают строку целиком. Любая правка
 * снимает короткий путь «отдать исходник как есть»: `native` больше не
 * описывает то, что мы собираемся отдать.
 */
function applyOverridesToNormalized(model, overrides) {
  if (!hasMeaningfulOverrides(overrides)) return model;
  const next = JSON.parse(JSON.stringify(model || {}));
  const nodeOverrides = overrides?.nodes && typeof overrides.nodes === "object" ? overrides.nodes : {};
  const byId = nodeOverrides.byId && typeof nodeOverrides.byId === "object" ? nodeOverrides.byId : {};
  const byName = nodeOverrides.byName && typeof nodeOverrides.byName === "object" ? nodeOverrides.byName : {};
  const disabledIds = Array.isArray(nodeOverrides.disabledIds)
    ? new Set(nodeOverrides.disabledIds.map((item) => String(item)))
    : new Set();
  const entryOverrides = overrides?.entries && typeof overrides.entries === "object" ? overrides.entries : {};
  const entriesById = entryOverrides.byId && typeof entryOverrides.byId === "object" ? entryOverrides.byId : {};
  const disabledEntryIds = Array.isArray(entryOverrides.disabledIds)
    ? new Set(entryOverrides.disabledIds.map((item) => String(item)))
    : new Set();

  next.entries = (Array.isArray(next.entries) ? next.entries : []).map((entry) => {
    const entryPatch = entriesById[String(entry?.id || "")];
    const patched = { ...entry };
    if (entryPatch && typeof entryPatch === "object") {
      if (typeof entryPatch.name === "string" && entryPatch.name.trim()) patched.name = entryPatch.name.trim();
      if (typeof entryPatch.enabled === "boolean") patched.enabled = entryPatch.enabled;
    }
    if (disabledEntryIds.has(String(entry?.id || ""))) patched.enabled = false;

    patched.nodes = (Array.isArray(entry?.nodes) ? entry.nodes : []).map((node) => {
      const idKey = String(node?.id || "");
      const nameKey = String(node?.name || "");
      const merged = {
        ...(byId[idKey] && typeof byId[idKey] === "object" ? byId[idKey] : {}),
        ...(byName[nameKey] && typeof byName[nameKey] === "object" ? byName[nameKey] : {}),
      };
      const applied = applyNodeOverrides(node, merged);
      if (disabledIds.has(idKey)) applied.enabled = false;
      return applied;
    });

    // Представитель мог быть выключен — берём первый живой узел записи.
    if (!patched.nodes.some((node) => node.id === patched.primaryNodeId && node.enabled !== false)) {
      const fallback = patched.nodes.find((node) => node.enabled !== false);
      patched.primaryNodeId = fallback ? fallback.id : "";
    }
    // У плоского источника запись и есть её единственный узел: переименование
    // узла должно менять и строку списка.
    if (patched.nodes.length === 1 && !(entryPatch && typeof entryPatch.name === "string")) {
      patched.name = patched.nodes[0].name;
    }
    // Исходник больше не описывает результат.
    patched.native = null;
    return patched;
  });

  const topologyOverrides = overrides?.topology && typeof overrides.topology === "object" ? overrides.topology : {};
  const policyOverrides = overrides?.policy && typeof overrides.policy === "object" ? overrides.policy : {};

  if (topologyOverrides.proxyGroups) {
    const value = topologyOverrides.proxyGroups;
    if (Array.isArray(value.replace)) next.groups = value.replace;
    if (value.byName && typeof value.byName === "object") {
      next.groups = (Array.isArray(next.groups) ? next.groups : []).map((group) => {
        const patch = value.byName[String(group?.name || "")];
        return patch && typeof patch === "object" ? { ...group, ...patch } : group;
      });
    }
  }

  if (topologyOverrides.balancers?.byEntryId && typeof topologyOverrides.balancers.byEntryId === "object") {
    const patches = topologyOverrides.balancers.byEntryId;
    next.entries = next.entries.map((entry) => {
      const patch = patches[String(entry?.id || "")];
      return Array.isArray(patch) ? { ...entry, topology: { ...entry.topology, balancers: patch } } : entry;
    });
  }

  if (policyOverrides.rules) {
    const value = policyOverrides.rules;
    if (Array.isArray(value.replace)) next.policy.rules = value.replace;
    if (Array.isArray(value.append) && value.append.length > 0) {
      next.policy.rules = [...(Array.isArray(next.policy?.rules) ? next.policy.rules : []), ...value.append];
    }
  }

  if (policyOverrides.dns && typeof policyOverrides.dns === "object") {
    next.policy.dns = {
      ...(next.policy?.dns && typeof next.policy.dns === "object" ? next.policy.dns : {}),
      ...policyOverrides.dns,
    };
  }

  next.meta = {
    ...(next.meta && typeof next.meta === "object" ? next.meta : {}),
    overridesApplied: true,
    overrideVersion: Number(overrides?.version || 0) || undefined,
  };
  return next;
}

function contentTypeForSnapshotOutput(output) {
  if (output === OUTPUT_JSON) return "application/json; charset=utf-8";
  if (output === OUTPUT_CLASH) return "text/yaml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/**
 * Вывод из модели. Пока правок нет, Clash-источник отдаётся своим исходным
 * текстом, а JSON-бандл — своими же конфигами: обратная конвертация ничего
 * не теряет и режим узлов на неё не влияет.
 */
async function renderOutputFromNormalized(model, output, options = {}) {
  if (!model || !Array.isArray(model.entries)) return { ok: false, error: "empty normalized snapshot" };
  const sourceFormat = String(model?.meta?.sourceFormat || "").trim().toLowerCase();
  const overridden = Boolean(model?.meta?.overridesApplied);
  const mode = normalizeNodesMode(options.nodesMode);

  if (sourceFormat === "yml" && output === OUTPUT_CLASH) {
    const originalText = String(model?.native?.text || "").trim();
    if (originalText && !overridden) {
      return { ok: true, body: originalText, contentType: contentTypeForSnapshotOutput(output), conversion: "normalized-clash-native" };
    }
    // С правками правим исходный YAML на месте: всё, что мы не разбираем,
    // остаётся в нём нетронутым.
    if (originalText) {
      let patched = originalText;
      if (model?.policy?.dns?.raw) {
        patched = replaceTopLevelYamlSection(patched, "dns", String(model.policy.dns.raw));
      }
      if (Array.isArray(model?.policy?.rules) && model.policy.rules.length > 0) {
        patched = replaceTopLevelYamlSection(patched, "rules", `rules:\n${buildYaml(model.policy.rules, 1)}`);
      }
      if (Array.isArray(model?.groups) && model.groups.length > 0) {
        patched = patchClashProxyGroupsInOriginalText(patched, model.groups);
      }
      return { ok: true, body: patched, contentType: contentTypeForSnapshotOutput(output), conversion: "normalized-clash-patched" };
    }
  }

  if (output === OUTPUT_CLASH) {
    // Clash строим через общий сборщик: он даёт AUTO/PROXY и группы из clash_groups.
    const { proxies, entryGroups } = buildClashProxiesAndGroups(model, mode);
    if (proxies.length === 0) return { ok: false, error: "no nodes in normalized snapshot" };
    const groups = entryGroups
      .filter((group) => group.type === "url-test")
      .map((group) => ({ groupName: group.name, autoName: `AUTO · ${group.name}`, proxies: group.proxies }));
    const body = renderFullClashConfig(proxies, groups, "", options);
    if (!body) return { ok: false, error: "no nodes in normalized snapshot" };
    return { ok: true, body, contentType: contentTypeForSnapshotOutput(output), conversion: "normalized-clash" };
  }

  const rendered = renderOutput(model, output, mode, options);
  if (!rendered.body) return { ok: false, error: "no nodes in normalized snapshot" };
  const conversion = output === OUTPUT_JSON && !overridden && sourceFormat === "json"
    ? "normalized-json-native"
    : `normalized-${output}`;
  return { ok: true, body: rendered.body, contentType: rendered.contentType, conversion };
}
async function loadLatestStoredSnapshotBundle({ subUrl = "", app = "", device = "", profileNames = [], forwardHeaders = {} }) {
  const feedKey = buildSubscriptionFeedKey({
    subUrl,
    app,
    device,
    profiles: profileNames,
    hwid: String(forwardHeaders?.["x-hwid"] || "").trim(),
  });
  const feed = await getSubscriptionFeedByKey(feedKey);
  if (!feed?.id) return null;
  const sourceSnapshot = await getLatestSourceSnapshotForFeed(feed.id);
  if (!sourceSnapshot) return null;
  const normalizedSnapshot = await getNormalizedSnapshotBySourceSnapshotId(sourceSnapshot.id);
  const overrides = await getSubscriptionOverridesForFeed(feed.id);
  return {
    feed,
    sourceSnapshot,
    normalizedSnapshot,
    overrides,
  };
}

async function respondFromStoredSnapshot(res, bundle, output, options = {}) {
  if (!bundle?.sourceSnapshot) return false;
  const sameFormat = sourceFormatMatchesOutput(bundle.sourceSnapshot.sourceFormat, output) && !hasMeaningfulOverrides(bundle?.overrides?.overrides);
  let body = "";
  let contentType = contentTypeForSnapshotOutput(output);
  let extraHeaders = sanitizeUpstreamResponseHeaders(bundle.sourceSnapshot.responseHeaders || {});

  if (sameFormat) {
    body = readSnapshotFile(bundle.sourceSnapshot.bodyPath);
    contentType =
      String(bundle.sourceSnapshot.responseHeaders?.["content-type"] || "").trim() ||
      String(bundle.sourceSnapshot.responseHeaders?.["Content-Type"] || "").trim() ||
      contentTypeForSnapshotOutput(output);
  } else {
    if (!bundle.normalizedSnapshot?.normalizedPath) return false;
    const normalized = applyOverridesToNormalized(
      JSON.parse(readSnapshotFile(bundle.normalizedSnapshot.normalizedPath)),
      bundle?.overrides ? { ...bundle.overrides.overrides, version: bundle.overrides.version } : null,
    );
    const rendered = await renderOutputFromNormalized(normalized, output, options);
    if (!rendered.ok) return false;
    body = String(rendered.body || "");
    contentType = rendered.contentType || contentType;
  }

  res.writeHead(200, {
    ...extraHeaders,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
  return true;
}

function extractVlessLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("vless://"));
}

function extractSubscriptionLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(vmess|vless|ss|ssr|trojan):\/\//.test(line));
}

function normalizeJsonNodeName(value, fallback = "node") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function buildXrayStreamSettings(item) {
  const network = String(item?.network || "tcp").trim() || "tcp";
  const security = String(item?.security || "none").trim() || "none";
  const settings = {
    network,
  };

  if (security && security !== "none") settings.security = security;

  if (security === "reality") {
    settings.realitySettings = {
      show: false,
    };
    if (item?.servername) settings.realitySettings.serverName = String(item.servername);
    if (item?.publicKey) settings.realitySettings.publicKey = String(item.publicKey);
    if (item?.shortId) settings.realitySettings.shortId = String(item.shortId);
    if (item?.clientFingerprint) settings.realitySettings.fingerprint = String(item.clientFingerprint);
  } else if (security === "tls" || security === "xtls") {
    settings.tlsSettings = {};
    if (item?.servername) settings.tlsSettings.serverName = String(item.servername);
    const alpn = String(item?.transport?.alpn || "").trim();
    if (alpn) settings.tlsSettings.alpn = alpn.split(",").map((part) => part.trim()).filter(Boolean);
    if (item?.clientFingerprint) settings.tlsSettings.fingerprint = String(item.clientFingerprint);
  }

  if (network === "ws") {
    settings.wsSettings = {};
    if (item?.path) settings.wsSettings.path = String(item.path);
    if (item?.host) settings.wsSettings.headers = { Host: String(item.host) };
  } else if (network === "grpc") {
    settings.grpcSettings = {};
    if (item?.serviceName) settings.grpcSettings.serviceName = String(item.serviceName);
    if (item?.transport?.authority) settings.grpcSettings.authority = String(item.transport.authority);
    if (item?.transport?.mode) settings.grpcSettings.mode = String(item.transport.mode) === "gun";
  } else if (network === "tcp" && item?.transport?.headerType) {
    settings.tcpSettings = {
      header: { type: String(item.transport.headerType) },
    };
  }

  return settings;
}

function buildXrayOutboundFromImportedItem(item, index) {
  const protocol = String(item?.type || "").toLowerCase();
  const name = normalizeJsonNodeName(item?.name, `node-${index + 1}`);
  const tag = `node-${String(index + 1).padStart(4, "0")}`;
  const server = String(item?.server || "").trim();
  const port = Number(item?.port || 0);
  if (!server || !port) return null;

  if (protocol === "vless") {
    const user = {
      id: String(item?.uuid || "").trim(),
      encryption: "none",
    };
    if (item?.flow) user.flow = String(item.flow);
    return {
      tag,
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: server,
            port,
            users: [user],
          },
        ],
      },
      streamSettings: buildXrayStreamSettings(item),
      remarks: name,
    };
  }

  if (protocol === "trojan") {
    return {
      tag,
      protocol: "trojan",
      settings: {
        servers: [
          {
            address: server,
            port,
            password: String(item?.password || ""),
          },
        ],
      },
      streamSettings: buildXrayStreamSettings(item),
      remarks: name,
    };
  }

  if (protocol === "vmess") {
    return {
      tag,
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: server,
            port,
            users: [
              {
                id: String(item?.uuid || "").trim(),
                alterId: Number(item?.transport?.aid || 0),
                security: "auto",
              },
            ],
          },
        ],
      },
      streamSettings: buildXrayStreamSettings(item),
      remarks: name,
    };
  }

  if (protocol === "ss") {
    return {
      tag,
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: server,
            port,
            method: "",
            password: String(item?.password || ""),
          },
        ],
      },
      remarks: name,
    };
  }

  if (protocol === "ssr") {
    return {
      tag,
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: server,
            port,
            method: String(item?.transport?.method || ""),
            password: String(item?.password || ""),
          },
        ],
      },
      remarks: name,
    };
  }

  return null;
}

/**
 * Надо ли пересобирать JSON-подписку ради режима узлов.
 *
 * Пересобираем только когда это на что-то влияет: внутри есть запись с
 * несколькими узлами и выбранный режим отличается от «как есть». В остальных
 * случаях выгоднее отдать конфиг провайдера нетронутым — в нём его dns,
 * inbounds и маршруты, а у нас на их месте был бы шаблон.
 */
function jsonBundleNeedsNodesMode(rawText, options) {
  const mode = normalizeNodesMode(options?.nodesMode);
  try {
    const model = parseSource(rawText);
    if (model.meta.sourceFormat !== "json" || model.entries.length === 0) return false;
    const multi = model.entries.some((entry) => {
      const nodes = Array.isArray(entry?.nodes) ? entry.nodes.filter((node) => node.enabled !== false) : [];
      return nodes.length > 1;
    });
    if (!multi) return false;
    // Пересобирать имеет смысл только ради «развернуть»: только он просит
    // разложить запись на отдельные узлы.
    //
    // «Свернуть» и «группами» в json не требуют ничего: запись провайдера и
    // так одна запись — клиент показывает её одной строкой, а кандидаты живут
    // внутри неё. Пересборка же ради них выбрасывала всё, кроме основного
    // узла (у VPNUS — 11 адресов из 29), и заодно теряла записи с
    // протоколами, которых не знает наш разбор, вроде Hysteria.
    return mode === NODES_EXPAND;
  } catch {
    return false;
  }
}

function buildJsonConfigBundleFromRaw(rawText) {
  const parsed = parseBulkProxyText(rawText);
  const configs = parsed
    .map((item, index) => {
      const outbound = buildXrayOutboundFromImportedItem(item, index);
      if (!outbound) return null;
      return {
        remarks: normalizeJsonNodeName(item.name, `node-${index + 1}`),
        log: {
          loglevel: "warning",
        },
        dns: {
          servers: ["8.8.8.8", "1.1.1.1"],
          queryStrategy: "UseIPv4",
        },
        inbounds: [
          {
            tag: "socks",
            port: 10808,
            listen: "127.0.0.1",
            protocol: "socks",
            settings: {
              udp: true,
              auth: "noauth",
            },
          },
          {
            tag: "http",
            port: 10809,
            listen: "127.0.0.1",
            protocol: "http",
            settings: {},
          },
        ],
        outbounds: [
          outbound,
          { tag: "direct", protocol: "freedom" },
          { tag: "block", protocol: "blackhole" },
        ],
        routing: {
          domainStrategy: "AsIs",
          rules: [
            {
              type: "field",
              protocol: ["bittorrent"],
              outboundTag: "block",
            },
            {
              type: "field",
              // Критерий обязателен: правило без единого поля Xray отвергает
              // с «this rule has no effective fields», и Happ показывает это
              // предупреждение на каждую подписку. tcp+udp — «всё остальное».
              network: "tcp,udp",
              outboundTag: outbound.tag,
            },
          ],
        },
      };
    })
    .filter(Boolean);

  return configs;
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


function sanitizeNodeName(value, fallback = "node") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function buildNodeName(baseName, outboundTag, totalOutbounds, outboundIndex) {
  const base = sanitizeNodeName(baseName, "node");
  const tag = sanitizeNodeName(outboundTag, "");
  if (totalOutbounds <= 1) return base;
  if (tag) return `${base} ${tag}`;
  return `${base} ${outboundIndex + 1}`;
}

function appendSearchParamIfPresent(params, key, value) {
  if (value === undefined || value === null) return;
  const text = String(value).trim();
  if (!text) return;
  params.set(key, text);
}

function vlessToProxy(line) {
  const url = new URL(line);
  const params = url.searchParams;
  const name = decodeURIComponent(url.hash.replace(/^#/, "")) || `${url.hostname}:${url.port || 443}`;
  const network = params.get("type") || "tcp";
  const security = params.get("security") || "none";
  const proxy = {
    name,
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

const CLASH_COUNTRY_GROUP_PRESETS = {
  rf: { name: "РФ", countries: ["🇷🇺", "Россия", "Russia", "RU"] },
  europe: {
    name: "ЕВРОПА",
    countries: ["🇩🇪", "Германия", "Germany", "🇫🇮", "Финляндия", "Finland", "🇸🇪", "Швеция", "Sweden", "🇪🇪", "Эстония", "Estonia", "🇵🇱", "Польша", "Poland", "🇳🇱", "Netherlands", "🇫🇷", "France", "🇬🇧", "UK", "🇱🇹", "Lithuania", "🇱🇻", "Latvia"],
  },
  cis: {
    name: "СНГ",
    countries: ["🇰🇿", "Казахстан", "Kazakhstan", "🇧🇾", "Беларус", "Belarus", "🇦🇲", "Армения", "Armenia", "🇦🇿", "Азербайджан", "Azerbaijan", "🇰🇬", "Киргиз", "Kyrgyz", "🇺🇿", "Узбекистан", "Uzbek", "🇹🇯", "Таджикистан", "Tajik", "🇲🇩", "Молд", "Moldova"],
  },
};

function parseClashGroupsConfig(input) {
  if (!input) return [];
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }
  }
  const source = Array.isArray(parsed) ? parsed : [];
  return source
    .map((item) => {
      const type = String(item?.type || "").trim().toLowerCase();
      const preset = String(item?.preset || "").trim().toLowerCase();
      const name = String(item?.name || "").trim();
      const countries = Array.isArray(item?.countries) ? item.countries.map((value) => String(value || "").trim()).filter(Boolean) : [];
      const regex = String(item?.regex || "").trim();
      if (preset && CLASH_COUNTRY_GROUP_PRESETS[preset]) return { type: "preset", preset, name: name || CLASH_COUNTRY_GROUP_PRESETS[preset].name };
      if (type === "not_rf") return { type: "not_rf", name: name || "ВСЁ КРОМЕ РФ" };
      if (type === "country" && countries.length > 0) return { type: "country", name: name || countries.join(", "), countries };
      if (type === "regex" && regex) return { type: "regex", name: name || regex, regex };
      return null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

function proxyNameMatchesCountries(proxyName, countries) {
  const name = String(proxyName || "");
  const lower = name.toLowerCase();
  return countries.some((country) => {
    const token = String(country || "").trim();
    return token && (name.includes(token) || lower.includes(token.toLowerCase()));
  });
}

function proxyNameMatchesClashGroup(proxyName, group) {
  if (!group) return false;
  if (group.type === "preset") {
    const preset = CLASH_COUNTRY_GROUP_PRESETS[group.preset];
    return preset ? proxyNameMatchesCountries(proxyName, preset.countries) : false;
  }
  if (group.type === "not_rf") return !proxyNameMatchesCountries(proxyName, CLASH_COUNTRY_GROUP_PRESETS.rf.countries);
  if (group.type === "country") return proxyNameMatchesCountries(proxyName, group.countries);
  if (group.type === "regex") {
    try {
      return new RegExp(group.regex, "i").test(String(proxyName || ""));
    } catch {
      return false;
    }
  }
  return false;
}

function buildConfiguredClashGroups(proxyNames, config) {
  return parseClashGroupsConfig(config)
    .map((group) => ({
      name: group.name,
      autoName: `AUTO · ${group.name}`,
      proxies: proxyNames.filter((proxyName) => proxyNameMatchesClashGroup(proxyName, group)),
    }))
    .filter((group) => group.proxies.length > 1);
}

function renderFullClashConfig(proxies, groups = [], proxiesYamlText = "", options = {}) {
  const proxyNames = proxies
    .map((proxy) => sanitizeNodeName(proxy?.name, "proxy"))
    .filter(Boolean);
  if (proxyNames.length === 0) return "";

  const effectiveGroups = Array.isArray(groups) && groups.length > 0
    ? groups.filter((group) => group?.autoName && Array.isArray(group.proxies) && group.proxies.length > 0)
    : buildAutoProxyGroups(proxyNames);
  const allGroups = [...buildConfiguredClashGroups(proxyNames, options.clashGroups), ...effectiveGroups];
  const proxyGroups = [];
  for (const group of allGroups) {
    proxyGroups.push({
      name: group.autoName,
      type: "url-test",
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
      proxies: group.proxies,
    });
  }
  const autoTargets = allGroups.length > 0 ? allGroups.map((group) => group.autoName) : proxyNames;
  proxyGroups.push(
    {
      name: "AUTO",
      type: "url-test",
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
      proxies: autoTargets,
    },
    {
      name: "PROXY",
      type: "select",
      proxies: ["AUTO", "DIRECT", ...autoTargets, ...proxyNames],
    },
  );
  const rules = ["MATCH,PROXY"];

  return [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "unified-delay: true",
    String(proxiesYamlText || "").trim() || `proxies:\n${buildYaml(proxies, 1)}`,
    `proxy-groups:\n${buildYaml(proxyGroups, 1)}`,
    `rules:\n${buildYaml(rules, 1)}`,
  ].join("\n");
}

function convertJsonConfigToClash(rawText, options = {}) {
  const model = parseSource(rawText);
  if (model.meta.sourceFormat !== "json" || model.entries.length === 0) return null;
  const mode = normalizeNodesMode(options.nodesMode);
  const { proxies, entryGroups } = buildClashProxiesAndGroups(model, mode);
  if (proxies.length === 0) return null;
  // В режиме групп запись с кандидатами становится собственной url-test группой.
  const groups = entryGroups
    .filter((group) => group.type === "url-test")
    .map((group) => ({ groupName: group.name, autoName: `AUTO · ${group.name}`, proxies: group.proxies }));
  return renderFullClashConfig(proxies, groups, "", options);
}

function convertVlessListToClash(text) {
  const lines = extractVlessLines(text);
  if (lines.length === 0) return null;
  const proxies = lines.map(vlessToProxy);
  const yaml = `proxies:\n${buildYaml(proxies, 1)}`;
  return yaml;
}

function normalizeAutoGroupName(proxyName) {
  const name = sanitizeNodeName(proxyName, "");
  if (!name) return "";
  const withoutGrp = name
    .replace(/\s+grp[-_ ]?\d+(?:[-_]\d+)*(?:[-_][A-Za-z0-9]+)?\s*$/i, "")
    .trim();
  if (withoutGrp && withoutGrp !== name) return withoutGrp;

  const withoutNode = name
    .replace(/\s+(?:node|сервер|server)[-_ ]?\d+\s*$/i, "")
    .trim();
  if (withoutNode && withoutNode !== name) return withoutNode;

  const withoutTrailingIndex = name
    .replace(/\s+#?\d+\s*$/i, "")
    .trim();
  if (withoutTrailingIndex && withoutTrailingIndex !== name) return withoutTrailingIndex;

  return name;
}

function buildAutoProxyGroups(proxyNames) {
  const grouped = new Map();
  for (const proxyName of proxyNames) {
    const groupName = normalizeAutoGroupName(proxyName);
    if (!groupName) continue;
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    grouped.get(groupName).push(proxyName);
  }

  const groups = [...grouped.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([groupName, names]) => ({
      groupName,
      autoName: `AUTO · ${groupName}`,
      proxies: names,
    }));

  return groups.length > 1 ? groups : [];
}

function wrapClashProviderAsFullConfig(yamlText, options = {}) {
  const text = String(yamlText || "").trim();
  if (!shouldWrapClashProviderForFlClash(text)) return text;

  const proxyNames = parseClashProxyList(text)
    .map((proxy) => sanitizeNodeName(proxy?.name, "proxy"))
    .filter(Boolean);
  if (proxyNames.length === 0) return text;

  const autoGroups = buildAutoProxyGroups(proxyNames);
  return renderFullClashConfig(parseClashProxyList(text), autoGroups, text, options);
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
      key === "x-output-auto" ||
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

function normalizeOutputAutoFlag(v) {
  const value = firstHeaderValue(v);
  if (value === undefined || value === null || value === "") return undefined;
  return parseBool(value, false);
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
  const dirs = [];
  for (const root of PROFILE_ROOT_DIRS) {
    dirs.push(path.join(root, "profiles"));
    dirs.push(path.join(root, "base"));
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

function defaultUaCatalog() {
  return {
    __default__: "SubLab/UA Default (Windows)",
    windows: {
      flclashx: "FlClash X/0.8.74 (Windows 11; Win64; x64)",
      happ: "Happ/1.2.0 (Windows 11; Win64; x64)",
    },
  };
}

function readUaCatalog() {
  try {
    if (!fs.existsSync(UA_CATALOG_PATH)) return defaultUaCatalog();
    const parsed = JSON.parse(fs.readFileSync(UA_CATALOG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultUaCatalog();
    }
    return parsed;
  } catch {
    return defaultUaCatalog();
  }
}

function getUaCatalogOptions() {
  const raw = readUaCatalog();
  const options = {};
  for (const [osKey, apps] of Object.entries(raw)) {
    if (osKey === "__default__") continue;
    if (!apps || typeof apps !== "object" || Array.isArray(apps)) continue;
    const appMap = {};
    for (const [appKey, ua] of Object.entries(apps)) {
      const safeApp = sanitizeProfileToken(appKey);
      if (!safeApp) continue;
      const text = String(ua || "").trim();
      if (!text) continue;
      appMap[safeApp] = text;
    }
    if (Object.keys(appMap).length > 0) {
      const safeOs = sanitizeProfileToken(osKey);
      if (safeOs) options[safeOs] = appMap;
    }
  }
  const defaultUa = typeof raw.__default__ === "string" && raw.__default__.trim()
    ? raw.__default__.trim()
    : "";
  return { options, defaultUa };
}

function normalizeAppMatchToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveKnownAppKeyFromUserAgent(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return "";
  if (/\bhapp\/\d+(?:\.\d+)*(?:\/|$)/i.test(ua)) return "happ";
  if (/\bclash\.meta\/v?\d+(?:\.\d+)*(?:\b|$)/i.test(ua)) return "clash-meta";
  if (/\bflclash\s*x\/v?\d+(?:\.\d+)*(?:\b|$)/i.test(ua)) return "flclashx";
  return "";
}

function resolveAppKeyFromUserAgent(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return "";
  const knownAppKey = resolveKnownAppKeyFromUserAgent(ua);
  if (knownAppKey) return knownAppKey;
  const compactUa = normalizeAppMatchToken(ua);
  if (!compactUa) return "";

  const { options } = getUaCatalogOptions();
  for (const appMap of Object.values(options)) {
    if (!appMap || typeof appMap !== "object") continue;
    for (const [appKey, catalogUa] of Object.entries(appMap)) {
      const compactCatalogUa = normalizeAppMatchToken(catalogUa);
      if (compactCatalogUa && (compactUa.includes(compactCatalogUa) || compactCatalogUa.includes(compactUa))) {
        return sanitizeProfileToken(appKey);
      }
    }
  }

  const catalog = getAppsCatalog();
  for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
    const keyToken = normalizeAppMatchToken(item?.key || "");
    const labelToken = normalizeAppMatchToken(item?.label || "");
    if ((keyToken && compactUa.includes(keyToken)) || (labelToken && compactUa.includes(labelToken))) {
      return sanitizeProfileToken(item?.key || "");
    }
  }
  return "";
}

function resolveOutputFromUserAgent(userAgent, fallbackOutput = OUTPUT_DEFAULT) {
  const fallback = normalizeOutput(fallbackOutput) || OUTPUT_DEFAULT;
  const appKey = resolveAppKeyFromUserAgent(userAgent);
  if (!appKey) {
    return { output: fallback, app: "", matched: false };
  }
  const catalog = getAppsCatalog();
  const item = Array.isArray(catalog.items)
    ? catalog.items.find((entry) => sanitizeProfileToken(entry?.key || "") === appKey)
    : null;
  const supported = (Array.isArray(item?.formats) ? item.formats : [])
    .map((value) => outputFromCatalogFormat(value))
    .filter(Boolean);
  // Про клиента ничего не знаем — отдаём то, что выбрано в подписке.
  if (supported.length === 0) {
    return { output: fallback, app: appKey, matched: true, bySource: false };
  }
  // Клиент читает и плоский список, и бандл Xray (это про Happ). Что из двух
  // отдать, решает формат источника: json имеет смысл, когда источник сам
  // json, иначе это тот же список, только втрое объёмнее. Окончательный выбор
  // делается после запроса к провайдеру — здесь его ещё не из чего сделать.
  if (supported.includes(OUTPUT_RAW) && supported.includes(OUTPUT_JSON)) {
    return { output: OUTPUT_RAW, app: appKey, matched: true, bySource: true };
  }
  // Файл для proxy-providers — тоже Clash, просто другой роли. Клиенту Clash
  // подменять его полным конфигом нельзя: его туда и выбрали осознанно.
  if (supported.includes(OUTPUT_CLASH) && fallback === OUTPUT_CLASH_PROVIDER) {
    return { output: OUTPUT_CLASH_PROVIDER, app: appKey, matched: true, bySource: false };
  }
  return { output: supported[0], app: appKey, matched: true, bySource: false };
}

/**
 * Окончательный формат для клиентов, у которых он зависит от источника.
 *
 * Объединение — особый случай: оно собирается из разных источников, часть из
 * которых не json вовсе, и приводить их к json всё равно приходится. Раз
 * клиент json читает, отдаём ему json целиком.
 */
function finalizeOutputBySource(output, bySource, subUrl, body, contentType = "") {
  if (!bySource) return output;
  if (String(subUrl || "").startsWith("merge:")) return OUTPUT_JSON;
  return detectSourceFormat(body, contentType) === "json" ? OUTPUT_JSON : OUTPUT_RAW;
}

/** Формат из каталога приложений — в выходной формат панели. */
function outputFromCatalogFormat(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "raw") return OUTPUT_RAW;
  if (token === "raw_base64" || token === "base64") return OUTPUT_RAW_BASE64;
  if (token === "json") return OUTPUT_JSON;
  if (token === "yml" || token === "yaml" || token === "clash") return OUTPUT_CLASH;
  return "";
}

function normalizeClashGroupsParam(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const groups = parseClashGroupsConfig(parsed);
    return groups.length > 0 ? JSON.stringify(groups) : "";
  } catch {
    return "";
  }
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
  const { options, defaultUa } = getUaCatalogOptions();
  const appToken = sanitizeProfileToken(app);
  const deviceToken = sanitizeProfileToken(device);
  if (!appToken && !deviceToken) {
    return defaultUa
      ? { ok: true, headers: { "user-agent": defaultUa }, source: "default" }
      : { ok: true, headers: {}, source: "" };
  }
  if (!appToken && deviceToken) {
    return { ok: false, error: "app is required when device is provided" };
  }

  if (deviceToken) {
    const perOs = options[deviceToken];
    if (perOs && perOs[appToken]) {
      return {
        ok: true,
        headers: { "user-agent": perOs[appToken] },
        source: `${deviceToken}:${appToken}`,
      };
    }
  }

  if (!deviceToken) {
    for (const [osKey, appMap] of Object.entries(options)) {
      if (appMap && appMap[appToken]) {
        return {
          ok: true,
          headers: { "user-agent": appMap[appToken] },
          source: `${osKey}:${appToken}`,
        };
      }
    }
  }

  if (defaultUa) {
    return { ok: true, headers: { "user-agent": defaultUa }, source: "default" };
  }
  return { ok: true, headers: {}, source: "" };
}

function mergeProfiles(profileNames) {
  const merged = {
    subUrl: "",
    output: undefined,
    headerPolicy: HEADER_POLICY_DEFAULT,
    allowHwidOverride: true,
    headers: {},
    requiredHeaders: [],
    lockedHeaders: {},
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
    if (name.startsWith("ua-")) {
      for (const [k, v] of Object.entries(profile.headers || {})) {
        if (v !== undefined && v !== null && v !== "") {
          merged.lockedHeaders[k] = String(v);
        }
      }
    }
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

function resolveForwardHeaders(reqHeaders, profile, hwidFromQuery, hwidFromHeader) {
  const incoming = sanitizeForwardHeaders(reqHeaders);
  const fromProfile = { ...profile.headers };
  const lockedHeaders = profile.lockedHeaders && typeof profile.lockedHeaders === "object"
    ? profile.lockedHeaders
    : {};

  // Query hwid (UI override) always wins.
  if (hwidFromQuery) {
    fromProfile["x-hwid"] = hwidFromQuery;
  } else if (hwidFromHeader && profile.allowHwidOverride !== false) {
    // Client-provided x-hwid can override only when profile allows it.
    fromProfile["x-hwid"] = hwidFromHeader;
  }

  // When override is disabled in profile, ignore client x-hwid header.
  if (profile.allowHwidOverride === false) {
    delete incoming["x-hwid"];
  }

  if (profile.headerPolicy === "require_request") {
    for (const required of profile.requiredHeaders) {
      if (!incoming[required]) {
        return { ok: false, error: `required header is missing: ${required}` };
      }
    }
  }

  const merged =
    profile.headerPolicy === "file_only"
      ? { ...incoming, ...fromProfile }
      : { ...fromProfile, ...incoming };
  for (const [k, v] of Object.entries(lockedHeaders)) {
    merged[k] = v;
  }
  if (hwidFromQuery) {
    merged["x-hwid"] = hwidFromQuery;
  }
  return { ok: true, headers: merged };
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

  const merged = mergeProfiles(profileNames);
  if (!merged.ok) {
    return { ok: false, status: 400, error: merged.error };
  }
  if (uaProfile.headers && uaProfile.headers["user-agent"]) {
    merged.profile.headers["user-agent"] = uaProfile.headers["user-agent"];
    merged.profile.lockedHeaders["user-agent"] = uaProfile.headers["user-agent"];
  }

  const subFromQuery = reqUrl.searchParams.get("sub_url");
  const subFromHeader = firstHeaderValue(reqHeaders["x-sub-url"]);
  const subUrl = subFromQuery || subFromHeader || merged.profile.subUrl || SUB_URL_DEFAULT;

  const outputFromQuery = reqUrl.searchParams.get("output");
  const outputFromHeader = reqHeaders["x-output"];
  const explicitOutput = parseOptionalOutput(outputFromQuery ?? outputFromHeader);
  if ((outputFromQuery || outputFromHeader) && !explicitOutput) {
    return { ok: false, status: 400, error: "unsupported output (use: clash|yml|yaml|raw|raw_base64|json)" };
  }
  const outputAutoFromQuery = reqUrl.searchParams.get("output_auto");
  const outputAutoFromHeader = reqHeaders["x-output-auto"];
  const outputAuto = normalizeOutputAutoFlag(outputAutoFromQuery ?? outputAutoFromHeader) === true;

  const legacyFromQuery = reqUrl.searchParams.get("use_converter");
  const legacyFromHeader = reqHeaders["x-use-converter"];
  const explicitLegacyUseConverter = parseOptionalBool(legacyFromQuery ?? legacyFromHeader);
  const fallbackOutput =
    explicitOutput ??
    (explicitLegacyUseConverter !== undefined
      ? explicitLegacyUseConverter
        ? OUTPUT_CLASH
        : OUTPUT_RAW
      : merged.profile.output || OUTPUT_DEFAULT);
  const requestUserAgent = String(firstHeaderValue(reqHeaders["user-agent"]) || "").trim();
  const auto = outputAuto && requestUserAgent
    ? resolveOutputFromUserAgent(requestUserAgent, fallbackOutput)
    : null;
  const output = auto ? auto.output : fallbackOutput;
  const outputBySource = Boolean(auto?.bySource);

  const hwidFromQuery = String(reqUrl.searchParams.get("hwid") || "").trim();
  const hwidFromHeader = String(firstHeaderValue(reqHeaders["x-hwid"]) || "").trim();
  const resolvedHeaders = resolveForwardHeaders(reqHeaders, merged.profile, hwidFromQuery, hwidFromHeader);
  if (!resolvedHeaders.ok) {
    return { ok: false, status: 400, error: resolvedHeaders.error };
  }
  const clashGroups = normalizeClashGroupsParam(
    reqUrl.searchParams.get("clash_groups") ?? firstHeaderValue(reqHeaders["x-clash-groups"]),
  );
  const nodesMode = normalizeNodesMode(
    reqUrl.searchParams.get("nodes") ?? firstHeaderValue(reqHeaders["x-nodes"]),
  );

  return {
    ok: true,
    subUrl,
    output,
    outputAuto,
    // Формат ещё не окончателен: он зависит от того, что пришлёт провайдер.
    outputBySource,
    app,
    device,
    clashGroups,
    nodesMode,
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

function resolveRequesterId(req) {
  if (!req || typeof req !== "object") return "";
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const remote = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "").trim();
  return forwardedFor || remote;
}

function buildSnapshotRequestContext({ route = "", output = "", profileNames = [], app = "", device = "", forwardHeaders = {}, req = null } = {}) {
  return {
    route: String(route || "").trim(),
    output: String(output || "").trim(),
    profileNames: Array.isArray(profileNames) ? profileNames.map((item) => String(item || "").trim()).filter(Boolean) : [],
    app: String(app || "").trim(),
    device: String(device || "").trim(),
    forwardHeaders: sanitizeForwardHeaders(forwardHeaders || {}),
    requestPath: req?.url ? String(req.url) : "",
    requesterId: resolveRequesterId(req),
  };
}

async function persistSuccessfulSourceSnapshot({
  req = null,
  route = "",
  subUrl = "",
  output = "",
  profileNames = [],
  app = "",
  device = "",
  forwardHeaders = {},
  fetched,
}) {
  if (!fetched || Number(fetched.responseStatus || 0) < 200 || Number(fetched.responseStatus || 0) >= 300) {
    return null;
  }
  const body = String(fetched.body || "");
  if (!body) return null;

  const feed = await upsertSubscriptionFeed({
    subUrl,
    app,
    device,
    profiles: profileNames,
    hwid: String(forwardHeaders?.["x-hwid"] || "").trim(),
  });
  const storedBody = writeRawSourceSnapshotBody(
    `${feed.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    body,
  );
  const contentType =
    String(fetched.responseHeaders?.["content-type"] || "").trim() ||
    String(fetched.responseHeaders?.["Content-Type"] || "").trim();
  const sourceFormat = detectSourceFormat(body, contentType);
  const sourceSnapshot = await createSourceSnapshot({
    feedId: feed.id,
    fetchedAt: new Date().toISOString(),
    fetchedByType: route ? `route:${route}` : "route",
    fetchedById: resolveRequesterId(req),
    requestContext: buildSnapshotRequestContext({
      route,
      output,
      profileNames,
      app,
      device,
      forwardHeaders,
      req,
    }),
    responseStatus: fetched.responseStatus,
    responseUrl: fetched.responseUrl,
    responseHeaders: fetched.responseHeaders || {},
    bodyPath: storedBody.path,
    bodySha256: storedBody.sha256,
    bodyBytes: storedBody.bytes,
    sourceFormat,
    sourceFormatDetails: {
      contentType,
      detectedAt: new Date().toISOString(),
    },
  });
  const normalized = buildNormalizedModelFromSource(body, contentType);
  const normalizedStored = writeNormalizedSnapshotFile(
    `${sourceSnapshot.id}-${PARSER_VERSION}`,
    normalized.model,
  );
  await createNormalizedSnapshot({
    feedId: feed.id,
    sourceSnapshotId: sourceSnapshot.id,
    schemaVersion: Number(normalized.model?.schemaVersion || 1),
    parserVersion: PARSER_VERSION,
    normalizedPath: normalizedStored.path,
    normalizedSha256: normalizedStored.sha256,
    warnings: Array.isArray(normalized.warnings) ? normalized.warnings : [],
    lossFlags: Array.isArray(normalized.lossFlags) ? normalized.lossFlags : [],
  });
  await pruneStoredSnapshots(feed.id);
  return sourceSnapshot;
}

async function callSubconverter(target, listMode) {
  const finalUrl = `${CONVERTER_URL}?target=${encodeURIComponent(target)}&url=${encodeURIComponent(
    SOURCE_URL,
  )}&list=${listMode ? "true" : "false"}`;
  const res = await fetch(finalUrl);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`subconverter ${res.status}: ${text.slice(0, 180)}`);
  }
  return text;
}

async function convertViaSubconverter(rawText) {
  if (!CONVERTER_URL) {
    throw new Error("CONVERTER_URL is not set");
  }
  fs.writeFileSync(SOURCE_PATH, rawText);
  const text = await callSubconverter("clash", true);
  fs.writeFileSync(OUT_CONVERTED, text);
  return text;
}

async function convertViaSubconverterToRaw(rawText) {
  if (!CONVERTER_URL) {
    throw new Error("CONVERTER_URL is not set");
  }
  fs.writeFileSync(SOURCE_PATH, rawText);
  try {
    return await callSubconverter("mixed", false);
  } catch {
    return await callSubconverter("mixed", true);
  }
}

function resolveLocalSourcePath(input) {
  const raw = String(input || "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return "";

  if (raw.startsWith("local:")) {
    const filePath = resolveLocalSourceFilePath(raw.slice(6).trim());
    if (filePath && fs.existsSync(filePath)) return filePath;
    return "";
  }

  let candidate = raw;
  if (raw.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return "";
    }
  } else if (raw.startsWith("file:")) {
    candidate = raw.slice(5).trim();
  }

  const possible = [];
  if (path.isAbsolute(candidate)) {
    possible.push(path.resolve(candidate));
  } else {
    possible.push(path.resolve(process.cwd(), candidate));
    possible.push(path.resolve(DATA_DIR, candidate));
    possible.push(path.resolve("/resources", candidate));
  }

  for (const next of possible) {
    if (!LOCAL_SOURCE_ROOTS.some((root) => next === root || next.startsWith(`${root}${path.sep}`))) continue;
    try {
      if (fs.existsSync(next) && fs.statSync(next).isFile()) return next;
    } catch {
      // ignore unreadable candidate
    }
  }
  return "";
}

function buildRequestUrlFromParams(params) {
  const reqUrl = new URL("http://localhost/sub");
  // `nodes` здесь обязателен: без него источник объединения всегда собирался
  // со свёрнутыми узлами, чего бы ни стояло у него в настройках.
  for (const key of ["sub_url", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups", "nodes"]) {
    const value = params?.[key];
    if (value === undefined || value === null || value === "") continue;
    reqUrl.searchParams.set(key, String(value));
  }
  return reqUrl;
}

/**
 * Сборка объединённой подписки.
 *
 * Каждый источник тянется со своими заголовками и приводится к raw, затем из
 * него отбираются серверы по регулярке записи. Заголовки источников сводятся
 * в один `subscription-userinfo`: иначе приложение показало бы объединение как
 * подписку без трафика и без срока.
 */
/**
 * Сборка объединённой подписки.
 *
 * Каждый источник тянется со своими заголовками и приводится к raw, затем из
 * него отбираются серверы по регулярке записи. Заголовки источников сводятся
 * в один `subscription-userinfo`: иначе приложение показало бы объединение как
 * подписку без трафика и без срока.
 *
 * Упавший источник не роняет объединение: провайдеры ложатся поодиночке, и
 * терять из-за одного из них все остальные серверы — хуже, чем отдать
 * неполный список. Ошибка возвращается, только если не собралось вообще
 * ничего: отдавать пустую подписку нельзя, приложение сочтёт её сломанной и
 * затрёт рабочий список.
 */
/**
 * Режим узлов источника внутри объединения.
 *
 * Объединение склеивается из плоских списков, и группы источника в нём не
 * выживают ни в каком выходном формате: что в json, что в clash каждая строка
 * становится самостоятельной записью. Поэтому «группами» здесь — это
 * «свернуть», иначе запись вроде «Автовыбор Белые списки» рассыпается на
 * кандидатов. «Развернуть» остаётся собой: его для того и выбирают.
 */
function mergeNodesMode(mode) {
  const normalized = normalizeNodesMode(mode);
  return normalized === NODES_GROUP ? NODES_COLLAPSE : normalized;
}

async function fetchMergedSource(mergeId) {
  const found = getMergedSource(mergeId);
  if (!found.ok) {
    throw new Error(found.error || "merged source not found");
  }
  const blocks = [];
  const sourceHeaders = [];
  const skipped = [];

  for (const item of found.source.items) {
    const label = String(item?.title || item?.sub_url || "источник");
    try {
      const reqUrl = buildRequestUrlFromParams(item || {});
      const config = resolveRequestConfig(reqUrl, {});
      if (!config.ok) {
        throw new Error(config.error || "неверные параметры источника");
      }
      const fetched = await fetchWithNode(config.subUrl, config.forwardHeaders);
      // nodesMode — настройка самого источника: у JSON-подписок от неё зависит,
      // приедет одна строка на запись или все её кандидаты по отдельности.
      const produced = await produceOutput(fetched.body, OUTPUT_RAW, {
        app: config.app,
        nodesMode: mergeNodesMode(config.nodesMode),
      });
      if (!produced.ok) {
        throw new Error(produced.error || "источник не разобрался");
      }
      // raw отдаёт подписку как есть, а провайдеры часто шлют её одной строкой
      // base64. Без декодирования источник приезжал в объединение ровно одним
      // «сервером» — этой самой строкой.
      const selected = filterRawBody(decodeBase64IfNeeded(produced.body), item?.filter, label);
      sourceHeaders.push(fetched.responseHeaders || {});
      blocks.push(...selected.lines);
    } catch (e) {
      skipped.push({ label, error: e?.message || String(e) });
    }
  }

  if (blocks.length === 0) {
    const details = skipped.map((row) => `${row.label}: ${row.error}`).join("; ");
    throw new Error(details ? `ни один источник не отдал серверы (${details})` : "объединение пустое");
  }
  if (skipped.length > 0) {
    console.warn(`[WARN] merge:${mergeId} пропущены источники: ${skipped.map((row) => `${row.label} (${row.error})`).join(", ")}`);
  }

  // Совпавшие имена разводим уже на собранном списке: повторы чаще приходят из
  // разных источников, чем встречаются внутри одного.
  return {
    body: dedupeServerNames(blocks).join("\n"),
    responseHeaders: buildMergedResponseHeaders(sourceHeaders, { title: found.source.name }),
    responseStatus: 200,
    responseUrl: `merge:${mergeId}`,
    skipped,
  };
}

/**
 * Что даёт каждый источник объединения по отдельности.
 *
 * Нужно интерфейсу: там регулярку пишут вручную и хотят сразу видеть, какие
 * серверы под неё попали. Имена считаем на сервере, а саму регулярку окно
 * применяет у себя — тогда список обновляется без похода в сеть на каждый
 * введённый символ.
 */
async function previewMergeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of list) {
    const reqUrl = buildRequestUrlFromParams(item || {});
    const config = resolveRequestConfig(reqUrl, {});
    if (!config.ok) {
      out.push({ ok: false, error: config.error || "invalid merge item", names: [] });
      continue;
    }
    try {
      const fetched = await fetchWithNode(config.subUrl, config.forwardHeaders);
      // Предпросмотр должен показывать ровно то, что попадёт в объединение,
      // поэтому режим узлов у него тот же самый.
      const produced = await produceOutput(fetched.body, OUTPUT_RAW, {
        app: config.app,
        nodesMode: mergeNodesMode(config.nodesMode),
      });
      if (!produced.ok) {
        out.push({ ok: false, error: produced.error || "failed to convert", names: [] });
        continue;
      }
      // Как и в самом объединении: base64 без декодирования выглядит одной
      // строкой, и предпросмотр показывал бы один «сервер» вместо всех.
      const names = rawLines(decodeBase64IfNeeded(produced.body)).map((line) => nameFromRawLine(line) || line);
      out.push({ ok: true, error: "", names });
    } catch (e) {
      out.push({ ok: false, error: e?.message || "fetch failed", names: [] });
    }
  }
  return out;
}

async function fetchWithNode(subUrl, forwardHeaders) {
  const decrypted = await decryptHappLink(subUrl);
  const raw = String(decrypted.resolvedUrl || subUrl || "").trim();
  if (raw.startsWith("merge:")) {
    return fetchMergedSource(raw.slice(6).trim());
  }
  const localPath = resolveLocalSourcePath(subUrl);
  if (localPath) {
    return {
      body: fs.readFileSync(localPath, "utf8"),
      responseHeaders: {
        "content-type": "text/plain; charset=utf-8",
      },
      responseStatus: 200,
      responseUrl: `file://${localPath}`,
    };
  }
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

async function produceOutput(rawText, output, options = {}) {
  if (!rawText || rawText.trim().length === 0) {
    return { ok: false, error: "empty response" };
  }
  if (isHtml(rawText)) {
    return { ok: false, error: describeHtmlResponse(rawText) };
  }

  if (output === OUTPUT_RAW_BASE64) {
    const rawResult = await produceOutput(rawText, OUTPUT_RAW, options);
    if (!rawResult.ok) return rawResult;
    return {
      ok: true,
      body: Buffer.from(String(rawResult.body || ""), "utf8").toString("base64"),
      contentType: "text/plain; charset=utf-8",
      conversion: rawResult.conversion === "none-raw" ? "base64-raw" : `${rawResult.conversion}+base64-raw`,
    };
  }

  if (output === OUTPUT_JSON) {
    const trimmed = String(rawText || "").trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        // Подписку провайдера отдаём как есть: в его конфиге свои dns, inbounds
        // и маршруты, и пересобирать их нам нечем. Но если внутри записи сидят
        // несколько узлов, то выбор «свернуть/группами/развернуть» перестаёт
        // работать — ради него такую подписку пересобираем.
        if (!jsonBundleNeedsNodesMode(trimmed, options)) {
          return {
            ok: true,
            body: JSON.stringify(parsed, null, 2),
            contentType: "application/json; charset=utf-8",
            conversion: "none-json",
          };
        }
      } catch {
        // fall through to raw->json conversion
      }
    }

    // «Группами» в JSON смысла не имеет: групп в этом формате нет, и запись с
    // кандидатами разъезжалась на несколько отдельных конфигов вместо одного.
    // Собираем её как «свернуть», а «развернуть» остаётся собой.
    const jsonOptions = normalizeNodesMode(options.nodesMode) === NODES_GROUP
      ? { ...options, nodesMode: NODES_COLLAPSE }
      : options;
    const rawResult = await produceOutput(rawText, OUTPUT_RAW, jsonOptions);
    if (!rawResult.ok) return rawResult;
    // raw отдаёт подписку как есть, а провайдеры часто присылают её в base64.
    // Для raw это нормально — клиент декодирует сам, — но собирать JSON из
    // нераскодированной строки нечего: получался пустой список.
    const rawBody = decodeBase64IfNeeded(String(rawResult.body || ""));
    const configs = buildJsonConfigBundleFromRaw(rawBody);
    if (configs.length > 0) {
      return {
        ok: true,
        body: JSON.stringify(configs, null, 2),
        contentType: "application/json; charset=utf-8",
        conversion: rawResult.conversion === "none-raw" ? "raw-json-bundle" : `${rawResult.conversion}+raw-json-bundle`,
      };
    }
    return {
      ok: true,
      body: JSON.stringify(extractSubscriptionLines(rawBody), null, 2),
      contentType: "application/json; charset=utf-8",
      conversion: rawResult.conversion === "none-raw" ? "raw-json" : `${rawResult.conversion}+raw-json`,
    };
  }

  if (output === OUTPUT_RAW) {
    let out = extractConvertibleSource(rawText, options);
    let conversion = "none-raw";

    if (out !== rawText && looksLikeUriListOrBase64(out)) {
      out = decodeBase64IfNeeded(out);
      conversion = "json-fallback-raw";
    }

    if (looksLikeClashProviderYaml(out)) {
      try {
        let converted = await convertViaSubconverterToRaw(out);
        if (looksLikeUriListOrBase64(converted)) {
          converted = decodeBase64IfNeeded(converted);
        }
        if (hasAnySubscriptions(converted) && !looksLikeClashProviderYaml(converted)) {
          out = converted;
          conversion = "subconverter-raw";
        } else {
          const fallback = convertClashYamlToRawUris(out);
          if (hasAnySubscriptions(fallback) && !looksLikeClashProviderYaml(fallback)) {
            out = fallback;
            conversion = "yaml-fallback-raw";
          } else {
            return { ok: false, error: "failed to convert yaml to raw" };
          }
        }
      } catch (e) {
        const fallback = convertClashYamlToRawUris(out);
        if (hasAnySubscriptions(fallback) && !looksLikeClashProviderYaml(fallback)) {
          out = fallback;
          conversion = "yaml-fallback-raw";
        } else {
          return { ok: false, error: `failed to convert yaml to raw: ${e?.message || e}` };
        }
      }
    }

    if (!hasAnySubscriptions(out)) {
      return { ok: false, error: "no subscriptions" };
    }
    return { ok: true, body: out, contentType: "text/plain; charset=utf-8", conversion };
  }

  // Файл для proxy-providers: тот же Clash, только без групп и правил.
  // Группы там всё равно не работают, поэтому «группами» сворачиваем — иначе
  // запись с кандидатами рассыпается в провайдере на отдельные строки.
  if (output === OUTPUT_CLASH_PROVIDER) {
    const full = await produceOutput(rawText, OUTPUT_CLASH, {
      ...options,
      nodesMode: normalizeNodesMode(options.nodesMode) === NODES_GROUP ? NODES_COLLAPSE : options.nodesMode,
    });
    if (!full.ok) return full;
    const proxies = parseClashProxyList(full.body);
    if (proxies.length === 0) {
      return { ok: false, error: "в подписке не нашлось ни одного прокси" };
    }
    return {
      ok: true,
      body: buildYaml({ proxies }),
      contentType: "text/yaml; charset=utf-8",
      conversion: `${full.conversion}+provider`,
    };
  }

  if (output !== OUTPUT_CLASH) {
    return { ok: false, error: `unsupported output: ${output}` };
  }

  let out = rawText;
  let conversion = "none";

  if (!looksLikeClashProviderYaml(rawText)) {
    const jsonClash = convertJsonConfigToClash(rawText, options);
    if (jsonClash) {
      return { ok: true, body: jsonClash, contentType: "text/yaml; charset=utf-8", conversion: "json-clash-full-config" };
    }

    let convertible = extractConvertibleSource(rawText, options);
    if (looksLikeUriListOrBase64(convertible)) {
      convertible = decodeBase64IfNeeded(convertible);
    }
    try {
      out = await convertViaSubconverter(convertible);
      conversion = "subconverter";
    } catch {
      out = convertible;
    }

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
  const wrapped = wrapClashProviderAsFullConfig(out, options);
  if (wrapped !== out) {
    out = wrapped;
    conversion = conversion === "none" ? "full-clash-config" : `${conversion}+full-clash-config`;
  }
  return { ok: true, body: out, contentType: "text/yaml; charset=utf-8", conversion };
}

async function refreshCache(subUrl, output, profileNames, forwardHeaders, app = "", device = "", req = null, clashGroups = "", nodesMode = NODES_MODE_DEFAULT, outputBySource = false) {
  const fetched = await fetchWithNode(subUrl, forwardHeaders);
  // Формат мог зависеть от источника — теперь источник в руках.
  output = finalizeOutputBySource(
    output,
    outputBySource,
    subUrl,
    fetched.body,
    fetched.responseHeaders?.["content-type"] || "",
  );
  await persistSuccessfulSourceSnapshot({
    req,
    route: "/last",
    subUrl,
    output,
    profileNames,
    app,
    device,
    forwardHeaders,
    fetched,
  });
  const produced = await produceOutput(fetched.body, output, { app, clashGroups, nodesMode });
  if (!produced.ok) {
    return produced;
  }
  const upstreamHeaders = sanitizeUpstreamResponseHeaders(fetched.responseHeaders);
  ensureCacheDir();
  const cacheKeyValue = cacheKey(subUrl, output, [profileNames.join(","), clashGroups, nodesMode].filter(Boolean).join("|"));
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
    output,
  };
}

async function handleSubscription(req, res, forcedProfileName = "") {
  const startedAtMs = Date.now();
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const config = resolveRequestConfig(reqUrl, req.headers, forcedProfileName);
  // Изменяемый по той же причине, что и в /last: формат может зависеть от
  // источника, а источник будет известен только после запроса к провайдеру.
  let output = config.ok ? config.output : OUTPUT_DEFAULT;

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

  const { subUrl, profileNames, forwardHeaders, app, device, clashGroups, nodesMode } = config;

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
    await persistSuccessfulSourceSnapshot({
      req,
      route: "/sub",
      subUrl,
      output,
      profileNames,
      app,
      device,
      forwardHeaders,
      fetched,
    });
    output = finalizeOutputBySource(
      output,
      config.outputBySource,
      subUrl,
      fetched.body,
      fetched.responseHeaders?.["content-type"] || "",
    );
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
        error: describeHtmlResponse(raw),
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
      throw new Error(describeHtmlResponse(raw));
    }

    const produced = await produceOutput(raw, output, { app, clashGroups, nodesMode });
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
    const cacheKeyValue = cacheKey(subUrl, output, [profileNames.join(","), clashGroups, nodesMode].filter(Boolean).join("|"));
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
    // Живого ответа нет — формат берём из памяти о прошлом удачном запросе,
    // иначе json-подписка уедет клиенту плоским raw.
    output = await outputFromRememberedSource(output, config.outputBySource, {
      subUrl, app, device, profileNames, forwardHeaders,
    });
    const fallback = await loadLatestStoredSnapshotBundle({
      subUrl,
      app,
      device,
      profileNames,
      forwardHeaders,
    });
    if (await respondFromStoredSnapshot(res, fallback, output, { app, clashGroups, nodesMode })) {
      logRequest({
        route: "/sub",
        status: 200,
        profiles: profileNames,
        output,
        app,
        device,
        cache: "snapshot-fallback",
        durationMs: Date.now() - startedAtMs,
        error: e?.message || String(e),
      });
      return;
    }
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

/**
 * Отдать `/last` из кэша, сохранённого в другом формате.
 *
 * Ключ кэша включает выходной формат, а с авто-форматом он зависит от клиента.
 * Поэтому первый же клиент, попросивший формат, которого ещё не просили,
 * получал 404 — хотя тело подписки лежало рядом, просто под другим ключом.
 * Перегоняем то, что есть: это всё равно честнее отказа.
 */
/**
 * Content-Type по выходному формату.
 *
 * Нужен там, где тело берут из кэша: у старых записей рядом нет меты, а
 * подставлять на этот случай yaml — значит объявить raw-подписку конфигом
 * Clash. Клиент, который yaml не читает, такую подписку просто отвергнет.
 */
function contentTypeForOutput(output) {
  if (output === OUTPUT_JSON) return "application/json; charset=utf-8";
  if (output === OUTPUT_CLASH_PROVIDER) return "text/yaml; charset=utf-8";
  if (output === OUTPUT_RAW || output === OUTPUT_RAW_BASE64) return "text/plain; charset=utf-8";
  return "text/yaml; charset=utf-8";
}

/**
 * Последний известный формат источника.
 *
 * Нужен, когда провайдер не ответил. Формат для клиентов вроде Happ зависит от
 * источника, а спросить источник в этот момент не у кого — и подписка уезжала
 * плоским raw, хотя вчера была json. Прошлый снимок знает ответ.
 */
async function lastKnownSourceFormat({ subUrl = "", app = "", device = "", profileNames = [], forwardHeaders = {} }) {
  try {
    const feedKey = buildSubscriptionFeedKey({
      subUrl,
      app,
      device,
      profiles: profileNames,
      hwid: String(forwardHeaders?.["x-hwid"] || "").trim(),
    });
    const feed = await getSubscriptionFeedByKey(feedKey);
    if (!feed?.id) return "";
    const snapshot = await getLatestSourceSnapshotForFeed(feed.id);
    return String(snapshot?.sourceFormat || "").trim();
  } catch {
    return "";
  }
}

/**
 * Формат по памяти, когда живого ответа нет.
 *
 * Объединение всегда json — оно и так собирается из разного. Для остальных
 * смотрим, чем источник оказался в прошлый раз.
 */
async function outputFromRememberedSource(output, bySource, context) {
  if (!bySource) return output;
  if (String(context?.subUrl || "").startsWith("merge:")) return OUTPUT_JSON;
  const known = await lastKnownSourceFormat(context);
  if (!known) return output;
  return known === "json" ? OUTPUT_JSON : OUTPUT_RAW;
}

async function respondFromSiblingCache(res, { subUrl, output, profileKey, app, clashGroups, nodesMode }) {
  for (const candidate of [OUTPUT_RAW, OUTPUT_CLASH, OUTPUT_JSON, OUTPUT_RAW_BASE64]) {
    if (candidate === output) continue;
    const key = cacheKey(subUrl, candidate, profileKey);
    const path = cachePathForKey(key);
    if (!fs.existsSync(path)) continue;
    let body = "";
    try {
      body = fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!body.trim()) continue;
    const produced = await produceOutput(body, output, { app, clashGroups, nodesMode });
    if (!produced.ok) continue;
    let responseHeaders = {};
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPathForKey(key), "utf8"));
      if (meta && typeof meta.responseHeaders === "object" && meta.responseHeaders) {
        responseHeaders = meta.responseHeaders;
      }
    } catch {
      // меты может не быть — заголовки провайдера тогда просто не повторим
    }
    res.writeHead(200, {
      ...responseHeaders,
      "Content-Type": produced.contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(produced.body);
    return candidate;
  }
  return "";
}

async function handleLast(req, res, forcedProfileName = "") {
  const startedAtMs = Date.now();
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const config = resolveRequestConfig(reqUrl, req.headers, forcedProfileName);
  // Изменяемый: у клиентов вроде Happ формат зависит от того, что пришлёт
  // провайдер, и окончательно он известен только после запроса.
  let output = config.ok ? config.output : OUTPUT_DEFAULT;

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

  const { subUrl, profileNames, forwardHeaders, app, device, clashGroups, nodesMode } = config;

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
    refreshed = await refreshCache(
      subUrl, output, profileNames, forwardHeaders, app, device, req, clashGroups, nodesMode, config.outputBySource,
    );
    // Ключ кэша считается по формату, а обновление могло его уточнить.
    if (refreshed?.output) output = refreshed.output;
  } catch {
    refreshed = null;
  }
  if (!refreshed?.output && config.outputBySource) {
    // Провайдер не ответил — берём формат из памяти о прошлом успешном ответе.
    output = await outputFromRememberedSource(output, config.outputBySource, {
      subUrl, app, device, profileNames, forwardHeaders,
    });
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

  const key = cacheKey(subUrl, output, [profileNames.join(","), clashGroups, nodesMode].filter(Boolean).join("|"));
  const path = cachePathForKey(key);
  try {
    let contentType = contentTypeForOutput(output);
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
    const fallback = await loadLatestStoredSnapshotBundle({
      subUrl,
      app,
      device,
      profileNames,
      forwardHeaders,
    });
    if (await respondFromStoredSnapshot(res, fallback, output, { app, clashGroups, nodesMode })) {
      logRequest({
        route: "/last",
        status: 200,
        profiles: profileNames,
        output,
        app,
        device,
        cache: "snapshot-fallback",
        durationMs: Date.now() - startedAtMs,
        error: err?.message || String(err),
      });
      return;
    }
    const sibling = await respondFromSiblingCache(res, {
      subUrl,
      output,
      profileKey: [profileNames.join(","), clashGroups, nodesMode].filter(Boolean).join("|"),
      app,
      clashGroups,
      nodesMode,
    });
    if (sibling) {
      logRequest({
        route: "/last",
        status: 200,
        profiles: profileNames,
        output,
        app,
        device,
        cache: `converted-from-${sibling}`,
        durationMs: Date.now() - startedAtMs,
        error: err?.message || String(err),
      });
      return;
    }
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
  NODES_MODES,
  NODES_MODE_DEFAULT,
  normalizeNodesMode,
  buildNormalizedModelFromSource,
  detectSourceFormat,
  applyOverridesToNormalized,
  hasMeaningfulOverrides,
  renderOutputFromNormalized,
  loadLatestStoredSnapshotBundle,
  sourceFormatMatchesOutput,
  isEncryptedHappLink,
  decryptHappLink,
  parseProfileYaml,
  getUaCatalogOptions,
  resolveAppKeyFromUserAgent,
  resolveOutputFromUserAgent,
  finalizeOutputBySource,
  outputFromRememberedSource,
  lastKnownSourceFormat,
  readProfileFile,
  profileExists,
  pickUserAgentProfile,
  resolveLocalSourcePath,
  resolveRequestConfig,
  produceOutput,
  persistSuccessfulSourceSnapshot,
  fetchWithNode,
  previewMergeItems,
  handleSubscription,
  handleLast,
  handleEcho,
  serveStaticFile,
};
