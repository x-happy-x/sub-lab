import { useEffect, useMemo, useRef, useState } from "react";
import type { FavoriteItem, MergeItem, MergeOnEmpty, MergePreviewResult, SubscriptionPayload } from "../types";
import { Badge, Button, Segmented, TextInput, Tooltip } from "../ui";
import { Modal } from "./Modal";
import { CloseIcon, PlusIcon, SaveIcon, TestIcon } from "../icons";

const WHITELIST_PATTERN = "whitelist|white|бел[ыо]|обход|bypass|direct|lte|4g|3g";

/**
 * Готовые регулярки под привычные названия «белых» серверов.
 *
 * Провайдеры называют их кто во что горазд: whitelist, white, Белые, Обход, а
 * ещё LTE и 4G — это те же белые списки, просто названные по каналу. Набирать
 * это руками каждый раз — лишняя работа и лишний шанс опечататься.
 */
const PATTERN_PRESETS: ReadonlyArray<{ label: string; pattern: string; tip: string }> = [
  {
    label: "Белые (обход)",
    pattern: WHITELIST_PATTERN,
    tip: "whitelist, white, Белые, Белый, Обход, bypass, direct, LTE, 4G, 3G",
  },
  {
    label: "Кроме белых",
    pattern: `^(?!.*(${WHITELIST_PATTERN})).*$`,
    tip: "Всё, что НЕ похоже на белый список",
  },
];

const ON_EMPTY_OPTIONS = [
  { value: "all", label: "Взять все", tip: "Регулярка ничего не нашла — берём все серверы источника" },
  { value: "skip", label: "Пропустить", tip: "Источник не попадёт в объединение вовсе" },
  { value: "error", label: "Ошибка", tip: "Подписка вернёт ошибку: так сразу видно, что регулярка устарела" },
] as const;

export type MergeDraftItem = {
  /** Стабильный ключ строки: индекс в списке подписок. */
  key: string;
  title: string;
  payload: SubscriptionPayload;
  shortId: string;
  selected: boolean;
  pattern: string;
  onEmpty: MergeOnEmpty;
};

type Props = {
  /** Заполнено — правим существующее объединение, пусто — собираем новое. */
  mergeId: string;
  name: string;
  onNameChange: (value: string) => void;
  output: SubscriptionPayload["output"];
  onOutputChange: (value: SubscriptionPayload["output"]) => void;
  /** Формат по User-Agent клиента: для объединения он тоже работает. */
  outputAuto: boolean;
  onOutputAutoChange: (value: boolean) => void;
  outputOptions: ReadonlyArray<{ value: string; label: string; tip?: string }>;
  items: MergeDraftItem[];
  onItemsChange: (next: MergeDraftItem[]) => void;
  /** Имена серверов по ключу строки: их присылает предпросмотр. */
  preview: Record<string, MergePreviewResult>;
  previewLoading: boolean;
  onPreview: () => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  note: string;
};

/** Скомпилированная регулярка или `null`, если шаблон кривой. */
function compilePattern(pattern: string): { regex: RegExp | null; error: string } {
  const text = String(pattern || "").trim();
  if (!text) return { regex: null, error: "" };
  try {
    return { regex: new RegExp(text, "i"), error: "" };
  } catch (e) {
    return { regex: null, error: (e as Error)?.message || "некорректная регулярка" };
  }
}

function buildFavoriteDrafts(favorites: FavoriteItem[]): MergeDraftItem[] {
  return favorites.map((item, index) => ({
    key: String(index),
    title: item.title,
    payload: item.payload,
    shortId: item.shortId || "",
    selected: false,
    pattern: "",
    onEmpty: "all" as MergeOnEmpty,
  }));
}

