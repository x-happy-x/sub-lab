/**
 * Ежедневная проверка подписок.
 *
 * Карточка должна отвечать на простой вопрос — «она вообще ещё жива?» — не
 * заставляя открывать страницу подключения. Заодно достаём срок и трафик из
 * заголовков провайдера и ссылку, по которой подписку продлевают.
 *
 * Ходим не чаще раза в сутки: чаще незачем, а провайдеры к частым запросам
 * относятся плохо — у некоторых за ними стоит антибот.
 */
import { parseSubscriptionUserinfo } from "./merge-source.js";
import { fetchWithNode, resolveRequestConfig, produceOutput } from "./subscription.js";
import { decodeBase64IfNeeded } from "./model/parse-source.js";
import {
  getShortLinkHealth,
  getShortLinkRow,
  listShortLinksDueForHealthCheck,
  upsertShortLinkHealth,
} from "./sqlite-store.js";

const CHECK_TIMEOUT_MS = 45_000;
const SERVER_LINE = /^(vmess|vless|ss|ssr|trojan):\/\//;

/** `profile-title` приезжает в base64, когда в названии есть не-ASCII. */
function decodeTitleHeader(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("base64:")) return raw;
  try {
    return Buffer.from(raw.slice(7), "base64").toString("utf8").trim();
  } catch {
    return raw;
  }
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[name];
  if (direct !== undefined) return String(Array.isArray(direct) ? direct[0] : direct || "").trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== lower) continue;
    return String(Array.isArray(value) ? value[0] : value || "").trim();
  }
  return "";
}

/**
 * Проверить одну подписку.
 *
 * Объединение проверяется наравне с остальными: fetchWithNode сам ходит по
 * его источникам, а заголовки собираются в общий `subscription-userinfo` —
 * срок там самый дальний, потому что объединение живо, пока жив хоть один.
 */
async function checkShortLinkHealth(id) {
  const linkId = String(id || "").trim();
  const link = await getShortLinkRow(linkId);
  if (!link) throw new Error("короткая ссылка не найдена");

  const params = link.params || {};

  const requestUrl = new URL("http://localhost/sub");
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    requestUrl.searchParams.set(key, String(value));
  }

  const base = {
    shortLinkId: linkId,
    checkedAt: new Date().toISOString(),
    ok: false,
    unreachable: false,
    status: 0,
    error: "",
    servers: 0,
    upload: 0,
    download: 0,
    total: 0,
    expireAt: 0,
    supportUrl: "",
    webPageUrl: "",
    providerTitle: "",
  };

  const config = resolveRequestConfig(requestUrl, {});
  if (!config.ok) {
    return await upsertShortLinkHealth({ ...base, error: config.error || "неверные параметры подписки" });
  }
  if (!/^(https?:\/\/|merge:)/i.test(String(config.subUrl || ""))) {
    // Без этого наружу уезжало бы undici-шное «Failed to parse URL from DAS».
    return await upsertShortLinkHealth({
      ...base,
      error: `адрес подписки не похож на ссылку: ${String(config.subUrl || "пусто").slice(0, 60)}`,
    });
  }

  try {
    const fetched = await Promise.race([
      fetchWithNode(config.subUrl, config.forwardHeaders),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("провайдер не ответил за 45 секунд")), CHECK_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    const headers = fetched.responseHeaders || {};
    const info = parseSubscriptionUserinfo(headerOf(headers, "subscription-userinfo"));
    const status = Math.max(0, Number(fetched.responseStatus || 0));
    // Считаем серверы по приведённому к raw ответу: так одинаково разбираются
    // и base64, и clash, и json, а на HTML-заглушке приходит внятная причина,
    // а не молчаливый ноль.
    const converted = await produceOutput(fetched.body, "raw", { app: config.app });
    // produceOutput в режиме raw отдаёт тело как есть, а провайдеры часто
    // шлют base64 — без декодирования серверов в нём «ноль».
    const servers = converted.ok
      ? decodeBase64IfNeeded(String(converted.body || ""))
        .split(/\r?\n/)
        .filter((line) => SERVER_LINE.test(line.trim()))
        .length
      : 0;
    return await upsertShortLinkHealth({
      ...base,
      // Живой считаем подписку, из которой удалось достать хотя бы один
      // сервер: 200 с пустым телом или страницей антибота — это не «жива».
      ok: servers > 0,
      status,
      error: servers > 0
        ? ""
        : (converted.error || "провайдер не отдал ни одного сервера"),
      servers,
      upload: info.upload,
      download: info.download,
      total: info.total,
      expireAt: info.expire > 0 ? info.expire * 1000 : 0,
      supportUrl: headerOf(headers, "support-url"),
      webPageUrl: headerOf(headers, "profile-web-page-url"),
      providerTitle: decodeTitleHeader(headerOf(headers, "profile-title")),
    });
  } catch (e) {
    // До провайдера не дошли вовсе: свой обрыв связи, DNS или таймаут. Это не
    // повод объявлять подписку мёртвой — иначе разовая авария у нас красит
    // весь список в красное на сутки. Прошлые цифры оставляем как есть.
    const previous = await getShortLinkHealth(linkId);
    return await upsertShortLinkHealth({
      ...base,
      unreachable: true,
      error: describeTransportError(e),
      servers: previous?.servers ?? 0,
      upload: previous?.upload ?? 0,
      download: previous?.download ?? 0,
      total: previous?.total ?? 0,
      expireAt: previous?.expireAt ?? 0,
      supportUrl: previous?.supportUrl ?? "",
      webPageUrl: previous?.webPageUrl ?? "",
      providerTitle: previous?.providerTitle ?? "",
    });
  }
}

