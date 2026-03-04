import { useEffect, type PropsWithChildren } from "react";
import type { ReactNode } from "react";
import { ModalHeader } from "@x-happy-x/ui-kit";

type ModalProps = PropsWithChildren<{
  onClose: () => void;
  className?: string;
  title?: ReactNode;
  showCloseButton?: boolean;
}>;

export function Modal({ onClose, className, title, showCloseButton = true, children }: ModalProps) {
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

  return (
    <section
      className="ui-modal-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`ui-modal-panel ${className || ""}`} onMouseDown={(event) => event.stopPropagation()}>
        {title ? <ModalHeader title={title} onClose={onClose} showCloseButton={showCloseButton} /> : null}
        {children}
      </div>
    </section>
  );
}
