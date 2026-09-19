/**
 * Внутреннее представление подписки (`normalized-v2`).
 *
 * Ключевое отличие от v1: источник разбирается не в плоский список серверов, а
 * в список записей (`entries`). Запись — это то, что пользователь видит в
 * приложении как одну строку списка: один конфиг Xray-бандла, один прокси
 * Clash, одна ссылка raw. Всё, что провайдер держит внутри записи —
 * кандидаты балансировщика, мосты, loopback, routing, dns, observatory —
 * остаётся внутри записи, а не всплывает отдельными серверами.
 *
 * Каждая запись хранит `native` — исходный объект без изменений. Пока нет
 * пользовательских правок, рендер в исходный формат собирается из `native`,
 * поэтому обратная конвертация ничего не теряет.
 */

const SCHEMA_VERSION = 2;
const PARSER_VERSION = "normalized-v2";

/** Роли узлов внутри записи. */
const NODE_PRIMARY = "primary";
const NODE_CANDIDATE = "candidate";
const NODE_AUXILIARY = "auxiliary";

/** Режимы разворачивания записей в форматы, где нет вложенности. */
const NODES_COLLAPSE = "collapse";
const NODES_GROUP = "group";
const NODES_EXPAND = "expand";
const NODES_MODES = [NODES_COLLAPSE, NODES_GROUP, NODES_EXPAND];
const NODES_MODE_DEFAULT = NODES_COLLAPSE;

function normalizeNodesMode(value, fallback = NODES_MODE_DEFAULT) {
  const text = String(value || "").trim().toLowerCase();
  if (NODES_MODES.includes(text)) return text;
  if (text === "flat" || text === "all") return NODES_EXPAND;
  if (text === "single" || text === "one") return NODES_COLLAPSE;
  if (text === "groups") return NODES_GROUP;
  return fallback;
}

function entryId(index) {
  return `e${String(index + 1).padStart(4, "0")}`;
}

function nodeId(entryIndex, nodeIndex) {
  return `${entryId(entryIndex)}n${String(nodeIndex + 1).padStart(3, "0")}`;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function createNode(input = {}) {
  return {
    id: String(input.id || ""),
    name: cleanText(input.name) || String(input.id || "node"),
    enabled: input.enabled !== false,
    role: input.role || NODE_CANDIDATE,
    type: String(input.type || "").toLowerCase(),
    endpoint: {
      host: String(input.endpoint?.host || ""),
      port: Number(input.endpoint?.port || 0),
    },
    auth: {
      uuid: String(input.auth?.uuid || ""),
      password: String(input.auth?.password || ""),
      method: String(input.auth?.method || ""),
      alterId: String(input.auth?.alterId || ""),
      flow: String(input.auth?.flow || ""),
      encryption: String(input.auth?.encryption || ""),
    },
    transport: {
      network: String(input.transport?.network || ""),
      path: String(input.transport?.path || ""),
      host: String(input.transport?.host || ""),
      serviceName: String(input.transport?.serviceName || ""),
      headerType: String(input.transport?.headerType || ""),
      authority: String(input.transport?.authority || ""),
      mode: String(input.transport?.mode || ""),
      alpn: String(input.transport?.alpn || ""),
      seed: String(input.transport?.seed || ""),
      quicSecurity: String(input.transport?.quicSecurity || ""),
      key: String(input.transport?.key || ""),
    },
    security: {
      mode: String(input.security?.mode || ""),
      sni: String(input.security?.sni || ""),
      fp: String(input.security?.fp || ""),
      pbk: String(input.security?.pbk || ""),
      sid: String(input.security?.sid || ""),
      allowInsecure: Boolean(input.security?.allowInsecure),
    },
    // Вес кандидата в балансировщике: меньше — предпочтительнее.
    cost: Number.isFinite(input.cost) ? Number(input.cost) : null,
    origin: {
      sourceFormat: String(input.origin?.sourceFormat || ""),
      tag: String(input.origin?.tag || ""),
      protocol: String(input.origin?.protocol || ""),
      uri: String(input.origin?.uri || ""),
      native: input.origin?.native ?? null,
    },
  };
}

function createEntry(input = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const primary = nodes.find((node) => node.role === NODE_PRIMARY) || nodes[0] || null;
  return {
    id: String(input.id || ""),
    name: cleanText(input.name) || String(input.id || "entry"),
    kind: String(input.kind || "entry"),
    enabled: input.enabled !== false,
    primaryNodeId: primary ? primary.id : "",
    nodes,
    topology: {
      balancers: Array.isArray(input.topology?.balancers) ? input.topology.balancers : [],
      observatory: input.topology?.observatory ?? null,
      burstObservatory: input.topology?.burstObservatory ?? null,
    },
    policy: {
      routingRules: Array.isArray(input.policy?.routingRules) ? input.policy.routingRules : [],
      dns: input.policy?.dns ?? null,
      inbounds: Array.isArray(input.policy?.inbounds) ? input.policy.inbounds : [],
    },
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    lossFlags: Array.isArray(input.lossFlags) ? input.lossFlags : [],
    native: input.native ?? null,
  };
}

function createModel(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      sourceFormat: String(input.meta?.sourceFormat || ""),
      parserVersion: PARSER_VERSION,
      parsedAt: String(input.meta?.parsedAt || new Date().toISOString()),
      warnings: Array.isArray(input.meta?.warnings) ? input.meta.warnings : [],
      lossFlags: Array.isArray(input.meta?.lossFlags) ? input.meta.lossFlags : [],
      entryCount: entries.length,
      nodeCount: entries.reduce((sum, entry) => sum + entry.nodes.length, 0),
    },
    entries,
    groups: Array.isArray(input.groups) ? input.groups : [],
    policy: {
      rules: Array.isArray(input.policy?.rules) ? input.policy.rules : [],
      dns: input.policy?.dns ?? null,
    },
    native: input.native ?? null,
  };
}