/**
 * Человеческая причина вместо undici-шного «fetch failed».
 *
 * `subject` — до кого не дозвонились: у проверки подписки это провайдер, у
 * синхронизации — удалённая панель. Само «fetch failed» не объясняет ничего,
 * и по нему нельзя понять, чинить настройки или ждать связь.
 */
function describeTransportError(error, subject = "провайдера") {
  const code = String(error?.cause?.code || error?.code || "");
  const message = String(error?.message || error || "не удалось связаться");
  const prefix = `не дозвонились до ${subject}`;
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return `${prefix}: таймаут соединения`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${prefix}: адрес не разрешается`;
  if (code === "ECONNREFUSED") return `${prefix}: соединение отклонено`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `${prefix}: соединение оборвано`;
  if (code.startsWith("CERT_") || code === "DEPTH_ZERO_SELF_SIGNED_CERT") return `${prefix}: проблема с сертификатом`;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `${prefix}: ответа не дождались`;
  if (/за 45 секунд/.test(message)) return message;
  return `${prefix}: ${message}`.slice(0, 400);
}

let healthRunning = false;

/**
 * Обойти всех, кого давно не проверяли.
 *
 * Последовательно и с паузой: одновременный залп по двум десяткам провайдеров
 * выглядит со стороны ровно как то, от чего они ставят антибот.
 */
async function runHealthSweep({ maxAgeHours = 24, limit = 200, pauseMs = 750 } = {}) {
  if (healthRunning) return { skipped: true, checked: 0, alive: 0, failed: 0 };
  healthRunning = true;
  const report = { skipped: false, checked: 0, alive: 0, failed: 0, unreachable: 0 };
  try {
    const ids = await listShortLinksDueForHealthCheck(maxAgeHours, limit);
    for (const id of ids) {
      let result = null;
      try {
        result = await checkShortLinkHealth(id);
      } catch {
        result = null;
      }
      if (!result) continue;
      report.checked += 1;
      if (result.ok) report.alive += 1;
      else if (result.unreachable) report.unreachable += 1;
      else report.failed += 1;
      if (pauseMs > 0) {
        // Тоже без unref: иначе обход обрывается на первой же паузе, если
        // процессу в этот момент больше нечем заняться.
        await new Promise((resolve) => { setTimeout(resolve, pauseMs); });
      }
    }
  } finally {
    healthRunning = false;
  }
  return report;
}

/**
 * Расписание: просыпаемся раз в час и добираем тех, кому больше суток.
 *
 * Час, а не сутки: панель перезапускают чаще, чем раз в день, и привязка к
 * моменту старта означала бы, что до проверки дело не дойдёт никогда.
 */
function startHealthScheduler({ intervalMs = 3600_000, firstRunDelayMs = 60_000 } = {}) {
  const tick = async () => {
    try {
      const report = await runHealthSweep();
      if (report.checked > 0) {
        console.log(`[INFO] проверка подписок: ${report.checked}, живых ${report.alive}, с ошибкой ${report.failed}, недоступных ${report.unreachable}`);
      }
    } catch (e) {
      console.log(`[WARN] проверка подписок не удалась: ${e?.message || e}`);
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  const first = setTimeout(() => { void tick(); }, firstRunDelayMs);
  if (typeof first.unref === "function") first.unref();
}

export { checkShortLinkHealth, describeTransportError, runHealthSweep, startHealthScheduler };
