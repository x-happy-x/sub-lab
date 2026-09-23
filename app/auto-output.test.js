import test from "node:test";
import assert from "node:assert/strict";

import { resolveOutputFromUserAgent } from "./subscription.js";

/**
 * Авто-формат нужен, чтобы не слать клиенту то, чего он не прочитает.
 * Отменять осознанный выбор формата — не его дело: именно так подписка,
 * настроенная как json, приезжала в Happ плоским raw.
 */
test("у Happ формат решает источник, а не настройка подписки", () => {
  // Happ читает и плоский список, и бандл Xray. Что из двух — известно только
  // после запроса к провайдеру, поэтому здесь помечаем выбор как «по источнику»
  // и временно ставим raw.
  for (const configured of ["json", "yml", "raw"]) {
    const happ = resolveOutputFromUserAgent("Happ/3.10.0", configured);
    assert.equal(happ.matched, true);
    assert.equal(happ.app, "happ");
    assert.equal(happ.bySource, true, `для настройки ${configured}`);
    assert.equal(happ.output, "raw");
  }
});

test("клиенту Clash всегда отдаём Clash", () => {
  for (const configured of ["json", "yml", "raw"]) {
    const result = resolveOutputFromUserAgent("FlClashX/1.0", configured);
    assert.equal(result.output, "clash", `для настройки ${configured}`);
    assert.equal(result.bySource, false);
  }
});

test("неизвестный клиент ничего не меняет", () => {
  for (const configured of ["json", "yml", "raw", "raw_base64"]) {
    const result = resolveOutputFromUserAgent("Mozilla/5.0", configured);
    assert.equal(result.matched, false);
    assert.equal(result.app, "");
    assert.equal(result.output, configured === "yml" ? "clash" : configured);
  }
});

test("пустой user-agent не ломает выбор", () => {
  assert.equal(resolveOutputFromUserAgent("", "json").output, "json");
  assert.equal(resolveOutputFromUserAgent(undefined, "raw").output, "raw");
});

test("узнанный, но не описанный клиент ничего не подменяет", () => {
  // Клиент определился по UA-каталогу, а в apps.yml его нет — про форматы мы
  // ничего не знаем. Раньше таким молча выдавался clash, что для Xray-клиента
  // означало нечитаемую подписку.
  const result = resolveOutputFromUserAgent("NoSuchClient/1.0 SomeUnknownApp", "json");
  assert.equal(result.output, "json");
});

test("клиентам Clash raw не отдаём", () => {
  // mihomo не читает плоский список ссылок — ему нужен конфиг.
  assert.equal(resolveOutputFromUserAgent("clash.meta/v1.19.24", "raw").output, "clash");
  assert.equal(resolveOutputFromUserAgent("clash.meta/v1.19.24", "json").output, "clash");
  assert.equal(resolveOutputFromUserAgent("clash.meta/v1.19.24", "yml").output, "clash");
});

test("окончательный формат Happ зависит от того, что прислал провайдер", async () => {
  const { finalizeOutputBySource } = await import("./subscription.js");
  const uuid = "11111111-2222-3333-4444-555555555555";
  const rawList = `vless://${uuid}@10.0.0.1:443?type=tcp&security=none#RU`;
  const jsonBundle = JSON.stringify([{ remarks: "A", outbounds: [] }]);

  assert.equal(finalizeOutputBySource("raw", true, "https://p.example.com/s", jsonBundle, "application/json"), "json");
  assert.equal(finalizeOutputBySource("raw", true, "https://p.example.com/s", rawList, "text/plain"), "raw");
  // Объединение собирается из разного, и json там удобнее в любом случае.
  assert.equal(finalizeOutputBySource("raw", true, "merge:abc", rawList, "text/plain"), "json");
  // Клиенты, чей формат от источника не зависит, остаются при своём.
  assert.equal(finalizeOutputBySource("clash", false, "merge:abc", jsonBundle, ""), "clash");
});

test("тип из ссылки понимается для всех форматов", async () => {
  const { resolveShortLinkTypeOverride } = await import("./server.js");
  const url = (type) => new URL(`http://localhost/l/x?type=${type}`);
  assert.equal(resolveShortLinkTypeOverride(url("raw")), "raw");
  assert.equal(resolveShortLinkTypeOverride(url("yml")), "yml");
  assert.equal(resolveShortLinkTypeOverride(url("clash")), "yml");
  assert.equal(resolveShortLinkTypeOverride(url("base64")), "raw_base64");
  // Раньше json проваливался в авто-подбор, хотя назван в ссылке прямо.
  assert.equal(resolveShortLinkTypeOverride(url("json")), "json");
  assert.equal(resolveShortLinkTypeOverride(url("что-то")), "");
  assert.equal(resolveShortLinkTypeOverride(new URL("http://localhost/l/x")), "");
});

test("файл для proxy-providers не подменяется полным конфигом", async () => {
  const { produceOutput } = await import("./subscription.js");
  // Клиент Clash — но формат выбран осознанно именно провайдерский.
  assert.equal(resolveOutputFromUserAgent("clash.meta/v1.19.24", "clash_provider").output, "clash_provider");
  assert.equal(resolveOutputFromUserAgent("FlClashX/1.0", "clash_provider").output, "clash_provider");

  const uuid = "11111111-2222-3333-4444-555555555555";
  const raw = `vless://${uuid}@10.0.0.1:443?type=tcp&security=none#RU`;
  const provider = await produceOutput(raw, "clash_provider", { app: "happ" });
  assert.equal(provider.ok, true, provider.error);
  assert.match(provider.body, /^proxies:/m);
  // Ни групп, ни правил: mihomo в роли провайдера их не читает, а на правила
  // ещё и ругается.
  assert.equal(/proxy-groups:/.test(provider.body), false);
  assert.equal(/^rules:/m.test(provider.body), false);
});

test("в json-подписке нет правил без критериев", async () => {
  const { produceOutput } = await import("./subscription.js");
  const uuid = "11111111-2222-3333-4444-555555555555";
  const raw = `vless://${uuid}@10.0.0.1:443?type=tcp&security=none#RU`;
  const result = await produceOutput(raw, "json", { app: "happ" });
  assert.equal(result.ok, true, result.error);

  for (const config of JSON.parse(result.body)) {
    for (const rule of config.routing?.rules || []) {
      const hasCriteria = Boolean(
        rule.domain || rule.ip || rule.port || rule.network
        || rule.protocol || rule.source || rule.inboundTag || rule.user || rule.attrs,
      );
      // Xray отвергает правило без единого критерия с «this rule has no
      // effective fields», и Happ показывает это на каждую подписку.
      assert.equal(hasCriteria, true, `правило без критериев: ${JSON.stringify(rule)}`);
    }
  }
});
