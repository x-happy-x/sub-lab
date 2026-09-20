export type NotificationLevel = "info" | "success" | "warning" | "error";

export type NotificationItem = {
  id: string;
  level: NotificationLevel;
  message: string;
  createdAt: number;
};

const LEVEL_TITLES: Record<NotificationLevel, string> = {
  info: "Инфо",
  success: "Готово",
  warning: "Внимание",
  error: "Ошибка",
};

type Props = {
  items: NotificationItem[];
  onDismiss: (id: string) => void;
};

export function NotificationToasts({ items, onDismiss }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.level}`}>
          <span className="toast-dot" />
          <div className="toast-main">
            <div className="toast-title">{LEVEL_TITLES[item.level] || item.level}</div>
            <div className="toast-body">{item.message}</div>
          </div>
          <button type="button" className="toast-close" aria-label="Скрыть" onClick={() => onDismiss(item.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
