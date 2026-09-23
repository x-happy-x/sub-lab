/**
 * Happ crypt5: расшифровка и сборка ссылок `happ://crypt5/...`.
 *
 * Раньше этим занимался сторонний бинарник, который запускался через execFile.
 * Он умел только в одну сторону, жил под один Linux x86-64 и ломал тесты на
 * любой другой машине. Формат разобран целиком, поэтому здесь чистый Node —
 * и заодно появилось шифрование, которого в бинарнике не было.
 *
 * Схема одного звена:
 *   payload           = swapBlockHalves(marker[0..4] + body + marker[4..8])
 *   body (salted)     = nonce(12) + 2 произвольных байта + salt(8) + длина + packed
 *   body (без соли)   = nonce(12) + длина + packed
 *   packed            = 1 произвольный байт + base64(chacha) + base64(RSA)
 *   base64(RSA)       = RSA-PKCS1v15(swapPairs(base64(ключ XOR salt)))
 *   base64(chacha)    = ChaCha20-Poly1305(nonce, swapPairs(base64(URL)))
 *
 * swapPairs и swapBlockHalves — сами себе обратные, поэтому обе стороны
 * пользуются одними и теми же функциями.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_LINK_BYTES = 2 * 1024 * 1024;
const CHACHA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 8;
const TAG_BYTES = 16;

/** Где искать таблицу ключей. Первый существующий файл и выигрывает. */
function keyFileCandidates() {
  const fromEnv = String(process.env.HAPP_CRYPT5_KEYS || "").trim();
  return [
    fromEnv,
    path.join(MODULE_DIR, "../resources/happ/crypt5-keys.json"),
    "/resources/happ/crypt5-keys.json",
    "/data/happ/crypt5-keys.json",
  ].filter(Boolean).map((value) => path.resolve(value));
}

let keyTableCache = null;

/**
 * Таблица маркеров.
 *
 * Сами ключи разбираем лениво: их 36 штук по 4096 бит, и на старте панели
 * тратить на это время незачем — почти всегда нужен ровно один.
 */
