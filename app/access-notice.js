/**
 * Подписка-уведомление: один сервер, имя которого — текст из политики.
 *
 * Приложение не умеет показывать текст ошибки: оно либо получает список
 * серверов, либо считает подписку сломанной. Поэтому на блокировку и на
 * превышение лимита отвечаем валидной подпиской из одного узла — человек
 * видит причину прямо в списке серверов. Адрес и ключи у узла случайные и
 * заведомо неживые, подключиться по нему нельзя.
 */

import crypto from "node:crypto";
import {
  NODE_PRIMARY,
  NODES_COLLAPSE,
  createEntry,
  createModel,
  createNode,
} from "./model/normalized.js";
import { renderOutput } from "./model/render.js";

/** Адрес из TEST-NET-3 (203.0.113.0/24): документационная сеть, она не маршрутизируется. */
function randomUnroutableHost() {
  return `203.0.113.${crypto.randomInt(1, 255)}`;
}

function randomPort() {
  return crypto.randomInt(10000, 60000);
}

function buildNoticeModel(message) {
  const name = String(message || "").trim() || "Доступ к подписке ограничен";
  const node = createNode({
    id: "notice-node",
    name,
    role: NODE_PRIMARY,
    type: "vless",
    endpoint: { host: randomUnroutableHost(), port: randomPort() },
    auth: { uuid: crypto.randomUUID(), encryption: "none" },
    transport: { network: "tcp" },
    security: { mode: "none" },
  });
  const entry = createEntry({ id: "notice-entry", name, nodes: [node] });
  return createModel({ entries: [entry], meta: { sourceFormat: "access-notice" } });
}

/**
 * Подписка из одного узла в запрошенном формате.
 * Возвращает `{ body, contentType }` — то же, что и обычный рендер.
 */
function renderAccessNotice(message, output) {
  return renderOutput(buildNoticeModel(message), output, NODES_COLLAPSE);
}

export { buildNoticeModel, renderAccessNotice };
