import { useEffect, useRef, useState } from "react";
import { CloseIcon, ProfileIcon } from "../icons";
import type { AuthUser } from "../types";

type Props = {
  user: AuthUser | null;
  onLogout: () => void;
  onAdmin?: () => void;
  onHome?: () => void;
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Администратор",
  editor: "Редактор",
  viewer: "Наблюдатель",
};

export function UserMenu({ user, onLogout, onAdmin, onHome }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (!user) return null;

  const role = String(user.accountRole || user.role || "");
  const initial = String(user.username || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="user-menu" ref={rootRef}>
      <button type="button" className="me-button" aria-haspopup="menu" aria-label="Аккаунт" onClick={() => setOpen((v) => !v)}>
        <span className="me-avatar">{initial}</span>
        <span className="me-text">
          <b>{user.username}</b>
          <span>{ROLE_LABELS[role] || role}</span>
        </span>
      </button>
      {open ? (
        <div className="user-dropdown" role="menu">
          <div className="user-dropdown-head">
            <span className="me-avatar">{initial}</span>
            <div>
              <div className="user-name">{user.username}</div>
              <div className="user-role">{ROLE_LABELS[role] || role}</div>
            </div>
          </div>
          <div className="user-dropdown-actions">
            {onHome ? (
              <button type="button" className="btn" onClick={() => { setOpen(false); onHome(); }}>
                <ProfileIcon className="btn-icon" /> Главная
              </button>
            ) : null}
            {user.role === "admin" && onAdmin ? (
              <button type="button" className="btn" onClick={() => { setOpen(false); onAdmin(); }}>
                <ProfileIcon className="btn-icon" /> Админка
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => { setOpen(false); onLogout(); }}>
              <CloseIcon className="btn-icon" /> Выйти
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