/** Строка одного источника: чекбокс, регулярка и что под неё попало. */
function MergeRow({
  item,
  preview,
  onChange,
}: {
  item: MergeDraftItem;
  preview?: MergePreviewResult;
  onChange: (patch: Partial<MergeDraftItem>) => void;
}) {
  const { regex, error } = compilePattern(item.pattern);
  const names = preview?.ok ? preview.names : [];
  const matched = useMemo(() => {
    if (!preview?.ok) return [];
    if (!regex) return names;
    return names.filter((name) => regex.test(name));
  }, [preview, regex, names]);

  const nothingMatched = Boolean(regex) && preview?.ok && matched.length === 0;

  return (
    <article className={`merge-row ${item.selected ? "selected" : ""}`.trim()}>
      <label className="merge-row-head">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={(e) => onChange({ selected: e.target.checked })}
        />
        <span className="merge-row-title">
          <strong>{item.title}</strong>
          <span className="merge-row-sub">{item.payload.sub_url || "источник не задан"}</span>
        </span>
        {preview?.ok ? <Badge>{names.length} серв.</Badge> : null}
        {preview && !preview.ok ? <Badge tone="danger">ошибка</Badge> : null}
      </label>

      {item.selected ? (
        <div className="merge-row-body">
          <div className="field">
            <span className="field-label">Регулярка по имени сервера</span>
            <TextInput
              placeholder="Пусто — берём все серверы источника"
              value={item.pattern}
              onChange={(e) => onChange({ pattern: e.target.value })}
            />
            <div className="chip-row merge-presets">
              {PATTERN_PRESETS.map((preset) => (
                <Tooltip key={preset.label} content={preset.tip}>
                  <button
                    type="button"
                    className={`chip-btn ${item.pattern === preset.pattern ? "active" : ""}`.trim()}
                    onClick={() => onChange({ pattern: item.pattern === preset.pattern ? "" : preset.pattern })}
                  >
                    {preset.label}
                  </button>
                </Tooltip>
              ))}
              {item.pattern ? (
                <button type="button" className="chip-btn" onClick={() => onChange({ pattern: "" })}>
                  Очистить
                </button>
              ) : null}
            </div>
            {error ? <div className="composer-hint merge-row-error">Регулярка не собирается: {error}</div> : null}
          </div>

          <div className="field">
            <span className="field-label">Если ничего не подошло</span>
            <Segmented
              ariaLabel="Поведение, когда регулярка ничего не нашла"
              value={item.onEmpty}
              onChange={(value) => onChange({ onEmpty: value as MergeOnEmpty })}
              options={ON_EMPTY_OPTIONS.map((option) => ({ value: option.value, label: option.label, tip: option.tip }))}
            />
          </div>

          <div className="merge-row-preview">
            {!preview ? (
              <div className="composer-meta-hint">Нажмите «Проверить источники», чтобы увидеть список серверов.</div>
            ) : !preview.ok ? (
              <div className="composer-hint merge-row-error">{preview.error || "Не удалось получить серверы"}</div>
            ) : (
              <>
                <div className="merge-row-count">
                  Попадает {matched.length} из {names.length}
                  {nothingMatched ? (
                    <span className="merge-row-warn">
                      {" "}— сработает правило «{ON_EMPTY_OPTIONS.find((option) => option.value === item.onEmpty)?.label}»
                    </span>
                  ) : null}
                </div>
                <ul className="merge-names">
                  {names.slice(0, 60).map((name, index) => {
                    const hit = !regex || regex.test(name);
                    return (
                      <li key={`${name}-${index}`} className={hit ? "hit" : "miss"}>
                        <span>{name}</span>
                      </li>
                    );
                  })}
                </ul>
                {names.length > 60 ? (
                  <div className="composer-meta-hint">…и ещё {names.length - 60}</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Отдельное окно сборки объединённой подписки.
 *
 * Конструктор подписки сюда не годится: там задают устройство, приложение и
 * профиль, а у объединения всё это своё у каждого источника. Здесь решают
 * только два вопроса: какие подписки соединить и какие серверы из каждой взять.
 */
export function MergeModal({
  mergeId,
  name,
  onNameChange,
  output,
  onOutputChange,
  outputAuto,
  onOutputAutoChange,
  outputOptions,
  items,
  onItemsChange,
  preview,
  previewLoading,
  onPreview,
  onSave,
  onClose,
  saving,
  note,
}: Props) {
  const selectedCount = items.filter((item) => item.selected).length;
  const autoPreviewed = useRef(false);

  // Правим существующее объединение — список серверов нужен сразу: регулярки
  // уже написаны, и без имён непонятно, что они сейчас ловят.
  useEffect(() => {
    if (autoPreviewed.current) return;
    if (!mergeId || selectedCount === 0) return;
    autoPreviewed.current = true;
    onPreview();
  }, [mergeId, selectedCount, onPreview]);

  const patch = (key: string, next: Partial<MergeDraftItem>) => {
    onItemsChange(items.map((item) => (item.key === key ? { ...item, ...next } : item)));
  };

  return (
    <Modal
      onClose={onClose}
      title={mergeId ? `Объединение: ${name || "без названия"}` : "Новое объединение"}
      lead="Устройство, приложение и профиль берутся из каждой подписки отдельно — здесь только состав и отбор серверов."
      showCloseButton
      footer={(
        <>
          <Button tone="primary" icon={mergeId ? <SaveIcon className="btn-icon" /> : <PlusIcon className="btn-icon" />} onClick={onSave} disabled={saving}>
            {mergeId ? "Сохранить объединение" : "Создать объединение"}
          </Button>
          <Button icon={<TestIcon className="btn-icon" />} onClick={onPreview} disabled={previewLoading || selectedCount === 0}>
            {previewLoading ? "Проверяем..." : "Проверить источники"}
          </Button>
          <Button icon={<CloseIcon className="btn-icon" />} onClick={onClose}>Закрыть</Button>
          <span className="modal-footer-note">
            Выбрано: {selectedCount}
            {note ? ` · ${note}` : ""}
          </span>
        </>
      )}
    >
      <div className="field-row">
        <div className="field">
          <span className="field-label">Название</span>
          <TextInput placeholder="Название объединённой подписки" value={name} onChange={(e) => onNameChange(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">Выходной формат</span>
          <Segmented
            ariaLabel="Выходной формат"
            value={String(output)}
            onChange={(value) => onOutputChange(value as SubscriptionPayload["output"])}
            options={outputOptions}
          />
        </div>
      </div>

      <label className="switch-row">
        <span className="switch-row-text">
          <span>Выбирать формат по User-Agent</span>
          <small>Объединение отдаётся тем же способом, что обычная подписка: если клиент не распознан, берётся формат выше.</small>
        </span>
        <input
          type="checkbox"
          checked={outputAuto}
          onChange={(e) => onOutputAutoChange(e.target.checked)}
        />
      </label>

      <div className="form-section-head merge-section-head">
        <div className="form-section-title">Что соединяем</div>
        <div className="form-section-lead">
          Отметьте подписки и при желании оставьте от каждой только нужные серверы.
        </div>
      </div>

      <div className="merge-rows">
        {items.length === 0 ? (
          <div className="status">Нет подписок, из которых можно собрать объединение.</div>
        ) : items.map((item) => (
          <MergeRow
            key={item.key}
            item={item}
            preview={preview[item.key]}
            onChange={(next) => patch(item.key, next)}
          />
        ))}
      </div>
    </Modal>
  );
}

export { buildFavoriteDrafts, PATTERN_PRESETS };
