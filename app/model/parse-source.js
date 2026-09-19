/**
 * Разбор любого источника подписки в `normalized-v2`.
 *
 * Clash и raw в исходнике уже плоские: один прокси или одна ссылка — одна
 * запись с одним узлом. Вложенность, которую надо сохранять, есть только у
 * JSON-бандлов Xray, поэтому весь нетривиальный разбор живёт в `parse-xray.js`.
 */

import { Buffer } from "node:buffer";
import { parseBulkProxyText } from "../proxy-import.js";
import {
  convertClashYamlToRawUris,
  extractTopLevelYamlSection,
  looksLikeFullClashConfig,
  parseClashProxyGroups,
  parseClashProxyList,
  parseClashRules,
} from "./yaml.js";
import {
  NODE_PRIMARY,
  cleanText,
  createEntry,
  createModel,
  createNode,
  entryId,
  nodeId,
} from "./normalized.js";
import { parseXraySource } from "./parse-xray.js";

const FORMAT_JSON = "json";
const FORMAT_YML = "yml";
const FORMAT_RAW = "raw";
const FORMAT_RAW_BASE64 = "raw(base64)";

function decodeBase64IfNeeded(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.includes("://")) return String(text || "");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) || trimmed.length < 200) return String(text || "");
  try {
    const decoded = Buffer.from(trimmed.replace(/\s+/g, ""), "base64").toString("utf8");
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
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      JSON.parse(text);
      return FORMAT_JSON;
    } catch {
      // не JSON — продолжаем определять
    }
  }
  if (ct.includes("application/json")) return FORMAT_JSON;
  if (/^\s*proxies\s*:\s*$/m.test(text)) return FORMAT_YML;
  if (/^(vmess|vless|ss|ssr|trojan|hysteria2?|tuic):\/\//m.test(text)) return FORMAT_RAW;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 120) {
    const decoded = decodeBase64IfNeeded(text);
    if (decoded !== text && /^(vmess|vless|ss|ssr|trojan|hysteria2?|tuic):\/\//m.test(decoded)) return FORMAT_RAW_BASE64;
  }
  return "unknown";
}

/** Один разобранный прокси (из raw-ссылки или из блока Clash) — в узел модели. */
function nodeFromFlatProxy(item, index, sourceFormat) {
  return createNode({
    id: nodeId(index, 0),
    name: cleanText(item?.name) || `node-${index + 1}`,
    role: NODE_PRIMARY,
    type: String(item?.type || "").toLowerCase(),
    endpoint: { host: String(item?.server || ""), port: Number(item?.port || 0) },
    auth: {
      uuid: item?.uuid,
      password: item?.password,
      method: item?.transport?.method || item?.cipher,
      alterId: item?.transport?.aid,
      flow: item?.flow,
    },
    transport: {
      network: item?.network,
      path: item?.path,
      host: item?.host,
      serviceName: item?.serviceName,
      headerType: item?.transport?.headerType,
      authority: item?.transport?.authority,
      mode: item?.transport?.mode,
      alpn: item?.transport?.alpn,
      seed: item?.transport?.seed,
      quicSecurity: item?.transport?.quicSecurity,
      key: item?.transport?.key,
    },
    security: {
      mode: item?.security,
      sni: item?.sni || item?.servername,
      fp: item?.clientFingerprint || item?.fp,
      pbk: item?.publicKey || item?.pbk,
      sid: item?.shortId || item?.sid,
    },
    origin: { sourceFormat, tag: "", protocol: String(item?.type || ""), uri: String(item?.uri || ""), native: item },
  });
}

function entriesFromFlatProxies(items, sourceFormat, kind) {
  return items.map((item, index) => {
    const node = nodeFromFlatProxy(item, index, sourceFormat);
    return createEntry({
      id: entryId(index),
      name: node.name,
      kind,
      nodes: [node],
      native: item,
    });
  });
}

function parseRawSource(rawText, sourceFormat) {
  const text = sourceFormat === FORMAT_RAW_BASE64 ? decodeBase64IfNeeded(rawText) : String(rawText || "");
  const entries = entriesFromFlatProxies(parseBulkProxyText(text), sourceFormat, "uri");
  return createModel({
    meta: {
      sourceFormat,
      warnings: entries.length > 0 ? [] : ["no-nodes-parsed-from-raw"],
    },
    entries,
    native: { kind: "raw", text },
  });
}

function parseClashSource(rawText) {
  const text = String(rawText || "");
  const proxies = parseClashProxyList(text);
  // Через URI, потому что `parseBulkProxyText` знает все протоколы,
  // а блок Clash даёт только сырые поля.
  const asUris = convertClashYamlToRawUris(text);
  const parsedUris = asUris ? parseBulkProxyText(asUris) : [];
  const items = parsedUris.length === proxies.length ? parsedUris : proxies;
  const entries = entriesFromFlatProxies(items, FORMAT_YML, "clash-proxy");
  // Имена берём из самого Clash: перевод в URI может их упростить.
  entries.forEach((entry, index) => {
    const name = cleanText(proxies[index]?.name);
    if (!name) return;
    entry.name = name;
    entry.nodes[0].name = name;
  });

  const dnsSection = extractTopLevelYamlSection(text, "dns");
  return createModel({
    meta: {
      sourceFormat: FORMAT_YML,
      warnings: entries.length > 0 ? [] : ["no-nodes-parsed-from-yaml"],
    },
    entries,
    // Группы хранятся ровно так, как их описывает источник: их же объекты
    // потом вставляются обратно в исходный YAML.
    groups: parseClashProxyGroups(text),
    policy: { rules: parseClashRules(text), dns: dnsSection ? { raw: dnsSection } : null },
    native: {
      kind: "clash",
      text,
      fullConfig: looksLikeFullClashConfig(text),
    },
  });
}

function parseSource(rawText, contentType = "") {
  const sourceFormat = detectSourceFormat(rawText, contentType);
  if (sourceFormat === FORMAT_JSON) return parseXraySource(rawText);
  if (sourceFormat === FORMAT_YML) return parseClashSource(rawText);
  if (sourceFormat === FORMAT_RAW || sourceFormat === FORMAT_RAW_BASE64) return parseRawSource(rawText, sourceFormat);
  return createModel({
    meta: {
      sourceFormat,
      warnings: ["unsupported-source-format"],
      lossFlags: sourceFormat === "unknown" ? ["unknown-source-format"] : [],
    },
    native: { kind: "unknown", contentType: String(contentType || ""), text: String(rawText || "") },
  });
}

export {
  FORMAT_JSON,
  FORMAT_RAW,
  FORMAT_RAW_BASE64,
  FORMAT_YML,
  decodeBase64IfNeeded,
  detectSourceFormat,
  parseClashSource,
  parseRawSource,
  parseSource,
};