/** Узел, представляющий запись в форматах без вложенности. */
function primaryNodeOf(entry) {
  if (!entry) return null;
  return entry.nodes.find((node) => node.id === entry.primaryNodeId)
    || entry.nodes.find((node) => node.role === NODE_PRIMARY)
    || entry.nodes[0]
    || null;
}

/**
 * Узлы записи для выбранного режима.
 * `collapse` — только представитель, `group` — представитель и кандидаты
 * того же балансировщика, `expand` — всё, что было в источнике.
 */
function nodesForMode(entry, mode) {
  if (!entry) return [];
  const enabled = entry.nodes.filter((node) => node.enabled !== false);
  if (mode === NODES_EXPAND) return enabled;
  if (mode === NODES_GROUP) {
    const picked = enabled.filter((node) => node.role === NODE_PRIMARY || node.role === NODE_CANDIDATE);
    if (picked.length > 0) return picked;
  }
  const primary = primaryNodeOf(entry);
  return primary && primary.enabled !== false ? [primary] : [];
}

/** Имя узла в выводе: в свёрнутом виде запись представлена своим именем. */
function displayNameFor(entry, node, mode, nodesInEntry) {
  if (mode === NODES_COLLAPSE || nodesInEntry <= 1) return entry.name;
  const tag = cleanText(node.origin?.tag) || cleanText(node.name);
  return tag && tag !== entry.name ? `${entry.name} · ${tag}` : entry.name;
}

/** Ровно один узел на запись — терять топологию нечем. */
function isFlatModel(model) {
  return model.entries.every((entry) => entry.nodes.length <= 1)
    && model.entries.every((entry) => entry.topology.balancers.length === 0);
}

export {
  SCHEMA_VERSION,
  PARSER_VERSION,
  NODE_PRIMARY,
  NODE_CANDIDATE,
  NODE_AUXILIARY,
  NODES_COLLAPSE,
  NODES_GROUP,
  NODES_EXPAND,
  NODES_MODES,
  NODES_MODE_DEFAULT,
  normalizeNodesMode,
  entryId,
  nodeId,
  cleanText,
  createNode,
  createEntry,
  createModel,
  primaryNodeOf,
  nodesForMode,
  displayNameFor,
  isFlatModel,
};
