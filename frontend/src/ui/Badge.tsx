import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: "accent" | "ok" | "warn" | "danger";
};

export function Badge({ tone, className = "", children, ...props }: Props) {
  return (
    <span className={`badge ${tone ? `badge-${tone}` : ""} ${className}`.trim()} {...props}>
      {children}
    </span>
  );
}
