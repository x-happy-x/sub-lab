import { useEffect, useState, type ReactNode } from "react";
import { MenuIcon, CloseIcon } from "../icons";

export type ShellNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
};

type Props = {
  logoSrc: string;
  subtitle: string;
  /** Разделы боковой колонки. Пустой список — сайдбар не показываем. */
  nav?: ShellNavItem[];
  /** Быстрые действия текущей страницы: блок под разделами. */
  navActions?: ReactNode;
  navActionsTitle?: string;
  /** Низ колонки: смена темы и меню аккаунта. */
  footer?: ReactNode;
  children: ReactNode;
};

function Brand({ logoSrc, subtitle }: { logoSrc: string; subtitle: string }) {
  return (
    <div className="shell-brand">
      <img className="shell-logo" src={logoSrc} alt="SubLab" />
      <span className="shell-brand-text">
        <b>SubLab</b>
        <span>{subtitle}</span>
      </span>
    </div>
  );
}

/**
 * Каркас приложения: слева разделы и аккаунт, справа страница.
 * На узком экране колонка уезжает в выдвижную панель с полосой сверху.
 */
export function AppShell({ logoSrc, subtitle, nav = [], navActions, navActionsTitle = "Действия", footer, children }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasSide = nav.length > 0 || Boolean(navActions);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const navList = nav.length > 0 ? (
    <nav className="side-nav" aria-label="Разделы">
      {nav.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`side-nav-item ${item.active ? "active" : ""}`}
          aria-current={item.active ? "page" : undefined}
          onClick={() => { setDrawerOpen(false); item.onClick(); }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  ) : null;

  return (
    <div className={`shell ${hasSide ? "" : "shell-bare"}`}>
      {hasSide ? (
        <aside className={`side ${drawerOpen ? "open" : ""}`}>
          <div className="side-top">
            <Brand logoSrc={logoSrc} subtitle={subtitle} />
            <button type="button" className="side-close" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)}>
              <CloseIcon className="btn-icon" />
            </button>
          </div>
          {navList}
          {navActions ? (
            <div className="side-actions">
              <div className="side-section-title">{navActionsTitle}</div>
              <div className="side-actions-list" onClick={() => setDrawerOpen(false)}>{navActions}</div>
            </div>
          ) : null}
          {footer ? <div className="side-foot">{footer}</div> : null}
        </aside>
      ) : null}
      {hasSide && drawerOpen ? <div className="side-scrim" onClick={() => setDrawerOpen(false)} /> : null}
      <div className="main">
        <header className="topbar">
          {hasSide ? (
            <button type="button" className="topbar-burger" aria-label="Меню" onClick={() => setDrawerOpen(true)}>
              <MenuIcon className="btn-icon" />
            </button>
          ) : null}
          <Brand logoSrc={logoSrc} subtitle={subtitle} />
          <span className="topbar-spacer" />
          {footer ? <div className="topbar-actions">{footer}</div> : null}
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
