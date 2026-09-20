import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { UsageStats, UsageStatsBreakdown } from "../types";
import { Card, Segmented } from "../ui";

type Props = {
  stats: UsageStats | null;
  loading: boolean;
  error: string;
  days: number;
  onDaysChange: (days: number) => void;
  onRefresh: () => void;
};

const PERIODS = [
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
] as const;

function formatNumber(value: number): string {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 10000) return n.toLocaleString("ru-RU");
  if (n < 1000000) return `${(n / 1000).toFixed(n < 100000 ? 1 : 0).replace(".", ",")}K`;
  return `${(n / 1000000).toFixed(1).replace(".", ",")}M`;
}

function formatDayShort(day: string): string {
  const ts = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ts)) return day;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
}

function formatDateTime(value: string): string {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatRelative(value: string): string {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return "только что";
  if (diff < 3600000) return `${Math.round(diff / 60000)} мин назад`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} ч назад`;
  if (diff < 30 * 86400000) return `${Math.round(diff / 86400000)} дн назад`;
  return formatDateTime(value);
}

/** Плитка с одним числом: подпись, значение и поясняющая строка. */
function StatTile({ label, value, hint, hero }: { label: string; value: ReactNode; hint?: ReactNode; hero?: boolean }) {
  return (
    <article className={`stat-tile ${hero ? "stat-tile-hero" : ""}`.trim()}>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
      {hint ? <div className="stat-tile-hint">{hint}</div> : null}
    </article>
  );
}

/** Верх шкалы: круглое число не ниже значения, чтобы сетка читалась. */
function niceCeil(value: number): number {
  const target = Math.max(1, value);
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  for (const factor of [1, 1.5, 2, 2.5, 5, 10]) {
    const candidate = factor * magnitude;
    if (candidate >= target) return Math.round(candidate);
  }
  return Math.round(10 * magnitude);
}

type ColumnPoint = {
  key: string;
  value: number;
  label: string;
  caption: string;
};

/**
 * Столбики по дням: одна серия, поэтому легенда не нужна — заголовок карточки
 * уже говорит, что мы считаем. Подпись значения ставим только на максимуме,
 * остальное читается по сетке и подсказке при наведении.
 */
function ColumnChart({ points, unit }: { points: ColumnPoint[]; unit: string }) {
  const max = points.reduce((acc, point) => Math.max(acc, point.value), 0);
  const niceMax = niceCeil(max * 1.15);
  const peakIndex = points.reduce((best, point, index) => (point.value > points[best]?.value ? index : best), 0);
  const ticks = [niceMax, Math.round(niceMax / 2), 0];
  // По оси X подписываем только края и середину: на узком экране частая сетка
  // подписей слипается, а точная дата всё равно есть в подсказке.
  const dayTicks = points.length > 2
    ? [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]]
    : points;

  if (max <= 0) {
    return (
      <div className="chart-empty">
        За выбранный период данных ещё нет. Счётчик пополняется, когда приложение забирает подписку по короткой ссылке.
      </div>
    );
  }

  return (
    <div className="chart">
      <div className="chart-axis" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{formatNumber(tick)}</span>)}
      </div>
      <div className="chart-plot">
        <div className="chart-grid" aria-hidden="true">
          <i /><i /><i />
        </div>
        <div className="chart-cols">
          {points.map((point, index) => (
            <div className="chart-col" key={point.key}>
              <div
                className={`chart-bar ${index === peakIndex ? "peak" : ""}`.trim()}
                style={{ height: `${Math.max(point.value > 0 ? 3 : 0, (point.value / niceMax) * 100)}%` }}
              >
                {index === peakIndex && point.value > 0 ? (
                  <span className="chart-peak-label">{formatNumber(point.value)}</span>
                ) : null}
                <span className="chart-tip" role="tooltip">
                  <b>{formatNumber(point.value)} {unit}</b>
                  <span>{point.caption}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="chart-ticks" aria-hidden="true">
        {dayTicks.map((point) => <span key={point.key}>{point.label}</span>)}
      </div>
      <table className="chart-table">
        <caption>Табличный вид данных графика</caption>
        <thead>
          <tr><th scope="col">Период</th><th scope="col">{unit}</th></tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}><th scope="row">{point.caption}</th><td>{point.value}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Горизонтальные полосы: величина одной шкалой, значение у кончика полосы. */
function BarList({ items, emptyText }: { items: UsageStatsBreakdown[]; emptyText: string }) {
  const max = items.reduce((acc, item) => Math.max(acc, item.count), 0);
  if (items.length === 0 || max <= 0) return <div className="chart-empty">{emptyText}</div>;
  return (
    <ul className="bar-list">
      {items.map((item) => (
        <li key={item.label}>
          <span className="bar-list-label" title={item.label}>{item.label}</span>
          <span className="bar-list-track">
            <span className="bar-list-fill" style={{ width: `${Math.max(4, (item.count / max) * 100)}%` }} />
          </span>
          <span className="bar-list-value">{formatNumber(item.count)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Страница «Статистика»: сводные числа, активность по дням и разрезы. */
export function StatsPage({ stats, loading, error, days, onDaysChange, onRefresh }: Props) {
  const [chartMode, setChartMode] = useState<"hits" | "devices">("hits");

  const points = useMemo<ColumnPoint[]>(() => {
    if (!stats) return [];
    return stats.daily.map((row) => ({
      key: row.day,
      value: chartMode === "hits" ? row.hits : row.newDevices,
      label: formatDayShort(row.day),
      caption: formatDayShort(row.day),
    }));
  }, [stats, chartMode]);

  if (error) {
    return (
      <Card title="Статистика недоступна">
        <p className="stats-note">{error}</p>
        <button type="button" className="btn" onClick={onRefresh}>Повторить</button>
      </Card>
    );
  }

  if (!stats && loading) {
    return <div className="status">Считаем статистику...</div>;
  }

  if (!stats) return null;

  const totals = stats.totals;
  const perDay = stats.daily.length > 0 ? totals.hitsPeriod / stats.daily.length : 0;

  return (
    <div className={`stats-page ${loading ? "is-loading" : ""}`.trim()}>
      <section className="stats-filters">
        <Segmented
          options={PERIODS.map((item) => ({ value: item.value, label: item.label }))}
          value={String(days)}
          onChange={(value) => onDaysChange(Number(value))}
          ariaLabel="Период статистики"
        />
        <span className="stats-scope">
          {stats.scope === "all" ? "Вся панель" : "Ваши подписки"}
          {stats.generatedAt ? ` · обновлено ${formatDateTime(stats.generatedAt)}` : ""}
        </span>
        <button type="button" className="btn btn-sm" onClick={onRefresh}>Обновить</button>
      </section>

      <section className="stats-tiles">
        <StatTile
          hero
          label="Обращения за период"
          value={formatNumber(totals.hitsPeriod)}
          hint={`≈ ${formatNumber(Math.round(perDay))} в сутки · всего за всё время ${formatNumber(totals.hits)}`}
        />
        <StatTile
          label="Устройства"
          value={formatNumber(totals.devices)}
          hint={(
            <>
              {formatNumber(totals.newDevicesPeriod)} новых за период
              {totals.blockedDevices > 0
                ? <> · <span className="stat-tile-alert">{formatNumber(totals.blockedDevices)} заблокировано</span></>
                : null}
            </>
          )}
        />
        <StatTile
          label="Активны за сутки"
          value={formatNumber(totals.activeDevices24h)}
          hint={`за неделю ${formatNumber(totals.activeDevices7d)} · за месяц ${formatNumber(totals.activeDevices30d)}`}
        />
        <StatTile
          label="Подписки"
          value={formatNumber(totals.subscriptions)}
          hint={totals.hiddenSubscriptions > 0 ? `из них скрытых ${formatNumber(totals.hiddenSubscriptions)}` : "все на виду"}
        />
      </section>

      <Card
        className="stats-chart-card"
        title={chartMode === "hits" ? "Обращения по дням" : "Новые устройства по дням"}
        lead={chartMode === "hits"
          ? "Каждое открытие короткой ссылки приложением или браузером."
          : "Первая встреча нового HWID на любой из подписок."}
        actions={(
          <Segmented
            options={[
              { value: "hits", label: "Обращения" },
              { value: "devices", label: "Устройства" },
            ]}
            value={chartMode}
            onChange={(value) => setChartMode(value as "hits" | "devices")}
            ariaLabel="Что показывать на графике"
          />
        )}
      >
        <ColumnChart points={points} unit={chartMode === "hits" ? "обращений" : "устройств"} />
      </Card>

      <section className="stats-split">
        <Card title="Операционные системы" lead="Считаем по последнему визиту устройства.">
          <BarList items={stats.byOs} emptyText="Пока ни одно устройство не сообщило о своей ОС." />
        </Card>
        <Card title="Приложения" lead="Клиент, из которого пришёл последний запрос.">
          <BarList items={stats.byApp} emptyText="Пока нет данных о клиентских приложениях." />
        </Card>
      </section>

      <Card title="Самые востребованные подписки" lead={`Сортировка по обращениям за ${days} дней.`}>
        {stats.topLinks.length === 0 ? (
          <div className="chart-empty">Ни одна подписка ещё не открывалась.</div>
        ) : (
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th scope="col">Подписка</th>
                  <th scope="col">За период</th>
                  <th scope="col">Всего</th>
                  <th scope="col">Устройств</th>
                  <th scope="col">Последний визит</th>
                </tr>
              </thead>
              <tbody>
                {stats.topLinks.map((link) => (
                  <tr key={link.id}>
                    <th scope="row">
                      <span className="stats-table-title">{link.title || link.id}</span>
                      <span className="stats-table-sub">/l/{link.id}</span>
                    </th>
                    <td>{formatNumber(link.hitsPeriod)}</td>
                    <td>{formatNumber(link.hits)}</td>
                    <td>{formatNumber(link.devices)}</td>
                    <td>{link.lastSeenAt ? formatRelative(link.lastSeenAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Последние устройства" lead="Кто подключался недавно.">
        {stats.recentDevices.length === 0 ? (
          <div className="chart-empty">Устройства ещё не подключались.</div>
        ) : (
          <ul className="device-feed">
            {stats.recentDevices.map((device) => (
              <li key={`${device.shortLinkId}-${device.hwid}`} className={device.blocked ? "blocked" : ""}>
                <span className="device-feed-dot" aria-hidden="true" />
                <span className="device-feed-main">
                  <span className="device-feed-title">{device.deviceModel || device.os || "Неизвестное устройство"}</span>
                  <span className="device-feed-sub">
                    {[device.app, device.os, device.title].filter(Boolean).join(" · ") || device.hwid}
                  </span>
                </span>
                <span className="device-feed-time">{formatRelative(device.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
