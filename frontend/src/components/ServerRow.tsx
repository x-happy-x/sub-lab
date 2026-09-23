import type { ReactNode } from "react";
import { parseServerMeta } from "../lib/servers";

type Props = {
  name: string;
  /** Ссылка сервера, если есть: из неё берутся протокол, транспорт и защита. */
  uri?: string;
  /** Формат подписки — показываем рядом с протоколом (JSON, YML, RAW). */
  format?: string;
  /** Правая часть строки: задержка, кнопка, что угодно. */
  trailing?: ReactNode;
  /** Строка под именем вместо разобранных меток. */
  sub?: ReactNode;
  /** Запись не прошла отбор — гасим её, но не прячем. */
  muted?: boolean;
  /** Сервер не отвечает. */
  dead?: boolean;
  selected?: boolean;
  onClick?: () => void;
};

/**
 * Строка сервера в списке.
 *
 * Флаг вынесен в отдельную плашку, чтобы имена выравнивались по левому краю и
 * список читался столбцом. Протокол и формат — заметные метки, транспорт и
 * защита — приглушённая подпись: по ним обычно не выбирают.
 *
 * Пометка обхода живёт в углу плашки с флагом: у провайдеров такие серверы
 * называются по-разному («whitelist», «Белые», «LTE»), и в длинном списке их
 * приходилось выискивать глазами по тексту.
 */
export function ServerRow({
  name,
  uri = "",
  format = "",
  trailing,
  sub,
  muted = false,
  dead = false,
  selected = false,
  onClick,
}: Props) {
  const meta = parseServerMeta(name, uri);
  const classes = [
    "server-row",
    muted ? "is-muted" : "",
    dead ? "is-dead" : "",
    selected ? "is-selected" : "",
    onClick ? "is-clickable" : "",
  ].filter(Boolean).join(" ");

  const body = (
    <>
      <span className="server-row-mark" aria-hidden="true">
        {meta.flag
          ? <span className="server-row-flag">{meta.flag}</span>
          : <span className="server-row-letter">{(meta.label || "?").trim().charAt(0).toUpperCase()}</span>}
        {meta.bypass ? <span className="server-row-bypass" title="Похож на «белый» сервер для обхода">⤳</span> : null}
      </span>
      <span className="server-row-body">
        <span className="server-row-name">{meta.label}</span>
        {sub ? <span className="server-row-sub">{sub}</span> : (
          <span className="server-row-tags">
            {meta.protocol ? <span className="server-tag">{meta.protocol}</span> : null}
            {format ? <span className="server-tag">{format.toUpperCase()}</span> : null}
            {meta.network || meta.security ? (
              <span className="server-row-meta">
                {[meta.network, meta.security].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </span>
        )}
      </span>
      {trailing ? <span className="server-row-trailing">{trailing}</span> : null}
    </>
  );

  if (!onClick) return <li className={classes}>{body}</li>;
  return (
    <li className={classes}>
      <button type="button" className="server-row-button" aria-pressed={selected} onClick={onClick}>
        {body}
      </button>
    </li>
  );
}

/** Обёртка списка: чтобы не повторять разметку в каждом месте. */
export function ServerList({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <ul className={`server-list ${className}`.trim()}>{children}</ul>;
}
