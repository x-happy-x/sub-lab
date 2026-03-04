import { useEffect, useRef, useState } from "react";
import { IconButton, Tooltip } from "@x-happy-x/ui-kit";
import { CloseIcon, ProfileIcon, UserIcon } from "../icons";
import type { AuthUser } from "../types";

type Props = {
  user: AuthUser | null;
  onLogout: () => void;
  onAdmin?: () => void;
  onHome?: () => void;
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

  return (
    <div className="user-menu" ref={rootRef}>
      <Tooltip content="Аккаунт">
        <span className="ui-tip-wrap">
          <IconButton aria-label="Аккаунт" onClick={() => setOpen((v) => !v)}>
            <UserIcon className="btn-icon" />
          </IconButton>
        </span>
      </Tooltip>
      {open ? (
        <div className="user-dropdown" role="menu">
          <div className="user-dropdown-head">
            <UserIcon className="btn-icon" />
            <div>
              <div className="user-name">{user.username}</div>
              <div className="user-role">{user.role}</div>
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
