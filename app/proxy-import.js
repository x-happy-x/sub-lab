import { Buffer } from "node:buffer";

function safeBase64Decode(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function safeBase64Encode(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function extractNameFromHash(value) {
  const hashIndex = String(value || "").indexOf("#");
  if (hashIndex < 0) return "";
  try {
    return decodeURIComponent(String(value).slice(hashIndex + 1));
  } catch {
    return String(value).slice(hashIndex + 1);
  }
}

function extractFlag(name) {
  const text = String(name || "");
  const match = text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  return match ? match[0] : "◻";
}

function normalizeOriginalName(name, fallback) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function parseVlessUri(line) {
  const url = new URL(line);
  const params = url.searchParams;
  const name = normalizeOriginalName(extractNameFromHash(line), `${url.hostname}:${url.port || "443"}`);
  return {
    name,
    type: "vless",
    server: url.hostname,
    port: Number(url.port || 443),
    uuid: decodeURIComponent(url.username || ""),
    password: "",
    network: params.get("type") || "tcp",
    security: params.get("security") || "none",
    sni: params.get("sni") || params.get("servername") || "",
    servername: params.get("sni") || params.get("servername") || "",
    flow: params.get("flow") || "",
    fp: params.get("fp") || params.get("client-fingerprint") || "",
    clientFingerprint: params.get("fp") || params.get("client-fingerprint") || "",
    pbk: params.get("pbk") || params.get("public-key") || "",
    publicKey: params.get("pbk") || params.get("public-key") || "",
    sid: params.get("sid") || params.get("short-id") || "",
    shortId: params.get("sid") || params.get("short-id") || "",
    path: params.get("path") || "",
    host: params.get("host") || "",
    serviceName: params.get("serviceName") || "",
    transport: {
      authority: params.get("authority") || "",
      mode: params.get("mode") || "",
      headerType: params.get("headerType") || "",
      alpn: params.get("alpn") || "",
      seed: params.get("seed") || "",
      quicSecurity: params.get("quicSecurity") || "",
      key: params.get("key") || "",
    },
    uri: line,
  };
}

function parseTrojanUri(line) {
  const url = new URL(line);
  const params = url.searchParams;
  const name = normalizeOriginalName(extractNameFromHash(line), `${url.hostname}:${url.port || "443"}`);
  return {
    name,
    type: "trojan",
    server: url.hostname,
    port: Number(url.port || 443),
    uuid: "",
    password: decodeURIComponent(url.username || ""),
    network: params.get("type") || "tcp",
    security: "tls",
    sni: params.get("sni") || params.get("peer") || "",
    servername: params.get("sni") || params.get("peer") || "",
    flow: params.get("flow") || "",
    fp: params.get("fp") || "",
    clientFingerprint: params.get("fp") || "",
    pbk: "",
    publicKey: "",
    sid: "",
    shortId: "",
    path: params.get("path") || "",
    host: params.get("host") || "",
    serviceName: params.get("serviceName") || "",
    transport: {
      mode: params.get("mode") || "",
      headerType: params.get("headerType") || "",
      alpn: params.get("alpn") || "",
      authority: params.get("authority") || "",
    },
    uri: line,
  };
}

function parseVmessUri(line) {
  const body = safeBase64Decode(String(line || "").replace(/^vmess:\/\//, ""));
  const parsed = JSON.parse(body || "{}");
  const name = normalizeOriginalName(parsed.ps, `${parsed.add || "node"}:${parsed.port || "443"}`);
  return {
    name,
    type: "vmess",
    server: String(parsed.add || ""),
    port: Number(parsed.port || 0),
    uuid: String(parsed.id || ""),
    password: "",
    network: String(parsed.net || "tcp"),
    security: parsed.tls ? "tls" : "none",
    sni: String(parsed.sni || ""),
    servername: String(parsed.sni || ""),
    flow: "",
    fp: String(parsed.fp || ""),
    clientFingerprint: String(parsed.fp || ""),
    pbk: "",
    publicKey: "",
    sid: "",
    shortId: "",
    path: String(parsed.path || ""),
    host: String(parsed.host || ""),
    serviceName: String(parsed.path || ""),
    transport: {
      headerType: String(parsed.type || ""),
      aid: String(parsed.aid || ""),
    },
    uri: line,
  };
}

function parseSsUri(line) {
  const text = String(line || "").trim();
  const name = normalizeOriginalName(extractNameFromHash(text), "ss");
  const withoutPrefix = text.replace(/^ss:\/\//, "");
  const hashIndex = withoutPrefix.indexOf("#");
  const main = hashIndex >= 0 ? withoutPrefix.slice(0, hashIndex) : withoutPrefix;
  const atIndex = main.lastIndexOf("@");
  let server = "";
  let port = 0;
  let password = "";
  if (atIndex >= 0) {
    const hostPart = main.slice(atIndex + 1);
    const decoded = safeBase64Decode(main.slice(0, atIndex));
    password = decoded.split(":").slice(1).join(":") || "";
    const hostMatch = hostPart.match(/^(.*):(\d+)$/);
    server = hostMatch?.[1] || "";
    port = Number(hostMatch?.[2] || 0);
  }
  return {
    name,
    type: "ss",
    server,
    port,
    uuid: "",
    password,
    network: "tcp",
    security: "none",
    sni: "",
    servername: "",
    flow: "",
    fp: "",
    clientFingerprint: "",
    pbk: "",
    publicKey: "",
    sid: "",
    shortId: "",
    path: "",
    host: "",
    serviceName: "",
    transport: {},
    uri: line,
  };
}

function parseSsrUri(line) {
  const text = safeBase64Decode(String(line || "").replace(/^ssr:\/\//, ""));
  const [head, query = ""] = text.split("/?");
  const headParts = head.split(":");
  const params = new URLSearchParams(query);
  const remarks = safeBase64Decode(params.get("remarks") || "");
  return {
    name: normalizeOriginalName(remarks, headParts[0] || "ssr"),
    type: "ssr",
    server: headParts[0] || "",
    port: Number(headParts[1] || 0),
    uuid: "",
    password: safeBase64Decode(headParts[5] || ""),
    network: "tcp",
    security: "none",
    sni: "",
    servername: "",
    flow: "",
    fp: "",
    clientFingerprint: "",
    pbk: "",
    publicKey: "",
    sid: "",
    shortId: "",
    path: "",
    host: "",
    serviceName: "",
    transport: {
      protocol: headParts[2] || "",
      method: headParts[3] || "",
      obfs: headParts[4] || "",
      obfsparam: safeBase64Decode(params.get("obfsparam") || ""),
      protoparam: safeBase64Decode(params.get("protoparam") || ""),
    },
    uri: line,
  };
}

function parseProxyLine(line) {
  const text = String(line || "").trim();
  if (!text || text.startsWith("#")) return null;
  try {
    if (text.startsWith("vless://")) return parseVlessUri(text);
    if (text.startsWith("trojan://")) return parseTrojanUri(text);
    if (text.startsWith("vmess://")) return parseVmessUri(text);
    if (text.startsWith("ssr://")) return parseSsrUri(text);
    if (text.startsWith("ss://")) return parseSsUri(text);
  } catch {
    return null;
  }
  return null;
}

function renameUri(item, normalizedName) {
  const encodedName = encodeURIComponent(normalizedName);
  const text = String(item?.uri || "");
  if (item?.type === "vmess") {
    const body = safeBase64Decode(text.replace(/^vmess:\/\//, ""));
    const parsed = JSON.parse(body || "{}");
    parsed.ps = normalizedName;
    return `vmess://${safeBase64Encode(JSON.stringify(parsed))}`;
  }
  if (item?.type === "ssr") {
    const body = safeBase64Decode(text.replace(/^ssr:\/\//, ""));
    const [head, query = ""] = body.split("/?");
    const params = new URLSearchParams(query);
    params.set("remarks", safeBase64Encode(normalizedName).replace(/=+$/g, ""));
    return `ssr://${safeBase64Encode(`${head}/?${params.toString()}`)}`;
  }
  const hashIndex = text.indexOf("#");
  if (hashIndex >= 0) return `${text.slice(0, hashIndex)}#${encodedName}`;
  return `${text}#${encodedName}`;
}

function parseBulkProxyText(text) {
  const parsed = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseProxyLine)
    .filter(Boolean);

  return parsed.map((item, index) => {
    const flag = extractFlag(item.name);
    const normalizedName = `${flag} ${String(index + 1).padStart(4, "0")} ${item.name}`;
    return {
      ...item,
      flag,
      index: index + 1,
      normalizedName,
      normalizedUri: renameUri(item, normalizedName),
    };
  });
}

export {
  parseBulkProxyText,
};
