import type { ShortLinkHealth, ShortLinkUserCounts } from "../types";

type Props = {
  /** Пусто, пока проверки грузятся или подписку ещё ни разу не смотрели. */
  health?: ShortLinkHealth | null;
  loading: boolean;
};

function humanBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** power;
  return `${scaled >= 100 || power === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[power]}`;
}

/** «12 дней», «завтра», «истекла 3 дня назад» — без календарной точности. */
function humanDeadline(expireAt: number): { text: string; soon: boolean; expired: boolean } {
  const ms = expireAt - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (ms <= 0) {
    const past = Math.abs(days);
    return { text: past <= 1 ? "срок истёк" : `срок истёк ${past} дн. назад`, soon: true, expired: true };
  }
  if (days <= 1) return { text: "истекает сегодня", soon: true, expired: false };
  if (days <= 7) return { text: `осталось ${days} дн.`, soon: true, expired: false };
  if (days <= 60) return { text: `осталось ${days} дн.`, soon: false, expired: false };
  return { text: `до ${new Date(expireAt).toLocaleDateString()}`, soon: false, expired: false };
}

function humanCheckedAt(checkedAt: string): string {
  const ts = Date.parse(checkedAt);
  if (!Number.isFinite(ts)) return "";
  const hours = Math.floor((Date.now() - ts) / 3_600_000);
  if (hours < 1) return "проверено только что";
  if (hours < 24) return `проверено ${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  return `проверено ${days} дн. назад`;
}

/**
 * Отметка о последней проверке — в шапке карточки, справа от названия.
 *
 * В строке состояния ей тесно: там и так есть что показать, а сама отметка
 * служебная и к сути «жива или нет» отношения не имеет.
 */
export function SubscriptionCheckedAt({ health, users }: {
  health?: ShortLinkHealth | null;
  users?: ShortLinkUserCounts | null;
}) {
  const text = health ? humanCheckedAt(health.checkedAt) : "";
  // Цифры без подписей: зелёная — сколько устройств пользуется подпиской,
  // красная — сколько заблокировано или оказалось сверх лимита. Что именно
  // значит каждая, рассказывает подсказка — иначе их не расшифровать.
  const active = Math.max(0, users?.active ?? 0);
  const trouble = Math.max(0, (users?.blocked ?? 0) + (users?.overLimit ?? 0));
  const hint = [
    text ? `Проверено: ${health?.checkedAt || ""}` : "",
    users ? `Устройств: ${active}` : "",
    users?.blocked ? `Заблокировано: ${users.blocked}` : "",
    users?.overLimit ? `Сверх лимита: ${users.overLimit} (лимит ${users.maxUsers})` : "",
  ].filter(Boolean).join("\n");

  if (!text && !users) return null;
  return (
    <span className="sub-checked" title={hint}>
      {text ? <span className="sub-checked-when">{text}</span> : null}
      {users ? <span className="sub-checked-users">{active}</span> : null}
      {trouble > 0 ? <span className="sub-checked-trouble">{trouble}</span> : null}
    </span>
  );
}

/**
 * Мелкая строка состояния под ссылкой.
 *
 * Показывает ровно то, что нужно решить «пора продлевать или нет»: жива ли
 * подписка, сколько осталось по сроку и трафику, и куда идти продлевать.
 * Данные приезжают отдельным запросом, поэтому карточка не ждёт их отрисовки.
 */
export function SubscriptionHealthLine({ health, loading }: Props) {
  if (!health) {
    return (
      <div className="sub-health sub-health-idle">
        <span className="sub-health-dot is-idle" aria-hidden="true" />
        <span>{loading ? "Проверяем состояние…" : "Ещё не проверялась"}</span>
      </div>
    );
  }

  const deadline = health.expireAt > 0 ? humanDeadline(health.expireAt) : null;
  const used = health.upload + health.download;
  const renewUrl = health.webPageUrl || health.supportUrl;
  // Недоступность — отдельное состояние: у нас оборвалась связь, а не у
  // подписки кончился срок. Красить это в красное — врать.
  const state = health.unreachable ? "idle" : (!health.ok ? "dead" : (deadline?.expired || deadline?.soon ? "warn" : "ok"));

  const parts: string[] = [];
  if (health.ok || health.unreachable) {
    if (health.servers > 0) parts.push(`${health.servers} серв.`);
    if (deadline) parts.push(deadline.text);
    if (used > 0 || health.total > 0) {
      parts.push(`${humanBytes(used)} из ${health.total > 0 ? humanBytes(health.total) : "∞"}`);
    }
  }

  // Строка одна, поэтому длинные причины обрезаются многоточием, а целиком
  // текст остаётся в подсказке.
  const text = health.unreachable
    ? [health.error || "проверить не удалось", parts.length > 0 ? `последнее: ${parts.join(" · ")}` : ""]
      .filter(Boolean).join(" — ")
    : (health.ok ? parts.join(" · ") : (health.error || "подписка не отвечает"));

  return (
    <div className={`sub-health sub-health-${state}`}>
      <span className={`sub-health-dot is-${state}`} aria-hidden="true" />
      <span className="sub-health-text" title={text}>{text}</span>
      {renewUrl ? (
        <a className="sub-health-renew" href={renewUrl} target="_blank" rel="noreferrer noopener">
          продлить
        </a>
      ) : null}
    </div>
  );
}
