import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FavoriteItem, ShortLinkHealth, ShortLinkUserCounts } from "../types";
import { SubscriptionCheckedAt, SubscriptionHealthLine } from "./SubscriptionHealthLine";
import {
  EditIcon,
  TrashIcon,
  TestIcon,
  ShareIcon,
  ProfileIcon,
  CopyIcon,
  UserIcon,
  PingIcon,
  LockIcon,
  MenuIcon,
  appIconFor,
  osIconFor,
} from "../icons";
import { copyToClipboard } from "../lib/clipboard";
import { Badge, Card, IconButton, Tooltip } from "../ui";

type Props = {
  item: FavoriteItem;
  /** Роль позволяет менять подписки. У наблюдателя карточка только читается. */
  canEdit: boolean;
  /** Полный набор инструментов: overrides, устройства, тестер. */
  showAdvanced: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onShare: () => void;
  onOpenUsers: () => void;
  /** Выдача прав на подписку. Доступно только админу. */
  onOpenAccess?: () => void;
  /** Замер задержки до серверов подписки. */
  onPing?: () => void;
  /** Собрать из короткой ссылки happ://crypt5/... */
  onHappLink?: () => void;
  onOpenOverrides: () => void;
  /** Итог суточной проверки. Приезжает отдельным запросом, позже карточки. */
  health?: ShortLinkHealth | null;
  healthLoading?: boolean;
  /** Сколько устройств на подписке — мелкие цифры в шапке. */
  users?: ShortLinkUserCounts | null;
  /** Проверить эту подписку прямо сейчас. */
  onCheckHealth?: () => void;
};

type MenuAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  tone?: "danger";
};

function TipIcon({ tip, label, icon, onClick, tone }: {
  tip: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <Tooltip content={tip}>
      <IconButton aria-label={label} icon={icon} tone={tone} onClick={onClick} />
    </Tooltip>
  );
}

/**
 * Меню остальных действий карточки.
 *
 * Иконок набралось столько, что ряд перестал читаться и на узком экране
 * переносился в две строки. Снаружи остались открытие и правка, всё
 * остальное живёт здесь.
 */
