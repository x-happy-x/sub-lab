import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonTone = "primary" | "danger" | "ghost" | "quiet";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  /** Иконка слева от текста. */
  icon?: ReactNode;
  size?: "md" | "sm";
  block?: boolean;
};

export function Button({ tone, icon, size = "md", block, className = "", type = "button", children, ...props }: Props) {
  const classes = [
    "btn",
    tone ? `btn-${tone}` : "",
    size === "sm" ? "btn-sm" : "",
    block ? "btn-block" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...props}>
      {icon}
      {children}
    </button>
  );
}
