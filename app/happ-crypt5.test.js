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

// Настоящая ссылка Happ и её содержимое. Сверено с независимой реализацией
// (happ-crypt5-cli на Go): та же таблица ключей даёт тот же результат.
const REAL_LINK = "happ://crypt5/fzvdd8y5uXn5FBbHyVtZ0QRa96EFefSGgZUQ6usVJJ7/UOJFP4j9rRx6dEGidFIrFgE+bpiUcQthphlJ3gLmFNtpTly7wg3AJV0in1d2/teph5fpovpCICjMRQDVUbq07YgwcpPNQTdFsAJZKXOFHT9lWSYc8W6ahluoW+f3Zj7eatLt7W4lIRpTWT4wvAIuR8dVPkpu5YC6dlIPx16L+CCiWVPKkdke3+K35RDRHQpR1jFhNGHApDClEQZUpPs+0C8PAL2Hjy68HKqifH5hYjZoIm3mOf2u93apqFTvPIWxeAf2yIhChCyUbPkwTdw+LIHkVswSMCu+aXB5GkAo6d34uWMPLE5GPAfH5hZFJEAwZgYs0J+zuxJcZ4BwwgF/0vouhGx4xpP6Wfr+1tzIQulV899I1ecjofYolr6kQSsW8msOoM1bvv1oh3L4cKKkX4tbsu4/a5mMFTnNii0O6911UduQ5HShja3yUibpqoMQluDuiFHzFmP6LTw3gFZPrS5NwW2A6/yCAkIsSgzdzVkAjENE77vPsbcDDvyvlcsX47VDL+I5pI8XbTdYEzcy8Hz3JdcNrswDc/EHkssaoGgaaNZh6TOWtJHI5d4vwbwPnIr0I3GBaGJ7CYqwwocTdHDNm1I9TsFR4tTiE//0VB49stPqVN4av/0Fa0qWe8Pyj4Q5Ot3GOfNE5bg222uuKXuR4bcVqpU6sVNSnbD5eEBgcNQybAQz03CjHYvXex+FYnmPsdXIhcX5zlAVV6bmUL8hU5bUH0NyjfNNFUywUNMkNHc6Z2FET8zVrgo5of=ff";
const REAL_URL = "https://subs.saveprox.com/QyBG6sdNeTBBffZt";

test("настоящая ссылка расшифровывается", () => {
  assert.equal(decryptHappCrypt5(REAL_LINK), REAL_URL);
  // Схема необязательна: из буфера обмена прилетает и «crypt5/...».
  assert.equal(decryptHappCrypt5(REAL_LINK.replace("happ://", "")), REAL_URL);
  // Кавычки от копирования из консоли тоже не должны мешать.
  assert.equal(decryptHappCrypt5(`"${REAL_LINK}"`), REAL_URL);
});

test("ссылка собирается обратно и читается", () => {
  for (const url of [
    "https://sub.nl.cdn6.ru/l/8YHjiTo",
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
  assert.throws(() => encryptHappCrypt5(REAL_LINK), /уже зашифрованная/);
});

test("подмена одного символа ломает проверку подлинности", () => {
  const link = encryptHappCrypt5("https://example.com/authentic");
  const middle = Math.floor(link.length / 2);
  const swapped = link[middle] === "A" ? "B" : "A";
  const tampered = link.slice(0, middle) + swapped + link.slice(middle + 1);
  assert.throws(() => decryptHappCrypt5(tampered));
});

test("распознавание ссылок", () => {
  assert.equal(isHappCrypt5Link(REAL_LINK), true);
  assert.equal(isHappCrypt5Link("crypt5/abc"), true);
  assert.equal(isHappCrypt5Link("https://example.com"), false);
  assert.equal(isEncryptedHappLink("happ://crypt2/abc"), true);
  assert.equal(isEncryptedHappLink("https://example.com"), false);
});

test("обычная ссылка проходит через decryptHappLink насквозь", async () => {
  const plain = await decryptHappLink("https://example.com/sub");
  assert.equal(plain.changed, false);
  assert.equal(plain.resolvedUrl, "https://example.com/sub");

  const encrypted = await decryptHappLink(REAL_LINK);
  assert.equal(encrypted.changed, true);
  assert.equal(encrypted.resolvedUrl, REAL_URL);
});
