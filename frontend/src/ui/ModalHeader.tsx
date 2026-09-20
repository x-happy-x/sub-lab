import type { ReactNode } from "react";
import { CloseIcon } from "../icons";

type Props = {
  title: ReactNode;
  onClose?: () => void;
  showCloseButton?: boolean;
  closeLabel?: string;
  actions?: ReactNode;
  className?: string;
};

export function ModalHeader({ title, onClose, showCloseButton = true, closeLabel = "Закрыть", actions, className = "" }: Props) {
  return (
    <header className={`modal-header ${className}`.trim()}>
      <h2 className="modal-title">{title}</h2>
      <div className="modal-header-actions">
        {actions}
        {showCloseButton && onClose ? (
          <button type="button" className="icon-btn modal-close" aria-label={closeLabel} onClick={onClose}>
            <CloseIcon className="btn-icon" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
