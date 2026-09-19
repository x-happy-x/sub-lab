/**
 * Разбор JSON-подписки (бандл конфигов Xray) в `normalized-v2`.
 *
 * Провайдеры отдают массив самостоятельных конфигов: один конфиг — одна строка
 * в списке приложения. Внутри конфига обычно лежит гораздо больше outbound-ов,
 * чем пользователь видит: кандидаты балансировщика, мосты второго и третьего
 * уровня, loopback-петли, `freedom`/`blackhole`/`dns`. Старый разбор
 * выкладывал все vless-outbound-ы отдельными серверами — отсюда и брались
 * лишние строки. Здесь конфиг остаётся одной записью, а его outbound-ы
 * получают роли.
 */

import {
  NODE_AUXILIARY,
  NODE_CANDIDATE,
  NODE_PRIMARY,
  cleanText,
  createEntry,
  createModel,
  createNode,
  entryId,
  nodeId,
} from "./normalized.js";

/** Протоколы, которые вообще могут быть сервером подписки. */
const PROXY_PROTOCOLS = new Set([
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "socks",
  "http",
  "hysteria",
  "hysteria2",
  "tuic",
  "wireguard",
]);

/** Служебные outbound-ы: они никогда не являются сервером. */
const SYSTEM_PROTOCOLS = new Set(["freedom", "blackhole", "dns", "loopback"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function protocolOf(outbound) {
  return String(outbound?.protocol || "").trim().toLowerCase();
}

function isProxyOutbound(outbound) {
  const protocol = protocolOf(outbound);
  return PROXY_PROTOCOLS.has(protocol) && !SYSTEM_PROTOCOLS.has(protocol);
}

/** Первый сервер outbound-а: у каждого протокола он лежит по-своему. */
function serverOf(outbound) {
  const settings = outbound?.settings || {};
  const stream = outbound?.streamSettings || {};
  const vnext = asArray(settings.vnext)[0];
  if (vnext) {
    const user = asArray(vnext.users)[0] || {};
    return {
      host: String(vnext.address || ""),
      port: Number(vnext.port || 0),
      uuid: String(user.id || ""),
      password: "",
      method: String(user.security || ""),
      alterId: user.alterId === undefined ? "" : String(user.alterId),
      flow: String(user.flow || ""),
      encryption: String(user.encryption || ""),
    };
  }
  const server = asArray(settings.servers)[0];
  if (server) {
    const user = asArray(server.users)[0] || {};
    return {
      host: String(server.address || ""),
      port: Number(server.port || 0),
      uuid: String(user.id || server.id || ""),
      password: String(server.password || user.pass || user.password || ""),
      method: String(server.method || ""),
      alterId: "",
      flow: String(server.flow || user.flow || ""),
      encryption: "",
    };
  }
  // hysteria/tuic/wireguard и прочие складывают адрес прямо в settings,
  // а секрет — в своей секции streamSettings.
  const host = String(settings.address || settings.server || "");
  if (!host) return null;
  const protocolSettings = stream.hysteriaSettings || stream.tuicSettings || {};
  return {
    host,
    port: Number(settings.port || 0),
    uuid: String(settings.uuid || protocolSettings.uuid || ""),
    password: String(
      settings.password
      || settings.auth
      || settings.auth_str
      || protocolSettings.auth
      || protocolSettings.password
      || "",
    ),
    method: "",
    alterId: "",
    flow: "",
    encryption: "",
  };
}

function transportOf(stream) {
  const network = String(stream?.network || "tcp").trim() || "tcp";
  const out = { network, path: "", host: "", serviceName: "", headerType: "", authority: "", mode: "", alpn: "" };
  if (network === "ws") {
    const ws = stream?.wsSettings || {};
    out.path = String(ws.path || "");
    out.host = String(ws.headers?.Host || ws.headers?.host || "");
  } else if (network === "grpc") {
    const grpc = stream?.grpcSettings || {};
    out.serviceName = String(grpc.serviceName || "");
    out.authority = String(grpc.authority || "");
    if (grpc.mode === true || grpc.mode === "gun") out.mode = "gun";
  } else if (network === "xhttp" || network === "splithttp") {
    const xhttp = stream?.xhttpSettings || stream?.splithttpSettings || {};
    out.path = String(xhttp.path || "");
    out.host = String(xhttp.host || "");
    out.mode = String(xhttp.mode || "");
  } else if (network === "http" || network === "h2") {
    const http = stream?.httpSettings || {};
    out.path = String(http.path || "");
    out.host = asArray(http.host).join(",");
  } else if (network === "tcp") {
    out.headerType = String(stream?.tcpSettings?.header?.type || "");
  } else if (network === "kcp") {
    out.headerType = String(stream?.kcpSettings?.header?.type || "");
    out.seed = String(stream?.kcpSettings?.seed || "");
  } else if (network === "hysteria" || network === "tuic") {
    // У этих протоколов транспорт задаёт сам протокол — отдельной сети нет.
    out.network = "";
  }
  return out;
}

function securityOf(stream) {
  const mode = String(stream?.security || "none").trim() || "none";
  if (mode === "reality") {
    const reality = stream?.realitySettings || {};
    return {
      mode,
      sni: String(reality.serverName || ""),
      fp: String(reality.fingerprint || ""),
      pbk: String(reality.publicKey || ""),
      sid: String(reality.shortId || ""),
      allowInsecure: false,
    };
  }
  if (mode === "tls" || mode === "xtls") {
    const tls = stream?.tlsSettings || stream?.xtlsSettings || {};
    return {
      mode,
      sni: String(tls.serverName || ""),
      fp: String(tls.fingerprint || ""),
      pbk: "",
      sid: "",
      allowInsecure: Boolean(tls.allowInsecure),
      alpn: asArray(tls.alpn).join(","),
    };
  }
  return { mode, sni: "", fp: "", pbk: "", sid: "", allowInsecure: false };
}

/**
 * Маршрут по умолчанию: первое правило без ограничений по домену/адресу.
 * Xray проверяет правила сверху вниз, поэтому побеждает именно первое —
 * его цель пользователь и считает «этим сервером».
 */
function defaultRouteTarget(config) {
  const rules = asArray(config?.routing?.rules);
  // Правило по умолчанию не сужает трафик ничем: ни доменом, ни адресом, ни
  // портом, ни протоколом. Привязка к `inboundTag` тоже сужает — так провайдеры
  // заворачивают служебные петли (`*-REROUTE`) и отдельные DNS-инбаунды.
  const isCatchAll = (rule) =>
    !asArray(rule?.domain).length
    && !asArray(rule?.ip).length
    && !String(rule?.port || "").trim()
    && !String(rule?.sourcePort || "").trim()
    && !asArray(rule?.source).length
    && !asArray(rule?.user).length
    && !asArray(rule?.protocol).length
    && !asArray(rule?.inboundTag).length;
  for (const rule of rules) {
    if (!isCatchAll(rule)) continue;
    const balancerTag = String(rule?.balancerTag || "").trim();
    if (balancerTag) return { balancerTag, outboundTag: "" };
    const outboundTag = String(rule?.outboundTag || "").trim();
    if (outboundTag && outboundTag !== "direct" && outboundTag !== "block") {
      return { balancerTag: "", outboundTag };
    }
  }
  return { balancerTag: "", outboundTag: "" };
}

function balancerByTag(config, tag) {
  return asArray(config?.routing?.balancers).find((balancer) => String(balancer?.tag || "") === tag) || null;
}

/** Теги, которые балансировщик отбирает своими селекторами: Xray сравнивает по префиксу. */
function selectedTags(balancer, tags) {
  const selectors = asArray(balancer?.selector).map((item) => String(item)).filter(Boolean);
  if (selectors.length === 0) return [];
  return tags.filter((tag) => selectors.some((selector) => tag.startsWith(selector)));
}

function costsByTag(balancer) {
  const costs = new Map();
  for (const cost of asArray(balancer?.strategy?.settings?.costs)) {
    if (cost?.regexp) continue;
    const match = String(cost?.match || "");
    if (match) costs.set(match, Number(cost?.value ?? 0));
  }
  return costs;
}

/**
 * Кандидаты «главного» балансировщика и предпочтительный из них.
 * Дешевле — предпочтительнее; при равной цене выигрывает порядок в конфиге.
 */
function resolvePrimary(config, proxyOutbounds) {
  const tags = proxyOutbounds.map((outbound) => String(outbound?.tag || ""));
  const target = defaultRouteTarget(config);

  if (target.outboundTag) {
    const index = tags.indexOf(target.outboundTag);
    if (index >= 0) return { primaryIndex: index, candidateIndexes: [index], costs: new Map() };
  }

  const balancer = target.balancerTag
    ? balancerByTag(config, target.balancerTag)
    : asArray(config?.routing?.balancers)[0] || null;

  if (balancer) {
    const picked = selectedTags(balancer, tags);
    const costs = costsByTag(balancer);
    const indexes = picked.map((tag) => tags.indexOf(tag)).filter((index) => index >= 0);
    if (indexes.length > 0) {
      const best = indexes.reduce((bestIndex, index) => {
        const bestCost = costs.has(tags[bestIndex]) ? costs.get(tags[bestIndex]) : Number.POSITIVE_INFINITY;
        const cost = costs.has(tags[index]) ? costs.get(tags[index]) : Number.POSITIVE_INFINITY;
        if (cost < bestCost) return index;
        return bestIndex;
      }, indexes[0]);
      return { primaryIndex: best, candidateIndexes: indexes, costs };
    }
  }

  // Ни маршрутов, ни балансировщиков: Xray возьмёт первый outbound, но
  // остальные здесь — равноправные альтернативы, а не служебные звенья,
  // поэтому все они считаются кандидатами.
  const proxyIndex = tags.findIndex((tag) => tag === "proxy");
  const primaryIndex = proxyIndex >= 0 ? proxyIndex : 0;
  return { primaryIndex, candidateIndexes: tags.map((_, index) => index), costs: new Map() };
}

function parseXrayConfig(config, index) {
  const outbounds = asArray(config?.outbounds);
  const proxyOutbounds = outbounds.filter(isProxyOutbound);
  const name = cleanText(config?.remarks) || `config-${index + 1}`;
  const warnings = [];
  const lossFlags = [];

  if (proxyOutbounds.length === 0) {
    warnings.push("xray-config-without-proxy-outbound");
  }

  const { primaryIndex, candidateIndexes, costs } = resolvePrimary(config, proxyOutbounds);
  const candidates = new Set(candidateIndexes);

  const nodes = proxyOutbounds.map((outbound, outboundIndex) => {
    const server = serverOf(outbound);
    const stream = outbound?.streamSettings || {};
    const tag = String(outbound?.tag || "");
    const role = outboundIndex === primaryIndex
      ? NODE_PRIMARY
      : candidates.has(outboundIndex)
        ? NODE_CANDIDATE
        : NODE_AUXILIARY;
    const security = securityOf(stream);
    const transport = transportOf(stream);
    if (security.alpn && !transport.alpn) transport.alpn = security.alpn;
    return createNode({
      id: nodeId(index, outboundIndex),
      name: tag || `${name} ${outboundIndex + 1}`,
      role,
      type: protocolOf(outbound),
      endpoint: { host: server?.host || "", port: server?.port || 0 },
      auth: {
        uuid: server?.uuid || "",
        password: server?.password || "",
        method: server?.method || "",
        alterId: server?.alterId || "",
        flow: server?.flow || "",
        encryption: server?.encryption || "",
      },
      transport,
      security,
      cost: costs.has(tag) ? costs.get(tag) : null,
      origin: { sourceFormat: "json", tag, protocol: protocolOf(outbound), native: outbound },
    });
  });

  const balancers = asArray(config?.routing?.balancers);
  if (balancers.length > 0) lossFlags.push("xray-balancers-not-representable-in-flat-output");
  if (nodes.filter((node) => node.role === NODE_AUXILIARY).length > 0) {
    lossFlags.push("xray-auxiliary-outbounds-hidden");
  }

  return createEntry({
    id: entryId(index),
    name,
    kind: "xray-config",
    nodes,
    topology: {
      balancers,
      observatory: config?.observatory ?? null,
      burstObservatory: config?.burstObservatory ?? null,
    },
    policy: {
      routingRules: asArray(config?.routing?.rules),
      dns: config?.dns ?? null,
      inbounds: asArray(config?.inbounds),
    },
    warnings,
    lossFlags,
    native: config,
  });
}

function parseXraySource(rawText) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawText || ""));
  } catch {
    return createModel({
      meta: { sourceFormat: "json", warnings: ["json-parse-failed"], lossFlags: ["json-parse-failed"] },
    });
  }

  const configs = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item && typeof item === "object");
  const entries = configs.map((config, index) => parseXrayConfig(config, index));

  return createModel({
    meta: {
      sourceFormat: "json",
      warnings: entries.flatMap((entry) => entry.warnings),
      lossFlags: [...new Set(entries.flatMap((entry) => entry.lossFlags))],
    },
    entries,
    native: { kind: "xray-bundle", isArray: Array.isArray(parsed) },
  });
}

export {
  PROXY_PROTOCOLS,
  SYSTEM_PROTOCOLS,
  isProxyOutbound,
  defaultRouteTarget,
  resolvePrimary,
  parseXrayConfig,
  parseXraySource,
};
