import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps } from "react";
import type {
  AuthUser,
  FavoriteItem,
  ImportedProxyItem,
  MockLogEntry,
  MockSource,
  ProfileCatalog,
  ProfileCatalogItem,
  ShortLinkAccessGrant,
  ShortLinkUsersData,
  SubscriptionPayload,
  SubTestResponse,
  UACatalog,
  UsageStats,
  MergeItem,
  MergePreviewResult,
  PingMode,
  PingResponse,
} from "./types";
import { readFavorites, writeFavorites } from "./lib/storage";
import {
  clearMockLogs,
  createMockSource,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUser,
  createShortLink,
  createLocalSource,
  createMergedSource,
  fetchMergedSource,
  updateMergedSource,
  previewMergeItems,
  pingSubscription,
  decryptHappSubscription,
  deleteProfile,
  fetchProfileCatalog,
  fetchAppsCatalog,
  fetchAppGuide,
  fetchFavorites as fetchFavoritesRemote,
  restoreFavorites as restoreFavoritesRemote,
  fetchUaCatalog,
  fetchUsageStats,
  fetchShortLink,
  fetchShortLinkAccess,
  fetchPublicShortLink,
  fetchPublicShortMeta,
  fetchLocalSource,
  parseBulkImport,
  getMockLogs,
  getMockSource,
  login,
  logout,
  fetchAuthState,
  fetchShortLinkUsers,
  updateShortLinkUsersPolicy,
  updateShortLinkUserState,
  deleteShortLinkUserEntry,
  readProfile,
  runSubTest,
  saveFavorites as saveFavoritesRemote,
  saveProfile,
  updateMockSource,
  updateShortLink,
  updateShortLinkAccess,
  type AppsCatalogItem,
  type PublicShortMeta,
} from "./lib/api";
import { copyToClipboard } from "./lib/clipboard";
import { FlaskIcon, ImportIcon, PlusIcon, ProfileIcon, CopyIcon, SaveIcon, SaveAsIcon, ThemeIcon, DiceIcon, TrashIcon, ListIcon, ShieldIcon, ChartIcon, TestIcon, CloseIcon } from "./icons";
import { SubscriptionCard } from "./components/SubscriptionCard";
import { SyncPeersPanel } from "./components/SyncPeersPanel";
import { Modal } from "./components/Modal";
import { AppShell, type ShellNavItem } from "./components/AppShell";
import { UserMenu } from "./components/UserMenu";
import { SharePanel } from "./components/SharePanel";
import { StatsPage } from "./components/StatsPage";
import { MergeModal, buildFavoriteDrafts, type MergeDraftItem } from "./components/MergeModal";
import { PingModal } from "./components/PingModal";
import { OverridesModal } from "./components/OverridesModal";
import { Badge, Button, IconButton, NotificationToasts, Segmented, TextInput, Textarea, Tooltip, type NotificationItem, type NotificationLevel } from "./ui";
import subLabIcon from "./assets/sub-lab-icon.png";

type TipButtonProps = ComponentProps<typeof Button> & {
  tip: string;
};

type TipIconButtonProps = ComponentProps<typeof IconButton> & {
  tip: string;
};

function TipButton({ tip, ...props }: TipButtonProps) {
  return (
    <Tooltip content={tip}>
      <Button {...props} />
    </Tooltip>
  );
}

function TipIconButton({ tip, ...props }: TipIconButtonProps) {
  return (
    <Tooltip content={tip}>
      <IconButton {...props} />
    </Tooltip>
  );
}

type TipChipButtonProps = ComponentProps<"button"> & {
  tip: string;
};

function TipChipButton({ tip, className, children, ...props }: TipChipButtonProps) {
  return (
    <Tooltip content={tip}>
      <button type="button" className={className} {...props}>
        {children}
      </button>
    </Tooltip>
  );
}

function defaultPayload(): SubscriptionPayload {
  return {
    endpoint: "last",
    sub_url: "",
    output: "yml",
    // Авто включено по умолчанию: формат почти всегда надёжнее выбрать по
    // User-Agent клиента, чем угадывать руками при создании подписки.
    output_auto: "1",
    app: "flclashx",
    device: "windows",
    profile: "",
    profiles: "",
    hwid: "",
    clash_groups: "",
    nodes: "",
  };
}

type ComposerSourceMode = "url" | "file" | "text";

function sourceModeFromPayload(payload: SubscriptionPayload | null): ComposerSourceMode {
  const subUrl = String(payload?.sub_url || "").trim().toLowerCase();
  if (subUrl.startsWith("local:")) return "text";
  return "url";
}

function countSourceServers(value: string): number {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(vless|vmess|ss|ssr|trojan):\/\//.test(line)).length;
}

type ClashGroupDraft = {
  type?: string;
  preset?: string;
  name?: string;
  countries?: string[];
  regex?: string;
};

/** Варианты выходного формата: один список на конструктор, импорт и объединение. */
const OUTPUT_OPTIONS = [
  { value: "yml", label: "yml", tip: "Формат YAML" },
  { value: "raw", label: "raw", tip: "Формат RAW" },
  { value: "raw_base64", label: "raw (base64)", tip: "Формат RAW в base64" },
  { value: "json", label: "json", tip: "Формат JSON" },
] as const;

const NODES_MODE_OPTIONS = [
  {
    value: "collapse",
    label: "свернуть",
    tip: "Одна строка на запись подписки. Кандидаты балансировщика, мосты и служебные outbound-ы остаются внутри и не показываются отдельными серверами.",
  },
  {
    value: "group",
    label: "группами",
    tip: "Запись с несколькими кандидатами становится своей url-test группой Clash; в raw уходят все её кандидаты.",
  },
  {
    value: "expand",
    label: "всё подряд",
    tip: "Каждый прокси-outbound становится отдельным сервером — как было раньше.",
  },
] as const;

const CLASH_GROUP_PRESETS = [
  { preset: "rf", name: "РФ" },
  { preset: "europe", name: "ЕВРОПА" },
  { preset: "cis", name: "СНГ" },
  { type: "not_rf", name: "ВСЁ КРОМЕ РФ" },
] as const;

function parseClashGroups(value: string | undefined): ClashGroupDraft[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as ClashGroupDraft[] : [];
  } catch {
    return [];
  }
}

function stringifyClashGroups(groups: ClashGroupDraft[]): string {
  const clean = groups
    .map((group) => ({
      type: String(group.type || "").trim() || undefined,
      preset: String(group.preset || "").trim() || undefined,
      name: String(group.name || "").trim() || undefined,
      countries: Array.isArray(group.countries) ? group.countries.map((item) => String(item || "").trim()).filter(Boolean) : undefined,
      regex: String(group.regex || "").trim() || undefined,
    }))
    .filter((group) => group.preset || group.type);
  return clean.length > 0 ? JSON.stringify(clean) : "";
}

function hasClashGroup(groups: ClashGroupDraft[], entry: typeof CLASH_GROUP_PRESETS[number]): boolean {
  if ("preset" in entry) return groups.some((group) => group.preset === entry.preset);
  return groups.some((group) => group.type === entry.type);
}

function toggleClashGroup(groups: ClashGroupDraft[], entry: typeof CLASH_GROUP_PRESETS[number]): ClashGroupDraft[] {
  if (hasClashGroup(groups, entry)) {
    return groups.filter((group) => ("preset" in entry ? group.preset !== entry.preset : group.type !== entry.type));
  }
  return [...groups, { ...entry }];
}

function isEncryptedHappLink(value: string): boolean {
  return /^happ:\/\/crypt\d*\//i.test(String(value || "").trim());
}

function labelsFromPayload(p: SubscriptionPayload): string[] {
  const labels: string[] = [p.output_auto ? `auto:${p.output || "yml"}` : (p.output || "yml")];
  if (p.app) labels.push(p.app);
  if (p.device) labels.push(p.device);
  if (p.profile) labels.push(`profile:${p.profile}`);
  if (p.clash_groups) labels.push("groups");
  if (p.nodes && p.nodes !== "collapse") labels.push(`nodes:${p.nodes}`);
  return labels;
}

function normalizeTagsInput(value: string | string[] | undefined): string[] {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const tag = String(item || "").trim().replace(/^#+/, "").toLowerCase();
    if (!tag || seen.has(tag)) continue;
    if (!/^[a-z0-9._-]+$/.test(tag)) continue;
    seen.add(tag);
    out.push(tag.slice(0, 64));
    if (out.length >= 30) break;
  }
  return out;
}

function formatLabelFromPayload(p: SubscriptionPayload): string {
  const fallback = String(p.output || "yml").trim() || "yml";
  return p.output_auto ? `auto -> ${fallback}` : fallback;
}

function parseUrlToPayload(raw: string): { ok: boolean; payload?: SubscriptionPayload; shortId?: string; error?: string } {
  try {
    const u = new URL(raw, window.location.origin);
    const path = u.pathname.replace(/^\/+/, "");
    if (path.startsWith("l/")) return { ok: true, shortId: path.slice(2) };
    return {
      ok: true,
      payload: {
        endpoint: path === "sub" ? "sub" : "last",
        sub_url: u.searchParams.get("sub_url") || "",
        output: (u.searchParams.get("output") || "yml") as SubscriptionPayload["output"],
        output_auto: u.searchParams.get("output_auto") || "",
        app: u.searchParams.get("app") || "",
        device: u.searchParams.get("device") || "",
        profile: u.searchParams.get("profile") || "",
        profiles: u.searchParams.get("profiles") || "",
        hwid: u.searchParams.get("hwid") || "",
        clash_groups: u.searchParams.get("clash_groups") || "",
        nodes: (u.searchParams.get("nodes") || "") as SubscriptionPayload["nodes"],
      },
    };
  } catch {
    return { ok: false, error: "Некорректная ссылка" };
  }
}

