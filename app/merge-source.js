import { Buffer } from "node:buffer";

/**
 * Объединённая подписка: отбор серверов и сведение заголовков.
 *
 * Каждый источник в объединении живёт своей жизнью: у него свои устройство,
 * приложение и профиль. Общего здесь два: какие серверы из источника брать
 * (регулярка по имени) и что делать, если под неё ничего не подошло.
 */

/** Что делать, когда регулярка не нашла ни одного сервера. */
const ON_EMPTY_ALL = "all";
const ON_EMPTY_SKIP = "skip";
const ON_EMPTY_ERROR = "error";
const ON_EMPTY_MODES = [ON_EMPTY_ALL, ON_EMPTY_SKIP, ON_EMPTY_ERROR];
const ON_EMPTY_DEFAULT = ON_EMPTY_ALL;

function normalizeOnEmpty(value) {
  const token = String(value || "").trim().toLowerCase();
  return ON_EMPTY_MODES.includes(token) ? token : ON_EMPTY_DEFAULT;
}

function normalizeMergeFilter(raw) {
  return {
    pattern: String(raw?.pattern || "").trim().slice(0, 500),
    onEmpty: normalizeOnEmpty(raw?.onEmpty),
  };
}

/**
 * Регулярка из строки пользователя.
 *
 * Регистр не учитываем: названия серверов у провайдеров приходят как попало,
 * и «Белые» против «белые» — не та разница, ради которой стоит спотыкаться.
 * Кривой шаблон не валит объединение, а просто не фильтрует.
 */
function compileMergePattern(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return null;
  try {
    return new RegExp(text, "i");
  } catch {
    return null;
  }
}

