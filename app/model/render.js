/**
 * Сборка выходных форматов из `normalized-v2`.
 *
 * Правила:
 * - если выходной формат совпадает с исходным и правок нет, отдаём `native`
 *   как есть — обратная конвертация ничего не теряет и режим узлов не влияет;
 * - иначе каждая запись разворачивается по выбранному режиму:
 *   `collapse` — один узел на запись, `group` — узел и кандидаты одного
 *   балансировщика, `expand` — все узлы, что были в источнике.
 */

import { Buffer } from "node:buffer";
import {
  NODES_COLLAPSE,
  NODES_EXPAND,
  NODES_GROUP,
  cleanText,
  displayNameFor,
  nodesForMode,
  primaryNodeOf,
} from "./normalized.js";
import { buildYaml } from "./yaml.js";

const OUTPUT_RAW = "raw";
const OUTPUT_RAW_BASE64 = "raw_base64";
const OUTPUT_JSON = "json";
const OUTPUT_CLASH = "clash";

function appendParam(params, key, value) {
  const text = String(value ?? "").trim();
  if (text) params.set(key, text);
}

/** Узлы модели с именами, готовыми к выводу. */
function flattenForOutput(model, mode) {
  const out = [];
  for (const entry of model.entries) {
    if (entry.enabled === false) continue;
    const nodes = nodesForMode(entry, mode);
    for (const node of nodes) {
      out.push({ entry, node, name: displayNameFor(entry, node, mode, nodes.length) });
    }
  }
  return out;
}

/* ---------- raw ---------- */

