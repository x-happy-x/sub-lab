import type { FavoriteItem } from "../types";
import { EditIcon, TrashIcon, TestIcon, ShareIcon } from "../icons";
import { Badge, Card, IconButton, Tooltip } from "@x-happy-x/ui-kit";

type Props = {
  item: FavoriteItem;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onShare: () => void;
};

export function SubscriptionCard({ item, onEdit, onDelete, onTest, onShare }: Props) {
  return (
    <Card
      className="sub-card"
      title={<div className="sub-name">{item.title}</div>}
      actions={(
        <div className="toolbar">
          <Tooltip content="Тест">
            <span className="ui-tip-wrap">
              <IconButton aria-label="Тест" icon={<TestIcon className="btn-icon" />} onClick={onTest} />
            </span>
          </Tooltip>
          <Tooltip content="Поделиться">
            <span className="ui-tip-wrap">
              <IconButton aria-label="Поделиться" icon={<ShareIcon className="btn-icon" />} onClick={onShare} />
            </span>
          </Tooltip>
          <Tooltip content="Редактировать">
            <span className="ui-tip-wrap">
              <IconButton aria-label="Редактировать" icon={<EditIcon className="btn-icon" />} onClick={onEdit} />
            </span>
          </Tooltip>
          <Tooltip content="Удалить">
            <span className="ui-tip-wrap">
              <IconButton aria-label="Удалить" icon={<TrashIcon className="btn-icon" />} tone="danger" onClick={onDelete} />
            </span>
          </Tooltip>
        </div>
      )}
    >
      <div className="sub-url">
        <a href={item.url} target="_blank" rel="noreferrer noopener">{item.url}</a>
      </div>
      <div className="labels">
        {item.labels.map((x) => (
          <Badge key={x} className="label">
            {x}
          </Badge>
        ))}
      </div>
    </Card>
  );
}
