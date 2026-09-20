import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  tone?: "danger" | "accent";
  size?: "md" | "sm";
};

export function IconButton({ icon, tone, size = "md", className = "", type = "button", children, ...props }: Props) {
  const classes = [
    "icon-btn",
    tone ? `icon-btn-${tone}` : "",
    size === "sm" ? "icon-btn-sm" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...props}>
      {icon}
      {children}
    </button>
  );
}
