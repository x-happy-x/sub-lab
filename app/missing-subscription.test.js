import test from "node:test";
import assert from "node:assert/strict";

import { renderProblemPage, sendMissingSubscription } from "./server.js";

/** Минимальный res: запоминает всё, что в него написали. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(body) { this.body = String(body ?? ""); },
  };
}

const req = (url, headers = {}) => ({ url, headers });

test("браузеру — страница с объяснением", () => {
  const res = fakeRes();
  sendMissingSubscription(req("/l/нетакой", { accept: "text/html,*/*" }), res, "нетакой");

  assert.equal(res.statusCode, 404);
  assert.match(String(res.headers["Content-Type"]), /text\/html/);
  assert.match(res.body, /Подписка не найдена/);
  // Человеку с чужой ссылкой нужно понимать, что делать дальше.
  assert.match(res.body, /Проверьте адрес/);
  assert.match(res.body, /Открыть панель/);
});

test("приложению — подписка из одного узла с текстом в имени", () => {
  const res = fakeRes();
  sendMissingSubscription(req("/l/пропала", { "user-agent": "Happ/5.8.0/ios/1" }), res, "пропала");

  // Именно 200: на 404 приложение не станет разбирать тело и покажет свою
  // ошибку вместо нашей.
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(String(res.headers["Content-Type"]), /text\/html/);
  // Один узел, не список.
  const lines = res.body.split(/\r?\n/).filter((line) => /^\w+:\/\//.test(line.trim()));
  assert.equal(lines.length, 1);
  // Имя узла и есть объяснение — в raw оно уезжает в кодированном виде.
  assert.match(decodeURIComponent(lines[0]), /Подписка не найдена/);
});

test("формат берётся из ссылки, когда он назван прямо", () => {
  const res = fakeRes();
  sendMissingSubscription(req("/l/пропала?type=json", { accept: "text/html" }), res, "пропала");

  // `?type=` сильнее и Accept, и User-Agent: раз формат назван — значит,
  // ссылку открывает приложение, а не человек.
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["Content-Type"]), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.equal(Array.isArray(parsed) ? parsed.length : 1, 1);
});

test("клиенту Clash — конфиг, а не список ссылок", () => {
  const res = fakeRes();
  sendMissingSubscription(req("/l/пропала", { "user-agent": "clash.meta/v1.19.24" }), res, "пропала");

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /^proxies:/m);
  assert.match(res.body, /Подписка не найдена/);
});

test("неизвестный клиент без Accept получает подписку, а не страницу", () => {
  const res = fakeRes();
  sendMissingSubscription(req("/l/пропала", {}), res, "пропала");
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(String(res.headers["Content-Type"]), /text\/html/);
});

test("страница показывает код ответа и не ломается на кавычках", () => {
  const page = renderProblemPage('Тест "кавычки" & <тег>', "Строка\nс переносом", null, 403);
  assert.match(page, /<span class="code">403<\/span>/);
  // Текст приходит из политик подписки — его пишет человек, и там бывает всё.
  assert.doesNotMatch(page, /<тег>/);
  assert.match(page, /&lt;тег&gt;/);
  assert.match(page, /&quot;кавычки&quot;|&#34;кавычки&#34;/);
});
