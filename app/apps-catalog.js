import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPS_CATALOG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/apps.yml");
const APP_GUIDES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/app-guides");
const DEFAULT_ITEMS = [
  {
    key: "happ",
    label: "Happ",
    deeplink: "happ://add/{url}",
    platforms: ["linux", "windows", "macos"],
    formats: ["raw"],
  },
  {
    key: "flclashx",
    label: "FlClashX",
    deeplink: "flclashx://install-config?url={url}",
    platforms: ["android"],
    formats: ["yml"],
  },
];
const DEFAULT_RECOMMENDED_BY_OS = {
  windows: ["happ", "flclashx"],
  macos: ["happ", "flclashx"],
  linux: ["happ", "flclashx"],
  android: ["flclashx", "v2raytun"],
  ios: ["happ", "shadowrocket", "clashmi"],
};
const DEFAULT_ORDER_BY_OS = {
  windows: ["flclashx", "koala-clash", "prizrak-box", "happ", "v2raytun", "clashmi", "shadowrocket"],
  macos: ["happ", "flclashx", "koala-clash", "prizrak-box", "v2raytun", "clashmi", "shadowrocket"],
  linux: ["flclashx", "koala-clash", "prizrak-box", "happ", "v2raytun", "clashmi", "shadowrocket"],
  android: ["happ", "flclashx", "v2raytun", "koala-clash", "prizrak-box", "clashmi", "shadowrocket"],
  ios: ["happ", "clashmi", "shadowrocket", "flclashx", "v2raytun", "koala-clash", "prizrak-box"],
};

function sanitizeAppToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (!/^[a-z0-9._-]+$/.test(token)) return "";
  return token;
}

function uniq(list) {
  return list.filter((item, idx) => list.indexOf(item) === idx);
}

function unquote(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function parsePlatforms(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  const bracket = trimmed.match(/^\[(.*)\]$/);
  const source = bracket ? bracket[1] : trimmed;
  return uniq(source
    .split(/[,|]/g)
    .map((part) => String(part || "").trim().toLowerCase())
    .filter(Boolean));
}

function parseItemBlocks(content) {
  const lines = String(content || "").split(/\r?\n/);
  const blocks = [];
  let inApps = false;
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^apps\s*:\s*$/i.test(trimmed)) {
      inApps = true;
      current = null;
      continue;
    }

    if (!inApps && !line.startsWith(" ")) continue;
    if (inApps && !line.startsWith(" ") && /^[a-z_]+\s*:/i.test(trimmed) && !trimmed.startsWith("-")) {
      inApps = false;
      current = null;
      continue;
    }
    if (!inApps) continue;

    if (trimmed.startsWith("-")) {
      current = {};
      blocks.push(current);
      const inline = trimmed.match(/^-+\s*key\s*:\s*(.+)$/i);
      if (inline) current.key = unquote(inline[1]);
      continue;
    }

    if (!current) continue;
    const pair = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (!pair) continue;
    const key = String(pair[1] || "").toLowerCase();
    const value = String(pair[2] || "");
    current[key] = value;
  }
  return blocks;
}

function parseRecommendedByOs(content) {
  return parseOsAppMapSection(content, "recommended_by_os");
}

function parseOrderByOs(content) {
  return parseOsAppMapSection(content, "order_by_os");
}

function parseOsAppMapSection(content, sectionName) {
  const out = {};
  const lines = String(content || "").split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (new RegExp(`^${sectionName}\\s*:\\s*$`, "i").test(trimmed)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!line.startsWith(" ")) break;
    const pair = trimmed.match(/^([a-z0-9._-]+)\s*:\s*\[(.*)\]\s*$/i);
    if (!pair) continue;
    const os = String(pair[1] || "").trim().toLowerCase();
    const apps = String(pair[2] || "")
      .split(",")
      .map((x) => sanitizeAppToken(x))
      .filter(Boolean);
    if (os && apps.length > 0) out[os] = uniq(apps);
  }
  return out;
}

