import type { ReactNode } from "react";
import type { FavoriteItem } from "../types";
import { EditIcon, TrashIcon, TestIcon, ShareIcon, ProfileIcon, CopyIcon, UserIcon, PingIcon, appIconFor, osIconFor } from "../icons";
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
  onOpenOverrides: () => void;
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

export function SubscriptionCard({ item, canEdit, showAdvanced, onEdit, onDelete, onTest, onShare, onOpenUsers, onOpenAccess, onPing, onOpenOverrides }: Props) {
  // Право на запись — это пересечение роли и доступа к конкретной ссылке:
  // редактор с доступом «просмотр» тоже ничего не меняет.
  const mayEdit = canEdit && item.permissions?.canEdit !== false;
  // Выданную подписку убрать из своего списка нельзя: она придёт обратно,
  // пока доступ не отозвали. Чужая — тем более не наша, чтобы её удалять.
  const mayDelete = mayEdit && !item.derived;
  // Значок берём по приложению, а если его нет — по ОС: карточка должна
  // узнаваться с одного взгляда, а не только по тексту заголовка.
  const MarkIcon = appIconFor(item.payload?.app || "") || osIconFor(item.payload?.device || "");
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
  return (
    <Card
      className={`sub-card${item.foreign ? " sub-card-foreign" : ""}`}
      title={title}
    >
      <div className="sub-url">
        <a href={item.url} target="_blank" rel="noreferrer noopener">{item.url}</a>
      </div>
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
        {showAdvanced ? item.labels.map((x) => (
          <Badge key={x} className="label">
            {x}
          </Badge>
        )) : null}
      </div>
      <div className="sub-card-actions">
        <TipIcon tip="Скопировать ссылку" label="Скопировать ссылку" icon={<CopyIcon className="btn-icon" />} onClick={() => void copyToClipboard(item.url)} />
        <TipIcon tip="Открыть страницу подключения" label="Открыть страницу подключения" icon={<ShareIcon className="btn-icon" />} onClick={onShare} />
        {onOpenAccess && item.shortId ? (
          <TipIcon tip="Кому выдан доступ" label="Доступы" icon={<UserIcon className="btn-icon" />} onClick={onOpenAccess} />
        ) : null}
        {onPing ? (
          <TipIcon tip="Пинг серверов подписки" label="Пинг" icon={<PingIcon className="btn-icon" />} onClick={onPing} />
        ) : null}
        {showAdvanced ? (
          <TipIcon tip="Тест" label="Тест" icon={<TestIcon className="btn-icon" />} onClick={onTest} />
        ) : null}
        {showAdvanced && mayEdit ? (
          <TipIcon tip="Overrides" label="Overrides" icon={<ProfileIcon className="btn-icon" />} onClick={onOpenOverrides} />
        ) : null}
        {mayEdit ? (
          <TipIcon tip="Редактировать" label="Редактировать" icon={<EditIcon className="btn-icon" />} onClick={onEdit} />
        ) : null}
        {mayDelete ? (
          <TipIcon tip="Удалить" label="Удалить" icon={<TrashIcon className="btn-icon" />} tone="danger" onClick={onDelete} />
        ) : null}
      </div>
    </Card>
  );
}
