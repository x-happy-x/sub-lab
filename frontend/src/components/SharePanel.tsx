import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip } from "@x-happy-x/ui-kit";
import {
  AppClashmiIcon,
  AppFlclashxIcon,
  AppHappIcon,
  AppKoalaClashIcon,
  AppPrizrakBoxIcon,
  AppShadowrocketIcon,
  AppV2raytunIcon,
  CopyIcon,
  FlaskIcon,
  ImportIcon,
  OsAndroidIcon,
  OsIosIcon,
  OsLinuxIcon,
  OsMacosIcon,
  OsWindowsIcon,
  PlusIcon,
  ProfileIcon,
  ShareIcon,
  TestIcon,
} from "../icons";
import type { AppGuide, AppsCatalogItem, PublicShortMeta } from "../lib/api";

type Props = {
  shortUrl: string;
  fullUrl: string;
  shareApps: AppsCatalogItem[];
  recommendedByOs: Record<string, string[]>;
  orderByOs: Record<string, string[]>;
  buildAppShareLink: (app: string, link: string) => string;
  onCopy: (text: string) => void;
  fetchGuide: (app: string, os: string) => Promise<AppGuide>;
  centeredTitle?: string;
  topMeta?: PublicShortMeta | null;
  topMetaLoading?: boolean;
  subscriptionFormat?: string;
  preferredOs?: string;
  preferredApp?: string;
};

type GuideStep = {
  icon: string;
  title: string;
  paragraphs: string[];
  buttons: Array<{ label: string; href: string }>;
};

const OS_ORDER = ["windows", "macos", "linux", "android", "ios"];

function guessOs(osList: string[]) {
  const ua = String(navigator.userAgent || "").toLowerCase();
  const platform = String(navigator.platform || "").toLowerCase();
  if (ua.includes("android")) return osList.includes("android") ? "android" : "";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return osList.includes("ios") ? "ios" : "";
  if (platform.includes("win")) return osList.includes("windows") ? "windows" : "";
  if (platform.includes("mac")) return osList.includes("macos") ? "macos" : "";
  if (platform.includes("linux")) return osList.includes("linux") ? "linux" : "";
  return osList[0] || "";
}

function OsIcon({ os }: { os: string }) {
  if (os === "windows") return <OsWindowsIcon className="share-os-icon" />;
  if (os === "macos") return <OsMacosIcon className="share-os-icon" />;
  if (os === "linux") return <OsLinuxIcon className="share-os-icon" />;
  if (os === "android") return <OsAndroidIcon className="share-os-icon" />;
  if (os === "ios") return <OsIosIcon className="share-os-icon" />;
  return <OsWindowsIcon className="share-os-icon" />;
}

function AppIcon({ app }: { app: string }) {
  if (app === "happ") return <AppHappIcon className="share-app-icon" />;
  if (app === "flclashx") return <AppFlclashxIcon className="share-app-icon" />;
  if (app === "v2raytun") return <AppV2raytunIcon className="share-app-icon" />;
  if (app === "koala-clash") return <AppKoalaClashIcon className="share-app-icon" />;
  if (app === "prizrak-box") return <AppPrizrakBoxIcon className="share-app-icon" />;
  if (app === "clashmi") return <AppClashmiIcon className="share-app-icon" />;
  if (app === "shadowrocket") return <AppShadowrocketIcon className="share-app-icon" />;
  return <AppHappIcon className="share-app-icon" />;
}

function StepIcon({ icon }: { icon: string }) {
  const token = String(icon || "").toLowerCase();
  if (token === "download") return <ImportIcon className="share-step-icon" />;
  if (token === "add") return <PlusIcon className="share-step-icon" />;
  if (token === "warning") return <ProfileIcon className="share-step-icon" />;
  if (token === "usage") return <TestIcon className="share-step-icon" />;
  return <FlaskIcon className="share-step-icon" />;
}

function parseGuideTemplate(template: string): GuideStep[] {
  const steps: GuideStep[] = [];
  let current: GuideStep | null = null;
  for (const raw of String(template || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^##\s*\[([a-z0-9_-]+)\]\s*(.+)$/i);
    if (header) {
      current = {
        icon: String(header[1] || "usage"),
        title: String(header[2] || "").trim(),
        paragraphs: [],
        buttons: [],
      };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const btn = line.match(/^\[button:(.+?)\]\((.+)\)$/i);
    if (btn) {
      current.buttons.push({ label: String(btn[1] || "").trim(), href: String(btn[2] || "").trim() });
      continue;
    }
    current.paragraphs.push(line);
  }
  return steps;
}

function formatDateRu(ts: number | null) {
  if (!ts) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(ts));
  } catch {
    return "—";
  }
}