function buildFullUrlWithOrigin(payload: SubscriptionPayload, origin: string): string {
  const endpoint = payload.endpoint === "sub" ? "sub" : "last";
  const params = new URLSearchParams();
  const keys: Array<keyof SubscriptionPayload> = ["sub_url", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups", "nodes"];
  for (const key of keys) {
    const v = payload[key];
    if (v) params.set(key, String(v));
  }
  if (!params.get("output")) params.set("output", "yml");
  return `${origin}/${endpoint}?${params.toString()}`;
}

function rewriteFavoriteUrlToOrigin(item: FavoriteItem, origin: string): FavoriteItem {
  const nextUrl = item.shortId
    ? `${origin}/l/${encodeURIComponent(item.shortId)}`
    : buildFullUrlWithOrigin(item.payload, origin);
  return {
    ...item,
    url: nextUrl,
  };
}

function normalizePublicBaseUrl(raw: string): string {
  const browserOrigin = String(window.location.origin || "").trim();
  const value = String(raw || "").trim();
  if (!value) return browserOrigin;
  try {
    const parsed = new URL(value);
    const browser = browserOrigin ? new URL(browserOrigin) : null;
    if (browser && browser.hostname && !["localhost", "127.0.0.1", "::1"].includes(browser.hostname.toLowerCase())) {
      return `${browser.protocol}//${browser.host}`;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return browserOrigin;
  }
}

function detectDownloadExtension(format: string): string {
  const token = String(format || "").trim().toLowerCase();
  if (token.startsWith("json")) return "json";
  if (token === "yaml" || token.startsWith("yml")) return "yaml";
  return "txt";
}

function downloadTextFile(body: string, fileName: string) {
  const blob = new Blob([String(body || "")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type FavoritesBackupFile = {
  version: number;
  exportedAt: string;
  account: string;
  items: FavoriteItem[];
};

function normalizeFavoriteBackupItem(raw: unknown, index: number): FavoriteItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const payloadRaw = (item.payload && typeof item.payload === "object") ? item.payload as Record<string, unknown> : {};
  const endpoint = String(payloadRaw.endpoint || "").trim() === "sub" ? "sub" : "last";
  const outputToken = String(payloadRaw.output || "").trim();
  const output = outputToken === "raw" || outputToken === "raw_base64" || outputToken === "json" || outputToken === "yml"
    ? outputToken
    : "yml";
  const subUrl = String(payloadRaw.sub_url || "").trim();
  if (!subUrl) return null;
  const title = String(item.title || "").trim() || `Подписка ${index + 1}`;
  const tsValue = Number(item.ts || 0);
  return {
    title,
    url: String(item.url || "").trim(),
    payload: {
      ...defaultPayload(),
      endpoint,
      output,
      output_auto: String(payloadRaw.output_auto || ""),
      sub_url: subUrl,
      app: String(payloadRaw.app || ""),
      device: String(payloadRaw.device || ""),
      profile: String(payloadRaw.profile || ""),
      profiles: String(payloadRaw.profiles || ""),
      hwid: String(payloadRaw.hwid || ""),
      clash_groups: String(payloadRaw.clash_groups || ""),
      nodes: String(payloadRaw.nodes || "") as SubscriptionPayload["nodes"],
    },
    labels: Array.isArray(item.labels) ? item.labels.map((value) => String(value || "")).filter(Boolean) : [],
    tags: normalizeTagsInput(Array.isArray(item.tags) ? item.tags.map((value) => String(value || "")) : []),
    shortId: String(item.shortId || "").trim() || undefined,
    hidden: Boolean(item.hidden),
    ts: Number.isFinite(tsValue) && tsValue > 0 ? tsValue : Date.now() + index,
  };
}

function parseFavoritesBackup(value: unknown): FavoriteItem[] {
  const rawItems = Array.isArray(value)
    ? value
    : ((value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) ? (value as { items: unknown[] }).items : []);
  return rawItems
    .map((item, index) => normalizeFavoriteBackupItem(item, index))
    .filter((item): item is FavoriteItem => Boolean(item))
    .slice(0, 50);
}

type ProfileHeaderRow = {
  id: string;
  key: string;
  value: string;
};

type ProfileFormState = {
  allowHwidOverride: boolean;
  headers: ProfileHeaderRow[];
};

type AppTestStep = 1 | 2 | 3;

function unquoteYamlValue(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseProfileForm(content: string): ProfileFormState {
  const lines = String(content || "").split(/\r?\n/);
  let allowHwidOverride = true;
  let inHeaders = false;
  const headers: ProfileHeaderRow[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const allowMatch = trimmed.match(/^allow_hwid_override\s*:\s*(true|false)\s*$/i);
    if (allowMatch) {
      allowHwidOverride = String(allowMatch[1] || "").toLowerCase() === "true";
      continue;
    }

    if (/^headers\s*:\s*$/i.test(trimmed)) {
      inHeaders = true;
      continue;
    }

    if (inHeaders) {
      if (!line.startsWith(" ")) {
        inHeaders = false;
        continue;
      }
      const pair = trimmed.match(/^([A-Za-z0-9._-]+)\s*:\s*(.*)$/);
      if (!pair) continue;
      headers.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: String(pair[1] || "").trim(),
        value: unquoteYamlValue(String(pair[2] || "")),
      });
    }
  }

  return { allowHwidOverride, headers };
}

function quoteYamlValue(value: string): string {
  const escaped = String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function buildProfileFormYaml(state: ProfileFormState): string {
  const lines = [`allow_hwid_override: ${state.allowHwidOverride ? "true" : "false"}`, "headers:"];
  const validHeaders = state.headers
    .map((row) => ({ key: String(row.key || "").trim(), value: String(row.value || "") }))
    .filter((row) => Boolean(row.key));
  if (validHeaders.length === 0) {
    lines.push("  {}");
  } else {
    for (const row of validHeaders) {
      lines.push(`  ${row.key}: ${quoteYamlValue(row.value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function getHeaderValue(headers: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = String(headers[String(key || "").toLowerCase()] || "").trim();
    if (value) return value;
  }
  return "";
}

function buildProfileFormFromHeaders(headers: Record<string, string>): ProfileFormState {
  const skip = new Set(["host", "connection", "accept-encoding", "content-length", "origin", "referer"]);
  const keys = Object.keys(headers)
    .map((key) => String(key || "").trim().toLowerCase())
    .filter((key) => key && !skip.has(key))
    .sort((a, b) => a.localeCompare(b));
  return {
    allowHwidOverride: !getHeaderValue(headers, ["x-hwid", "x-device-id"]),
    headers: keys.map((key) => ({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      key,
      value: String(headers[key] || ""),
    })),
  };
}

function sanitizeProfileNameToken(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildCapturedProfileName(username: string, app: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  const user = sanitizeProfileNameToken(username || "user") || "user";
  const appToken = sanitizeProfileNameToken(app || "client") || "client";
  return `capture-${user}-${appToken}-${stamp}`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  window.crypto.getRandomValues(bytes);
  const value = Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
  return value.slice(0, length);
}

function randomDigits(length: number): string {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((x) => String(x % 10)).join("");
}

function generateWindowsUuid(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function generateHwidByOs(os: string): string {
  const token = String(os || "").trim().toLowerCase();
  if (token === "windows") return generateWindowsUuid();
  if (token === "router" || token === "ndms") {
    return `${randomDigits(3)}-${randomDigits(3)}-${randomDigits(3)}-${randomDigits(3)}-${randomDigits(3)}`;
  }
  if (token === "macos" || token === "linux") return randomHex(32);
  if (token === "android" || token === "ios") return randomHex(16);
  return randomHex(16);
}

/** Путь публичной страницы подключения: открывается и без входа. */
const PUBLIC_SHARE_PATH = /^\/l\/[A-Za-z0-9_-]+$/;

export default function App() {
  type ModalKind = "import" | "composer" | "bulkImport" | "merge" | "tester" | "mock" | "appTest" | "profileEditor" | "share" | "access" | "ping" | "subUsers" | "overrides";
  const [theme, setTheme] = useState<"claude" | "claude-dark">(() => {
    const saved = localStorage.getItem("sublab-theme") || localStorage.getItem("submirror-theme");
    if (saved === "claude" || saved === "claude-dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "claude-dark" : "claude";
  });
  const [favorites, setFavorites] = useState<FavoriteItem[]>(() => readFavorites());
  const [status, setStatus] = useState("");
  const [listQuery, setListQuery] = useState("");
  // Владелец записи: «мои» — созданные вами, «выданные» — через доступ,
  // «чужие» — админский обзор. Чужие по умолчанию спрятаны, иначе список
  // администратора превращается в свалку всей установки.
  const [listOwnerFilter, setListOwnerFilter] = useState<"visible" | "mine" | "shared" | "foreign" | "all">("visible");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(true);
  const [authResolved, setAuthResolved] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [statsDays, setStatsDays] = useState(30);
  const [adminNewUsername, setAdminNewUsername] = useState("");
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminNewRole, setAdminNewRole] = useState<"user" | "admin">("user");
  const [adminEditPassword, setAdminEditPassword] = useState("");
  const [payload, setPayload] = useState<SubscriptionPayload>(defaultPayload());
  const [composerSourceMode, setComposerSourceMode] = useState<ComposerSourceMode>("url");
  const [composerFileName, setComposerFileName] = useState("");
  const [composerFileBody, setComposerFileBody] = useState("");
  const [composerTextBody, setComposerTextBody] = useState("");
  const [originalHappUrl, setOriginalHappUrl] = useState("");
  const [happDecryptDismissedUrl, setHappDecryptDismissedUrl] = useState("");
  const [showHappDecryptPrompt, setShowHappDecryptPrompt] = useState(false);
  const [happDecryptLoading, setHappDecryptLoading] = useState(false);
  const [happDecryptStatus, setHappDecryptStatus] = useState("");
  const [name, setName] = useState("");
  const [shortIdDraft, setShortIdDraft] = useState("");
  const [hiddenDraft, setHiddenDraft] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");
  const [clashGroupName, setClashGroupName] = useState("");
  const [clashGroupRegex, setClashGroupRegex] = useState("");
  const [clashGroupCountries, setClashGroupCountries] = useState("");
  const [editingIndex, setEditingIndex] = useState<number>(-1);
  const [importUrl, setImportUrl] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showTester, setShowTester] = useState(false);
  const [showMock, setShowMock] = useState(false);
  const [showAppTest, setShowAppTest] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [showSubUsers, setShowSubUsers] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [shareItem, setShareItem] = useState<FavoriteItem | null>(null);
  const [subUsersItem, setSubUsersItem] = useState<FavoriteItem | null>(null);
  const [overridesItem, setOverridesItem] = useState<FavoriteItem | null>(null);
  const [subUsersData, setSubUsersData] = useState<ShortLinkUsersData | null>(null);
  const [subUsersLoading, setSubUsersLoading] = useState(false);
  const [subUsersMax, setSubUsersMax] = useState("0");
  const [subUsersBlockedMessage, setSubUsersBlockedMessage] = useState("");
  const [subUsersLimitMessage, setSubUsersLimitMessage] = useState("");
  const [subUsersExpandedHwid, setSubUsersExpandedHwid] = useState("");
  const [shareModalMeta, setShareModalMeta] = useState<PublicShortMeta | null>(null);
  const [shareModalMetaLoading, setShareModalMetaLoading] = useState(false);
  const [shareAccessLoading, setShareAccessLoading] = useState(false);
  const [shareAccessOwner, setShareAccessOwner] = useState("");
  const [shareAccessDraft, setShareAccessDraft] = useState<Record<string, "" | "view" | "edit">>({});
  const [testResult, setTestResult] = useState<SubTestResponse | null>(null);

  const [profileCatalog, setProfileCatalog] = useState<ProfileCatalog>({ profiles: [] });
  const [uaCatalog, setUaCatalog] = useState<UACatalog>({ options: {}, defaultUa: "" });
  const [appsCatalog, setAppsCatalog] = useState<string[]>([]);
  const [appShareLinks, setAppShareLinks] = useState<Record<string, string>>({});
  const [shareApps, setShareApps] = useState<AppsCatalogItem[]>([]);
  const [recommendedByOs, setRecommendedByOs] = useState<Record<string, string[]>>({});
  const [orderByOs, setOrderByOs] = useState<Record<string, string[]>>({});
  const [publicSharePayload, setPublicSharePayload] = useState<SubscriptionPayload | null>(null);
  const [publicShareMeta, setPublicShareMeta] = useState<PublicShortMeta | null>(null);
  const [publicShareMetaLoading, setPublicShareMetaLoading] = useState(false);
  const [publicShareShortUrl, setPublicShareShortUrl] = useState("");
  const [publicShareError, setPublicShareError] = useState("");
  const [publicShareLoading, setPublicShareLoading] = useState(false);
  const [selectedOs, setSelectedOs] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileContent, setProfileContent] = useState("");
  const [profileForm, setProfileForm] = useState<ProfileFormState>({ allowHwidOverride: true, headers: [] });

  const [mockId, setMockId] = useState("");
  const [mockUrl, setMockUrl] = useState("");
  const [mockPreset, setMockPreset] = useState("stub_raw");
  const [mockStatus, setMockStatus] = useState("200");
  const [mockContentType, setMockContentType] = useState("text/plain; charset=utf-8");
  const [mockDelayMs, setMockDelayMs] = useState("0");
  const [mockHeaders, setMockHeaders] = useState("{}");
  const [mockBody, setMockBody] = useState("");
  const [mockLogs, setMockLogs] = useState("");
  const [mockTestTarget, setMockTestTarget] = useState("__current__");
  const [appTestStep, setAppTestStep] = useState<AppTestStep>(1);
  const [appTestSource, setAppTestSource] = useState<MockSource | null>(null);
  const [appTestLogs, setAppTestLogs] = useState<MockLogEntry[]>([]);
  const [appTestLoading, setAppTestLoading] = useState(false);
  const [appTestStatus, setAppTestStatus] = useState("");
  const [appTestSelectedApp, setAppTestSelectedApp] = useState("");
  const [appTestProfileName, setAppTestProfileName] = useState("");
  const [appTestSavingProfile, setAppTestSavingProfile] = useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const bulkImportFileInputRef = useRef<HTMLInputElement | null>(null);
  const backupRestoreInputRef = useRef<HTMLInputElement | null>(null);
  const [bulkImportFileName, setBulkImportFileName] = useState("");
  const [bulkImportRaw, setBulkImportRaw] = useState("");
  const [bulkImportItems, setBulkImportItems] = useState<ImportedProxyItem[]>([]);
  const [bulkImportMask, setBulkImportMask] = useState("");
  const [bulkImportRegex, setBulkImportRegex] = useState("");
  const [bulkImportCountry, setBulkImportCountry] = useState("");
  const [bulkImportSplitSize, setBulkImportSplitSize] = useState("0");
  const [bulkImportOutput, setBulkImportOutput] = useState<SubscriptionPayload["output"]>("raw");
  const [bulkImportName, setBulkImportName] = useState("Импорт подписки");
  const [mergeName, setMergeName] = useState("Объединенная подписка");
  const [mergeOutput, setMergeOutput] = useState<SubscriptionPayload["output"]>("yml");
  const [showPing, setShowPing] = useState(false);
  const [pingItem, setPingItem] = useState<FavoriteItem | null>(null);
  const [pingData, setPingData] = useState<PingResponse | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState("");
  const [pingMode, setPingMode] = useState<PingMode>("tcp");
  const [pingAttempts, setPingAttempts] = useState(3);
  const [mergeId, setMergeId] = useState("");
  const [mergeOutputAuto, setMergeOutputAuto] = useState(true);
  const [mergeItems, setMergeItems] = useState<MergeDraftItem[]>([]);
  const [mergePreview, setMergePreview] = useState<Record<string, MergePreviewResult>>({});
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [mergeEditingIndex, setMergeEditingIndex] = useState(-1);

  const notify = (level: NotificationLevel, message: string) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item: NotificationItem = { id, level, message, createdAt: Date.now() };
    setNotifications((prev) => [...prev, item].slice(-6));
    window.setTimeout(() => {
      setNotifications((prev) => prev.filter((x) => x.id !== id));
    }, 3200);
  };

  useEffect(() => {
    void fetchAuthState()
      .then((auth) => {
        setAuthEnabled(auth.enabled);
        setAuthenticated(auth.authenticated || !auth.enabled);
        setAuthUser(auth.user || null);
        setPublicBaseUrl(normalizePublicBaseUrl(auth.publicBaseUrl));
      })
      .catch(() => {})
      .finally(() => setAuthResolved(true));
  }, []);

  const effectiveOrigin = useMemo(() => {
    const fromApi = normalizePublicBaseUrl(publicBaseUrl);
    return fromApi || window.location.origin;
  }, [publicBaseUrl]);

  /** Перечитать список с сервера: после синхронизации он мог поменяться целиком. */
  const reloadFavorites = async () => {
    const list = await fetchFavoritesRemote();
    setFavorites(list);
    writeFavorites(list);
  };

  useEffect(() => {
    if (!authResolved) return;
    if (authEnabled && !authenticated) return;
    void fetchFavoritesRemote()
      .then(async (remote) => {
        if (authEnabled) {
          return remote;
        }
        const local = readFavorites();
        if (remote.length === 0 && local.length > 0) {
          try {
            await saveFavoritesRemote(local);
          } catch {
            // Keep local fallback if remote sync is unavailable.
          }
          return local;
        }
        return remote;
      })
      .then((list) => {
        setFavorites(list);
        writeFavorites(list);
      })
      .catch(() => {});
  }, [authResolved, authEnabled, authenticated]);

  useEffect(() => {
    if (!authResolved || !authEnabled || authenticated) return;
    // Короткая ссылка открывается без входа: страница подключения `/l/<id>` —
    // это то, чем делятся, и вход там не нужен.
    if (PUBLIC_SHARE_PATH.test(window.location.pathname)) return;
    window.location.replace(`/auth/start?return=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [authResolved, authEnabled, authenticated]);

  useEffect(() => {
    if (!authResolved) return;
    if (authEnabled && !authenticated) return;
    void Promise.all([fetchProfileCatalog(), fetchUaCatalog(), fetchAppsCatalog()])
      .then(([profiles, ua, apps]) => {
        setProfileCatalog(profiles);
        setUaCatalog(ua);
        setAppsCatalog(apps.apps);
        setAppShareLinks(apps.shareLinks);
        setShareApps(apps.items);
        setRecommendedByOs(apps.recommendedByOs);
        setOrderByOs(apps.orderByOs);
      })
      .catch(() => {});
  }, [authResolved, authEnabled, authenticated]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("sublab-theme", theme);
  }, [theme]);

  const isAdminPath = window.location.pathname === "/admin";
  const isStatsPath = window.location.pathname === "/stats";
  const publicShareMatch = window.location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  const publicShareId = publicShareMatch ? publicShareMatch[1] : "";
  const publicTypeOverrideRaw = String(new URLSearchParams(window.location.search).get("type") || "").trim().toLowerCase();
  const publicTypeOverride = publicTypeOverrideRaw === "raw"
    ? "raw"
    : ((publicTypeOverrideRaw === "yml" || publicTypeOverrideRaw === "yaml" || publicTypeOverrideRaw === "clash") ? "yml" : "");
  const isAdminUser = authUser?.role === "admin";
  /**
   * Роль решает, что вообще показывать.
   *
   * Наблюдатель видит только список, редактор — подписки и короткую форму,
   * админ — весь инструментарий. Сервер проверяет то же самое: без роли editor
   * он не примет ни создание, ни изменение короткой ссылки.
   */
  const canEditSubs = !authEnabled || Boolean(authUser?.canEdit) || isAdminUser;
  const showAdvanced = isAdminUser || !authEnabled;
  const isMainPath = !isAdminPath && !isStatsPath && !publicShareId;

  const refreshAdminUsers = async () => {
    const list = await adminListUsers();
    setAdminUsers(list);
  };

  useEffect(() => {
    if (!isAdminPath || !authenticated || !isAdminUser) return;
    void refreshAdminUsers().catch(() => {});
  }, [isAdminPath, authenticated, isAdminUser]);

  const loadStats = (days: number) => {
    setStatsLoading(true);
    setStatsError("");
    void fetchUsageStats(days)
      .then((data) => setStats(data))
      .catch((e) => setStatsError((e as Error)?.message || "Не удалось получить статистику"))
      .finally(() => setStatsLoading(false));
  };

  useEffect(() => {
    if (!isStatsPath || !authenticated) return;
    loadStats(statsDays);
  }, [isStatsPath, authenticated, statsDays]);

  useEffect(() => {
    if (!publicShareId) return;
    setPublicShareLoading(true);
    setPublicShareError("");
    setPublicShareMeta(null);
    setPublicShareMetaLoading(true);
    void Promise.all([fetchPublicShortLink(publicShareId), fetchAppsCatalog()])
      .then(([shared, apps]) => {
        setPublicSharePayload({ ...defaultPayload(), ...shared.payload });
        setPublicShareShortUrl(shared.shortUrl);
        setAppsCatalog(apps.apps);
        setAppShareLinks(apps.shareLinks);
        setShareApps(apps.items);
        setRecommendedByOs(apps.recommendedByOs);
        setOrderByOs(apps.orderByOs);
      })
      .catch((e) => {
        setPublicShareError((e as Error)?.message || "Не удалось загрузить страницу шаринга");
      })
      .finally(() => setPublicShareLoading(false));

    void fetchPublicShortMeta(publicShareId, publicTypeOverride)
      .then((meta) => setPublicShareMeta(meta))
      .catch(() => {})
      .finally(() => setPublicShareMetaLoading(false));
  }, [publicShareId, publicTypeOverride]);

  useEffect(() => {
    if ((!showShare && !showAccess) || !shareItem?.shortId) {
      setShareModalMeta(null);
      setShareModalMetaLoading(false);
      setShareAccessLoading(false);
      setShareAccessOwner("");
      setShareAccessDraft({});
      return;
    }
    setShareModalMeta(null);
    setShareModalMetaLoading(true);
    void fetchPublicShortMeta(shareItem.shortId)
      .then((meta) => setShareModalMeta(meta))
      .catch(() => {})
      .finally(() => setShareModalMetaLoading(false));
    if (!isAdminUser) return;
    setShareAccessLoading(true);
    void Promise.all([
      adminUsers.length > 0 ? Promise.resolve(adminUsers) : adminListUsers(),
      fetchShortLinkAccess(shareItem.shortId),
    ])
      .then(([users, access]) => {
        if (adminUsers.length === 0) setAdminUsers(users);
        setShareAccessOwner(access.ownerUsername);
        const next: Record<string, "" | "view" | "edit"> = {};
        for (const user of users) {
          if (user.role === "admin") continue;
          if (user.username === access.ownerUsername) {
            next[user.username] = "edit";
            continue;
          }
          const grant = access.grants.find((item) => item.username === user.username);
          next[user.username] = grant?.accessLevel || "";
        }
        setShareAccessDraft(next);
      })
      .catch(() => {
        setShareAccessOwner("");
        setShareAccessDraft({});
      })
      .finally(() => setShareAccessLoading(false));
  }, [showShare, showAccess, shareItem?.shortId, isAdminUser, adminUsers]);

  const persistFavorites = async (list: FavoriteItem[]) => {
    const next = list.slice(0, 50);
    setFavorites(next);
    writeFavorites(next);
    if (!authResolved) return next;
    if (authEnabled && !authenticated) return next;
    const saved = await saveFavoritesRemote(next);
    const normalized = Array.isArray(saved) ? saved.slice(0, 50) : next;
    setFavorites(normalized);
    writeFavorites(normalized);
    return normalized;
  };

  const saveFavorites = (list: FavoriteItem[]) => {
    void persistFavorites(list).catch(() => {});
  };

  const currentClashGroups = parseClashGroups(payload.clash_groups);

  const updateClashGroups = (groups: ClashGroupDraft[]) => {
    setPayload((prev) => ({
      ...prev,
      clash_groups: stringifyClashGroups(groups),
    }));
  };

  const addRegexClashGroup = () => {
    const regex = clashGroupRegex.trim();
    if (!regex) return;
    updateClashGroups([
      ...currentClashGroups,
      { type: "regex", name: clashGroupName.trim() || regex, regex },
    ]);
    setClashGroupName("");
    setClashGroupRegex("");
  };

  const addCountryClashGroup = () => {
    const countries = clashGroupCountries
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (countries.length === 0) return;
    updateClashGroups([
      ...currentClashGroups,
      { type: "country", name: clashGroupName.trim() || countries.join(", "), countries },
    ]);
    setClashGroupName("");
    setClashGroupCountries("");
  };

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((x) => x.id !== id));
  };

  const closeAllModals = () => {
    setShowImport(false);
    setShowComposer(false);
    setShowBulkImport(false);
    setShowMerge(false);
    setShowTester(false);
    setShowMock(false);
    setShowAppTest(false);
    setShowProfileEditor(false);
    setShowShare(false);
    setShowAccess(false);
    setShowPing(false);
    setShowSubUsers(false);
    setShowOverrides(false);
  };

  const openModal = (kind: ModalKind) => {
    closeAllModals();
    if (kind === "import") setShowImport(true);
    if (kind === "composer") setShowComposer(true);
    if (kind === "bulkImport") setShowBulkImport(true);
    if (kind === "merge") setShowMerge(true);
    if (kind === "tester") setShowTester(true);
    if (kind === "mock") setShowMock(true);
    if (kind === "appTest") setShowAppTest(true);
    if (kind === "profileEditor") setShowProfileEditor(true);
    if (kind === "share") setShowShare(true);
    if (kind === "access") setShowAccess(true);
    if (kind === "ping") setShowPing(true);
    if (kind === "subUsers") setShowSubUsers(true);
    if (kind === "overrides") setShowOverrides(true);
  };

  const resetComposer = () => {
    setPayload(defaultPayload());
    setComposerSourceMode("url");
    setComposerFileName("");
    setComposerFileBody("");
    setComposerTextBody("");
    setOriginalHappUrl("");
    setHappDecryptDismissedUrl("");
    setShowHappDecryptPrompt(false);
    setHappDecryptLoading(false);
    setHappDecryptStatus("");
    setName("");
    setShortIdDraft("");
    setHiddenDraft(false);
    setTagsDraft("");
    setClashGroupName("");
    setClashGroupRegex("");
    setClashGroupCountries("");
    setEditingIndex(-1);
  };

  const hydrateComposerSource = async (nextPayload: SubscriptionPayload) => {
    const mode = sourceModeFromPayload(nextPayload);
    setComposerSourceMode(mode);
    setComposerFileName("");
    setComposerFileBody("");
    setComposerTextBody("");
    if (mode !== "text") return;
    const subUrl = String(nextPayload.sub_url || "").trim();
    if (!subUrl.startsWith("local:")) return;
    try {
      const source = await fetchLocalSource(subUrl.slice(6));
      setComposerTextBody(source.body);
      setComposerFileName(source.name);
    } catch {
      // keep alias in sub_url when body is unavailable
    }
  };

  const resolveComposerSubUrl = async () => {
    if (composerSourceMode === "url") {
      return String(payload.sub_url || "").trim();
    }
    if (composerSourceMode === "file") {
      const body = String(composerFileBody || "").trim();
      if (!body) throw new Error("Загрузите файл со списком адресов");
      const created = await createLocalSource({
        name: composerFileName || "uploaded-source.txt",
        body,
      });
      return created.subUrl;
    }
    const body = String(composerTextBody || "").trim();
    if (!body) throw new Error("Заполните поле с адресами");
    const created = await createLocalSource({
      name: name.trim() || "inline-source",
      body,
    });
    return created.subUrl;
  };

  const handleComposerFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setComposerFileName(file.name);
      setComposerFileBody(text);
      setStatus(`Файл загружен: ${file.name}`);
    } catch {
      setStatus("Не удалось прочитать файл");
    } finally {
      event.target.value = "";
    }
  };

  useEffect(() => {
    if (composerSourceMode !== "url") return;
    const subUrl = String(payload.sub_url || "").trim();
    if (!isEncryptedHappLink(subUrl)) return;
    if (originalHappUrl && originalHappUrl === subUrl) return;
    if (happDecryptDismissedUrl && happDecryptDismissedUrl === subUrl) return;
    setShowHappDecryptPrompt(true);
    setHappDecryptStatus("");
  }, [composerSourceMode, payload.sub_url, originalHappUrl, happDecryptDismissedUrl]);

  const applyHappDecryption = async () => {
    const current = String(payload.sub_url || "").trim();
    if (!isEncryptedHappLink(current)) {
      setShowHappDecryptPrompt(false);
      return;
    }
    try {
      setHappDecryptLoading(true);
      const result = await decryptHappSubscription(current);
      setPayload((prev) => ({ ...prev, sub_url: result.resolvedUrl }));
      setOriginalHappUrl(result.originalUrl);
      setHappDecryptDismissedUrl("");
      setHappDecryptStatus(`Успех: ${result.resolvedUrl}`);
      setShowHappDecryptPrompt(false);
      notify("success", "Happ-ссылка расшифрована");
    } catch (e) {
      const message = (e as Error)?.message || "Не удалось расшифровать happ-ссылку";
      setHappDecryptStatus(`Ошибка: ${message}`);
      notify("error", message);
    } finally {
      setHappDecryptLoading(false);
    }
  };

  const handleBulkImportFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = await parseBulkImport(text);
      setBulkImportFileName(file.name);
      setBulkImportRaw(text);
      setBulkImportItems(items);
      setBulkImportName(file.name.replace(/\.[^.]+$/, "") || "Импорт подписки");
      setStatus(`Импортировано прокси: ${items.length}`);
    } catch (e) {
      setStatus((e as Error)?.message || "Не удалось импортировать файл");
    } finally {
      event.target.value = "";
    }
  };

  const downloadFavoritesBackup = () => {
    const payload: FavoritesBackupFile = {
      version: 1,
      exportedAt: new Date().toISOString(),
      account: authUser?.username || "",
      // Чужие подписки админ видит, но в свою копию они не едут: восстановление
      // из такого файла присвоило бы их ему.
      items: favorites.filter((item) => !item.foreign),
    };
    const stamp = payload.exportedAt.replace(/[:.]/g, "-");
    downloadTextFile(JSON.stringify(payload, null, 2), `sub-lab-backup-${stamp}.json`);
    notify("success", `Экспортировано подписок: ${payload.items.length}`);
  };

  const rewriteFavoritesToCurrentOrigin = async () => {
    try {
      const next = favorites.map((item) => rewriteFavoriteUrlToOrigin(item, effectiveOrigin));
      await persistFavorites(next);
      notify("success", "Ссылки обновлены на текущий домен");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось обновить ссылки");
    }
  };

  const handleRestoreFavoritesBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const items = parseFavoritesBackup(parsed);
      if (items.length === 0) {
        throw new Error("В файле не найдено ни одной подписки");
      }
      const confirmed = window.confirm(`Заменить текущий список подписок (${favorites.length}) на ${items.length} из резервной копии?`);
      if (!confirmed) return;
      // Восстановление идёт через сервер: он заново создаёт короткие ссылки,
      // которых в базе уже нет, иначе список приходил бы пустым.
      const { favorites: restored, report } = await restoreFavoritesRemote(items);
      setFavorites(restored);
      writeFavorites(restored);
      const parts = [`восстановлено ${report.kept + report.created}`];
      if (report.created > 0) parts.push(`создано коротких ссылок: ${report.created}`);
      if (report.skipped > 0) parts.push(`пропущено чужих: ${report.skipped}`);
      notify(report.skipped > 0 ? "warning" : "success", parts.join(", "));
      if (report.skipped > 0) {
        setStatus(`Нет доступа: ${report.skippedTitles.join(", ")}`);
      }
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось восстановить резервную копию");
    }
  };

  const openBulkImportModal = () => {
    setBulkImportFileName("");
    setBulkImportRaw("");
    setBulkImportItems([]);
    setBulkImportMask("");
    setBulkImportRegex("");
    setBulkImportCountry("");
    setBulkImportSplitSize("0");
    setBulkImportOutput("raw");
    setBulkImportName("Импорт подписки");
    openModal("bulkImport");
  };

  const handleCreateBulkImportedSubscriptions = async () => {
    if (!bulkImportName.trim()) {
      setStatus("Укажите название импорта");
      return;
    }
    if (bulkImportFilteredItems.length === 0) {
      setStatus("Нет прокси после фильтрации");
      return;
    }
    try {
      const splitSize = Math.max(0, Number(bulkImportSplitSize || "0"));
      const chunks: ImportedProxyItem[][] = [];
      if (splitSize > 0) {
        for (let i = 0; i < bulkImportFilteredItems.length; i += splitSize) {
          chunks.push(bulkImportFilteredItems.slice(i, i + splitSize));
        }
      } else {
        chunks.push(bulkImportFilteredItems);
      }

      const createdItems: FavoriteItem[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const body = chunk.map((item) => item.normalizedUri).join("\n");
        const local = await createLocalSource({
          name: chunks.length > 1 ? `${bulkImportName.trim()} part ${index + 1}` : bulkImportName.trim(),
          body,
        });
        const nextPayload: SubscriptionPayload = {
          ...defaultPayload(),
          sub_url: local.subUrl,
          output: bulkImportOutput,
        };
        const short = await createShortLink(
          nextPayload,
          chunks.length > 1 ? `${bulkImportName.trim()} ${String(index + 1).padStart(2, "0")}` : bulkImportName.trim(),
        );
        createdItems.push({
          title: chunks.length > 1 ? `${bulkImportName.trim()} ${String(index + 1).padStart(2, "0")}` : bulkImportName.trim(),
          url: short.shortUrl,
          shortId: short.id,
          payload: nextPayload,
          labels: [...labelsFromPayload(nextPayload), `import:${chunk.length}`],
          ts: Date.now() + index,
        });
      }
      saveFavorites([...createdItems, ...favorites]);
      setShowBulkImport(false);
      notify("success", `Создано подписок: ${createdItems.length}`);
    } catch (e) {
      const message = (e as Error)?.message || "Не удалось создать подписки из импорта";
      setStatus(message);
      notify("error", message);
    }
  };

  const handleSave = async (forceNew: boolean) => {
    let resolvedSubUrl = "";
    if (!name.trim()) return setStatus("Укажите название");
    try {
      resolvedSubUrl = await resolveComposerSubUrl();
      if (!resolvedSubUrl) return setStatus("Укажите источник подписки");
      const next = [...favorites];
      const existing = !forceNew && editingIndex >= 0 ? next[editingIndex] : null;
      let shortId = existing?.shortId || "";
      let shortUrl = existing?.url || "";
      const nextPayload = { ...payload, sub_url: resolvedSubUrl };
      const requestedShortId = String(shortIdDraft || "").trim();
      const tags = normalizeTagsInput(tagsDraft);
      const saveOptions = {
        id: requestedShortId || undefined,
        hidden: hiddenDraft,
        tags,
      };

      // Потерянная короткая ссылка (запись пережила свою базу) пересоздаётся
      // под тем же идентификатором — иначе сохранение упиралось бы в 404.
      const linkMissing = Boolean(existing?.permissions?.missing);
      const saved = shortId && !forceNew && !linkMissing
        ? await updateShortLink(shortId, nextPayload, name.trim(), saveOptions)
        : await createShortLink(nextPayload, name.trim(), linkMissing && !forceNew ? { ...saveOptions, id: requestedShortId || shortId } : saveOptions);
      shortId = saved.id;
      shortUrl = saved.shortUrl;

      const item: FavoriteItem = {
        title: name.trim(),
        url: shortUrl,
        shortId,
        hidden: saved.hidden,
        tags: saved.tags,
        payload: nextPayload,
        labels: labelsFromPayload(nextPayload),
        derived: !forceNew ? existing?.derived : undefined,
        // Чужую подписку админ правит на месте: признак владельца надо
        // сохранить, иначе карточка до перезагрузки уедет в «мои».
        foreign: !forceNew ? existing?.foreign : undefined,
        ownerUsername: !forceNew ? existing?.ownerUsername : undefined,
        ts: Date.now(),
      };

      if (!forceNew && editingIndex >= 0) next[editingIndex] = item;
      else next.unshift(item);

      saveFavorites(next);
      setShowComposer(false);
      setStatus(`Сохранено: ${shortUrl}`);
      notify("success", "Подписка сохранена");
    } catch (e) {
      const message = (e as Error)?.message || "Не удалось сохранить подписку";
      setStatus(message);
      notify("error", message);
    }
  };

  const applyImport = async () => {
    const parsed = parseUrlToPayload(importUrl.trim());
    if (!parsed.ok) return setStatus(parsed.error || "Ошибка импорта");
    let nextPayload = defaultPayload();
    if (parsed.shortId) {
      const p = await fetchShortLink(parsed.shortId);
      nextPayload = { ...defaultPayload(), ...p };
    } else if (parsed.payload) {
      nextPayload = { ...defaultPayload(), ...parsed.payload };
    }
    setPayload(nextPayload);
    setShortIdDraft(parsed.shortId || "");
    setHiddenDraft(false);
    openModal("composer");
    await hydrateComposerSource(nextPayload);
    notify("info", "Ссылка импортирована");
  };

  const onEdit = async (idx: number) => {
    const item = favorites[idx];
    if (!item) return;
    if (item.permissions?.canEdit === false) {
      notify("warning", "Эту подписку можно только просматривать");
      return;
    }
    // У объединения свой конструктор: в обычном настраивать нечего — там
    // устройство и приложение, а у объединения это своё в каждом источнике.
    if (mergeIdFromPayload(item.payload)) {
      await openMergeEditor(idx);
      return;
    }
    setEditingIndex(idx);
    setName(item.title);
    setShortIdDraft(item.shortId || "");
    setHiddenDraft(Boolean(item.hidden));
    setTagsDraft((item.tags || []).join(", "));
    const nextPayload = { ...defaultPayload(), ...item.payload };
    setOriginalHappUrl("");
    setHappDecryptDismissedUrl("");
    setHappDecryptStatus("");
    setShowHappDecryptPrompt(false);
    setPayload(nextPayload);
    openModal("composer");
    await hydrateComposerSource(nextPayload);
  };

  const onDelete = (idx: number) => {
    if (favorites[idx]?.permissions?.canEdit === false) {
      notify("warning", "Эту подписку нельзя удалять");
      return;
    }
    const next = favorites.filter((_, i) => i !== idx);
    saveFavorites(next);
    notify("info", "Подписка удалена");
  };

  /** Короткая ссылка объединения: `merge:<id>` в параметрах подписки. */
  const mergeIdFromPayload = (value: SubscriptionPayload | undefined): string => {
    const subUrl = String(value?.sub_url || "").trim();
    return subUrl.startsWith("merge:") ? subUrl.slice(6).trim() : "";
  };

  const resetMergeDrafts = () => {
    setMergePreview({});
    setMergePreviewLoading(false);
    setMergeSaving(false);
  };

  // Кандидаты на объединение — все подписки, кроме самих объединений: вложенные
  // объединения превратили бы обновление подписки в дерево запросов.
  const mergeCandidates = () => favorites.filter((item) => !mergeIdFromPayload(item.payload));

  const openMergeModal = () => {
    setMergeId("");
    setMergeEditingIndex(-1);
    setMergeName("Объединенная подписка");
    setMergeOutput("yml");
    setMergeOutputAuto(true);
    setMergeItems(buildFavoriteDrafts(mergeCandidates()));
    resetMergeDrafts();
    openModal("merge");
  };

  /**
   * Правка существующего объединения.
   *
   * Состав читаем с сервера, а не из избранного: там лежит только ссылка
   * `merge:<id>`, а какие подписки внутри и с какими регулярками — знает
   * сохранённый источник.
   */
  const openMergeEditor = async (index: number) => {
    const favorite = favorites[index];
    const id = mergeIdFromPayload(favorite?.payload);
    if (!favorite || !id) return;
    resetMergeDrafts();
    setMergeEditingIndex(index);
    setMergeId(id);
    setMergeName(favorite.title);
    setMergeOutput((favorite.payload.output || "yml") as SubscriptionPayload["output"]);
    setMergeOutputAuto(Boolean(favorite.payload.output_auto));
    const drafts = buildFavoriteDrafts(mergeCandidates());
    setMergeItems(drafts);
    openModal("merge");
    try {
      const source = await fetchMergedSource(id);
      setMergeName(source.name || favorite.title);
      setMergeItems(drafts.map((draft) => {
        const saved = source.items.find((item) => (
          (item.shortId && draft.shortId && item.shortId === draft.shortId)
          || String(item.sub_url || "") === String(draft.payload.sub_url || "")
        ));
        if (!saved) return draft;
        return {
          ...draft,
          selected: true,
          pattern: String(saved.filter?.pattern || ""),
          onEmpty: saved.filter?.onEmpty || "all",
        };
      }));
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось прочитать состав объединения");
    }
  };

  /** Элементы объединения в том виде, в котором их ждёт сервер. */
  const buildMergeItems = async (): Promise<MergeItem[]> => {
    const out: MergeItem[] = [];
    for (const draft of mergeItems) {
      if (!draft.selected) continue;
      let sourcePayload = draft.payload;
      if ((!sourcePayload || !sourcePayload.sub_url) && draft.shortId) {
        sourcePayload = await fetchShortLink(draft.shortId);
      }
      out.push({
        ...defaultPayload(),
        ...sourcePayload,
        title: draft.title,
        shortId: draft.shortId,
        filter: { pattern: draft.pattern.trim(), onEmpty: draft.onEmpty },
      });
    }
    return out;
  };

  const runMergePreview = async () => {
    const selected = mergeItems.filter((item) => item.selected);
    if (selected.length === 0) return;
    setMergePreviewLoading(true);
    try {
      const items = await buildMergeItems();
      const results = await previewMergeItems(items);
      const next: Record<string, MergePreviewResult> = {};
      selected.forEach((draft, index) => {
        const row = results[index];
        if (row) next[draft.key] = row;
      });
      setMergePreview(next);
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось получить серверы источников");
    } finally {
      setMergePreviewLoading(false);
    }
  };

  const handleSaveMerge = async () => {
    const title = mergeName.trim();
    if (!title) {
      notify("warning", "Укажите название объединенной подписки");
      return;
    }
    if (mergeItems.every((item) => !item.selected)) {
      notify("warning", "Выберите хотя бы одну подписку");
      return;
    }
    setMergeSaving(true);
    try {
      const items = await buildMergeItems();
      if (mergeId) {
        await updateMergedSource(mergeId, { name: title, items });
        const mergedPayload: SubscriptionPayload = {
          ...defaultPayload(),
          sub_url: `merge:${mergeId}`,
          output: mergeOutput,
          output_auto: mergeOutputAuto ? "1" : "",
        };
        const existing = favorites[mergeEditingIndex];
        if (existing?.shortId) {
          await updateShortLink(existing.shortId, mergedPayload, title, { hidden: existing.hidden, tags: existing.tags });
        }
        saveFavorites(favorites.map((item, index) => (index === mergeEditingIndex
          ? {
            ...item,
            title,
            payload: mergedPayload,
            labels: [...labelsFromPayload(mergedPayload), `merge:${items.length}`],
            ts: Date.now(),
          }
          : item)));
        setShowMerge(false);
        notify("success", "Объединение обновлено");
        return;
      }

      const merged = await createMergedSource({ name: title, items });
      const mergedPayload: SubscriptionPayload = {
        ...defaultPayload(),
        sub_url: merged.subUrl,
        output: mergeOutput,
        output_auto: mergeOutputAuto ? "1" : "",
      };
      const created = await createShortLink(mergedPayload, title);
      const next: FavoriteItem = {
        title,
        url: created.shortUrl,
        shortId: created.id,
        payload: mergedPayload,
        labels: [...labelsFromPayload(mergedPayload), `merge:${items.length}`],
        ts: Date.now(),
      };
      saveFavorites([next, ...favorites]);
      setShowMerge(false);
      setStatus(`Сохранено: ${created.shortUrl}`);
      notify("success", "Объединенная подписка создана");
    } catch (e) {
      const message = (e as Error)?.message || "Не удалось сохранить объединение";
      setStatus(message);
      notify("error", message);
    } finally {
      setMergeSaving(false);
    }
  };

  const runTester = async (data = payload) => {
    try {
      const result = await runSubTest(data);
      setTestResult(result);
      notify("success", "Тест завершен");
    } catch (e) {
      const message = (e as Error)?.message || "Ошибка теста";
      notify("error", message);
      throw e;
    }
  };

  const applySavedToTester = async (runNow = false, idxRaw = "0") => {
    const idx = Number(idxRaw || "-1");
    if (!Number.isInteger(idx) || idx < 0 || idx >= favorites.length) return;
    const item = favorites[idx];
    let p = item.payload;
    if ((!p || !p.sub_url) && item.shortId) p = await fetchShortLink(item.shortId);
    setPayload({ ...defaultPayload(), ...p });
    openModal("tester");
    if (runNow) await runTester({ ...defaultPayload(), ...p });
  };

  const sourceServers = useMemo(() => testResult?.upstream?.servers || [], [testResult]);
  const convertedServers = useMemo(() => testResult?.conversion?.servers || [], [testResult]);
  const osOptions = useMemo(() => Object.keys(uaCatalog.options || {}), [uaCatalog]);
  const composerFileServersCount = useMemo(() => countSourceServers(composerFileBody), [composerFileBody]);
  const composerTextServersCount = useMemo(() => countSourceServers(composerTextBody), [composerTextBody]);
  const bulkImportFlags = useMemo(
    () => Array.from(new Set(bulkImportItems.map((item) => item.flag))).sort((a, b) => a.localeCompare(b)),
    [bulkImportItems],
  );
  const bulkImportFilteredItems = useMemo(() => {
    let next = [...bulkImportItems];
    if (bulkImportCountry) next = next.filter((item) => item.flag === bulkImportCountry);
    if (bulkImportMask.trim()) {
      const mask = bulkImportMask.trim().toLowerCase();
      next = next.filter((item) => item.normalizedName.toLowerCase().includes(mask) || item.name.toLowerCase().includes(mask));
    }
    if (bulkImportRegex.trim()) {
      try {
        const re = new RegExp(bulkImportRegex, "i");
        next = next.filter((item) => re.test(item.normalizedName) || re.test(item.name));
      } catch {
        return [];
      }
    }
    return next;
  }, [bulkImportCountry, bulkImportItems, bulkImportMask, bulkImportRegex]);
  const appOptions = useMemo(() => {
    if (appsCatalog.length > 0) return appsCatalog;
    if (!selectedOs || !uaCatalog.options[selectedOs]) return [];
    return Object.keys(uaCatalog.options[selectedOs] || {});
  }, [appsCatalog, uaCatalog, selectedOs]);
  const shareAccessUsers = useMemo(
    () => adminUsers.filter((user) => user.role !== "admin").sort((a, b) => a.username.localeCompare(b.username)),
    [adminUsers],
  );
  const selectedProfileMeta = useMemo<ProfileCatalogItem | null>(
    () => profileCatalog.items?.find((item) => item.name === profileName) || null,
    [profileCatalog.items, profileName],
  );
  const uaPreview = useMemo(() => {
    const os = selectedOs || String(payload.device || "");
    const app = String(payload.app || "");
    if (!os || !app) return uaCatalog.defaultUa || "";
    return uaCatalog.options?.[os]?.[app] || uaCatalog.defaultUa || "";
  }, [selectedOs, payload.device, payload.app, uaCatalog]);
  const appTestUrl = String(appTestSource?.id || "").trim() ? `${effectiveOrigin}/mock/${appTestSource?.id}` : "";
  const appTestLatestLog = appTestLogs[0] || null;
  const appTestHeaders = useMemo<Record<string, string>>(
    () => appTestLatestLog?.headers || {},
    [appTestLatestLog],
  );
  const appTestSummary = useMemo(() => ({
    userAgent: getHeaderValue(appTestHeaders, ["user-agent"]),
    hwid: getHeaderValue(appTestHeaders, ["x-hwid"]),
    deviceModel: getHeaderValue(appTestHeaders, ["x-device-model"]),
    deviceOs: getHeaderValue(appTestHeaders, ["x-device-os"]),
    app: getHeaderValue(appTestHeaders, ["x-app", "x-client-app"]),
    acceptLanguage: getHeaderValue(appTestHeaders, ["accept-language"]),
    contentType: getHeaderValue(appTestHeaders, ["content-type"]),
  }), [appTestHeaders]);

  useEffect(() => {
    if (osOptions.length === 0) return;
    const hasPayloadOs = !!payload.device && !!uaCatalog.options[payload.device];
    const nextOs = hasPayloadOs ? String(payload.device) : (selectedOs && uaCatalog.options[selectedOs] ? selectedOs : osOptions[0]);
    if (nextOs !== selectedOs) setSelectedOs(nextOs);

    const nextApps = appsCatalog.length > 0 ? appsCatalog : Object.keys(uaCatalog.options[nextOs] || {});
    setPayload((prev) => {
      const nextDevice = nextOs;
      const nextApp = nextApps.includes(String(prev.app || "")) ? String(prev.app || "") : (nextApps[0] || String(prev.app || ""));
      if (prev.device === nextDevice && String(prev.app || "") === nextApp) return prev;
      return { ...prev, device: nextDevice, app: nextApp };
    });
  }, [appsCatalog, osOptions, selectedOs, payload.device, uaCatalog]);

  const refreshMockLogs = async () => {
    if (!mockId) return;
    const logs = await getMockLogs(mockId);
    setMockLogs(JSON.stringify(logs, null, 2));
  };

  const createMock = async () => {
    const source = await createMockSource({
      preset: mockPreset,
      status: Number(mockStatus || "200"),
      contentType: mockContentType,
      delayMs: Number(mockDelayMs || "0"),
      body: mockBody,
      headers: JSON.parse(mockHeaders || "{}"),
    });
    setMockId(source.id);
    const url = `${effectiveOrigin}/mock/${source.id}`;
    setMockUrl(url);
    setPayload((prev) => ({ ...prev, sub_url: url }));
    await refreshMockLogs();
    notify("success", "Mock-сервер создан");
  };

  const loadMock = async () => {
    const id = mockUrl.replace(/^.*\/mock\//, "").trim();
    if (!id) return;
    const source = await getMockSource(id);
    setMockId(source.id);
    setMockPreset(source.config.preset || "stub_raw");
    setMockStatus(String(source.config.status || 200));
    setMockContentType(String(source.config.contentType || "text/plain; charset=utf-8"));
    setMockDelayMs(String(source.config.delayMs || 0));
    setMockBody(String(source.config.body || ""));
    setMockHeaders(JSON.stringify(source.config.headers || {}, null, 2));
    await refreshMockLogs();
    notify("info", "Mock-конфигурация загружена");
  };

  const updateMock = async () => {
    if (!mockId) return;
    await updateMockSource(mockId, {
      preset: mockPreset,
      status: Number(mockStatus || "200"),
      contentType: mockContentType,
      delayMs: Number(mockDelayMs || "0"),
      body: mockBody,
      headers: JSON.parse(mockHeaders || "{}"),
    });
    notify("success", "Mock-конфигурация обновлена");
  };

  const clearLogs = async () => {
    if (!mockId) return;
    await clearMockLogs(mockId);
    setMockLogs("[]");
    notify("info", "Логи очищены");
  };

  const mockResolvedUrl = String(mockUrl || "").trim() || (mockId ? `${effectiveOrigin}/mock/${mockId}` : "");

  const runMockSubscriptionTest = async () => {
    if (!mockResolvedUrl) {
      notify("warning", "Сначала создайте или загрузите mock-сервер");
      return;
    }
    let basePayload: SubscriptionPayload = { ...payload };
    if (mockTestTarget !== "__current__") {
      const idx = Number(mockTestTarget || "-1");
      if (!Number.isInteger(idx) || idx < 0 || idx >= favorites.length) {
        notify("warning", "Выберите корректную подписку");
        return;
      }
      const item = favorites[idx];
      let p = item?.payload;
      if ((!p || !p.sub_url) && item?.shortId) {
        p = await fetchShortLink(item.shortId);
      }
      basePayload = { ...defaultPayload(), ...(p || {}) };
    }
    const testPayload: SubscriptionPayload = {
      ...defaultPayload(),
      ...basePayload,
      sub_url: mockResolvedUrl,
    };
    setPayload(testPayload);
    await runTester(testPayload);
  };

  const loadProfileFile = async () => {
    if (!profileName) return;
    const content = await readProfile(profileName);
    setProfileContent(content);
    setProfileForm(parseProfileForm(content));
    notify("info", "Профиль загружен");
  };

  const saveProfileFile = async () => {
    if (!profileName.trim()) return;
    const built = buildProfileFormYaml(profileForm);
    setProfileContent(built);
    await saveProfile(profileName.trim(), built);
    const catalog = await fetchProfileCatalog();
    setProfileCatalog(catalog);
    notify("success", "Профиль сохранен");
  };

  const removeProfileFile = async () => {
    if (!profileName.trim()) return;
    await deleteProfile(profileName.trim());
    setProfileContent("");
    setProfileForm({ allowHwidOverride: true, headers: [] });
    const catalog = await fetchProfileCatalog();
    setProfileCatalog(catalog);
    notify("warning", "Профиль удален");
  };

  const openShare = (item: FavoriteItem) => {
    setShareItem(item);
    openModal("share");
  };

  /**
   * Пинг серверов подписки.
   *
   * Меряем с панели: свой туннель она поднять не может, поэтому это оценка
   * доступности точки входа, а не скорости внутри соединения.
   */
  const runPing = async (item: FavoriteItem, mode: PingMode, attempts: number) => {
    setPingLoading(true);
    setPingError("");
    try {
      let params = item.payload;
      if ((!params || !params.sub_url) && item.shortId) {
        params = await fetchShortLink(item.shortId);
      }
      const data = await pingSubscription({ ...defaultPayload(), ...params }, { mode, attempts });
      setPingData(data);
    } catch (e) {
      setPingData(null);
      setPingError((e as Error)?.message || "Не удалось опросить серверы");
    } finally {
      setPingLoading(false);
    }
  };

  const openPing = (item: FavoriteItem) => {
    setPingItem(item);
    setPingData(null);
    setPingError("");
    openModal("ping");
    void runPing(item, pingMode, pingAttempts);
  };

  const openAccess = (item: FavoriteItem) => {
    setShareItem(item);
    openModal("access");
  };

  const saveShareAccess = async () => {
    if (!shareItem?.shortId) return;
    try {
      const grants: ShortLinkAccessGrant[] = Object.entries(shareAccessDraft)
        .filter(([, accessLevel]) => accessLevel === "view" || accessLevel === "edit")
        .map(([username, accessLevel]) => ({
          username,
          role: adminUsers.find((user) => user.username === username)?.role === "admin" ? "admin" : "user",
          accessLevel: accessLevel === "edit" ? "edit" : "view",
        }));
      await updateShortLinkAccess(shareItem.shortId, grants);
      notify("success", "Права доступа сохранены");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось сохранить доступ");
    }
  };

  const openSubUsers = async (item: FavoriteItem) => {
    if (!item.shortId) {
      notify("warning", "Для этой подписки нет short id");
      return;
    }
    setSubUsersItem(item);
    setSubUsersData(null);
    setSubUsersLoading(true);
    setSubUsersExpandedHwid("");
    openModal("subUsers");
    try {
      const data = await fetchShortLinkUsers(item.shortId);
      setSubUsersData(data);
      setSubUsersMax(String(data.policy.maxUsers || 0));
      setSubUsersBlockedMessage(String(data.policy.blockedMessage || ""));
      setSubUsersLimitMessage(String(data.policy.limitMessage || ""));
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось загрузить пользователей подписки");
    } finally {
      setSubUsersLoading(false);
    }
  };

  const openOverrides = async (item: FavoriteItem) => {
    if (!item.shortId) {
      notify("warning", "Для этой подписки нет short id");
      return;
    }
    if (item.permissions?.canEdit === false) {
      notify("warning", "Недостаточно прав для редактирования overrides");
      return;
    }
    setOverridesItem(item);
    openModal("overrides");
  };

  const refreshSubUsers = async () => {
    if (!subUsersItem?.shortId) return;
    const data = await fetchShortLinkUsers(subUsersItem.shortId);
    setSubUsersData(data);
    setSubUsersMax(String(data.policy.maxUsers || 0));
    setSubUsersBlockedMessage(String(data.policy.blockedMessage || ""));
    setSubUsersLimitMessage(String(data.policy.limitMessage || ""));
  };

  const saveSubUsersPolicy = async () => {
    if (!subUsersItem?.shortId) return;
    if (subUsersItem.permissions?.canEdit === false) {
      notify("warning", "Недостаточно прав для изменения политики");
      return;
    }
    try {
      await updateShortLinkUsersPolicy(subUsersItem.shortId, {
        maxUsers: Number(subUsersMax || "0"),
        blockedMessage: subUsersBlockedMessage,
        limitMessage: subUsersLimitMessage,
      });
      await refreshSubUsers();
      notify("success", "Настройки ограничений сохранены");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось сохранить настройки");
    }
  };

  const toggleSubUserBlocked = async (hwid: string, blocked: boolean, currentReason = "") => {
    if (!subUsersItem?.shortId) return;
    if (subUsersItem.permissions?.canEdit === false) {
      notify("warning", "Недостаточно прав для изменения пользователей");
      return;
    }
    const reason = blocked
      ? (window.prompt("Текст заглушки для блокировки этого пользователя", currentReason || subUsersBlockedMessage || "") || currentReason || "")
      : "";
    try {
      await updateShortLinkUserState(subUsersItem.shortId, hwid, {
        blocked,
        blockReason: reason,
      });
      await refreshSubUsers();
      notify("success", blocked ? "Пользователь заблокирован" : "Пользователь разблокирован");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось обновить состояние пользователя");
    }
  };

  const removeSubUser = async (hwid: string) => {
    if (!subUsersItem?.shortId) return;
    if (subUsersItem.permissions?.canEdit === false) {
      notify("warning", "Недостаточно прав для удаления пользователя");
      return;
    }
    const ok = window.confirm(`Удалить пользователя ${hwid} из списка?`);
    if (!ok) return;
    try {
      await deleteShortLinkUserEntry(subUsersItem.shortId, hwid);
      await refreshSubUsers();
      notify("warning", "Пользователь удален");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось удалить пользователя");
    }
  };

  const buildAppShareLink = (app: string, link: string) => {
    const template = appShareLinks[String(app || "").toLowerCase()];
    if (!template) return "";
    return template
      .split("{encoded_url}")
      .join(encodeURIComponent(link))
      .split("{url}")
      .join(link);
  };

  useEffect(() => {
    if (!showAppTest) return;
    if (appTestSelectedApp && shareApps.some((item) => item.key === appTestSelectedApp)) return;
    const preferred = String(payload.app || "").trim().toLowerCase();
    const next = shareApps.find((item) => item.key === preferred) || shareApps[0] || null;
    if (next?.key) setAppTestSelectedApp(next.key);
  }, [showAppTest, appTestSelectedApp, shareApps, payload.app]);

  useEffect(() => {
    if (!showAppTest || !appTestSource?.id) return;
    let stopped = false;
    const poll = async () => {
      try {
        const logs = await getMockLogs(appTestSource.id);
        if (stopped) return;
        setAppTestLogs(logs);
        if (logs.length > 0) {
          setAppTestStep(3);
          setAppTestStatus("Запрос получен. Можно изучить заголовки и сохранить профиль.");
          setAppTestProfileName((prev) => prev || buildCapturedProfileName(authUser?.username || "", appTestSummary.app || appTestSelectedApp || payload.app || ""));
        }
      } catch (e) {
        if (stopped) return;
        setAppTestStatus((e as Error)?.message || "Не удалось обновить лог теста приложения");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [showAppTest, appTestSource?.id, authUser?.username, appTestSelectedApp, payload.app, appTestSummary.app]);

  const openAppTestModal = () => {
    setAppTestStep(1);
    setAppTestSource(null);
    setAppTestLogs([]);
    setAppTestLoading(false);
    setAppTestStatus("");
    setAppTestProfileName("");
    openModal("appTest");
  };

  const createAppTestSession = async () => {
    try {
      setAppTestLoading(true);
      setAppTestStatus("");
      const source = await createMockSource({
        preset: payload.output === "yml" ? "stub_clash" : "stub_raw",
        status: 200,
        contentType: payload.output === "yml" ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8",
        mode: "app_test",
        label: `app-test:${authUser?.username || "user"}`,
      });
      setAppTestSource(source);
      setAppTestLogs([]);
      setAppTestStep(2);
      setAppTestStatus("Временный URL готов. Вставьте его в приложение или откройте через deeplink-кнопку ниже.");
    } catch (e) {
      setAppTestStatus((e as Error)?.message || "Не удалось создать тестовый URL");
      notify("error", (e as Error)?.message || "Не удалось создать тестовый URL");
    } finally {
      setAppTestLoading(false);
    }
  };

  const resetAppTestCapture = async () => {
    if (!appTestSource?.id) return;
    try {
      await clearMockLogs(appTestSource.id);
      setAppTestLogs([]);
      setAppTestStep(2);
      setAppTestStatus("Логи очищены. Можно повторить тест другим приложением.");
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось очистить логи теста");
    }
  };

  const saveCapturedProfile = async () => {
    if (!appTestLatestLog) {
      notify("warning", "Сначала дождитесь запроса от приложения");
      return;
    }
    const token = sanitizeProfileNameToken(appTestProfileName);
    if (!token) {
      notify("warning", "Укажите имя профиля");
      return;
    }
    try {
      setAppTestSavingProfile(true);
      const form = buildProfileFormFromHeaders(appTestHeaders);
      const content = buildProfileFormYaml(form);
      await saveProfile(token, content);
      const catalog = await fetchProfileCatalog();
      setProfileCatalog(catalog);
      setProfileName(token);
      setProfileContent(content);
      setProfileForm(form);
      setAppTestStatus(`Профиль ${token} сохранен`);
      notify("success", `Профиль ${token} сохранен`);
    } catch (e) {
      notify("error", (e as Error)?.message || "Не удалось сохранить профиль");
      setAppTestStatus((e as Error)?.message || "Не удалось сохранить профиль");
    } finally {
      setAppTestSavingProfile(false);
    }
  };

  const tryLogin = async () => {
    try {
      setAuthError("");
      await login(authUsername, authPassword);
      const auth = await fetchAuthState();
      setAuthEnabled(auth.enabled);
      setAuthenticated(auth.authenticated || !auth.enabled);
      setAuthUser(auth.user || null);
      setPublicBaseUrl(normalizePublicBaseUrl(auth.publicBaseUrl));
      if (auth.user?.role === "admin" && window.location.pathname === "/") {
        history.replaceState(null, "", "/admin");
      }
      if (auth.user?.role !== "admin" && window.location.pathname === "/admin") {
        history.replaceState(null, "", "/");
      }
      setAuthUsername("");
      setAuthPassword("");
      notify("success", "Вы вошли в аккаунт");
    } catch (e) {
      setAuthError((e as Error)?.message || "Ошибка входа");
      notify("error", (e as Error)?.message || "Ошибка входа");
    }
  };

  const tryLogout = async () => {
    try {
      await logout();
      notify("info", "Вы вышли из аккаунта");
    } finally {
      setAuthenticated(false);
      setAuthUser(null);
    }
  };

  const createAdminUser = async () => {
    try {
      setStatus("");
      await adminCreateUser({
        username: adminNewUsername.trim().toLowerCase(),
        password: adminNewPassword,
        role: adminNewRole,
      });
      setAdminNewUsername("");
      setAdminNewPassword("");
      await refreshAdminUsers();
      notify("success", "Пользователь создан");
    } catch (e) {
      setStatus((e as Error)?.message || "Не удалось создать пользователя");
      notify("error", (e as Error)?.message || "Не удалось создать пользователя");
    }
  };

  const updateAdminUser = async (username: string, role: "user" | "admin") => {
    try {
      setStatus("");
      await adminUpdateUser(username, {
        role,
        password: adminEditPassword.trim() ? adminEditPassword : undefined,
      });
      setAdminEditPassword("");
      await refreshAdminUsers();
      notify("success", "Пользователь обновлен");
    } catch (e) {
      setStatus((e as Error)?.message || "Не удалось обновить пользователя");
      notify("error", (e as Error)?.message || "Не удалось обновить пользователя");
    }
  };

  const removeAdminUser = async (username: string) => {
    try {
      setStatus("");
      await adminDeleteUser(username);
      await refreshAdminUsers();
      notify("warning", "Пользователь удален");
    } catch (e) {
      setStatus((e as Error)?.message || "Не удалось удалить пользователя");
      notify("error", (e as Error)?.message || "Не удалось удалить пользователя");
    }
  };

  const resetAdminUserPassword = async (username: string, role: "user" | "admin") => {
    const nextPassword = adminEditPassword.trim();
    if (!nextPassword) {
      setStatus("Введите новый пароль в блоке «Пароль для операций»");
      notify("warning", "Укажите пароль для сброса");
      return;
    }
    try {
      setStatus("");
      await adminUpdateUser(username, {
        role,
        password: nextPassword,
      });
      setAdminEditPassword("");
      await refreshAdminUsers();
      notify("success", "Пароль обновлен");
    } catch (e) {
      setStatus((e as Error)?.message || "Не удалось обновить пароль");
      notify("error", (e as Error)?.message || "Не удалось обновить пароль");
    }
  };

  const goAdmin = () => {
    history.replaceState(null, "", "/admin");
    window.location.reload();
  };

  const goMain = () => {
    history.replaceState(null, "", "/");
    window.location.reload();
  };

  const goStats = () => {
    history.replaceState(null, "", "/stats");
    window.location.reload();
  };

  // Поиск по списку не меняет сам список: индекс исходного массива едет вместе
  // с записью, поэтому редактирование и удаление работают как раньше.
  const visibleFavorites = useMemo(() => {
    const all = favorites.map((item, index) => ({ item, index }));
    const entries = all.filter(({ item }) => {
      if (listOwnerFilter === "all") return true;
      if (listOwnerFilter === "foreign") return Boolean(item.foreign);
      if (listOwnerFilter === "shared") return Boolean(item.derived) && !item.foreign;
      if (listOwnerFilter === "mine") return !item.derived;
      return !item.foreign;
    });
    const query = listQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(({ item }) => [
      item.title,
      item.url,
      item.payload.sub_url,
      item.payload.app,
      item.payload.device,
      ...(item.tags || []),
      ...(item.labels || []),
      item.ownerUsername || "",
    ].join(" ").toLowerCase().includes(query));
  }, [favorites, listQuery, listOwnerFilter]);

  const foreignFavoritesCount = useMemo(
    () => favorites.filter((item) => item.foreign).length,
    [favorites],
  );

  const formatDateTime = (value: string) => {
    const ts = Date.parse(String(value || ""));
    if (!Number.isFinite(ts)) return "—";
    return new Date(ts).toLocaleString();
  };

  const shellNav: ShellNavItem[] = [
    {
      key: "subs",
      label: "Подписки",
      icon: <ListIcon className="btn-icon" />,
      active: isMainPath,
      onClick: () => { if (!isMainPath) goMain(); },
    },
    {
      key: "stats",
      label: "Статистика",
      icon: <ChartIcon className="btn-icon" />,
      active: isStatsPath,
      onClick: () => { if (!isStatsPath) goStats(); },
    },
    ...(isAdminUser
      ? [{
        key: "admin",
        label: "Админка",
        icon: <ShieldIcon className="btn-icon" />,
        active: isAdminPath,
        onClick: () => { if (!isAdminPath) goAdmin(); },
      } as ShellNavItem]
      : []),
  ];

  // Быстрые действия главной страницы живут в боковой колонке.
  const mainQuickActions = (
    <>
      <TipButton tip="Добавить новую подписку" tone="primary" onClick={() => { resetComposer(); openModal("composer"); }}>
        <PlusIcon className="btn-icon" /> Добавить
      </TipButton>
      <TipButton tip="Импортировать подписку по ссылке" onClick={() => openModal("import")}>
        <ImportIcon className="btn-icon" /> Импорт
      </TipButton>
      <TipButton tip="Скачать резервную копию всех доступных подписок" onClick={downloadFavoritesBackup}>
        <SaveIcon className="btn-icon" /> Резервная копия
      </TipButton>
      <TipButton tip="Восстановить подписки из резервной копии" onClick={() => backupRestoreInputRef.current?.click()}>
        <ImportIcon className="btn-icon" /> Восстановить
      </TipButton>
      <input ref={backupRestoreInputRef} type="file" accept="application/json,.json" hidden onChange={(e) => void handleRestoreFavoritesBackup(e)} />
      {showAdvanced ? (
        <>
          <TipButton tip="Импортировать массовый файл прокси" onClick={openBulkImportModal}>
            <ImportIcon className="btn-icon" /> Массовый импорт
          </TipButton>
          <TipButton tip="Объединить несколько подписок в одну" onClick={openMergeModal}>
            <CopyIcon className="btn-icon" /> Объединить
          </TipButton>
          <TipButton tip="Пошагово проверить, какие заголовки реально отправляет приложение" onClick={openAppTestModal}>
            <FlaskIcon className="btn-icon" /> Тест приложения
          </TipButton>
          <TipButton tip="Переписать все сохраненные ссылки на текущий домен" onClick={() => void rewriteFavoritesToCurrentOrigin()}>
            <CopyIcon className="btn-icon" /> Обновить ссылки
          </TipButton>
        </>
      ) : null}
    </>
  );

  // Выдача доступов: один и тот же редактор в окне «Поделиться» и в отдельном
  // окне «Доступы» — второе нужно, чтобы права не приходилось искать в конце
  // длинной страницы подключения.
  const accessEditor = (
    <>
      <div className="admin-section-head">
        <h2>Кому выдан доступ</h2>
        <p>Выберите уровень для каждого пользователя: просмотр или редактирование подписки.</p>
      </div>
      {shareAccessLoading ? <div className="status">Загрузка доступа...</div> : null}
      {!shareAccessLoading ? (
        <>
          <div className="status">Владелец: {shareAccessOwner || "не задан"}</div>
          <div className="share-access-list">
            {shareAccessUsers.length === 0 ? <div className="status">Нет обычных пользователей для выдачи доступа.</div> : null}
            {shareAccessUsers.map((user) => (
              <label key={user.username} className="share-access-row">
                <span>{user.username}</span>
                <select
                  value={shareAccessDraft[user.username] || ""}
                  disabled={user.username === shareAccessOwner}
                  onChange={(e) => setShareAccessDraft((prev) => ({
                    ...prev,
                    [user.username]: (e.target.value === "edit" ? "edit" : (e.target.value === "view" ? "view" : "")),
                  }))}
                >
                  <option value="">нет доступа</option>
                  <option value="view">view</option>
                  <option value="edit">edit</option>
                </select>
              </label>
            ))}
          </div>
          <div className="toolbar">
            <TipButton tip="Сохранить права доступа к подписке" tone="primary" onClick={() => void saveShareAccess()}>
              Сохранить доступ
            </TipButton>
          </div>
        </>
      ) : null}
    </>
  );

  const topRightControls = (
    <div className="top-right-controls">
      <Tooltip content={theme === "claude" ? "Включить тёмную тему" : "Включить светлую тему"}>
        <IconButton className="theme-toggle" aria-label="Сменить тему" onClick={() => setTheme((prev) => (prev === "claude" ? "claude-dark" : "claude"))}>
          <ThemeIcon className="btn-icon" />
        </IconButton>
      </Tooltip>
      {authEnabled && authenticated ? (
        <UserMenu
          user={authUser}
          onLogout={() => { void tryLogout(); }}
          onAdmin={authUser?.role === "admin" ? goAdmin : undefined}
          onHome={isMainPath ? undefined : goMain}
        />
      ) : null}
    </div>
  );

  const profileEditorContent = (
    <div className="editor-layout">
      <section className="editor-pane">
        <div className="form-section-head">
          <div className="form-section-title">Профили</div>
          <div className="form-section-lead">Заголовки, которые уходят в источник подписки.</div>
        </div>
        <div className="row">
          <select value={profileName} onChange={(e) => setProfileName(e.target.value)}>
            <option value="">Выберите профиль</option>
            {profileCatalog.profiles.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <TextInput placeholder="или имя нового профиля" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
        </div>
        {selectedProfileMeta ? (
          <div className="composer-meta-hint">
            Владелец: {selectedProfileMeta.ownerUsername || "shared"} · Тип: {selectedProfileMeta.visibility}
          </div>
        ) : null}
        <div className="profile-form-card">
          <div className="field">
            <span className="field-label">Переопределение HWID</span>
            <Segmented
              ariaLabel="Переопределение HWID"
              value={profileForm.allowHwidOverride ? "allow" : "deny"}
              onChange={(value) => setProfileForm((prev) => ({ ...prev, allowHwidOverride: value === "allow" }))}
              options={[
                { value: "allow", label: "Разрешено", tip: "Разрешить override hwid из запроса" },
                { value: "deny", label: "Запрещено", tip: "Запретить override hwid из заголовков запроса" },
              ]}
            />
          </div>

          <div className="field">
            <span className="field-label">Заголовки профиля</span>
            <div className="profile-headers-list">
              {profileForm.headers.length === 0 ? <div className="status">Заголовки не добавлены</div> : null}
              {profileForm.headers.map((row) => (
                <div key={row.id} className="profile-header-row">
                  <TextInput
                    placeholder="header-name"
                    value={row.key}
                    onChange={(e) => setProfileForm((prev) => ({
                      ...prev,
                      headers: prev.headers.map((item) => (item.id === row.id ? { ...item, key: e.target.value } : item)),
                    }))}
                  />
                  <TextInput
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => setProfileForm((prev) => ({
                      ...prev,
                      headers: prev.headers.map((item) => (item.id === row.id ? { ...item, value: e.target.value } : item)),
                    }))}
                  />
                  <TipIconButton
                    tip="Удалить заголовок"
                    aria-label="Удалить заголовок"
                    tone="danger"
                    icon={<TrashIcon className="btn-icon" />}
                    onClick={() => setProfileForm((prev) => ({ ...prev, headers: prev.headers.filter((item) => item.id !== row.id) }))}
                  />
                </div>
              ))}
            </div>
            <TipButton
              tip="Добавить заголовок"
              onClick={() => setProfileForm((prev) => ({
                ...prev,
                headers: [...prev.headers, { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, key: "", value: "" }],
              }))}
            >
              <PlusIcon className="btn-icon" /> Добавить заголовок
            </TipButton>
          </div>
        </div>
        <div className="toolbar">
          <TipButton tip="Загрузить выбранный профиль" onClick={() => void loadProfileFile()}>Загрузить</TipButton>
          <TipButton tip="Сохранить профиль" tone="primary" onClick={() => void saveProfileFile()}>
            <SaveIcon className="btn-icon" /> Сохранить
          </TipButton>
          <TipButton tip="Удалить профиль" tone="danger" onClick={() => void removeProfileFile()}>
            <TrashIcon className="btn-icon" /> Удалить
          </TipButton>
        </div>
      </section>

      <section className="editor-pane">
        <div className="form-section-head">
          <div className="form-section-title">UA-каталог</div>
          <div className="form-section-lead">User-Agent подставляется по паре «ОС + приложение».</div>
        </div>
        <div className="row">
          <select value={selectedOs} onChange={(e) => setSelectedOs(e.target.value)}>
            <option value="">Выберите ОС</option>
            {osOptions.map((osName) => <option key={osName} value={osName}>{osName}</option>)}
          </select>
          <select value={payload.app || ""} onChange={(e) => setPayload((p) => ({ ...p, app: e.target.value }))}>
            <option value="">Выберите приложение</option>
            {appOptions.map((appName) => <option key={appName} value={appName}>{appName}</option>)}
          </select>
        </div>
        <div className="field">
          <span className="field-label">Текущий User-Agent</span>
          <Textarea readOnly value={uaPreview || "UA не найден"} />
        </div>
        <div className="status">UA берётся из каталога и автоматически применяется при запросах.</div>
      </section>
    </div>
  );

  const mockModalContent = (
    <div className="mock-layout">
      <section className="mock-section">
        <div className="step-head">
            <span className="step-num">1</span>
            <div className="form-section-title">Подключение mock</div>
          </div>
        <label className="composer-label">URL mock-сервера</label>
        <div className="url-row">
          <TextInput placeholder="http://.../mock/<id>" value={mockUrl} onChange={(e) => setMockUrl(e.target.value)} />
          <TipButton tip="Загрузить конфигурацию mock по URL" onClick={() => void loadMock()}>Загрузить</TipButton>
        </div>
        <div className="status">Текущий URL: {mockResolvedUrl || "не задан"}</div>
      </section>

      <section className="mock-section">
        <div className="step-head">
            <span className="step-num">2</span>
            <div className="form-section-title">Конфигурация ответа</div>
          </div>
        <div className="row">
          <select value={mockPreset} onChange={(e) => setMockPreset(e.target.value)}>
            <option value="stub_raw">stub_raw</option>
            <option value="stub_clash">stub_clash</option>
            <option value="no_subscriptions">no_subscriptions</option>
            <option value="antibot_html">antibot_html</option>
          </select>
          <TextInput placeholder="status" value={mockStatus} onChange={(e) => setMockStatus(e.target.value)} />
        </div>
        <div className="row">
          <TextInput placeholder="content-type" value={mockContentType} onChange={(e) => setMockContentType(e.target.value)} />
          <TextInput placeholder="delay ms" value={mockDelayMs} onChange={(e) => setMockDelayMs(e.target.value)} />
        </div>
        <label className="composer-label">headers (JSON)</label>
        <Textarea placeholder='{"x-debug":"demo"}' value={mockHeaders} onChange={(e) => setMockHeaders(e.target.value)} />
        <label className="composer-label">body</label>
        <Textarea placeholder="Тело ответа mock-сервера" value={mockBody} onChange={(e) => setMockBody(e.target.value)} />
        <div className="toolbar">
          <TipButton tip="Создать новый mock-сервер" onClick={() => void createMock()}>Создать</TipButton>
          <TipButton tip="Обновить текущий mock-сервер" onClick={() => void updateMock()}>Обновить</TipButton>
          <TipButton tip="Показать логи запросов mock-сервера" onClick={() => void refreshMockLogs()}>Логи</TipButton>
          <TipButton tip="Очистить логи mock-сервера" onClick={() => void clearLogs()}>Очистить логи</TipButton>
          <TipButton tip="Подставить mock URL в sub_url" tone="primary" onClick={() => setPayload((p) => ({ ...p, sub_url: mockResolvedUrl }))}>Использовать в конструкторе</TipButton>
        </div>
      </section>

      <section className="mock-section">
        <div className="step-head">
            <span className="step-num">3</span>
            <div className="form-section-title">Тест подписки через mock</div>
          </div>
        <label className="composer-label">Выберите подписку для теста</label>
        <div className="row">
          <select value={mockTestTarget} onChange={(e) => setMockTestTarget(e.target.value)}>
            <option value="__current__">Текущая форма (конструктор)</option>
            {favorites.map((item, idx) => (
              <option key={`${item.shortId || item.title}-${idx}`} value={String(idx)}>
                {item.title} [{formatLabelFromPayload(item.payload)} | {item.payload.app || "-"} | {item.payload.device || "-"}]
              </option>
            ))}
          </select>
          <TipButton tip="Запустить тест выбранной подписки через mock-сервер" tone="primary" onClick={() => void runMockSubscriptionTest()}>
            Тест через mock
          </TipButton>
        </div>
        <div className="toolbar">
          <TipButton tip="Открыть полный тестер" onClick={() => setShowTester(true)}>Открыть тестер</TipButton>
          <TipIconButton tip="Копировать исходный ответ" aria-label="Копировать исходный ответ" icon={<CopyIcon className="btn-icon" />} onClick={() => void copyToClipboard(testResult?.upstream?.body || "")} />
          <TipIconButton tip="Копировать результат конвертации" aria-label="Копировать результат конвертации" icon={<CopyIcon className="btn-icon" />} onClick={() => void copyToClipboard(testResult?.conversion?.body || "")} />
        </div>
        <div className="result-grid">
          <div className="result">
            <strong>Источник: {testResult?.upstream?.sourceFormat || "-"}</strong>
            <select>{sourceServers.map((x, i) => <option key={`${x}-${i}`}>{x}</option>)}</select>
          </div>
          <div className="result">
            <strong>После конвертации: {testResult?.conversion?.outputFormat || "-"}</strong>
            <select>{convertedServers.map((x, i) => <option key={`${x}-${i}`}>{x}</option>)}</select>
          </div>
        </div>
      </section>

      <section className="mock-section">
        <div className="form-section-title">Логи mock-сервера</div>
        <pre className="json">{mockLogs || "Логов пока нет"}</pre>
      </section>
    </div>
  );

  const appTestModalContent = (
    <div className="app-test-layout">
      <section className={`app-test-step ${appTestStep === 1 ? "active" : ""}`}>
        <div className="step-head">
            <span className="step-num">1</span>
            <div className="form-section-title">Создайте временный URL</div>
          </div>
        <div className="status">
          Этот URL нужен только для диагностики. Приложение запросит его как обычную подписку, а мы покажем все ключевые заголовки и тело запроса.
        </div>
        <div className="toolbar">
          <TipButton tip="Создать временный диагностический URL" tone="primary" onClick={() => void createAppTestSession()} disabled={appTestLoading}>
            {appTestLoading ? "Создание..." : "Создать временный URL"}
          </TipButton>
        </div>
      </section>

      <section className={`app-test-step ${appTestStep === 2 ? "active" : ""}`}>
        <div className="step-head">
            <span className="step-num">2</span>
            <div className="form-section-title">Откройте URL в приложении</div>
          </div>
        <div className="composer-meta-hint">
          Можно просто скопировать URL вручную или сразу открыть подходящее приложение через deeplink-кнопку.
        </div>
        <TextInput value={appTestUrl} onChange={() => {}} readOnly placeholder="Сначала создайте временный URL" />
        <div className="toolbar">
          <TipButton tip="Скопировать тестовый URL" onClick={() => void copyToClipboard(appTestUrl)} disabled={!appTestUrl}>
            <CopyIcon className="btn-icon" /> Копировать URL
          </TipButton>
        </div>
        <div className="chip-row">
          {shareApps.map((item) => (
            <TipChipButton
              key={item.key}
              tip={`Открыть через ${item.label}`}
              className={`chip-btn ${appTestSelectedApp === item.key ? "active" : ""}`}
              onClick={() => setAppTestSelectedApp(item.key)}
            >
              {item.label}
            </TipChipButton>
          ))}
        </div>
        <div className="toolbar">
          <TipButton
            tip="Открыть deeplink выбранного приложения"
            onClick={() => {
              const deeplink = buildAppShareLink(appTestSelectedApp, appTestUrl);
              if (!deeplink) {
                notify("warning", "Для этого приложения нет deeplink-шаблона");
                return;
              }
              window.location.href = deeplink;
            }}
            disabled={!appTestUrl || !appTestSelectedApp}
          >
            Открыть в {appTestSelectedApp || "приложении"}
          </TipButton>
        </div>
        <div className="status">
          После первого запроса шаг автоматически переключится на результат. Ожидание можно держать открытым.
        </div>
      </section>

      <section className={`app-test-step ${appTestStep === 3 ? "active" : ""}`}>
        <div className="step-head">
            <span className="step-num">3</span>
            <div className="form-section-title">Что прислало приложение</div>
          </div>
        <div className="result-grid app-test-summary-grid">
          <div className="result"><strong>UA</strong><div>{appTestSummary.userAgent || "—"}</div></div>
          <div className="result"><strong>x-hwid</strong><div>{appTestSummary.hwid || "—"}</div></div>
          <div className="result"><strong>x-device-os</strong><div>{appTestSummary.deviceOs || "—"}</div></div>
          <div className="result"><strong>x-device-model</strong><div>{appTestSummary.deviceModel || "—"}</div></div>
          <div className="result"><strong>x-app</strong><div>{appTestSummary.app || "—"}</div></div>
          <div className="result"><strong>Метод</strong><div>{appTestLatestLog?.method || "—"}</div></div>
        </div>
        <div className="composer-meta-hint">
          Путь: {appTestLatestLog?.path || "—"} · Язык: {appTestSummary.acceptLanguage || "—"} · Content-Type: {appTestSummary.contentType || "—"} · Body bytes: {appTestLatestLog?.bodyBytes || 0}
        </div>
        <label className="composer-label">Имя профиля</label>
        <div className="row">
          <TextInput placeholder="capture-myapp-..." value={appTestProfileName} onChange={(e) => setAppTestProfileName(e.target.value)} />
          <TipButton tip="Сохранить профиль из пойманных заголовков" tone="primary" onClick={() => void saveCapturedProfile()} disabled={appTestSavingProfile || !appTestLatestLog}>
            {appTestSavingProfile ? "Сохранение..." : "Создать профиль"}
          </TipButton>
        </div>
        <div className="toolbar">
          <TipButton tip="Очистить логи и запустить тест заново" onClick={() => void resetAppTestCapture()} disabled={!appTestSource?.id}>
            Очистить и повторить
          </TipButton>
        </div>
        <label className="composer-label">Все заголовки</label>
        <pre className="json">{JSON.stringify(appTestHeaders, null, 2) || "{}"}</pre>
        <label className="composer-label">Query</label>
        <pre className="json">{JSON.stringify(appTestLatestLog?.query || {}, null, 2)}</pre>
        <label className="composer-label">Тело запроса</label>
        <pre className="json">{appTestLatestLog?.body || "Пусто"}</pre>
      </section>

      {appTestStatus ? <div className="status">{appTestStatus}</div> : null}
    </div>
  );

  if (publicShareId) {
    const publicFullUrl = publicSharePayload ? buildFullUrlWithOrigin(publicSharePayload, effectiveOrigin) : "";
    return (
      <AppShell logoSrc={subLabIcon} subtitle="Подключение подписки" footer={topRightControls}>
        {publicShareLoading ? <div className="status">Загрузка...</div> : null}
        {publicShareError ? <div className="status">{publicShareError}</div> : null}
        {publicSharePayload && !publicShareError ? (
          <SharePanel
            shortUrl={publicShareShortUrl}
            fullUrl={publicFullUrl}
            shareApps={shareApps}
            recommendedByOs={recommendedByOs}
            orderByOs={orderByOs}
            topMeta={publicShareMeta}
            topMetaLoading={publicShareMetaLoading}
            subscriptionFormat={publicTypeOverride || publicShareMeta?.sourceFormatToken || publicSharePayload.output || ""}
            preferredOs={publicSharePayload.device || ""}
            preferredApp={publicSharePayload.app || ""}
            buildAppShareLink={buildAppShareLink}
            fetchGuide={fetchAppGuide}
            onCopy={(text) => { void copyToClipboard(text); }}
          />
        ) : null}
      </AppShell>
    );
  }

  if (!authResolved) {
    return (
      <AppShell logoSrc={subLabIcon} subtitle="Проверка доступа" footer={topRightControls}>
        <section className="auth-layout">
          <article className="card auth-card">
            <h2>Проверка авторизации...</h2>
            <p>Секунду, загружаем данные сессии.</p>
          </article>
        </section>
        <NotificationToasts items={notifications} onDismiss={dismissNotification} />
      </AppShell>
    );
  }

  if (authEnabled && !authenticated) {
    return null;
  }

  if (isStatsPath) {
    return (
      <AppShell logoSrc={subLabIcon} subtitle="Статистика" nav={shellNav} footer={topRightControls}>
        <section className="page-head">
          <div>
            <h1>Статистика</h1>
            <p>Как часто забирают подписки и с каких устройств</p>
          </div>
        </section>
        <StatsPage
          stats={stats}
          loading={statsLoading}
          error={statsError}
          days={statsDays}
          onDaysChange={setStatsDays}
          onRefresh={() => loadStats(statsDays)}
        />
        <NotificationToasts items={notifications} onDismiss={dismissNotification} />
      </AppShell>
    );
  }

  if (isAdminPath) {
    if (!isAdminUser) {
      return (
        <AppShell logoSrc={subLabIcon} subtitle="Админка" footer={topRightControls}>
          <section className="auth-screen">
            <h1>/admin</h1>
            <p>Доступ только для admin</p>
            <div className="toolbar">
              <TipButton tip="На главную" onClick={goMain}>
                На главную
              </TipButton>
            </div>
          </section>
          <NotificationToasts items={notifications} onDismiss={dismissNotification} />
        </AppShell>
      );
    }

    return (
      <AppShell logoSrc={subLabIcon} subtitle="Админка" nav={shellNav} footer={topRightControls}>
        <section className="page-head">
          <div>
            <h1>Админка</h1>
            <p>Управление пользователями и сервисными инструментами</p>
          </div>
        </section>

        <section className="admin-overview">
          <article className="card admin-metric-card">
            <div className="admin-metric-label">Всего пользователей</div>
            <div className="admin-metric-value">{adminUsers.length}</div>
          </article>
          <article className="card admin-metric-card">
            <div className="admin-metric-label">Администраторы</div>
            <div className="admin-metric-value">{adminUsers.filter((u) => u.role === "admin").length}</div>
          </article>
          <article className="card admin-metric-card">
            <div className="admin-metric-label">Обычные пользователи</div>
            <div className="admin-metric-value">{adminUsers.filter((u) => u.role === "user").length}</div>
          </article>
        </section>

        <section className="admin-section">
          <div className="admin-section-head">
            <h2>Инструменты</h2>
            <p>Сервисные экраны для диагностики и настройки профилей.</p>
          </div>
          <div className="admin-tools-grid">
            <button type="button" className="admin-tool-card" onClick={() => openModal("mock")}>
              <span className="admin-tool-icon"><FlaskIcon className="btn-icon" /></span>
              <span className="admin-tool-title">Тестовый сервер</span>
              <span className="admin-tool-text">Проверка источников, пресеты, логирование и отладка ответа.</span>
            </button>
            <button type="button" className="admin-tool-card" onClick={openAppTestModal}>
              <span className="admin-tool-icon"><TestIcon className="btn-icon" /></span>
              <span className="admin-tool-title">Тест приложения</span>
              <span className="admin-tool-text">Пошаговый capture реального запроса из клиента и сбор профиля.</span>
            </button>
            <button type="button" className="admin-tool-card" onClick={() => openModal("profileEditor")}>
              <span className="admin-tool-icon"><ProfileIcon className="btn-icon" /></span>
              <span className="admin-tool-title">Профили и UA</span>
              <span className="admin-tool-text">Редактирование заголовков профилей и UA-каталога.</span>
            </button>
          </div>
        </section>

        <SyncPeersPanel notify={notify} onSynced={() => { void reloadFavorites().catch(() => {}); }} />

        <section className="admin-section">
          <div className="admin-section-head">
            <h2>Пользователи</h2>
            <p>Источник — account: там же меняются роли и пароли. Здесь список нужен, чтобы выдавать доступ к ссылкам.</p>
          </div>
          {status ? <div className="status admin-status">{status}</div> : null}
          <div className="cards admin-users-list">
            {adminUsers.map((u) => (
              <article key={u.username} className="card admin-user-card">
                <div className="admin-user-row">
                  <span className="me-avatar">{u.username.trim().charAt(0).toUpperCase()}</span>
                  <div className="admin-user-main">
                    <div className="sub-name">{u.username}</div>
                    <div className="labels">
                      <Badge tone={u.role === "admin" ? "accent" : undefined}>{u.accountRole || u.role}</Badge>
                      {u.username === authUser?.username ? <Badge>это вы</Badge> : null}
                    </div>
                  </div>
                </div>
              </article>
            ))}
            {adminUsers.length === 0 ? <article className="card empty-state"><div className="empty-state-title">Пользователи не найдены</div><div className="empty-state-text">Проверьте, что account доступен и в нём есть группы sub_mirror.</div></article> : null}
          </div>
        </section>

        {showMock ? (
          <Modal onClose={() => setShowMock(false)} title="Тестовый сервер" showCloseButton>
            {mockModalContent}
          </Modal>
        ) : null}

        {showAppTest ? (
          <Modal onClose={() => setShowAppTest(false)} title="Тест приложения" showCloseButton>
            {appTestModalContent}
          </Modal>
        ) : null}

        {showProfileEditor ? (
          <Modal onClose={() => setShowProfileEditor(false)} title="Редактор профилей и UA" showCloseButton>
            {profileEditorContent}
          </Modal>
        ) : null}
        <NotificationToasts items={notifications} onDismiss={dismissNotification} />
      </AppShell>
    );
  }

  return (
    <AppShell
      logoSrc={subLabIcon}
      subtitle="Лаборатория подписок"
      nav={shellNav}
      navActions={canEditSubs ? mainQuickActions : null}
      footer={topRightControls}
    >

      {canEditSubs ? null : (
        <section className="viewer-note">
          Доступные вам подписки. Откройте карточку, чтобы получить ссылку для приложения.
        </section>
      )}

      <section className="page-head">
        <div>
          <h1>Подписки</h1>
          <p>
            {favorites.length === 0
              ? "Здесь появятся ссылки для приложений"
              : (listQuery.trim() || listOwnerFilter !== "visible"
                ? `Показано ${visibleFavorites.length} из ${favorites.length}`
                : `Всего подписок: ${visibleFavorites.length}`)}
          </p>
        </div>
        {favorites.length > 0 ? (
          <div className="head-actions">
            {isAdminUser && foreignFavoritesCount > 0 ? (
              <div className="list-filters" role="group" aria-label="Фильтр по владельцу">
                {([
                  ["visible", "Доступные мне", "Свои и выданные вам подписки"],
                  ["mine", "Мои", "Только те, что вы создали сами"],
                  ["shared", "Выданные мне", "Подписки, к которым вам дали доступ"],
                  ["foreign", "Чужие", `Подписки других пользователей: ${foreignFavoritesCount}`],
                  ["all", "Все", "Весь список без разбора владельца"],
                ] as const).map(([key, label, tip]) => (
                  <Tooltip key={key} content={tip}>
                    <button
                      type="button"
                      className={`list-filter${listOwnerFilter === key ? " is-active" : ""}`}
                      aria-pressed={listOwnerFilter === key}
                      onClick={() => setListOwnerFilter(key)}
                    >
                      {label}
                      {key === "foreign" ? <span className="list-filter-count">{foreignFavoritesCount}</span> : null}
                    </button>
                  </Tooltip>
                ))}
              </div>
            ) : null}
            <div className="list-search">
              <input
                type="search"
                placeholder="Поиск по названию, ссылке, тегам"
                value={listQuery}
                onChange={(e) => setListQuery(e.target.value)}
                aria-label="Поиск подписок"
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="cards">
        {favorites.length === 0 ? (
          <article className="card empty-state">
            <div className="empty-state-title">{canEditSubs ? "Пока пусто" : "Нет доступных подписок"}</div>
            <div className="empty-state-text">
              {canEditSubs
                ? "Добавьте первую подписку или импортируйте существующую ссылку — она появится здесь карточкой."
                : "Вам пока не выдали ни одной подписки. Как только доступ появится, она возникнет в этом списке."}
            </div>
            {canEditSubs ? (
              <div className="toolbar">
                <TipButton tip="Добавить новую подписку" tone="primary" onClick={() => { resetComposer(); openModal("composer"); }}>
                  <PlusIcon className="btn-icon" /> Добавить подписку
                </TipButton>
              </div>
            ) : null}
          </article>
        ) : visibleFavorites.length === 0 ? (
          <article className="card empty-state">
            <div className="empty-state-title">Ничего не найдено</div>
            <div className="empty-state-text">
              {listQuery.trim()
                ? `По запросу «${listQuery.trim()}» нет подписок. Попробуйте другое название или тег.`
                : "В этом фильтре подписок нет. Выберите другой набор или снимите фильтр."}
            </div>
            <div className="toolbar">
              <TipButton tip="Сбросить поиск и фильтр" onClick={() => { setListQuery(""); setListOwnerFilter("visible"); }}>Сбросить фильтры</TipButton>
            </div>
          </article>
        ) : (
          visibleFavorites.map(({ item, index: idx }) => (
            <SubscriptionCard
              key={`${item.shortId || item.title}-${item.ts}`}
              item={item}
              canEdit={canEditSubs}
              showAdvanced={showAdvanced}
              onEdit={() => onEdit(idx)}
              onDelete={() => onDelete(idx)}
              onTest={() => void applySavedToTester(true, String(idx))}
              onShare={() => openShare(item)}
              onOpenUsers={() => void openSubUsers(item)}
              onOpenAccess={isAdminUser ? () => openAccess(item) : undefined}
              onPing={() => openPing(item)}
              onOpenOverrides={() => void openOverrides(item)}
            />
          ))
        )}
      </section>

      {showImport ? (
        <Modal
          onClose={() => setShowImport(false)}
          title="Импорт подписки"
          showCloseButton
          lead="Вставьте ссылку вида /sub, /last или /l/&lt;id&gt; — поля конструктора заполнятся сами."
          footer={(
            <TipButton tip="Применить импортированную ссылку" tone="primary" onClick={() => void applyImport()}>
              <ImportIcon className="btn-icon" /> Применить
            </TipButton>
          )}
        >
          <div className="field">
            <span className="field-label">Ссылка</span>
            <TextInput placeholder="https://example.com/l/my-sub" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
          </div>
        </Modal>
      ) : null}

      {showBulkImport ? (
        <Modal
          onClose={() => setShowBulkImport(false)}
          title="Массовый импорт"
          showCloseButton
          footer={(
            <>
              <TipButton tip="Создать подписки из отфильтрованного списка" tone="primary" onClick={() => void handleCreateBulkImportedSubscriptions()}>
                <PlusIcon className="btn-icon" /> Создать подписки
              </TipButton>
              <span className="modal-footer-note">После фильтрации: {bulkImportFilteredItems.length} из {bulkImportItems.length}</span>
            </>
          )}
        >
          <section className="form-section">
          <div className="form-section-head">
            <div className="form-section-title">Файл с прокси</div>
            <div className="form-section-lead">Текстовый файл, по одной ссылке на строку.</div>
          </div>
          <label className="composer-label">Файл</label>
          <div className="url-row">
            <TextInput placeholder="Выберите текстовый файл с proxy-ссылками" value={bulkImportFileName} onChange={() => {}} readOnly />
            <TipButton tip="Выбрать файл для импорта" tone="primary" onClick={() => bulkImportFileInputRef.current?.click()}>Выбрать файл</TipButton>
            <input ref={bulkImportFileInputRef} type="file" accept=".txt,.log,.conf,text/plain" hidden onChange={(e) => void handleBulkImportFilePicked(e)} />
          </div>
          <div className="composer-meta-hint">Найдено прокси: {bulkImportItems.length}</div>

          <label className="composer-label">Название</label>
          <TextInput placeholder="Название набора" value={bulkImportName} onChange={(e) => setBulkImportName(e.target.value)} />

          <label className="composer-label">Выходной формат</label>
          <Segmented
            ariaLabel="Выходной формат"
            value={String(bulkImportOutput)}
            onChange={(value) => setBulkImportOutput(value as SubscriptionPayload["output"])}
            options={OUTPUT_OPTIONS}
          />
          </section>

          <section className="form-section">
          <div className="form-section-head">
            <div className="form-section-title">Фильтры</div>
            <div className="form-section-lead">Оставить только нужные серверы и при желании разбить на части.</div>
          </div>
          <div className="row">
            <select value={bulkImportCountry} onChange={(e) => setBulkImportCountry(e.target.value)}>
              <option value="">Все страны</option>
              {bulkImportFlags.map((flag) => <option key={flag} value={flag}>{flag}</option>)}
            </select>
            <TextInput placeholder="Маска имени" value={bulkImportMask} onChange={(e) => setBulkImportMask(e.target.value)} />
          </div>
          <div className="row">
            <TextInput placeholder="Regex" value={bulkImportRegex} onChange={(e) => setBulkImportRegex(e.target.value)} />
            <TextInput placeholder="Размер части, 0 = без деления" value={bulkImportSplitSize} onChange={(e) => setBulkImportSplitSize(e.target.value)} />
          </div>
          <div className="composer-meta-hint">После фильтрации: {bulkImportFilteredItems.length}</div>
          </section>

          <section className="form-section">
          <div className="form-section-head">
            <div className="form-section-title">Предпросмотр</div>
            <div className="form-section-lead">Первые 200 записей из отобранных.</div>
          </div>
          <div className="bulk-import-preview">
            {bulkImportFilteredItems.slice(0, 200).map((item) => (
              <article key={`${item.index}-${item.server}-${item.port}`} className="bulk-import-item">
                <div className="bulk-import-title">{item.normalizedName}</div>
                <div className="bulk-import-sub">{item.type} · {item.server}:{item.port} · {item.network} · {item.security}</div>
                <div className="bulk-import-fields">
                  {item.uuid ? <span>uuid: {item.uuid}</span> : null}
                  {item.password ? <span>password: {item.password}</span> : null}
                  {item.sni ? <span>sni: {item.sni}</span> : null}
                  {item.flow ? <span>flow: {item.flow}</span> : null}
                  {item.fp ? <span>fp: {item.fp}</span> : null}
                  {item.pbk ? <span>pbk: {item.pbk}</span> : null}
                  {item.sid ? <span>sid: {item.sid}</span> : null}
                  {item.path ? <span>path: {item.path}</span> : null}
                  {item.host ? <span>host: {item.host}</span> : null}
                  {item.serviceName ? <span>serviceName: {item.serviceName}</span> : null}
                </div>
              </article>
            ))}
          </div>
          </section>
        </Modal>
      ) : null}

      {showPing && pingItem ? (
        <PingModal
          title={pingItem.title}
          data={pingData}
          loading={pingLoading}
          error={pingError}
          mode={pingMode}
          onModeChange={(value) => { setPingMode(value); void runPing(pingItem, value, pingAttempts); }}
          attempts={pingAttempts}
          onAttemptsChange={(value) => { setPingAttempts(value); void runPing(pingItem, pingMode, value); }}
          onRun={() => void runPing(pingItem, pingMode, pingAttempts)}
          onClose={() => setShowPing(false)}
        />
      ) : null}

      {showMerge ? (
        <MergeModal
          mergeId={mergeId}
          name={mergeName}
          onNameChange={setMergeName}
          output={mergeOutput}
          onOutputChange={setMergeOutput}
          outputAuto={mergeOutputAuto}
          onOutputAutoChange={setMergeOutputAuto}
          outputOptions={OUTPUT_OPTIONS}
          items={mergeItems}
          onItemsChange={setMergeItems}
          preview={mergePreview}
          previewLoading={mergePreviewLoading}
          onPreview={() => void runMergePreview()}
          onSave={() => void handleSaveMerge()}
          onClose={() => setShowMerge(false)}
          saving={mergeSaving}
          note={mergeId ? "адрес подписки не меняется" : ""}
        />
      ) : null}

      {showComposer ? (
        <Modal
          onClose={() => setShowComposer(false)}
          title={showAdvanced ? "Конструктор подписки" : (editingIndex >= 0 ? "Изменить подписку" : "Новая подписка")}
          showCloseButton
          footer={(
            <>
              <TipButton tip="Сохранить подписку" tone="primary" onClick={() => void handleSave(false)}>
                <SaveIcon className="btn-icon" /> Сохранить
              </TipButton>
              <TipButton tip="Сохранить как новую подписку" onClick={() => void handleSave(true)}>
                <SaveAsIcon className="btn-icon" /> Сохранить как
              </TipButton>
              <TipButton tip="Закрыть без сохранения" onClick={() => setShowComposer(false)}>
                <CloseIcon className="btn-icon" /> Закрыть
              </TipButton>
              {showAdvanced ? (
                <TipIconButton tip="Открыть тестер" aria-label="Открыть тестер" icon={<FlaskIcon className="btn-icon" />} onClick={() => openModal("tester")} />
              ) : null}
              {status ? <span className="modal-footer-note">{status}</span> : null}
            </>
          )}
        >
          {showAdvanced ? null : (
            <div className="composer-hint">
              Укажите название и ссылку на подписку провайдера. Формат, группы и заголовки приложения
              подставятся сами.
            </div>
          )}

          <div className="form-stack">
            <section className="form-section">
              <div className="form-section-head">
                <div className="form-section-title">Основное</div>
                <div className="form-section-lead">Как подписка называется и откуда берутся серверы.</div>
              </div>

              <div className="field">
                <span className="field-label">Название</span>
                <TextInput placeholder="Название подписки" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              {showAdvanced ? (
                <>
                  <div className="field-row">
                    <div className="field">
                      <span className="field-label">Короткая ссылка</span>
                      <TextInput
                        placeholder="my-sub или пусто для генерации"
                        value={shortIdDraft}
                        onChange={(e) => setShortIdDraft(e.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80))}
                      />
                    </div>
                    <div className="field">
                      <span className="field-label">Теги</span>
                      <TextInput placeholder="router, home" value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} />
                    </div>
                  </div>
                  <label className="switch-row">
                    <span>Скрыть подписку по короткой ссылке</span>
                    <input type="checkbox" checked={hiddenDraft} onChange={(e) => setHiddenDraft(e.target.checked)} />
                  </label>
                  {hiddenDraft ? (
                    <div className="composer-meta-hint">
                      Публичные `/l/{shortIdDraft || "..."}` и meta API будут отвечать 404. Владелец и админ смогут редактировать подписку в кабинете.
                    </div>
                  ) : null}
                </>
              ) : null}

              <div className="field">
                <span className="field-label">Источник</span>
                {showAdvanced ? (
                  <Segmented
                    ariaLabel="Тип источника"
                    value={composerSourceMode}
                    onChange={(value) => setComposerSourceMode(value as ComposerSourceMode)}
                    options={[
                      { value: "url", label: "URL", tip: "Загрузить источник по URL" },
                      { value: "file", label: "Файл", tip: "Загрузить файл со списком адресов" },
                      { value: "text", label: "Поле", tip: "Вставить список адресов вручную" },
                    ]}
                  />
                ) : null}
                {composerSourceMode === "url" ? (
                  <>
                    <TextInput
                      placeholder="URL или встроенный файл, например bypass-all.txt"
                      value={payload.sub_url}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                        setPayload({ ...payload, sub_url: nextValue });
                        if (nextValue.trim() !== originalHappUrl.trim()) {
                          setOriginalHappUrl("");
                          setHappDecryptStatus("");
                        }
                        if (nextValue.trim() !== happDecryptDismissedUrl.trim()) {
                          setHappDecryptDismissedUrl("");
                        }
                      }}
                    />
                    {happDecryptStatus ? <div className="composer-meta-hint">{happDecryptStatus}</div> : null}
                    {originalHappUrl ? (
                      <button
                        type="button"
                        className="composer-original-link"
                        onClick={() => {
                          void copyToClipboard(originalHappUrl);
                          notify("info", "Оригинальная happ-ссылка скопирована");
                        }}
                      >
                        Оригинал: {originalHappUrl}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {composerSourceMode === "file" ? (
                  <>
                    <div className="url-row">
                      <TextInput placeholder="Выберите файл со списком vless://..." value={composerFileName} onChange={() => {}} readOnly />
                      <TipButton tip="Выбрать файл источника" onClick={() => composerFileInputRef.current?.click()}>Выбрать файл</TipButton>
                      <input ref={composerFileInputRef} type="file" accept=".txt,.log,.conf,text/plain" hidden onChange={(e) => void handleComposerFilePicked(e)} />
                    </div>
                    <Textarea rows={10} placeholder="Содержимое файла появится здесь" value={composerFileBody} onChange={(e) => setComposerFileBody(e.target.value)} />
                    <div className="composer-meta-hint">Серверов найдено: {composerFileServersCount}</div>
                  </>
                ) : null}
                {composerSourceMode === "text" ? (
                  <>
                    <Textarea rows={10} placeholder={"Вставьте vless:// адреса, по одному на строку"} value={composerTextBody} onChange={(e) => setComposerTextBody(e.target.value)} />
                    <div className="composer-meta-hint">Серверов найдено: {composerTextServersCount}</div>
                  </>
                ) : null}
              </div>

              {showAdvanced ? (
                <div className="field">
                  <span className="field-label">Режим выдачи</span>
                  <Segmented
                    ariaLabel="Режим выдачи"
                    value={payload.endpoint === "sub" ? "sub" : "last"}
                    onChange={(value) => setPayload({ ...payload, endpoint: value === "sub" ? "sub" : "last" })}
                    options={[
                      { value: "last", label: "С кэшем", tip: "Отдавать последнюю успешную версию из кэша" },
                      { value: "sub", label: "Без кэша", tip: "Каждый раз запрашивать источник заново" },
                    ]}
                  />
                </div>
              ) : null}
            </section>

            <section className="form-section">
              <div className="form-section-head">
                <div className="form-section-title">Формат выдачи</div>
                <div className="form-section-lead">В каком виде приложение получит подписку.</div>
              </div>

              <div className="field">
                <span className="field-label">Формат</span>
                <Segmented
                  ariaLabel="Формат"
                  value={String(payload.output || "yml")}
                  onChange={(value) => setPayload({ ...payload, output: value as SubscriptionPayload["output"] })}
                  options={[
                    { value: "yml", label: "yml", tip: "Формат YAML" },
                    { value: "raw", label: "raw", tip: "Формат RAW" },
                    { value: "raw_base64", label: "raw (base64)", tip: "Формат RAW в base64" },
                    { value: "json", label: "json", tip: "Формат JSON" },
                  ]}
                />
              </div>

              <label className="switch-row">
                <span className="switch-row-text">
                  Выбирать формат по User-Agent
                  <span className="composer-meta-hint">Если UA нет или он не распознан, берётся формат выше.</span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(payload.output_auto)}
                  onChange={(e) => setPayload({ ...payload, output_auto: e.target.checked ? "1" : "" })}
                />
              </label>

              {showAdvanced ? (
                <>
                  <div className="field">
                    <span className="field-label">Серверы из JSON-подписки</span>
                    <Segmented
                      ariaLabel="Серверы из JSON-подписки"
                      value={String(payload.nodes || "collapse")}
                      onChange={(value) => setPayload({ ...payload, nodes: value as SubscriptionPayload["nodes"] })}
                      options={NODES_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label, tip: option.tip }))}
                    />
                  </div>
                  <div className="composer-hint">
                    Обратная конвертация в исходный формат (json → json) отдаёт подписку как есть и этот выбор не учитывает.
                  </div>
                </>
              ) : null}
            </section>

            {showAdvanced ? (
              <section className="form-section">
                <div className="form-section-head">
                  <div className="form-section-title">Группы Clash</div>
                  <div className="form-section-lead">Готовые наборы или своя выборка по регулярке и странам.</div>
                </div>
                <div className="chip-row">
                  {CLASH_GROUP_PRESETS.map((entry) => (
                    <TipChipButton
                      key={"preset" in entry ? entry.preset : entry.type}
                      tip={`Добавить группу ${entry.name}`}
                      className={`chip-btn ${hasClashGroup(currentClashGroups, entry) ? "active" : ""}`}
                      onClick={() => updateClashGroups(toggleClashGroup(currentClashGroups, entry))}
                    >
                      {entry.name}
                    </TipChipButton>
                  ))}
                </div>
                <div className="url-row">
                  <TextInput placeholder="Название группы" value={clashGroupName} onChange={(e) => setClashGroupName(e.target.value)} />
                  <TextInput placeholder="Регулярка, например Finland|🇫🇮" value={clashGroupRegex} onChange={(e) => setClashGroupRegex(e.target.value)} />
                  <TipButton tip="Добавить группу по регулярке" onClick={addRegexClashGroup}>Regex</TipButton>
                </div>
                <div className="url-row">
                  <TextInput placeholder="Страны/токены через запятую: 🇫🇮, Финляндия, Finland" value={clashGroupCountries} onChange={(e) => setClashGroupCountries(e.target.value)} />
                  <TipButton tip="Добавить группу по списку стран" onClick={addCountryClashGroup}>Страны</TipButton>
                </div>
                {currentClashGroups.length > 0 ? (
                  <div className="labels">
                    {currentClashGroups.map((group, idx) => (
                      <Badge key={`${group.name || group.preset || group.regex}-${idx}`} tone="accent">
                        {group.name || group.preset || group.regex}
                        <button type="button" className="mini-link" onClick={() => updateClashGroups(currentClashGroups.filter((_, i) => i !== idx))}> ×</button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <div className="composer-meta-hint">
                    Группы создаются только если найдено больше одного сервера. Одиночные серверы остаются без отдельной подгруппы.
                  </div>
                )}
              </section>
            ) : null}

            <section className="form-section">
              <div className="form-section-head">
                <div className="form-section-title">Устройство и приложение</div>
                <div className="form-section-lead">Отсюда берутся User-Agent и заголовки запроса.</div>
              </div>

              <div className="field">
                <span className="field-label">ОС</span>
                <div className="chip-row">
                  {osOptions.length === 0 ? <span className="status">UA-каталог пуст</span> : null}
                  {osOptions.map((osName) => (
                    <TipChipButton
                      tip={`ОС: ${osName}`}
                      key={osName}
                      className={`chip-btn ${selectedOs === osName ? "active" : ""}`}
                      onClick={() => {
                        const apps = appsCatalog.length > 0 ? appsCatalog : Object.keys(uaCatalog.options[osName] || {});
                        setSelectedOs(osName);
                        setPayload((prev) => ({
                          ...prev,
                          device: osName,
                          app: apps.includes(String(prev.app || "")) ? String(prev.app || "") : (apps[0] || String(prev.app || "")),
                        }));
                      }}
                    >
                      {osName}
                    </TipChipButton>
                  ))}
                </div>
              </div>

              <div className="field">
                <span className="field-label">Приложение</span>
                <div className="chip-row">
                  {appOptions.map((appName) => (
                    <TipChipButton
                      tip={`Приложение: ${appName}`}
                      key={appName}
                      className={`chip-btn ${payload.app === appName ? "active" : ""}`}
                      onClick={() => setPayload({ ...payload, app: appName })}
                    >
                      {appName}
                    </TipChipButton>
                  ))}
                </div>
              </div>

              {showAdvanced ? (
                <>
                  <div className="field">
                    <span className="field-label">Предустановки</span>
                    <div className="chip-row">
                      <TipChipButton tip="Без предустановки" className={`chip-btn ${!payload.profile ? "active" : ""}`} onClick={() => setPayload({ ...payload, profile: "" })}>Без профиля</TipChipButton>
                      {profileCatalog.profiles.map((profileName) => (
                        <TipChipButton tip={`Предустановка: ${profileName}`} key={profileName} className={`chip-btn ${payload.profile === profileName ? "active" : ""}`} onClick={() => setPayload({ ...payload, profile: profileName })}>
                          {profileName}
                        </TipChipButton>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span className="field-label">HWID</span>
                    <div className="hwid-row">
                      <TextInput placeholder="hwid" value={payload.hwid || ""} onChange={(e) => setPayload({ ...payload, hwid: e.target.value })} />
                      <TipIconButton
                        tip="Сгенерировать случайный HWID"
                        aria-label="Сгенерировать HWID"
                        icon={<DiceIcon className="btn-icon" />}
                        onClick={() => setPayload((prev) => ({ ...prev, hwid: generateHwidByOs(selectedOs || prev.device || "") }))}
                      />
                    </div>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        </Modal>
      ) : null}

      {showHappDecryptPrompt ? (
        <Modal
          onClose={() => {
            setHappDecryptDismissedUrl(String(payload.sub_url || "").trim());
            setShowHappDecryptPrompt(false);
          }}
          title="Расшифровать Happ-ссылку"
          showCloseButton
          lead="Обнаружена ссылка вида happ://crypt… — её можно сразу расшифровать и сохранить в подписке обычный URL."
          footer={(
            <>
              <TipButton tip="Расшифровать ссылку через binary" tone="primary" onClick={() => void applyHappDecryption()} disabled={happDecryptLoading}>
                {happDecryptLoading ? "Расшифровка..." : "Расшифровать"}
              </TipButton>
              <TipButton
                tip="Оставить исходную happ-ссылку без расшифровки"
                onClick={() => {
                  setHappDecryptDismissedUrl(String(payload.sub_url || "").trim());
                  setShowHappDecryptPrompt(false);
                }}
              >
                Не расшифровывать
              </TipButton>
            </>
          )}
        >
          <div className="happ-decrypt-dialog">
            <div className="json">{payload.sub_url}</div>
            {happDecryptStatus ? <div className="composer-meta-hint">{happDecryptStatus}</div> : null}
          </div>
        </Modal>
      ) : null}

      {showTester ? (
        <Modal
          onClose={() => setShowTester(false)}
          title="Тестер подписки"
          showCloseButton
          lead="Слева — что отдал источник, справа — что получит приложение после конвертации."
          footer={(
            <TipButton tip="Запустить тест подписки" tone="primary" onClick={() => void runTester()}>
              <TestIcon className="btn-icon" /> Запустить тест
            </TipButton>
          )}
        >
          <div className="result-grid">
            <div className="result">
              <strong>Источник: {testResult?.upstream?.sourceFormat || "-"}</strong>
              <select>{sourceServers.map((x, i) => <option key={`${x}-${i}`}>{x}</option>)}</select>
              <div className="toolbar">
                <TipIconButton tip="Копировать исходный ответ" icon={<CopyIcon className="btn-icon" />} onClick={() => void copyToClipboard(testResult?.upstream?.body || "")} />
                <TipIconButton
                  tip="Скачать исходный ответ"
                  icon={<SaveIcon className="btn-icon" />}
                  onClick={() => downloadTextFile(testResult?.upstream?.body || "", `source.${detectDownloadExtension(testResult?.upstream?.sourceFormat || "")}`)}
                />
              </div>
            </div>
            <div className="result">
              <strong>После конвертации: {testResult?.conversion?.outputFormat || "-"}</strong>
              <select>{convertedServers.map((x, i) => <option key={`${x}-${i}`}>{x}</option>)}</select>
              <div className="toolbar">
                <TipIconButton tip="Копировать результат конвертации" icon={<CopyIcon className="btn-icon" />} onClick={() => void copyToClipboard(testResult?.conversion?.body || "")} />
                <TipIconButton
                  tip="Скачать результат конвертации"
                  icon={<SaveIcon className="btn-icon" />}
                  onClick={() => downloadTextFile(testResult?.conversion?.body || "", `converted.${detectDownloadExtension(testResult?.conversion?.outputFormat || "")}`)}
                />
              </div>
            </div>
          </div>
          <pre className="json">{JSON.stringify(testResult, null, 2)}</pre>
        </Modal>
      ) : null}

      {showMock ? (
        <Modal onClose={() => setShowMock(false)} title="Тестовый сервер" showCloseButton>
          {mockModalContent}
        </Modal>
      ) : null}

      {showAppTest ? (
        <Modal onClose={() => setShowAppTest(false)} title="Тест приложения" showCloseButton>
          {appTestModalContent}
        </Modal>
      ) : null}

      {showProfileEditor ? (
        <Modal onClose={() => setShowProfileEditor(false)} title="Редактор профилей и UA" showCloseButton>
          {profileEditorContent}
        </Modal>
      ) : null}

      {showShare && shareItem ? (
        <Modal onClose={() => setShowShare(false)} title={`Поделиться: ${shareItem.title}`} showCloseButton>
          <>
            <SharePanel
              shortUrl={shareItem.hidden ? "" : (shareItem.url || buildFullUrlWithOrigin(shareItem.payload, effectiveOrigin))}
              fullUrl={buildFullUrlWithOrigin(shareItem.payload, effectiveOrigin)}
              shareApps={shareApps}
              recommendedByOs={recommendedByOs}
              orderByOs={orderByOs}
              topMeta={shareModalMeta}
              topMetaLoading={shareModalMetaLoading}
              subscriptionFormat={shareItem.payload.output_auto ? `auto -> ${shareItem.payload.output || ""}` : (shareItem.payload.output || "")}
              preferredOs={shareItem.payload.device || ""}
              preferredApp={shareItem.payload.app || ""}
              buildAppShareLink={buildAppShareLink}
              fetchGuide={fetchAppGuide}
              onCopy={(text) => { void copyToClipboard(text); }}
            />
            {shareItem.hidden ? <div className="status">Короткая ссылка скрыта: публичный адрес `/l/{shareItem.shortId || ""}` недоступен.</div> : null}
            {isAdminUser && shareItem.shortId ? (
              <section className="card share-access-card">{accessEditor}</section>
            ) : null}
          </>
        </Modal>
      ) : null}
      {showOverrides && overridesItem ? (
        <OverridesModal item={overridesItem} onClose={() => setShowOverrides(false)} onNotify={notify} />
      ) : null}
      {showAccess && shareItem ? (
        <Modal
          onClose={() => setShowAccess(false)}
          title={`Доступы: ${shareItem.title}`}
          lead="Права на эту подписку. Владелец всегда может её менять."
          showCloseButton
          footer={(
            <TipButton tip="Закрыть окно" onClick={() => setShowAccess(false)}>Закрыть</TipButton>
          )}
        >
          {shareItem.shortId
            ? accessEditor
            : <div className="status">У подписки нет короткой ссылки — выдавать доступ не к чему. Сначала сохраните её с коротким идентификатором.</div>}
        </Modal>
      ) : null}

      {showSubUsers && subUsersItem ? (
        <Modal onClose={() => setShowSubUsers(false)} title={`Пользователи: ${subUsersItem.title}`} showCloseButton>
          <div className="sub-users-layout">
            {subUsersLoading ? <div className="status">Загрузка...</div> : null}
            {!subUsersLoading && subUsersData ? (
              <>
                <section className="sub-users-policy">
                  <div className="form-section-head">
                    <div className="form-section-title">Правила доступа</div>
                    <div className="form-section-lead">Лимит устройств и тексты, которые увидит заблокированный пользователь.</div>
                  </div>
                  <div className="sub-users-summary">
                    <Badge>Всего: {subUsersData.summary.usersCount}</Badge>
                    <Badge tone="ok">Активных: {subUsersData.summary.activeCount}</Badge>
                    <Badge tone="danger">Заблокировано: {subUsersData.summary.blockedCount}</Badge>
                  </div>
                  <div className="row">
                    <TextInput
                      placeholder="Лимит пользователей (0 = без лимита)"
                      value={subUsersMax}
                      onChange={(e) => setSubUsersMax(e.target.value)}
                      disabled={subUsersItem.permissions?.canEdit === false}
                    />
                    <TipButton tip="Сохранить настройки" onClick={() => void saveSubUsersPolicy()} disabled={subUsersItem.permissions?.canEdit === false}>
                      Сохранить настройки
                    </TipButton>
                  </div>
                  <label className="composer-label">Текст при блокировке пользователя</label>
                  <TextInput
                    placeholder="Доступ к подписке заблокирован"
                    value={subUsersBlockedMessage}
                    onChange={(e) => setSubUsersBlockedMessage(e.target.value)}
                    disabled={subUsersItem.permissions?.canEdit === false}
                  />
                  <label className="composer-label">Текст при превышении лимита пользователей</label>
                  <TextInput
                    placeholder="Достигнут лимит пользователей для этой подписки"
                    value={subUsersLimitMessage}
                    onChange={(e) => setSubUsersLimitMessage(e.target.value)}
                    disabled={subUsersItem.permissions?.canEdit === false}
                  />
                </section>

                <section className="sub-users-list">
                  {subUsersData.users.length === 0 ? (
                    <article className="card empty-state">
                      <div className="empty-state-title">Подключений пока нет</div>
                      <div className="empty-state-text">Как только приложение запросит подписку по этой ссылке, устройство появится здесь.</div>
                    </article>
                  ) : null}
                  {subUsersData.users.map((user) => (
                    <article key={user.hwid} className="card sub-user-card">
                      <div className="sub-head">
                        <div>
                          <div className="sub-name">{user.hwid}</div>
                          <div className="labels">
                            <span className="label">{user.blocked ? "blocked" : "active"}</span>
                            {user.lastSeen.deviceModel ? <span className="label">{user.lastSeen.deviceModel}</span> : null}
                            {user.lastSeen.app ? <span className="label">{user.lastSeen.app}</span> : null}
                            {user.lastSeen.device ? <span className="label">{user.lastSeen.device}</span> : null}
                          </div>
                        </div>
                        <div className="toolbar">
                          <TipButton
                            tip={user.blocked ? "Разблокировать пользователя" : "Заблокировать пользователя"}
                            disabled={subUsersItem.permissions?.canEdit === false}
                            onClick={() => void toggleSubUserBlocked(user.hwid, !user.blocked, user.blockReason)}
                          >
                            {user.blocked ? "Разблокировать" : "Блокировать"}
                          </TipButton>
                          <TipButton tip="Удалить пользователя и историю" onClick={() => void removeSubUser(user.hwid)} disabled={subUsersItem.permissions?.canEdit === false}>
                            Удалить
                          </TipButton>
                        </div>
                      </div>
                      <div className="status">
                        Первый запрос: {formatDateTime(user.firstSeenAt)} | Последний запрос: {formatDateTime(user.lastSeenAt)}
                      </div>
                      <div className="status">
                        IP: {user.lastSeen.ip || "—"} | UA: {user.lastSeen.userAgent || "—"}
                      </div>
                      {user.blocked && user.blockReason ? (
                        <div className="status">Текст блокировки: {user.blockReason}</div>
                      ) : null}
                      <div className="toolbar">
                        <TipButton
                          tip="Показать/скрыть историю изменений устройства"
                          onClick={() => setSubUsersExpandedHwid((prev) => (prev === user.hwid ? "" : user.hwid))}
                        >
                          {subUsersExpandedHwid === user.hwid ? "Скрыть историю" : "История изменений"}
                        </TipButton>
                      </div>
                      {subUsersExpandedHwid === user.hwid ? (
                        <div className="sub-user-history">
                          {user.history.length === 0 ? <div className="status">История изменений отсутствует.</div> : null}
                          {user.history.map((h, idx) => (
                            <article key={`${h.changedAt}-${idx}`} className="sub-user-history-item">
                              <div className="status">
                                {formatDateTime(h.changedAt)} [{h.eventType}]
                              </div>
                              <div className="status">
                                OS: {h.deviceOs || "—"} | Model: {h.deviceModel || "—"} | App: {h.app || "—"} | Device: {h.device || "—"}
                              </div>
                              <div className="status">
                                IP: {h.ip || "—"} | UA: {h.userAgent || "—"} | Lang: {h.acceptLanguage || "—"}
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </section>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
      <NotificationToasts items={notifications} onDismiss={dismissNotification} />
    </AppShell>
  );
}
