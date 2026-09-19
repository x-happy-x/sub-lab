/**
 * Работа с Clash/YAML: разбор текста подписки, сборка YAML и перевод
 * прокси Clash обратно в URI. Вынесено из `subscription.js`, чтобы парсеры и
 * рендереры нормализованной модели могли пользоваться этим без цикла импортов.
 */

function looksLikeClashProviderYaml(s) {
  return /^\s*proxies\s*:\s*$/m.test(s);
}

function looksLikeFullClashConfig(s) {
  const text = String(s || "");
  return /^(?:mixed-port|port|socks-port|redir-port|tproxy-port|allow-lan|mode|log-level|external-controller|secret|dns|proxy-groups|rules|rule-providers|proxy-providers)\s*:/m.test(
    text,
  );
}

function shouldWrapClashProviderForFlClash(s) {
  const text = String(s || "").trim();
  return looksLikeClashProviderYaml(text) && !looksLikeFullClashConfig(text);
}


function formatYamlScalar(value) {
  if (typeof value === "string") {
    const text = String(value);
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) && !/^(?:true|false|null|yes|no|on|off)$/i.test(text)) {
      return text;
    }
    return JSON.stringify(text);
  }
  return String(value);
}

function buildYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(obj)) {
    return obj
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const body = buildYaml(item, indent + 1);
          if (!body) return `${pad}-`;
          const lines = body.split("\n");
          const first = String(lines.shift() || "").trimStart();
          return [`${pad}- ${first}`, ...lines].join("\n");
        }
        return `${pad}- ${formatYamlScalar(item)}`;
      })
      .join("\n");
  }
  if (typeof obj !== "object" || obj === null) {
    return `${pad}${formatYamlScalar(obj)}`;
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
      return `${pad}${key}: ${formatYamlScalar(value)}`;
    })
    .join("\n");
}

function unquoteYamlValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\'/g, "'");
  }
  return value;
}

function parseInlineYamlMap(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};
  const out = {};
  for (const part of inner.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = unquoteYamlValue(value);
  }
  return out;
}

function normalizeYamlKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function normalizeYamlScalarValue(value) {
  const raw = String(value || "").trim();
  return unquoteYamlValue(raw);
}