function normalizeFormatToken(value: string) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (token.startsWith("raw")) return "raw";
  if (token.startsWith("yml") || token === "yaml") return "yml";
  return "";
}

export function SharePanel({
  shortUrl,
  fullUrl,
  shareApps,
  recommendedByOs,
  orderByOs,
  buildAppShareLink,
  onCopy,
  fetchGuide,
  centeredTitle,
  topMeta,
  topMetaLoading = false,
  subscriptionFormat = "",
  preferredOs = "",
  preferredApp = "",
}: Props) {
  const [subInfoOpen, setSubInfoOpen] = useState(false);
  const [selectedOs, setSelectedOs] = useState("");
  const [selectedApp, setSelectedApp] = useState("");
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState("");
  const [guide, setGuide] = useState<AppGuide | null>(null);
  const [showLinkBlock, setShowLinkBlock] = useState(false);
  const [osOpen, setOsOpen] = useState(false);
  const [selectedServerIdx, setSelectedServerIdx] = useState(0);
  const osDropRef = useRef<HTMLDivElement | null>(null);
  const selectedFormatToken = useMemo(
    () => normalizeFormatToken(topMeta?.sourceFormatToken || topMeta?.sourceFormat || subscriptionFormat),
    [subscriptionFormat, topMeta?.sourceFormat, topMeta?.sourceFormatToken],
  );

  const osList = useMemo(() => {
    const out = new Set<string>();
    for (const app of shareApps) {
      for (const os of app.platforms || []) {
        const token = String(os || "").trim().toLowerCase();
        if (token) out.add(token);
      }
    }
    return [...OS_ORDER.filter((os) => out.has(os)), ...Array.from(out).filter((os) => !OS_ORDER.includes(os))];
  }, [shareApps]);

  useEffect(() => {
    if (osList.length === 0) return;
    const pref = String(preferredOs || "").trim().toLowerCase();
    setSelectedOs((prev) => {
      if (prev && osList.includes(prev)) return prev;
      if (pref && osList.includes(pref)) return pref;
      return guessOs(osList);
    });
  }, [osList, preferredOs]);

  const recommendedKeys = useMemo(() => {
    if (!selectedOs) return new Set<string>();
    const keys = Array.isArray(recommendedByOs[selectedOs]) ? recommendedByOs[selectedOs] : [];
    return new Set(keys);
  }, [recommendedByOs, selectedOs]);

  const visibleApps = useMemo(() => {
    const base = selectedOs
      ? shareApps.filter((app) => app.platforms.includes(selectedOs))
      : shareApps;
    const order = Array.isArray(orderByOs[selectedOs]) ? orderByOs[selectedOs] : [];
    if (order.length === 0) return base;
    const indexMap = new Map(order.map((key, idx) => [key, idx]));
    return [...base].sort((a, b) => {
      const ai = indexMap.has(a.key) ? (indexMap.get(a.key) as number) : 9999;
      const bi = indexMap.has(b.key) ? (indexMap.get(b.key) as number) : 9999;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label);
    });
  }, [shareApps, selectedOs, orderByOs]);

  useEffect(() => {
    const recommended = visibleApps.find((app) => recommendedKeys.has(app.key));
    const pref = String(preferredApp || "").trim().toLowerCase();
    const preferred = visibleApps.find((app) => app.key === pref);
    const first = preferred || recommended || visibleApps[0];
    if (!first) return;
    setSelectedApp((prev) => (prev && visibleApps.some((x) => x.key === prev) ? prev : first.key));
  }, [visibleApps, recommendedKeys, preferredApp]);

  useEffect(() => {
    if (!selectedApp) return;
    setGuideLoading(true);
    setGuideError("");
    void fetchGuide(selectedApp, selectedOs || "default")
      .then((next) => setGuide(next))
      .catch((e) => {
        setGuide(null);
        setGuideError((e as Error)?.message || "Не удалось загрузить инструкцию");
      })
      .finally(() => setGuideLoading(false));
  }, [fetchGuide, selectedApp, selectedOs]);

  useEffect(() => {
    if (!osOpen) return;
    const onPointer = (event: MouseEvent) => {
      const root = osDropRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) return;
      setOsOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [osOpen]);

  useEffect(() => {
    setSelectedServerIdx(0);
  }, [topMeta?.serverEntries]);

  const guideSteps = useMemo(() => {
    if (!guide) return [];
    const parsedTemplate = parseGuideTemplate(guide.template || "");
    return parsedTemplate;
  }, [guide]);

  const selectedServer = Array.isArray(topMeta?.serverEntries) ? topMeta.serverEntries[selectedServerIdx] : null;
  const selectedServerUri = String(selectedServer?.uri || "");
  const hasCopyableServerUri = Boolean(selectedServerUri);

  const resolveTemplateUrl = (value: string) => {
    const appItem = visibleApps.find((app) => app.key === selectedApp) || null;
    const appType = appItem?.formats?.[0] || selectedFormatToken || "";
    let shortWithType = shortUrl || fullUrl;
    if (appType && shortWithType) {
      try {
        const parsed = new URL(shortWithType, window.location.origin);
        parsed.searchParams.set("type", appType);
        shortWithType = parsed.toString();
      } catch {
        // keep original when URL parsing fails
      }
    }
    const deeplink = buildAppShareLink(selectedApp, shortWithType);
    return String(value || "")
      .split("{SHORT_URL}")
      .join(shortUrl || fullUrl)
      .split("{FULL_URL}")
      .join(fullUrl)
      .split("{ENCODED_SHORT_URL}")
      .join(encodeURIComponent(shortUrl || fullUrl))
      .split("{ENCODED_FULL_URL}")
      .join(encodeURIComponent(fullUrl))
      .split("{DEEPLINK}")
      .join(deeplink);
  };

  return (
    <div className="share-page">
      {topMeta ? (
        <section className="sub-info">
          <button type="button" className="sub-info-head sub-info-head-toggle" onClick={() => setSubInfoOpen((v) => !v)}>
            <div className="sub-info-title-row">
              <span className={`sub-info-status-dot ${topMeta.active ? "active" : "expired"}`} />
              <div className="sub-info-title">{topMeta.providerName}</div>
            </div>
            <span className={`sub-info-caret ${subInfoOpen ? "open" : ""}`}>▾</span>
          </button>
          <div className="sub-info-sub">
            {topMeta.userName}
            {" · "}
            {topMeta.daysLeft === null ? "Без срока" : (topMeta.daysLeft >= 0 ? `Истекает через ${topMeta.daysLeft} дн` : "Срок истек")}
          </div>
          <div className={`sub-info-grid ${subInfoOpen ? "open" : "collapsed"}`}>
            <article className="sub-info-item">
              <div className="sub-info-label">Пользователь</div>
              <div className="sub-info-value">{topMeta.userName}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Статус</div>
              <div className="sub-info-value">{topMeta.statusText}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Истекает</div>
              <div className="sub-info-value">{formatDateRu(topMeta.expiresAt)}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Трафик</div>
              <div className="sub-info-value">{topMeta.trafficText}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Серверов</div>
              <div className="sub-info-value">{topMeta.serversCount}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Формат</div>
              <div className="sub-info-value">{topMeta.sourceFormat || "—"}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">Устройство</div>
              <div className="sub-info-value">{topMeta.deviceModel || topMeta.device || "—"}</div>
            </article>
            <article className="sub-info-item">
              <div className="sub-info-label">UA</div>
              <div className="sub-info-value" title={topMeta.userAgent || "—"}>{topMeta.userAgent || "—"}</div>
            </article>
          </div>
        </section>
      ) : (topMetaLoading ? (
        <section className="sub-info sub-info-loading">
          <div className="sub-info-sub">Загрузка информации о подписке…</div>
        </section>
      ) : (centeredTitle ? <h2 className="share-centered-title">{centeredTitle}</h2> : null))}

      <div className="share-os-row">
        <strong className="share-connect-title">Подключение</strong>
        <div className="share-os-dropdown" ref={osDropRef}>
          <button type="button" className="btn share-os-trigger" onClick={() => setOsOpen((v) => !v)}>
            <span className="share-os-trigger-left"><OsIcon os={selectedOs} /> {selectedOs || "Выберите ОС"}</span>
            <span className={`share-os-caret ${osOpen ? "open" : ""}`}>▾</span>
          </button>
          {osOpen ? (
            <div className="share-os-menu">
              {osList.map((os) => (
                <button key={os} type="button" className={`share-os-item ${os === selectedOs ? "active" : ""}`} onClick={() => { setSelectedOs(os); setOsOpen(false); }}>
                  <OsIcon os={os} /> {os}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="share-actions share-actions-apps">
        {visibleApps.map((app) => (
          <button
            key={app.key}
            type="button"
            className={`btn share-app-btn ${selectedApp === app.key ? "active" : ""}`}
            onClick={() => setSelectedApp(app.key)}
          >
            <span className="share-app-name">
              {app.label}
              {recommendedKeys.has(app.key) ? <sup className="share-rec-star">★</sup> : null}
            </span>
            <span className="share-app-icon-wrap"><AppIcon app={app.key} /></span>
          </button>
        ))}
      </div>
      {visibleApps.length === 0 ? <div className="status">Для выбранной ОС нет приложений.</div> : null}

      <div className="share-guide">
        {guideLoading ? <div className="status">Загрузка инструкции...</div> : null}
        {guideError ? <div className="status">{guideError}</div> : null}
        {!guideLoading && !guideError && guide && guideSteps.length === 0 ? <div className="status">Шаблон инструкции пуст</div> : null}
        {guideSteps.length > 0 ? (
          <div className="share-timeline">
            {guideSteps.map((step, idx) => (
              <section key={`${step.title}-${idx}`} className="share-step">
                <div className="share-step-rail">
                  <span className="share-step-dot"><StepIcon icon={step.icon} /></span>
                  {idx < guideSteps.length - 1 ? <span className="share-step-line" /> : null}
                </div>
                <div className="share-step-content">
                  <h3>{step.title}</h3>
                  {step.paragraphs.map((text, i) => <p key={`${step.title}-p-${i}`}>{text}</p>)}
                  {step.buttons.length > 0 ? (
                    <div className="share-install-links">
                      {step.buttons.map((link, i) => {
                        const href = resolveTemplateUrl(link.href);
                        const isDeeplink = href.startsWith("happ:") || href.startsWith("flclash") || href.startsWith("v2raytun:") || href.startsWith("shadowrocket:") || href.startsWith("koala-clash:") || href.startsWith("prizrak-box:") || href.startsWith("clashmi:");
                        if (isDeeplink) {
                          return (
                            <Button key={`${href}-${i}`} className="btn share-add-btn" onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
                              <PlusIcon className="btn-icon" /> {link.label}
                            </Button>
                          );
                        }
                        return (
                          <a key={`${href}-${i}`} href={href} target="_blank" rel="noreferrer" className="btn share-link-btn">
                            <ShareIcon className="btn-icon" /> {link.label}
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </div>

      <div className="share-links-toggle">
        <Button className="btn" onClick={() => setShowLinkBlock((v) => !v)}>
          {showLinkBlock ? "Скрыть ссылку и QR" : "Показать ссылку и QR"}
        </Button>
      </div>

      {showLinkBlock ? (
        <div className="share-links-block">
          <div className="share-actions share-actions-copy">
            <Button className="btn" onClick={() => onCopy(shortUrl || fullUrl)}>
              <CopyIcon className="btn-icon" /> Короткая ссылка
            </Button>
            <Button className="btn" onClick={() => onCopy(fullUrl)}>
              <CopyIcon className="btn-icon" /> Полная ссылка
            </Button>
          </div>
          <div className="qr">
            <img alt="qr" src={`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(shortUrl || fullUrl)}`} />
          </div>
          {Array.isArray(topMeta?.serverEntries) && topMeta.serverEntries.length > 0 ? (
            <div className="share-server-box">
              <label className="composer-label" htmlFor="server-select">Сервер</label>
              <div className="row">
                <select id="server-select" value={String(selectedServerIdx)} onChange={(e) => setSelectedServerIdx(Number(e.target.value || "0"))}>
                  {topMeta.serverEntries.map((row, idx) => (
                    <option key={`${row.name}-${idx}`} value={String(idx)}>{row.name}</option>
                  ))}
                </select>
                {hasCopyableServerUri ? (
                  <Button className="btn" onClick={() => onCopy(selectedServerUri)}>
                    <CopyIcon className="btn-icon" /> Копировать ссылку
                  </Button>
                ) : (
                  <Tooltip content="Для этой подписки нельзя получить прямую ссылку сервера">
                    <span className="ui-tip-wrap">
                      <Button className="btn" disabled>
                        <CopyIcon className="btn-icon" /> Копировать ссылку
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
