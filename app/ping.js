/**
 * Замер задержки до серверов подписки.
 *
 * Полноценный тест «как в приложении» — это поднять туннель и сходить через
 * него наружу; клиента протоколов здесь нет и не будет. Зато всё, что меряет
 * телефон до того, как туннель встанет, замерить можно: DNS, TCP-рукопожатие
 * и TLS. Именно они и отвечают на вопрос «сервер вообще жив и далеко ли он».
 */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";

const PING_TCP = "tcp";
const PING_TLS = "tls";
const PING_DNS = "dns";
const PING_MODES = [PING_TCP, PING_TLS, PING_DNS];
const PING_MODE_DEFAULT = PING_TCP;

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 10000;
const MAX_TARGETS = 120;
const MAX_ATTEMPTS = 5;
const CONCURRENCY = 8;

function normalizePingMode(value) {
  const token = String(value || "").trim().toLowerCase();
  return PING_MODES.includes(token) ? token : PING_MODE_DEFAULT;
}

function normalizeTimeout(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(300, Math.round(ms)));
}

function normalizeAttempts(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(count)));
}

function normalizeTarget(raw, index) {
  const host = String(raw?.host || "").trim();
  if (!host) return null;
  const port = Math.min(65535, Math.max(1, Number(raw?.port || 443) || 443));
  return {
    id: String(raw?.id || `${index}`),
    name: String(raw?.name || host).slice(0, 200),
    host: host.slice(0, 255),
    port,
    // Для TLS важно, какое имя предъявлять: у reality и ws оно отличается от адреса.
    sni: String(raw?.sni || "").trim().slice(0, 255),
  };
}

function normalizeTargets(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_TARGETS)
    .map(normalizeTarget)
    .filter(Boolean);
}

/** Одна попытка: соединяемся и меряем, сколько заняло рукопожатие. */
function measureOnce(target, mode, timeoutMs) {
  if (mode === PING_DNS) return measureDns(target, timeoutMs);
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // сокет уже закрыт — измерению это не мешает
      }
      resolve(result);
    };

    const onReady = () => finish({ ok: true, ms: Math.round(performance.now() - started), error: "" });
    const onError = (error) => finish({ ok: false, ms: 0, error: String(error?.code || error?.message || "connect failed") });

    const socket = mode === PING_TLS
      ? tls.connect({
        host: target.host,
        port: target.port,
        servername: target.sni || (net.isIP(target.host) ? undefined : target.host),
        // Сертификат нас не интересует: меряем доступность, а не доверие.
        rejectUnauthorized: false,
      }, onReady)
      : net.connect({ host: target.host, port: target.port }, onReady);

    socket.setTimeout(timeoutMs, () => finish({ ok: false, ms: 0, error: "timeout" }));
    socket.on("error", onError);
  });
}

async function measureDns(target, timeoutMs) {
  if (net.isIP(target.host)) {
    return { ok: true, ms: 0, error: "", note: "адрес уже числовой" };
  }
  const started = performance.now();
  try {
    await Promise.race([
      dns.lookup(target.host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { ok: true, ms: Math.round(performance.now() - started), error: "" };
  } catch (e) {
    return { ok: false, ms: 0, error: String(e?.code || e?.message || "dns failed") };
  }
}

function summarize(samples) {
  const good = samples.filter((sample) => sample.ok).map((sample) => sample.ms);
  if (good.length === 0) {
    return {
      ok: false,
      best: 0,
      worst: 0,
      average: 0,
      loss: 100,
      error: samples.find((sample) => sample.error)?.error || "нет ответа",
    };
  }
  const sum = good.reduce((acc, ms) => acc + ms, 0);
  return {
    ok: true,
    best: Math.min(...good),
    worst: Math.max(...good),
    average: Math.round(sum / good.length),
    loss: Math.round(((samples.length - good.length) / samples.length) * 100),
    error: "",
  };
}

/**
 * Пинг списка серверов.
 *
 * Меряем пачками: последовательно ждать сотню серверов долго, а открывать их
 * все разом — получить таймауты на ровном месте из-за очереди сокетов.
 */
async function pingTargets(input = {}) {
  const targets = normalizeTargets(input.targets);
  const mode = normalizePingMode(input.mode);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const attempts = normalizeAttempts(input.attempts);
  if (targets.length === 0) return { ok: false, status: 400, error: "ping targets are required" };

  const results = new Array(targets.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      const samples = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        samples.push(await measureOnce(target, mode, timeoutMs));
      }
      results[index] = {
        id: target.id,
        name: target.name,
        host: target.host,
        port: target.port,
        ...summarize(samples),
        samples: samples.map((sample) => ({ ok: sample.ok, ms: sample.ms, error: sample.error })),
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  return { ok: true, mode, timeoutMs, attempts, results };
}

export {
  PING_DNS,
  PING_MODES,
  PING_MODE_DEFAULT,
  PING_TCP,
  PING_TLS,
  normalizePingMode,
  normalizeTargets,
  pingTargets,
  summarize,
};
