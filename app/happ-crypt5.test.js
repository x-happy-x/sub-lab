import test from "node:test";
import assert from "node:assert/strict";

import {
  decryptHappCrypt5,
  encryptHappCrypt5,
  isEncryptedHappLink,
  isHappCrypt5Link,
  listHappMarkers,
} from "./happ-crypt5.js";
import { decryptHappLink } from "./subscription.js";

// Эталонная ссылка Happ с вымышленным адресом, собрана encryptHappCrypt5 (соль).
// Формат сверялся с настоящими ссылками Happ и независимой реализацией на Go.
const SAMPLE_LINK = "happ://crypt5/bzqywwjuxq7R0ZqZYZSFeObl11xHPc2S9JqWCN9F7aIMXFgJJzr9J8pQpm0Hpp/bKs+DB2Cv80Sl4nnIoyZoMNn2iHIxw5lFYU3i1HgTco5bXzdIisO1i1gFCmOGzUqMPl9eXU4OJApnVOcEnxhvwtuKbQIQbwRbT11/3tnqw3mms0zgqPPiGO1Q2hJhTIPO1l9Bas41dB6YU6/lKPWEAo1a2tPn8WManoRn6BGSncboIGTKGUWcQ+edo6DP7HLRHNz1uOfbqZkmHTiJvvm/MD5kINHJRtfktOoWTG9EvHK0NTlCycDFaj5i10haYodMwWueYixjJzHANaDoV7TmalU8UWLWoGt1qrOZTfAklv9ChHY33l/sved3giK8aA6rWZTbWJvfRRtO/s9rTW5e9mkneZdgpcnvFQmCDVzx4GF68Hmed6SE40Z25c5zufeQd3+1hvTBLcb9KeDLYjS/QThD/6CkpM0noBQpEiDAANDxMQbu2GKASXzQwaJ+0FxzqClMqu3+IQnE9oUGOE9RYkChdsFm1pGoMsuKR/MwBkgyaDpK0sIOuLrmz6pU3PzKmb/unXgDpG6zgTPCypqC60ziXkPwVlleDnwhwOX+VFryt/jZ6uVCUgeVRtrutPoxURlpzw16v1dDdRAUjSi1jP5Zuw4iE4UEH6eGQoW4sZ/tQrNFLRAg+ezVIdqA9DcrRMsUpuJxBUBFwoHOl32MeJPw8GPXPU0qknX+krHswBXsjoRda1nHROVQSiLxWhPOxMxduqHlMkIIH8UjHhYR+S4CDYXYvnhI3eBRTuICHQdwlQelbqIfbZurmio=dz";
const SAMPLE_URL = "https://sub.example.net/s/Demo0Subscription1Token";

test("эталонная ссылка расшифровывается", () => {
  assert.equal(decryptHappCrypt5(SAMPLE_LINK), SAMPLE_URL);
  // Схема необязательна: из буфера обмена прилетает и «crypt5/...».
  assert.equal(decryptHappCrypt5(SAMPLE_LINK.replace("happ://", "")), SAMPLE_URL);
  // Кавычки от копирования из консоли тоже не должны мешать.
  assert.equal(decryptHappCrypt5(`"${SAMPLE_LINK}"`), SAMPLE_URL);
});

test("ссылка собирается обратно и читается", () => {
  for (const url of [
    "https://sub.example.org/l/8YHjiTo",
    "https://example.com/s/abc?token=1&x=2#frag",
    "https://пример.рф/подписка",
    `https://example.com/${"a".repeat(2000)}`,
  ]) {
    const link = encryptHappCrypt5(url);
    assert.match(link, /^happ:\/\/crypt5\//);
    // Ссылку копируют руками и шлют в мессенджерах: непечатаемые байты в ней
    // превратили бы её в мусор ещё до того, как её попробуют открыть.
    assert.match(link, /^[\x20-\x7e]+$/, `непечатаемые символы для ${url.slice(0, 40)}`);
    assert.equal(decryptHappCrypt5(link), url);
  }
});

test("каждый раз получается новая ссылка", () => {
  const url = "https://example.com/same";
  const first = encryptHappCrypt5(url);
  const second = encryptHappCrypt5(url);
  assert.notEqual(first, second);
  assert.equal(decryptHappCrypt5(first), url);
  assert.equal(decryptHappCrypt5(second), url);
});

test("раскладка без соли тоже читается", () => {
  const url = "https://example.com/plain";
  const link = encryptHappCrypt5(url, { salted: false });
  assert.equal(decryptHappCrypt5(link), url);
});

test("маркер можно задать, но только из таблицы", () => {
  const markers = listHappMarkers();
  assert.ok(markers.length >= 1);
  assert.equal(markers.every((marker) => marker.length === 8), true);
  const link = encryptHappCrypt5("https://example.com/fixed", { marker: markers[0] });
  assert.equal(decryptHappCrypt5(link), "https://example.com/fixed");
  assert.throws(() => encryptHappCrypt5("https://example.com/x", { marker: "нетакой" }), /не из таблицы/);
});

test("испорченная ссылка объясняет, что не так", () => {
  assert.throws(() => decryptHappCrypt5("https://example.com/plain"), /happ:\/\/crypt5/);
  assert.throws(() => decryptHappCrypt5("happ://crypt5/short"), /слишком короткое/);
  // Подменённый маркер: ключа под него нет.
  const link = encryptHappCrypt5("https://example.com/x");
  const broken = `happ://crypt5/zzzz${link.slice("happ://crypt5/".length + 4)}`;
  assert.throws(() => decryptHappCrypt5(broken), /неизвестный маркер|повреждена|не похожа/);
  assert.throws(() => encryptHappCrypt5(""), /нечего шифровать/);
  assert.throws(() => encryptHappCrypt5(SAMPLE_LINK), /уже зашифрованная/);
});

test("подмена одного символа ломает проверку подлинности", () => {
  const link = encryptHappCrypt5("https://example.com/authentic");
  const middle = Math.floor(link.length / 2);
  const swapped = link[middle] === "A" ? "B" : "A";
  const tampered = link.slice(0, middle) + swapped + link.slice(middle + 1);
  assert.throws(() => decryptHappCrypt5(tampered));
});

test("распознавание ссылок", () => {
  assert.equal(isHappCrypt5Link(SAMPLE_LINK), true);
  assert.equal(isHappCrypt5Link("crypt5/abc"), true);
  assert.equal(isHappCrypt5Link("https://example.com"), false);
  assert.equal(isEncryptedHappLink("happ://crypt2/abc"), true);
  assert.equal(isEncryptedHappLink("https://example.com"), false);
});

test("обычная ссылка проходит через decryptHappLink насквозь", async () => {
  const plain = await decryptHappLink("https://example.com/sub");
  assert.equal(plain.changed, false);
  assert.equal(plain.resolvedUrl, "https://example.com/sub");

  const encrypted = await decryptHappLink(SAMPLE_LINK);
  assert.equal(encrypted.changed, true);
  assert.equal(encrypted.resolvedUrl, SAMPLE_URL);
});
