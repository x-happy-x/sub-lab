import type { HTMLAttributes, ReactNode } from "react";

type Props = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  actions?: ReactNode;
  /** Подпись под заголовком. */
  lead?: ReactNode;
};

export function Card({ title, actions, lead, className = "", children, ...props }: Props) {
  return (
    <article className={`card ${className}`.trim()} {...props}>
      {title || actions ? (
        <header className="card-head">
          <div className="card-title-wrap">
            {title ? <div className="card-title">{title}</div> : null}
            {lead ? <div className="card-lead">{lead}</div> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card-body">{children}</div>
    </article>
  );
}