function loadKeyTable() {
  if (keyTableCache) return keyTableCache;
  const tried = [];
  for (const candidate of keyFileCandidates()) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`таблица ключей ${candidate} — не JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`таблица ключей ${candidate} должна быть объектом «маркер: ключ»`);
    }
    const table = new Map();
    for (const [marker, value] of Object.entries(parsed)) {
      if (String(marker).length !== 8 || typeof value !== "string") continue;
      table.set(String(marker), value);
    }
    if (table.size === 0) throw new Error(`в таблице ключей ${candidate} нет пригодных записей`);
    keyTableCache = { path: candidate, table, parsed: new Map() };
    return keyTableCache;
  }
  throw new Error(`таблица ключей crypt5 не найдена: ${tried.join(", ")}`);
}

function privateKeyFor(marker) {
  const state = loadKeyTable();
  if (state.parsed.has(marker)) return state.parsed.get(marker);
  const encoded = state.table.get(marker);
  if (!encoded) {
    throw new Error(`неизвестный маркер crypt5 «${marker}» — нужна свежая таблица ключей`);
  }
  const key = crypto.createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
  state.parsed.set(marker, key);
  return key;
}

export function listHappMarkers() {
  return [...loadKeyTable().table.keys()].sort();
}

export function happKeyTablePath() {
  return loadKeyTable().path;
}

export function isHappCrypt5Link(value) {
  return /^(happ:\/\/)?crypt5\//i.test(String(value || "").trim());
}

/** Любая happ-ссылка, включая форматы, которые мы не умеем разбирать. */
export function isEncryptedHappLink(value) {
  return /^happ:\/\/crypt\d*\//i.test(String(value || "").trim());
}

function swapPairs(input) {
  const out = Buffer.from(input);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const tmp = out[i];
    out[i] = out[i + 1];
    out[i + 1] = tmp;
  }
  return out;
}

function swapBlockHalves(input) {
  const out = Buffer.from(input);
  for (let i = 0; i + 3 < out.length; i += 4) {
    let tmp = out[i];
    out[i] = out[i + 2];
    out[i + 2] = tmp;
    tmp = out[i + 1];
    out[i + 1] = out[i + 3];
    out[i + 3] = tmp;
  }
  return out;
}

/** base64 в том виде, в каком его шлёт Happ: с «-_», пробелами и без padding. */
function decodeLooseBase64(input, what) {
  const text = Buffer.from(input).toString("latin1")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(text)) throw new Error(`${what}: строка не похожа на base64`);
  const out = Buffer.from(text, "base64");
  // Node молча съедает мусор, поэтому сверяем длину: иначе испорченная ссылка
  // доезжала бы до расшифровки и падала уже непонятным «authentication failed».
  if (Buffer.from(out).toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw new Error(`${what}: строка не похожа на base64`);
  }
  return out;
}

function parseLink(link) {
  const raw = String(link || "").trim().replace(/^﻿/, "");
  if (raw.length > MAX_LINK_BYTES) throw new Error("ссылка длиннее 2 МиБ");
  const unquoted = raw.replace(/^["']|["']$/g, "");
  const withoutScheme = unquoted.replace(/^happ:\/\//i, "");
  if (!/^crypt5\//i.test(withoutScheme)) {
    throw new Error("ожидалась ссылка happ://crypt5/... — другие форматы не поддерживаются");
  }
  const shuffled = swapBlockHalves(Buffer.from(withoutScheme.slice("crypt5/".length), "latin1"));
  if (shuffled.length < 8) throw new Error("тело crypt5 слишком короткое");
  const marker = shuffled.subarray(0, 4).toString("latin1") + shuffled.subarray(shuffled.length - 4).toString("latin1");
  return { marker, body: shuffled.subarray(4, shuffled.length - 4) };
}

/**
 * Снять PKCS#1 v1.5 вручную.
 *
 * Node с 18.19 запрещает RSA_PKCS1_PADDING на приватной расшифровке из-за
 * атаки Marvin, так что блок достаём сырым. Здесь это безопасно: мы разбираем
 * собственную ссылку, а не работаем оракулом для чужого шифротекста.
 */
function rsaDecryptPkcs1(key, ciphertext) {
  const block = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, ciphertext);
  if (block.length < 11 || block[0] !== 0x00 || block[1] !== 0x02) {
    throw new Error("RSA: ссылка повреждена или ключ не тот");
  }
  let separator = 2;
  while (separator < block.length && block[separator] !== 0x00) separator += 1;
  if (separator >= block.length || separator < 10) {
    throw new Error("RSA: ссылка повреждена или ключ не тот");
  }
  return block.subarray(separator + 1);
}

function decodeBody(body, key, salted) {
  if (body.length < 13) throw new Error("тело crypt5 слишком короткое");
  const nonce = body.subarray(0, NONCE_BYTES);
  let lengthStart = NONCE_BYTES;
  let salt = null;
  if (salted) {
    if (body.length < 22) throw new Error("короткий заголовок соли");
    salt = body.subarray(14, 22);
    lengthStart = 22;
  }
  let lengthEnd = lengthStart;
  while (lengthEnd < body.length && body[lengthEnd] >= 0x30 && body[lengthEnd] <= 0x39) lengthEnd += 1;
  if (lengthEnd === lengthStart) throw new Error("не указана длина сегмента");
  const segmentLength = Number(body.subarray(lengthStart, lengthEnd).toString("latin1"));
  if (!Number.isSafeInteger(segmentLength)) throw new Error("длина сегмента не число");
  const packed = body.subarray(lengthEnd);
  if (packed.length === 0 || segmentLength > packed.length - 1) throw new Error("сегмент обрезан");

  const encryptedUrl = packed.subarray(1, segmentLength + 1);
  const rsaCiphertext = decodeLooseBase64(packed.subarray(segmentLength + 1), "RSA-сегмент");
  const rsaPlaintext = rsaDecryptPkcs1(key, rsaCiphertext);
  const chachaKey = decodeLooseBase64(swapPairs(rsaPlaintext), "восстановленный ключ");
  if (chachaKey.length !== CHACHA_KEY_BYTES) {
    throw new Error(`неожиданная длина симметричного ключа: ${chachaKey.length}`);
  }
  if (salt) {
    for (let i = 0; i < chachaKey.length; i += 1) chachaKey[i] ^= salt[i % salt.length];
  }

  const sealed = decodeLooseBase64(encryptedUrl, "зашифрованный URL");
  if (sealed.length <= TAG_BYTES) throw new Error("зашифрованный URL обрезан");
  const decipher = crypto.createDecipheriv("chacha20-poly1305", chachaKey, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const intermediate = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
  return decodeLooseBase64(swapPairs(intermediate), "расшифрованный URL").toString("utf8");
}

/**
 * Расшифровать ссылку.
 *
 * Раскладку («с солью» или без) определяем по первому байту после nonce, но на
 * всякий случай пробуем и вторую: у разных версий Happ она отличается.
 */
export function decryptHappCrypt5(link) {
  const { marker, body } = parseLink(link);
  const key = privateKeyFor(marker);
  const preferSalted = body.length > 12 && (body[12] < 0x30 || body[12] > 0x39);
  let firstError = null;
  for (const salted of [preferSalted, !preferSalted]) {
    try {
      const url = decodeBody(body, key, salted);
      if (!url) throw new Error("расшифровка дала пустую строку");
      // eslint-disable-next-line no-control-regex
      if (/[ -]/.test(url)) throw new Error("в расшифрованной строке управляющие символы");
      return url;
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  throw firstError || new Error("не удалось расшифровать ссылку");
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALPHANUM = `${LETTERS}0123456789`;

/**
 * Случайная печатная строка.
 *
 * Nonce и соль настоящих ссылок Happ — обычный буквенно-цифровой текст, и это
 * не украшение: они едут внутри ссылки как есть. Сырые байты из randomBytes
 * сделали бы ссылку непечатаемой и нерабочей при копировании.
 */
function randomText(count, alphabet = ALPHANUM) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return Buffer.from(out, "latin1");
}

/**
 * Собрать `happ://crypt5/...` из обычной ссылки.
 *
 * Маркер берём из той же таблицы: приложение узнаёт ссылку по нему, поэтому
 * выдумывать свой нельзя. Раскладка — «с солью», как в сегодняшних ссылках Happ.
 */
export function encryptHappCrypt5(url, options = {}) {
  const plain = String(url || "").trim();
  if (!plain) throw new Error("нечего шифровать: пустая ссылка");
  if (plain.length > MAX_LINK_BYTES) throw new Error("ссылка длиннее 2 МиБ");
  if (isEncryptedHappLink(plain)) throw new Error("это уже зашифрованная ссылка happ://");

  const table = loadKeyTable().table;
  const requested = String(options.marker || "").trim();
  if (requested && !table.has(requested)) throw new Error(`маркер «${requested}» не из таблицы ключей`);
  const markers = [...table.keys()].sort();
  const marker = requested || markers[crypto.randomInt(markers.length)];
  const salted = options.salted !== false;

  const publicKey = crypto.createPublicKey(privateKeyFor(marker));
  const nonce = randomText(NONCE_BYTES);
  const salt = salted ? randomText(SALT_BYTES) : null;
  // Ключ — единственное, что в ссылку не попадает, поэтому он полностью случайный.
  const aeadKey = crypto.randomBytes(CHACHA_KEY_BYTES);

  // В RSA уезжает ключ ДО наложения соли: расшифровка накладывает её сама.
  const wrappedKey = Buffer.from(aeadKey);
  if (salt) {
    for (let i = 0; i < wrappedKey.length; i += 1) wrappedKey[i] ^= salt[i % salt.length];
  }
  const rsaPlaintext = swapPairs(Buffer.from(wrappedKey.toString("base64"), "latin1"));
  const rsaSegment = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    rsaPlaintext,
  ).toString("base64");

  const intermediate = swapPairs(Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "latin1"));
  const cipher = crypto.createCipheriv("chacha20-poly1305", aeadKey, nonce, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([cipher.update(intermediate), cipher.final(), cipher.getAuthTag()]);
  const encryptedUrl = sealed.toString("base64");

  const packed = Buffer.concat([
    randomText(1, LETTERS),
    Buffer.from(encryptedUrl, "latin1"),
    Buffer.from(rsaSegment, "latin1"),
  ]);
  const header = salt
    // Два произвольных символа перед солью — только буквы: по тому, что первый
    // из них не цифра, расшифровка и понимает, что раскладка «с солью».
    ? Buffer.concat([nonce, randomText(2, LETTERS), salt])
    : nonce;
  const body = Buffer.concat([
    header,
    Buffer.from(String(encryptedUrl.length), "latin1"),
    packed,
  ]);

  const shuffled = Buffer.concat([
    Buffer.from(marker.slice(0, 4), "latin1"),
    body,
    Buffer.from(marker.slice(4), "latin1"),
  ]);
  return `happ://crypt5/${swapBlockHalves(shuffled).toString("latin1")}`;
}