function parseClashProxyList(yamlText) {
  const text = String(yamlText || "").replace(/\t/g, "  ");
  const lines = text.split(/\r?\n/);
  const proxies = [];
  let inProxies = false;
  let current = null;
  let currentIndent = -1;

  function pushCurrent() {
    if (!current) return;
    if (Object.keys(current).length > 0) proxies.push(current);
    current = null;
    currentIndent = -1;
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!inProxies) {
      if (/^proxies\s*:\s*$/i.test(trimmed)) inProxies = true;
      continue;
    }

    const newTopLevel = rawLine.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (newTopLevel && !rawLine.startsWith(" ") && !rawLine.startsWith("-")) {
      pushCurrent();
      break;
    }

    const item = rawLine.match(/^(\s*)-\s*(.*)$/);
    if (item) {
      pushCurrent();
      current = {};
      currentIndent = item[1].length;
      const body = (item[2] || "").trim();
      if (body) {
        const inlineMap = parseInlineYamlMap(body);
        if (inlineMap) {
          Object.assign(current, inlineMap);
        } else {
          const pair = body.match(/^(['"]?[A-Za-z0-9_.-]+['"]?)\s*:\s*(.*)$/);
          if (pair) current[normalizeYamlKey(pair[1])] = normalizeYamlScalarValue(pair[2] || "");
        }
      }
      continue;
    }

    if (!current) continue;
    const kv = rawLine.match(/^(\s*)(['"]?[A-Za-z0-9_.-]+['"]?)\s*:\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1].length;
    if (indent <= currentIndent) continue;
    current[normalizeYamlKey(kv[2])] = normalizeYamlScalarValue(kv[3] || "");
  }

  pushCurrent();
  return proxies;
}

function extractTopLevelYamlSection(yamlText, sectionName) {
  const text = String(yamlText || "").replace(/\t/g, "  ");
  const lines = text.split(/\r?\n/);
  const target = String(sectionName || "").trim();
  if (!target) return "";
  const out = [];
  let collecting = false;

  for (const line of lines) {
    const topLevelMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!collecting) {
      if (topLevelMatch && topLevelMatch[1] === target) {
        collecting = true;
        out.push(line);
      }
      continue;
    }
    if (topLevelMatch && !line.startsWith(" ") && !line.startsWith("\t")) break;
    out.push(line);
  }

  return out.join("\n").trimEnd();
}

function parseYamlListBlocks(sectionText) {
  const text = String(sectionText || "").trim();
  if (!text) return [];
  const body = text.replace(/^[A-Za-z0-9_.-]+\s*:\s*\n?/i, "");
  return body
    .split(/\n(?=\s*-\s+)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("-"));
}

function parseClashProxyGroups(yamlText) {
  const section = extractTopLevelYamlSection(yamlText, "proxy-groups");
  if (!section) return [];
  return parseYamlListBlocks(section)
    .map((block) => {
      const normalizedBlock = String(block || "").replace(/^(\s*)-\s*/, "$1");
      const flat = parseYamlProxyBlock(normalizedBlock);
      return {
        name: String(flat.name || "").trim(),
        type: String(flat.type || "").trim(),
        proxies: Array.isArray(flat.proxies) ? flat.proxies : (flat.proxies ? [flat.proxies] : []),
        url: String(flat.url || "").trim(),
        interval: String(flat.interval || "").trim(),
        tolerance: String(flat.tolerance || "").trim(),
        flat,
      };
    })
    .filter((item) => item.name);
}

function parseClashRules(yamlText) {
  const section = extractTopLevelYamlSection(yamlText, "rules");
  if (!section) return [];
  return parseYamlListBlocks(section)
    .map((block) => String(block || "").replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function replaceTopLevelYamlSection(yamlText, sectionName, replacementText) {
  const text = String(yamlText || "").replace(/\t/g, "  ");
  const target = String(sectionName || "").trim();
  if (!target) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let replaced = false;
  let skipping = false;

  for (const line of lines) {
    const topLevelMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (skipping) {
      if (topLevelMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
        skipping = false;
      } else {
        continue;
      }
    }
    if (!skipping && topLevelMatch && topLevelMatch[1] === target) {
      if (replacementText) out.push(String(replacementText).trimEnd());
      replaced = true;
      skipping = true;
      continue;
    }
    out.push(line);
  }

  if (!replaced && replacementText) out.push(String(replacementText).trimEnd());
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function patchClashProxyGroupsInOriginalText(originalText, proxyGroups) {
  let next = String(originalText || "");
  for (const group of Array.isArray(proxyGroups) ? proxyGroups : []) {
    const name = String(group?.name || "").trim();
    if (!name) continue;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockPattern = new RegExp(`((?:^|\\n)\\s*-\\s+name\\s*:\\s*${escapedName}\\s*[\\s\\S]*?)(?=\\n\\s*-\\s+name\\s*:|\\n[A-Za-z0-9_.-]+\\s*:|$)`, "m");
    const match = next.match(blockPattern);
    if (!match) continue;
    let block = match[1];
    for (const [field, value] of Object.entries(group || {})) {
      if (field === "name" || field === "proxies" || field === "flat") continue;
      const text = String(value || "").trim();
      if (!text) continue;
      const fieldPattern = new RegExp(`(^\\s*${field}\\s*:\\s*).*$`, "m");
      if (fieldPattern.test(block)) {
        block = block.replace(fieldPattern, `$1${text}`);
      }
    }
    next = next.replace(blockPattern, block);
  }
  return next;
}

function parseYamlProxyBlock(block) {
  const text = String(block || "").replace(/\t/g, "  ");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const flat = {};
  const stack = [];

  function stackPath() {
    return stack.map((entry) => entry.key).join(".");
  }

  function setValue(path, value) {
    if (!path) return;
    flat[path] = value;
  }

  function pushListValue(path, value) {
    if (!path) return;
    const existing = flat[path];
    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }
    if (existing !== undefined) {
      flat[path] = [existing, value];
      return;
    }
    flat[path] = [value];
  }

  for (const rawLine of lines) {
    const item = rawLine.match(/^(\s*)-\s*(.*)$/);
    if (item) {
      const indent = item[1].length;
      const value = normalizeYamlScalarValue(item[2] || "");
      while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
      pushListValue(stackPath(), value);
      continue;
    }

    const kv = rawLine.match(/^(\s*)(['"]?[^'":]+['"]?)\s*:\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1].length;
    const key = normalizeYamlKey(kv[2]);
    const value = normalizeYamlScalarValue(kv[3] || "");

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const path = [...stack.map((entry) => entry.key), key].join(".");
    if (value) {
      setValue(path, value);
      continue;
    }
    stack.push({ key, indent });
  }

  return flat;
}

function buildRawUriFromProxy(proxy) {
  const type = String(proxy.type || "").toLowerCase();
  const name = encodeURIComponent(String(proxy.name || proxy.server || "proxy"));
  const server = String(proxy.server || "").trim();
  const port = Number(proxy.port || 0);
  if (!server || !port) return "";

  if (type === "ss") {
    const cipher = String(proxy.cipher || "").trim();
    const password = String(proxy.password || "").trim();
    if (!cipher || !password) return "";
    const userInfo = Buffer.from(`${cipher}:${password}`, "utf8").toString("base64");
    return `ss://${userInfo}@${server}:${port}#${name}`;
  }

  if (type === "trojan") {
    const password = String(proxy.password || "").trim();
    if (!password) return "";
    const params = new URLSearchParams();
    if (proxy.sni || proxy.servername) params.set("sni", String(proxy.sni || proxy.servername));
    if (proxy["skip-cert-verify"] === "true" || proxy["skip-cert-verify"] === true) {
      params.set("allowInsecure", "1");
    }
    const query = params.toString();
    return `trojan://${encodeURIComponent(password)}@${server}:${port}${query ? `?${query}` : ""}#${name}`;
  }

  if (type === "ssr") {
    const protocol = String(proxy.protocol || "origin").trim();
    const method = String(proxy.cipher || proxy.method || "").trim();
    const obfs = String(proxy.obfs || "plain").trim();
    const password = String(proxy.password || "").trim();
    if (!method || !password) return "";
    const pwd64 = Buffer.from(password, "utf8").toString("base64").replace(/=+$/g, "");
    const protocolParam = String(proxy["protocol-param"] || proxy.protocolparam || "").trim();
    const obfsParam = String(proxy["obfs-param"] || proxy.obfsparam || "").trim();
    const remarks = decodeURIComponent(name);
    const qs = new URLSearchParams();
    if (obfsParam) qs.set("obfsparam", Buffer.from(obfsParam, "utf8").toString("base64").replace(/=+$/g, ""));
    if (protocolParam) qs.set("protoparam", Buffer.from(protocolParam, "utf8").toString("base64").replace(/=+$/g, ""));
    qs.set("remarks", Buffer.from(remarks, "utf8").toString("base64").replace(/=+$/g, ""));
    const payload = `${server}:${port}:${protocol}:${method}:${obfs}:${pwd64}/?${qs.toString()}`;
    return `ssr://${Buffer.from(payload, "utf8").toString("base64")}`;
  }

  if (type === "vless") {
    const uuid = String(proxy.uuid || "").trim();
    if (!uuid) return "";
    const params = new URLSearchParams();
    const network = String(proxy.network || "tcp").trim() || "tcp";
    const hasReality = Boolean(proxy["reality-opts.public-key"] || proxy["reality-opts.short-id"]);
    const security = hasReality
      ? "reality"
      : (proxy.tls === "true" || proxy.tls === true ? "tls" : "none");
    params.set("type", network);
    params.set("security", security);
    if (proxy.servername || proxy.sni) params.set("sni", String(proxy.servername || proxy.sni));
    if (proxy.flow) params.set("flow", String(proxy.flow));
    if (proxy["client-fingerprint"]) params.set("fp", String(proxy["client-fingerprint"]));
    if (proxy["packet-encoding"]) params.set("packetEncoding", String(proxy["packet-encoding"]));
    if (hasReality) {
      if (proxy["reality-opts.public-key"]) params.set("pbk", String(proxy["reality-opts.public-key"]));
      if (proxy["reality-opts.short-id"]) params.set("sid", String(proxy["reality-opts.short-id"]));
    }
    const alpn = Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn || "").trim();
    if (alpn) params.set("alpn", alpn);
    if (network === "ws") {
      if (proxy["ws-opts.path"]) params.set("path", String(proxy["ws-opts.path"]));
      if (proxy["ws-opts.headers.Host"] || proxy["ws-opts.headers.host"]) {
        params.set("host", String(proxy["ws-opts.headers.Host"] || proxy["ws-opts.headers.host"]));
      }
    } else if (network === "grpc") {
      if (proxy["grpc-opts.service-name"] || proxy["grpc-opts.serviceName"]) {
        params.set("serviceName", String(proxy["grpc-opts.service-name"] || proxy["grpc-opts.serviceName"]));
      }
      if (proxy["grpc-opts.authority"]) params.set("authority", String(proxy["grpc-opts.authority"]));
    } else if (network === "http") {
      const path = Array.isArray(proxy["http-opts.path"]) ? proxy["http-opts.path"][0] : proxy["http-opts.path"];
      const host = Array.isArray(proxy["http-opts.headers.Host"]) ? proxy["http-opts.headers.Host"][0] : proxy["http-opts.headers.Host"];
      if (path) params.set("path", String(path));
      if (host) params.set("host", String(host));
    } else if (network === "tcp" && proxy["tcp-opts.header.type"]) {
      params.set("headerType", String(proxy["tcp-opts.header.type"]));
    }
    return `vless://${uuid}@${server}:${port}?${params.toString()}#${name}`;
  }

  if (type === "vmess") {
    const uuid = String(proxy.uuid || "").trim();
    if (!uuid) return "";
    const vmess = {
      v: "2",
      ps: decodeURIComponent(name),
      add: server,
      port: String(port),
      id: uuid,
      aid: String(proxy.alterId || proxy.alterid || 0),
      net: String(proxy.network || "tcp"),
      type: "none",
      host: String(proxy.host || ""),
      path: String(proxy.path || ""),
      tls: proxy.tls === "true" || proxy.tls === true ? "tls" : "",
      sni: String(proxy.servername || proxy.sni || ""),
    };
    const encoded = Buffer.from(JSON.stringify(vmess), "utf8").toString("base64");
    return `vmess://${encoded}`;
  }

  return "";
}

function convertClashYamlToRawUris(yamlText) {
  const text = String(yamlText || "");
  const proxies = parseClashProxyList(text);
  let lines = proxies.map(buildRawUriFromProxy).filter(Boolean);
  if (lines.length > 0) return lines.join("\n");

  const sectionMatch = text.match(/(?:^|\n)proxies\s*:\s*\n([\s\S]*)$/i);
  const section = sectionMatch ? sectionMatch[1] : "";
  if (!section) return "";
  const blocks = section
    .split(/\n(?=\s*-\s+name\s*:)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("- name:"));

  function getField(block, key) {
    const re = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(.+)$`, "m");
    const m = block.match(re);
    return m ? normalizeYamlScalarValue(m[1]) : "";
  }

  const regexProxies = blocks.map((block) => {
    const flat = parseYamlProxyBlock(block);
    return {
      name: normalizeYamlScalarValue(block.replace(/^-+\s*name\s*:\s*/i, "").split(/\n/)[0] || ""),
      type: flat.type || getField(block, "type"),
      server: flat.server || getField(block, "server"),
      port: flat.port || getField(block, "port"),
      network: flat.network || getField(block, "network"),
      tls: flat.tls || getField(block, "tls"),
      servername: flat.servername || getField(block, "servername"),
      sni: flat.sni || getField(block, "sni"),
      uuid: flat.uuid || getField(block, "uuid"),
      cipher: flat.cipher || getField(block, "cipher"),
      method: flat.method || getField(block, "method"),
      password: flat.password || getField(block, "password"),
      obfs: flat.obfs || getField(block, "obfs"),
      protocol: flat.protocol || getField(block, "protocol"),
      flow: flat.flow || getField(block, "flow"),
      "client-fingerprint": flat["client-fingerprint"] || getField(block, "client-fingerprint"),
      "packet-encoding": flat["packet-encoding"] || getField(block, "packet-encoding"),
      alpn: flat.alpn || getField(block, "alpn"),
      "protocol-param": flat["protocol-param"] || getField(block, "protocol-param"),
      "obfs-param": flat["obfs-param"] || getField(block, "obfs-param"),
      "reality-opts.public-key": flat["reality-opts.public-key"] || "",
      "reality-opts.short-id": flat["reality-opts.short-id"] || "",
      "ws-opts.path": flat["ws-opts.path"] || "",
      "ws-opts.headers.Host": flat["ws-opts.headers.Host"] || flat["ws-opts.headers.host"] || "",
      "grpc-opts.service-name": flat["grpc-opts.service-name"] || flat["grpc-opts.serviceName"] || "",
      "grpc-opts.authority": flat["grpc-opts.authority"] || "",
      "http-opts.path": flat["http-opts.path"] || "",
      "http-opts.headers.Host": flat["http-opts.headers.Host"] || flat["http-opts.headers.host"] || "",
      "tcp-opts.header.type": flat["tcp-opts.header.type"] || "",
    };
  });

  lines = regexProxies.map(buildRawUriFromProxy).filter(Boolean);
  return lines.join("\n");
}


export {
  looksLikeClashProviderYaml,
  looksLikeFullClashConfig,
  shouldWrapClashProviderForFlClash,
  formatYamlScalar,
  buildYaml,
  parseInlineYamlMap,
  normalizeYamlKey,
  normalizeYamlScalarValue,
  parseClashProxyList,
  extractTopLevelYamlSection,
  parseYamlListBlocks,
  parseClashProxyGroups,
  parseClashRules,
  replaceTopLevelYamlSection,
  patchClashProxyGroupsInOriginalText,
  parseYamlProxyBlock,
  buildRawUriFromProxy,
  convertClashYamlToRawUris,
  unquoteYamlValue,

};
