import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function TextInput({ className = "", type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={`input ${className}`.trim()} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`.trim()} {...props} />;
}