function normalizeItem(raw) {
  const key = sanitizeAppToken(unquote(raw.key || ""));
  if (!key) return null;
  const label = unquote(raw.label || key);
  const deeplink = unquote(raw.deeplink || "");
  if (!deeplink) return null;
  const platforms = parsePlatforms(unquote(raw.platforms || ""));
  const formats = parsePlatforms(unquote(raw.formats || "")).filter((x) => x === "raw" || x === "yml");
  return { key, label, deeplink, platforms, formats: formats.length > 0 ? formats : ["raw", "yml"] };
}

function getAppsCatalog() {
  const fallbackItems = [...DEFAULT_ITEMS];
  const fallbackApps = fallbackItems.map((x) => x.key);
  const fallbackShareLinks = Object.fromEntries(fallbackItems.map((x) => [x.key, x.deeplink]));
  const fallbackRecommendedByOs = { ...DEFAULT_RECOMMENDED_BY_OS };
  const fallbackOrderByOs = { ...DEFAULT_ORDER_BY_OS };
  try {
    if (!fs.existsSync(APPS_CATALOG_PATH)) {
      return {
        apps: fallbackApps,
        shareLinks: fallbackShareLinks,
        items: fallbackItems,
        recommendedByOs: fallbackRecommendedByOs,
        orderByOs: fallbackOrderByOs,
      };
    }
    const content = fs.readFileSync(APPS_CATALOG_PATH, "utf8");
    const blocks = parseItemBlocks(content);
    const items = blocks
      .map((item) => normalizeItem(item))
      .filter(Boolean);
    const recommendedByOs = {
      ...fallbackRecommendedByOs,
      ...parseRecommendedByOs(content),
    };
    const orderByOs = {
      ...fallbackOrderByOs,
      ...parseOrderByOs(content),
    };
    if (items.length === 0) {
      return { apps: fallbackApps, shareLinks: fallbackShareLinks, items: fallbackItems, recommendedByOs, orderByOs };
    }
    const apps = uniq(items.map((x) => x.key));
    const shareLinks = Object.fromEntries(items.map((x) => [x.key, x.deeplink]));
    return { apps, shareLinks, items, recommendedByOs, orderByOs };
  } catch {
    return {
      apps: fallbackApps,
      shareLinks: fallbackShareLinks,
      items: fallbackItems,
      recommendedByOs: fallbackRecommendedByOs,
      orderByOs: fallbackOrderByOs,
    };
  }
}

function sanitizeOsToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (!/^[a-z0-9._-]+$/.test(token)) return "";
  return token;
}

function parseGuideYaml(content) {
  const out = {
    app: "",
    os: "",
    template: "",
  };

  const lines = String(content || "").split(/\r?\n/);
  let currentBlock = "";
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();

    if (currentBlock) {
      if (line.startsWith("  ")) {
        const existing = out[currentBlock] ? `${out[currentBlock]}\n` : "";
        out[currentBlock] = `${existing}${line.slice(2).trimEnd()}`.trimEnd();
        continue;
      }
      currentBlock = "";
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    const pair = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = String(pair[1] || "");
    const rawValue = String(pair[2] || "");
    if (rawValue.trim() === "|") {
      const map = { template: "template" };
      if (map[key]) currentBlock = map[key];
      continue;
    }

    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (key === "app") out.app = value;
    if (key === "os") out.os = value;
  }

  return out;
}

function readGuideFile(app, os) {
  const candidates = [
    path.join(APP_GUIDES_DIR, app, `${os}.yml`),
    path.join(APP_GUIDES_DIR, app, "default.yml"),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      return parseGuideYaml(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

function getAppGuide(app, os) {
  const appToken = sanitizeAppToken(app);
  const osToken = sanitizeOsToken(os);
  if (!appToken) return { ok: false, status: 400, error: "invalid app" };
  const guide = readGuideFile(appToken, osToken || "default");
  if (!guide) return { ok: false, status: 404, error: "guide not found" };
  return { ok: true, guide };
}

export {
  getAppsCatalog,
  getAppGuide,
};