function nodeToUri(node, name) {
  const host = node.endpoint.host;
  const port = node.endpoint.port || 443;
  if (!host) return "";

  // Ссылка из источника не хуже собранной — берём её, только переименовав.
  if (node.origin.uri && node.origin.uri.includes("://")) {
    const hashIndex = node.origin.uri.indexOf("#");
    const base = hashIndex >= 0 ? node.origin.uri.slice(0, hashIndex) : node.origin.uri;
    return `${base}#${encodeURIComponent(name)}`;
  }

  const type = node.type;
  const params = new URLSearchParams();
  const network = node.transport.network || "tcp";
  const security = node.security.mode || "none";

  if (type === "vless") {
    params.set("type", network);
    params.set("security", security);
    appendParam(params, "flow", node.auth.flow);
    appendParam(params, "encryption", node.auth.encryption);
  } else if (type === "trojan" || type === "vmess") {
    params.set("type", network);
    params.set("security", security);
  } else if (type === "hysteria" || type === "hysteria2" || type === "tuic") {
    appendParam(params, "sni", node.security.sni);
    appendParam(params, "alpn", node.transport.alpn);
    const auth = node.auth.password || node.auth.uuid;
    if (!auth) return "";
    return `${type === "hysteria" ? "hysteria2" : type}://${encodeURIComponent(auth)}@${host}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
  } else {
    return "";
  }

  appendParam(params, "sni", node.security.sni);
  appendParam(params, "fp", node.security.fp);
  if (security === "reality") {
    appendParam(params, "pbk", node.security.pbk);
    appendParam(params, "sid", node.security.sid);
  } else {
    appendParam(params, "alpn", node.transport.alpn);
  }
  if (network === "ws" || network === "xhttp" || network === "http") {
    appendParam(params, "path", node.transport.path);
    appendParam(params, "host", node.transport.host);
    appendParam(params, "mode", node.transport.mode);
  } else if (network === "grpc") {
    appendParam(params, "serviceName", node.transport.serviceName);
    appendParam(params, "authority", node.transport.authority);
    appendParam(params, "mode", node.transport.mode);
  } else if (network === "tcp") {
    appendParam(params, "headerType", node.transport.headerType);
  }

  const credential = node.auth.uuid || node.auth.password;
  if (!credential) return "";
  return `${type}://${encodeURIComponent(credential)}@${host}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function renderRaw(model, mode) {
  const lines = flattenForOutput(model, mode)
    .map(({ node, name }) => nodeToUri(node, name))
    .filter(Boolean);
  return lines.join("\n");
}

/* ---------- clash ---------- */

function nodeToClashProxy(node, name) {
  const proxy = {
    name,
    type: node.type === "hysteria" ? "hysteria2" : node.type,
    server: node.endpoint.host,
    port: node.endpoint.port || 443,
    udp: true,
  };
  if (node.auth.uuid) proxy.uuid = node.auth.uuid;
  if (node.auth.password) proxy.password = node.auth.password;
  if (node.auth.method) proxy.cipher = node.auth.method;
  if (node.auth.flow) proxy.flow = node.auth.flow;

  const network = node.transport.network;
  if (network && network !== "tcp") proxy.network = network === "xhttp" ? "http" : network;
  if (node.security.mode && node.security.mode !== "none") proxy.tls = true;
  if (node.security.sni) proxy.servername = node.security.sni;
  if (node.security.fp) proxy["client-fingerprint"] = node.security.fp;
  if (node.security.allowInsecure) proxy["skip-cert-verify"] = true;

  if (node.security.mode === "reality") {
    const reality = {};
    if (node.security.pbk) reality["public-key"] = node.security.pbk;
    if (node.security.sid) reality["short-id"] = node.security.sid;
    if (Object.keys(reality).length) proxy["reality-opts"] = reality;
  }

  if (network === "ws") {
    const ws = {};
    if (node.transport.path) ws.path = node.transport.path;
    if (node.transport.host) ws.headers = { Host: node.transport.host };
    if (Object.keys(ws).length) proxy["ws-opts"] = ws;
  } else if (network === "grpc") {
    if (node.transport.serviceName) proxy["grpc-opts"] = { "grpc-service-name": node.transport.serviceName };
  } else if (network === "xhttp" || network === "http") {
    const httpOpts = {};
    if (node.transport.path) httpOpts.path = [node.transport.path];
    if (node.transport.host) httpOpts.headers = { Host: [node.transport.host] };
    if (node.transport.mode) httpOpts.mode = node.transport.mode;
    if (Object.keys(httpOpts).length) proxy["http-opts"] = httpOpts;
  }

  return proxy;
}

/**
 * Прокси и группы для Clash.
 * В режиме `group` запись с кандидатами превращается в `url-test`: её узлы
 * попадают в свою группу, а верхний селектор показывает только имя записи.
 */
function buildClashProxiesAndGroups(model, mode) {
  const proxies = [];
  const entryGroups = [];
  const used = new Set();

  const uniqueName = (candidate) => {
    let name = candidate || "node";
    let suffix = 2;
    while (used.has(name)) {
      name = `${candidate} ${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name;
  };

  for (const entry of model.entries) {
    if (entry.enabled === false) continue;
    const nodes = nodesForMode(entry, mode);
    if (nodes.length === 0) continue;
    const names = [];
    for (const node of nodes) {
      const proxy = nodeToClashProxy(node, uniqueName(displayNameFor(entry, node, mode, nodes.length)));
      if (!proxy.server) continue;
      proxies.push(proxy);
      names.push(proxy.name);
    }
    if (names.length === 0) continue;
    // Запись, давшая несколько прокси, остаётся одной строкой выбора:
    // её узлы прячутся в собственную url-test группу.
    if (names.length > 1) {
      entryGroups.push({ name: uniqueName(entry.name), type: "url-test", proxies: names });
    } else {
      entryGroups.push({ name: names[0], type: "proxy", proxies: names });
    }
  }

  return { proxies, entryGroups };
}

/** Имена, которые попадают в верхний селектор: группы записей, а не их внутренности. */
function selectableNames(entryGroups) {
  return entryGroups.map((group) => group.name);
}

function renderClash(model, mode, { groups = [], extraGroupsBuilder = null } = {}) {
  const { proxies, entryGroups } = buildClashProxiesAndGroups(model, mode);
  if (proxies.length === 0) return "";

  const selectable = selectableNames(entryGroups);
  const urlTestGroups = entryGroups.filter((group) => group.type === "url-test");
  const configured = typeof extraGroupsBuilder === "function" ? extraGroupsBuilder(selectable, groups) : [];

  const proxyGroups = [
    ...urlTestGroups.map((group) => ({
      name: group.name,
      type: "url-test",
      proxies: group.proxies,
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
    })),
    ...configured,
    {
      name: "PROXY",
      type: "select",
      proxies: [...configured.map((group) => group.name), ...selectable],
    },
  ];

  return buildYaml({
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    proxies,
    "proxy-groups": proxyGroups,
    rules: model.policy.rules.length > 0 ? model.policy.rules : ["MATCH,PROXY"],
  });
}

/* ---------- json ---------- */

/** Минимальный конфиг Xray для узла, пришедшего не из JSON. */
function nodeToXrayConfig(node, name) {
  const streamSettings = { network: node.transport.network || "tcp", security: node.security.mode || "none" };
  if (node.security.mode === "reality") {
    streamSettings.realitySettings = {
      serverName: node.security.sni,
      fingerprint: node.security.fp,
      publicKey: node.security.pbk,
      shortId: node.security.sid,
      show: false,
    };
  } else if (node.security.mode === "tls" || node.security.mode === "xtls") {
    streamSettings.tlsSettings = {
      serverName: node.security.sni,
      fingerprint: node.security.fp,
      allowInsecure: node.security.allowInsecure,
    };
  }
  const network = streamSettings.network;
  if (network === "ws") {
    streamSettings.wsSettings = {
      path: node.transport.path || "/",
      headers: node.transport.host ? { Host: node.transport.host } : {},
    };
  } else if (network === "grpc") {
    streamSettings.grpcSettings = { serviceName: node.transport.serviceName || "" };
  } else if (network === "xhttp") {
    streamSettings.xhttpSettings = { path: node.transport.path || "/", host: node.transport.host || "" };
  } else if (network === "tcp" && node.transport.headerType) {
    streamSettings.tcpSettings = { header: { type: node.transport.headerType } };
  }

  return {
    remarks: name,
    outbounds: [
      {
        tag: "proxy",
        protocol: node.type || "vless",
        settings: {
          vnext: [
            {
              address: node.endpoint.host,
              port: node.endpoint.port || 443,
              users: [
                {
                  id: node.auth.uuid,
                  encryption: node.auth.encryption || "none",
                  flow: node.auth.flow || "",
                },
              ],
            },
          ],
        },
        streamSettings,
      },
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "block", protocol: "blackhole", settings: {} },
    ],
    routing: {
      rules: [
        { type: "field", outboundTag: "direct", domain: ["geosite:private"] },
        { type: "field", outboundTag: "proxy", network: "tcp,udp" },
      ],
    },
  };
}

function renderJson(model, mode) {
  // JSON-источник возвращается своей же структурой: ничего не теряется.
  const fromNative = model.entries
    .filter((entry) => entry.enabled !== false && entry.native && entry.kind === "xray-config")
    .map((entry) => entry.native);
  if (fromNative.length > 0) return JSON.stringify(fromNative, null, 2);

  const configs = [];
  for (const entry of model.entries) {
    if (entry.enabled === false) continue;
    const nodes = mode === NODES_EXPAND ? nodesForMode(entry, mode) : [primaryNodeOf(entry)].filter(Boolean);
    for (const node of nodes) {
      if (!node.endpoint.host) continue;
      configs.push(nodeToXrayConfig(node, displayNameFor(entry, node, mode, nodes.length)));
    }
  }
  return JSON.stringify(configs, null, 2);
}

/* ---------- точка входа ---------- */

function contentTypeFor(output) {
  if (output === OUTPUT_JSON) return "application/json; charset=utf-8";
  if (output === OUTPUT_CLASH) return "text/yaml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function renderOutput(model, output, mode = NODES_COLLAPSE, options = {}) {
  if (output === OUTPUT_JSON) return { body: renderJson(model, mode), contentType: contentTypeFor(output) };
  if (output === OUTPUT_CLASH) return { body: renderClash(model, mode, options), contentType: contentTypeFor(output) };
  if (output === OUTPUT_RAW_BASE64) {
    const raw = renderRaw(model, mode);
    return { body: Buffer.from(raw, "utf8").toString("base64"), contentType: contentTypeFor(output) };
  }
  return { body: renderRaw(model, mode), contentType: contentTypeFor(output) };
}

export {
  OUTPUT_CLASH,
  OUTPUT_JSON,
  OUTPUT_RAW,
  OUTPUT_RAW_BASE64,
  buildClashProxiesAndGroups,
  cleanText,
  contentTypeFor,
  flattenForOutput,
  nodeToClashProxy,
  nodeToUri,
  nodeToXrayConfig,
  renderClash,
  renderJson,
  renderOutput,
  renderRaw,
};
