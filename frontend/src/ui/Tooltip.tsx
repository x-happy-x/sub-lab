import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = {
  content: ReactNode;
  children: ReactNode;
  /** Растянуть обёртку: нужно, когда кнопка внутри сетки. */
  block?: boolean;
};

type Position = { x: number; y: number; above: boolean };

/**
 * Подсказка рисуется в портале с position: fixed — иначе её режет
 * прокручиваемая панель модалки.
 */
export function Tooltip({ content, children, block }: Props) {
  const [position, setPosition] = useState<Position | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);

  const show = useCallback(() => {
    const host = hostRef.current;
    if (!host || !content) return;
    const rect = host.getBoundingClientRect();
    const above = rect.top > 90;
    setPosition({
      x: Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 12),
      y: above ? rect.top - 8 : rect.bottom + 8,
      above,
    });
  }, [content]);

  const hide = useCallback(() => setPosition(null), []);

  if (!content) return <>{children}</>;

  return (
    <span
      ref={hostRef}
      className={`tip ${block ? "tip-block" : ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {position
        ? createPortal(
          <span
            className={`tooltip ${position.above ? "tooltip-above" : "tooltip-below"}`}
            role="tooltip"
            style={{ left: `${position.x}px`, top: `${position.y}px` }}
          >
            {content}
          </span>,
          document.body,
        )
        : null}
    </span>
  );
}
