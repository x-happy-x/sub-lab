import { useEffect, type PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { ModalHeader } from "../ui";

type ModalProps = PropsWithChildren<{
  onClose: () => void;
  className?: string;
  title?: ReactNode;
  showCloseButton?: boolean;
  /** Липкая полоса действий внизу окна. */
  footer?: ReactNode;
  /** Подпись под заголовком. */
  lead?: ReactNode;
}>;

export function Modal({ onClose, className, title, showCloseButton = true, footer, lead, children }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Окно живёт в <body>, а не внутри страницы: у `.page` своя анимация, а значит
  // и свой контекст наложения — из него модалка не могла перекрыть липкую шапку,
  // и на узком экране шапка закрывала заголовок окна вместе с крестиком.
  return createPortal(
    <section
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal-panel ${className || ""}`} onMouseDown={(event) => event.stopPropagation()}>
        {title ? <ModalHeader title={title} onClose={onClose} showCloseButton={showCloseButton} /> : null}
        {lead ? <p className="modal-lead">{lead}</p> : null}
        {children}
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </section>,
    document.body,
  );
}
