import path from "node:path";

const SUB_URL_DEFAULT = process.env.SUB_URL || "";
const LEGACY_USE_CONVERTER_DEFAULT = process.env.USE_CONVERTER === "1";
const OUTPUT_DEFAULT_ENV = (process.env.OUTPUT || "").trim().toLowerCase();
const CONVERTER_URL = process.env.CONVERTER_URL || "";
const SOURCE_URL = process.env.SOURCE_URL || "http://web/source.txt";
const PORT = Number(process.env.PORT || "8787");
const PROFILE_DIR_ENV = process.env.PROFILE_DIR || "";
const PROFILE_FALLBACK_DIR = path.resolve(process.cwd(), "profiles");
const PROFILE_ROOT_DIRS = PROFILE_DIR_ENV
  ? [PROFILE_DIR_ENV]
  : ["/data/profiles", PROFILE_FALLBACK_DIR];
const HEADER_POLICY_DEFAULT = "prefer_request";
const OUTPUT_RAW = "raw";
const OUTPUT_CLASH = "clash";

function normalizeOutput(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (s === "yml" || s === "yaml" || s === OUTPUT_CLASH) return OUTPUT_CLASH;
  if (s === "raw" || s === "plain" || s === "text" || s === "source") return OUTPUT_RAW;
  return null;
}

const OUTPUT_DEFAULT =
  normalizeOutput(OUTPUT_DEFAULT_ENV) ||
  (LEGACY_USE_CONVERTER_DEFAULT ? OUTPUT_CLASH : OUTPUT_RAW);

const OUT_RAW = "/data/raw.txt";
const OUT_YAML = "/data/subscription.yaml";
const OUT_STATUS = "/data/status.json";
const OUT_CONVERTED = "/data/converted.txt";
const SOURCE_PATH = "/data/source.txt";
const CACHE_DIR = "/data/cache";
const STATIC_FILES = new Map([
  ["/raw.txt", { path: OUT_RAW, type: "text/plain; charset=utf-8" }],
  ["/status.json", { path: OUT_STATUS, type: "application/json; charset=utf-8" }],
  ["/converted.txt", { path: OUT_CONVERTED, type: "text/plain; charset=utf-8" }],
  ["/source.txt", { path: SOURCE_PATH, type: "text/plain; charset=utf-8" }],
]);

export {
  SUB_URL_DEFAULT,
  CONVERTER_URL,
  SOURCE_URL,
  PORT,
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
  STATIC_FILES,
  normalizeOutput,
};
