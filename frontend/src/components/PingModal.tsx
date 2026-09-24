import { useMemo, useState } from "react";
import type { PingMode, PingResponse } from "../types";
import { Badge, Button, Segmented } from "../ui";
import { Modal } from "./Modal";
import { CloseIcon, TestIcon } from "../icons";

/**
 * Варианты замера.
 *
 * Полный тест «через туннель» панель сделать не может: клиента протоколов у неё
 * нет. Зато всё, что происходит до поднятия туннеля, меряется честно — и именно
 * это отвечает на вопрос «сервер жив и далеко ли он».
 */
const MODES: ReadonlyArray<{ value: PingMode; label: string; tip: string }> = [
  { value: "tcp", label: "TCP", tip: "Рукопожатие до порта сервера: самый близкий аналог пинга в приложении" },
  { value: "tls", label: "TLS", tip: "TCP плюс TLS-рукопожатие: видно, отвечает ли сервер как положено" },
  { value: "dns", label: "DNS", tip: "Только разрешение имени: показывает, тормозит ли сам домен" },
];

const ATTEMPTS = [
  { value: "1", label: "1 раз" },
  { value: "3", label: "3 раза" },
  { value: "5", label: "5 раз" },
];

type Props = {
  title: string;
  data: PingResponse | null;
  loading: boolean;
  error: string;
  mode: PingMode;
  onModeChange: (value: PingMode) => void;
  attempts: number;
  onAttemptsChange: (value: number) => void;
  onRun: () => void;
  onClose: () => void;
};

/** Задержку красим по порогам: зелёный — быстро, жёлтый — терпимо, красный — плохо. */
function latencyTone(ms: number): "ok" | "warn" | "danger" {
  if (ms <= 120) return "ok";
  if (ms <= 350) return "warn";
  return "danger";
}

export function PingModal({
  title,
  data,
  loading,
  error,
  mode,
  onModeChange,
  attempts,
  onAttemptsChange,
  onRun,
  onClose,
}: Props) {
  const [sort, setSort] = useState<"latency" | "name">("latency");

  const rows = useMemo(() => {
    const list = [...(data?.results || [])];
    if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name));
    // Недоступные уезжают вниз: сортировка по задержке для них бессмысленна.
    return list.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.average - b.average;
    });
  }, [data, sort]);

  const alive = rows.filter((row) => row.ok).length;
  const fastest = rows.find((row) => row.ok);

  return (
    <Modal
      onClose={onClose}
      title={`Пинг: ${title}`}
      lead="Замер идёт с сервера панели до точки входа, а не из вашей сети и не внутри туннеля."
      showCloseButton
      footer={(
        <>
          <Button tone="primary" icon={<TestIcon className="btn-icon" />} onClick={onRun} disabled={loading}>
            {loading ? "Пингуем..." : "Запустить"}
          </Button>
          <Button icon={<CloseIcon className="btn-icon" />} onClick={onClose}>Закрыть</Button>
          {data ? (
            <span className="modal-footer-note">
              Живых {alive} из {rows.length}
              {fastest ? ` · быстрейший ${fastest.name} (${fastest.average} мс)` : ""}
            </span>
          ) : null}
        </>
      )}
    >
      <div className="field-row">
        <div className="field">
          <span className="field-label">Что меряем</span>
          <Segmented
            ariaLabel="Вариант пинга"
            value={mode}
            onChange={(value) => onModeChange(value as PingMode)}
            options={MODES.map((item) => ({ value: item.value, label: item.label, tip: item.tip }))}
          />
        </div>
        <div className="field">
          <span className="field-label">Попыток на сервер</span>
          <Segmented
            ariaLabel="Число попыток"
            value={String(attempts)}
            onChange={(value) => onAttemptsChange(Number(value))}
            options={ATTEMPTS}
          />
        </div>
      </div>

      {error ? <div className="composer-hint merge-row-error">{error}</div> : null}

      {!data && !loading ? (
        <div className="chart-empty">Нажмите «Запустить» — панель опросит все серверы подписки.</div>
      ) : null}

      {data ? (
        <>
          <div className="ping-toolbar">
            <Segmented
              ariaLabel="Сортировка"
              value={sort}
              onChange={(value) => setSort(value as "latency" | "name")}
              options={[
                { value: "latency", label: "По задержке" },
                { value: "name", label: "По имени" },
              ]}
            />
            <span className="composer-meta-hint">
              {data.attempts} попыт. · таймаут {data.timeoutMs} мс
            </span>
          </div>

          <ul className="ping-list">
            {rows.map((row) => (
              <li key={`${row.id}-${row.host}-${row.port}`} className={row.ok ? "" : "dead"}>
                <span className="ping-main">
                  <span className="ping-name">{row.name}</span>
                  <span className="ping-sub">{row.host}:{row.port}</span>
                </span>
                {row.ok ? (
                  <>
                    <span className="ping-bar" aria-hidden="true">
                      <span
                        className={`ping-bar-fill ${latencyTone(row.average)}`}
                        style={{ width: `${Math.min(100, Math.max(4, (row.average / 600) * 100))}%` }}
                      />
                    </span>
                    <span className="ping-value">
                      <b>{row.average}</b> мс
                      {row.best !== row.worst ? <small>{row.best}–{row.worst}</small> : null}
                    </span>
                    {row.loss > 0 ? <Badge tone="warn">потери {row.loss}%</Badge> : null}
                  </>
                ) : (
                  <span className="ping-error">{row.error || "нет ответа"}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
