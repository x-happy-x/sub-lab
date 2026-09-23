/**
 * Разбор имени и ссылки сервера для списков.
 *
 * Провайдеры кладут в имя всё сразу: флаг страны, пометку «обход», номер,
 * иногда протокол. Списки от этого выглядят как каша, поэтому разбираем имя
 * на части один раз здесь, а рисуем — общим компонентом.
 */

/** Пара региональных индикаторов — обычный флаг страны. */
const COUNTRY_FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
/** Белый и чёрный флаги, флажки: ими помечают «обход» и служебные записи. */
const OTHER_FLAG = /\u{1F3F3}️?|\u{1F3F4}(?:\u{E0060}-\u{E007F})*|\u{1F6A9}|\u{1F3C1}/u;

/**
 * Названия «белых» серверов у провайдеров.
 *
 * Те же слова, что в быстрых наборах регулярок конструктора объединения:
 * whitelist, white, Белые, Обход, bypass, direct, а ещё LTE и 4G — это те же
 * белые списки, просто названные по каналу.
 */
export const BYPASS_PATTERN = "whitelist|white|бел[ыо]|обход|bypass|direct|lte|4g|3g";

const BYPASS_RE = new RegExp(BYPASS_PATTERN, "i");

export type ServerMeta = {
  /** Флаг страны из имени, если он там был. */
  flag: string;
  /** Имя без вынесенного флага. */
  label: string;
  /** VLESS, VMESS, SS, TROJAN — из ссылки, если она есть. */
  protocol: string;
  /** TCP, WS, GRPC — транспорт. */
  network: string;
  /** REALITY, TLS — защита. */
  security: string;
  /** Имя похоже на «белый» сервер для обхода. */
  bypass: boolean;
};

/** Первый флаг в имени: сначала страна, потом всё остальное. */
function pickFlag(name: string): string {
  return COUNTRY_FLAG.exec(name)?.[0] || OTHER_FLAG.exec(name)?.[0] || "";
}

function readUriPart(uri: string, key: string): string {
  try {
    const query = uri.slice(uri.indexOf("?") + 1).split("#")[0];
    const value = new URLSearchParams(query).get(key);
    return String(value || "").trim();
  } catch {
    return "";
  }
}

export function isBypassName(name: string): boolean {
  return BYPASS_RE.test(String(name || ""));
}

/**
 * Разобрать сервер для показа.
 *
 * Ссылка необязательна: у предпросмотра объединения есть только имена, и это
 * нормально — тогда остаются флаг, имя и пометка обхода.
 */
export function parseServerMeta(name: string, uri = ""): ServerMeta {
  const raw = String(name || "").trim();
  const flag = pickFlag(raw);
  // Флаг вынесли в свою плашку — из имени его убираем, иначе он задвоится.
  const label = (flag ? raw.replace(flag, "") : raw).replace(/\s{2,}/g, " ").trim() || raw;

  const link = String(uri || "").trim();
  const scheme = /^([a-z0-9+-]+):\/\//i.exec(link)?.[1] || "";
  const security = link ? readUriPart(link, "security") : "";
  const network = link ? readUriPart(link, "type") : "";

  return {
    flag,
    label,
    protocol: scheme ? scheme.toUpperCase() : "",
    network: network && network !== "none" ? network.toUpperCase() : "",
    security: security && security !== "none" ? security.toUpperCase() : "",
    bypass: isBypassName(raw),
  };
}