/** Имя сервера из строки raw-подписки: всё, что после `#`. */
function nameFromRawLine(line) {
  const text = String(line || "");
  const hash = text.indexOf("#");
  if (hash < 0) return "";
  const tail = text.slice(hash + 1);
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function rawLines(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Отбор строк одного источника.
 *
 * Возвращает и сами строки, и статистику — она нужна и для ошибки, и для
 * предпросмотра в интерфейсе.
 */
function filterRawBody(body, filter, label = "") {
  const lines = rawLines(body);
  const normalized = normalizeMergeFilter(filter);
  const pattern = compileMergePattern(normalized.pattern);
  if (!pattern) {
    return { lines, total: lines.length, matched: lines.length, filtered: false, fellBack: false };
  }

  const matched = lines.filter((line) => pattern.test(nameFromRawLine(line) || line));
  if (matched.length > 0) {
    return { lines: matched, total: lines.length, matched: matched.length, filtered: true, fellBack: false };
  }

  const where = label ? ` (${label})` : "";
  if (normalized.onEmpty === ON_EMPTY_ERROR) {
    throw new Error(`под регулярку «${normalized.pattern}» не подошёл ни один сервер${where}`);
  }
  if (normalized.onEmpty === ON_EMPTY_SKIP) {
    return { lines: [], total: lines.length, matched: 0, filtered: true, fellBack: true };
  }
  return { lines, total: lines.length, matched: 0, filtered: true, fellBack: true };
}

/** Строка raw-подписки с новым именем в `#`. */
function withRawLineName(line, name) {
  const text = String(line || "");
  const hash = text.indexOf("#");
  const base = hash < 0 ? text : text.slice(0, hash);
  return `${base}#${encodeURIComponent(name)}`;
}

/**
 * Развести одинаковые имена серверов.
 *
 * У разных провайдеров легко встречается один и тот же «Нидерланды», и в
 * приложении две такие строки неразличимы: непонятно, какая из какой подписки
 * и почему одна не работает. Повторам добавляем номер, первый остаётся как был.
 */
function dedupeServerNames(lines) {
  const used = new Map();
  return lines.map((line) => {
    const name = nameFromRawLine(line);
    if (!name) return line;
    const key = name.toLowerCase();
    const seen = used.get(key) || 0;
    used.set(key, seen + 1);
    if (seen === 0) return line;
    let suffix = seen + 1;
    let candidate = `${name} (${suffix})`;
    while (used.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${name} (${suffix})`;
    }
    used.set(candidate.toLowerCase(), 1);
    return withRawLineName(line, candidate);
  });
}

/* ---------- заголовки ---------- */

function parseSubscriptionUserinfo(value) {
  const out = { upload: 0, download: 0, total: 0, expire: 0 };
  const raw = String(value || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=").map((x) => String(x || "").trim().toLowerCase());
    if (!k) continue;
    const n = Number(v || "0");
    if (!Number.isFinite(n)) continue;
    if (k === "upload") out.upload = Math.max(0, n);
    if (k === "download") out.download = Math.max(0, n);
    if (k === "total") out.total = Math.max(0, n);
    if (k === "expire") out.expire = Math.max(0, n);
  }
  return out;
}

function formatSubscriptionUserinfo(info) {
  const parts = [
    `upload=${Math.max(0, Math.round(Number(info?.upload || 0)))}`,
    `download=${Math.max(0, Math.round(Number(info?.download || 0)))}`,
    `total=${Math.max(0, Math.round(Number(info?.total || 0)))}`,
  ];
  const expire = Math.max(0, Math.round(Number(info?.expire || 0)));
  if (expire > 0) parts.push(`expire=${expire}`);
  return parts.join("; ");
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const lower = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key || "").toLowerCase() === lower) return String(value ?? "").trim();
  }
  return "";
}

/**
 * Сводка трафика по всем источникам объединения.
 *
 * Потрачено и лимит складываем: объединение живёт ровно столько, сколько дают
 * все источники вместе. Срок берём ближайший — когда кончится первый источник,
 * часть серверов в объединении уже перестанет работать, и честнее показать
 * именно эту дату, а не самую дальнюю.
 */
function mergeUserinfo(list) {
  const totals = { upload: 0, download: 0, total: 0, expire: 0 };
  let seen = false;
  let unlimited = false;
  for (const raw of list) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const info = parseSubscriptionUserinfo(text);
    if (info.upload === 0 && info.download === 0 && info.total === 0 && info.expire === 0) continue;
    seen = true;
    totals.upload += info.upload;
    totals.download += info.download;
    if (info.total > 0) totals.total += info.total;
    else unlimited = true;
    if (info.expire > 0 && (totals.expire === 0 || info.expire < totals.expire)) totals.expire = info.expire;
  }
  if (!seen) return "";
  // Хотя бы один безлимитный источник — общий лимит тоже безлимитный.
  if (unlimited) totals.total = 0;
  return formatSubscriptionUserinfo(totals);
}

/** Заголовки ответа объединённой подписки. */
function buildMergedResponseHeaders(sourceHeaders, { title = "" } = {}) {
  const headers = { "content-type": "text/plain; charset=utf-8" };
  const userinfo = mergeUserinfo(sourceHeaders.map((item) => headerValue(item, "subscription-userinfo")));
  if (userinfo) headers["subscription-userinfo"] = userinfo;

  // В заголовок можно класть только latin1, а названия у нас русские. Провайдеры
  // решают это префиксом `base64:` — тем же, который мы сами и разбираем.
  const name = String(title || "").trim();
  if (name) {
    headers["profile-title"] = /^[\x20-\x7e]*$/.test(name)
      ? name
      : `base64:${Buffer.from(name, "utf8").toString("base64")}`;
  }

  // Интервал обновления — самый частый из заявленных источниками.
  let interval = 0;
  for (const item of sourceHeaders) {
    const value = Number(headerValue(item, "profile-update-interval") || 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (interval === 0 || value < interval) interval = value;
  }
  if (interval > 0) headers["profile-update-interval"] = String(interval);

  return headers;
}

export {
  ON_EMPTY_ALL,
  ON_EMPTY_SKIP,
  ON_EMPTY_ERROR,
  ON_EMPTY_MODES,
  ON_EMPTY_DEFAULT,
  buildMergedResponseHeaders,
  compileMergePattern,
  dedupeServerNames,
  filterRawBody,
  formatSubscriptionUserinfo,
  headerValue,
  mergeUserinfo,
  nameFromRawLine,
  normalizeMergeFilter,
  normalizeOnEmpty,
  parseSubscriptionUserinfo,
  rawLines,
  withRawLineName,
};