function CardMenu({ actions, open, onOpenChange }: {
  actions: MenuAction[];
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const setOpen = onOpenChange;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className="card-menu" ref={rootRef}>
      <Tooltip content="Ещё действия">
        <IconButton
          aria-label="Ещё действия"
          aria-haspopup="menu"
          aria-expanded={open}
          icon={<MenuIcon className="btn-icon" />}
          onClick={() => setOpen(!open)}
        />
      </Tooltip>
      {open ? (
        <div className="card-dropdown" role="menu">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={`card-dropdown-item${action.tone === "danger" ? " is-danger" : ""}`}
              onClick={() => { setOpen(false); action.onClick(); }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SubscriptionCard({
  item,
  canEdit,
  showAdvanced,
  onEdit,
  onDelete,
  onTest,
  onShare,
  onOpenUsers,
  onOpenAccess,
  onPing,
  onHappLink,
  onOpenOverrides,
  health,
  healthLoading = false,
  users,
  onCheckHealth,
}: Props) {
  // Меню знает карточка, а не только оно само: пока оно открыто, карточке
  // нужен z-index выше соседей.
  const [menuOpen, setMenuOpen] = useState(false);
  // Право на запись — это пересечение роли и доступа к конкретной ссылке:
  // редактор с доступом «просмотр» тоже ничего не меняет.
  const mayEdit = canEdit && item.permissions?.canEdit !== false;
  // Свою подписку убираем из списка, чужую админ удаляет вместе со ссылкой.
  // Выданную не трогаем вовсе: она вернётся, пока доступ не отозвали.
  const mayDelete = mayEdit && (!item.derived || (Boolean(item.foreign) && item.permissions?.canManageAccess === true));
  // Значок берём по приложению, а если его нет — по ОС: карточка должна
  // узнаваться с одного взгляда, а не только по тексту заголовка.
  const MarkIcon = appIconFor(item.payload?.app || "") || osIconFor(item.payload?.device || "");
  // У объединения приложение и устройство свои у каждого источника, поэтому
  // общие метки вроде «flclashx» или «windows» тут врут. Старые записи несут их
  // с собой, пока их не пересохранят, — отфильтровываем при показе.
  const isMerge = String(item.payload?.sub_url || "").startsWith("merge:");
  const shownLabels = isMerge ? item.labels.filter((x) => x.startsWith("merge:")) : item.labels;
  const name = showAdvanced
    ? <button type="button" className="sub-name sub-name-btn" onClick={onOpenUsers}>{item.title}</button>
    : <span className="sub-name">{item.title}</span>;
  const title = (
    <span className="sub-title-row">
      <span className="sub-mark" aria-hidden="true">
        {MarkIcon ? <MarkIcon className="btn-icon" /> : <span className="sub-mark-letter">{(item.title || "?").trim().charAt(0).toUpperCase()}</span>}
      </span>
      {name}
    </span>
  );

  const menuActions: MenuAction[] = ([
    onOpenAccess && item.shortId
      ? { key: "access", label: "Кому выдан доступ", icon: <UserIcon className="btn-icon" />, onClick: onOpenAccess }
      : null,
    onPing
      ? { key: "ping", label: "Пинг серверов", icon: <PingIcon className="btn-icon" />, onClick: onPing }
      : null,
    onHappLink
      ? { key: "happ", label: "Ссылка для Happ", icon: <LockIcon className="btn-icon" />, onClick: onHappLink }
      : null,
    onCheckHealth
      ? { key: "recheck", label: "Проверить сейчас", icon: <PingIcon className="btn-icon" />, onClick: onCheckHealth }
      : null,
    showAdvanced
      ? { key: "test", label: "Тест подписки", icon: <TestIcon className="btn-icon" />, onClick: onTest }
      : null,
    showAdvanced && mayEdit
      ? { key: "overrides", label: "Overrides", icon: <ProfileIcon className="btn-icon" />, onClick: onOpenOverrides }
      : null,
    mayDelete
      ? {
        key: "delete",
        label: item.foreign ? "Удалить подписку" : "Убрать из списка",
        icon: <TrashIcon className="btn-icon" />,
        onClick: onDelete,
        tone: "danger" as const,
      }
      : null,
  ].filter(Boolean)) as MenuAction[];

  return (
    <Card
      className={`sub-card${item.foreign ? " sub-card-foreign" : ""}${menuOpen ? " is-menu-open" : ""}`}
      title={title}
      actions={<SubscriptionCheckedAt health={health} users={users} />}
    >
      <div className="sub-url">
        <a href={item.url} target="_blank" rel="noreferrer noopener">{item.url}</a>
        <Tooltip content="Скопировать ссылку">
          <button
            type="button"
            className="sub-url-copy"
            aria-label="Скопировать ссылку"
            onClick={() => void copyToClipboard(item.url)}
          >
            <CopyIcon className="btn-icon" />
          </button>
        </Tooltip>
      </div>
      <SubscriptionHealthLine health={health} loading={healthLoading} />
      <div className="labels">
        {item.foreign ? (
          <Badge className="label label-foreign" tone="accent">
            чужая{item.ownerUsername ? ` · ${item.ownerUsername}` : ""}
          </Badge>
        ) : item.derived ? <Badge className="label">выдана вам</Badge> : null}
        {item.permissions?.missing ? <Badge className="label">ссылка не создана</Badge> : null}
        {item.permissions?.accessLevel ? (
          <Badge className="label">
            {item.permissions.accessLevel}
          </Badge>
        ) : null}
        {item.hidden ? (
          <Badge className="label">
            hidden
          </Badge>
        ) : null}
        {(item.tags || []).map((tag) => (
          <Badge key={`tag:${tag}`} className="label label-tag">
            #{tag}
          </Badge>
        ))}
        {showAdvanced ? shownLabels.map((x) => (
          <Badge key={x} className="label">
            {x}
          </Badge>
        )) : null}
      </div>
      <div className="sub-card-actions">
        <TipIcon tip="Открыть страницу подключения" label="Открыть страницу подключения" icon={<ShareIcon className="btn-icon" />} onClick={onShare} />
        {mayEdit ? (
          <TipIcon tip="Редактировать" label="Редактировать" icon={<EditIcon className="btn-icon" />} onClick={onEdit} />
        ) : null}
        <CardMenu actions={menuActions} open={menuOpen} onOpenChange={setMenuOpen} />
      </div>
    </Card>
  );
}
