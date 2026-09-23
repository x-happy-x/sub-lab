import type {
  AuthUser,
  ImportedProxyItem,
  MockLogEntry,
  MockSource,
  ProfileCatalog,
  ProfileCatalogItem,
  ShortLinkAccessGrant,
  ShortLinkPermissions,
  ShortLinkUsersData,
  SubTestResponse,
  MergeItem,
  MergeOnEmpty,
  MergedSource,
  MergePreviewResult,
  PingMode,
  PingResponse,
  PingResult,
  UsageStats,
  UsageStatsTotals,
  SubscriptionPayload,
  UACatalog,
} from "../types";
import type { FavoriteItem, ShortLinkHealth, ShortLinkUserCounts, SyncPeer, SyncPeerInput, SyncPeerTestResult } from "../types";

const PARAM_KEYS = ["sub_url", "endpoint", "output", "output_auto", "app", "device", "profile", "profiles", "hwid", "clash_groups", "nodes"] as const;

function currentBrowserOrigin(): string {
  if (typeof window === "undefined" || !window.location?.origin) return "";
  return String(window.location.origin || "").trim();
}

function isLocalHostname(hostname: string): boolean {
  const token = String(hostname || "").trim().toLowerCase();
  return token === "localhost" || token === "127.0.0.1" || token === "::1";
}

function rewriteUrlToBrowserOrigin(raw: string): string {
  const value = String(raw || "").trim();
  const browserOrigin = currentBrowserOrigin();
  if (!value || !browserOrigin) return value;
  try {
    const browserUrl = new URL(browserOrigin);
    if (isLocalHostname(browserUrl.hostname)) return value;
    const parsed = new URL(value, browserOrigin);
    parsed.protocol = browserUrl.protocol;
    // hostname и port по отдельности: сеттер `host` без явного порта старый
    // порт не убирает, и ссылка на домен уезжала бы как sub.example.com:4192.
    parsed.hostname = browserUrl.hostname;
    parsed.port = browserUrl.port;
    return parsed.toString();
  } catch {
    return value;
  }
}

function normalizeFavoriteUrl(item: FavoriteItem): FavoriteItem {
  return {
    ...item,
    url: rewriteUrlToBrowserOrigin(String(item.url || "")),
  };
}

export async function fetchAuthState(): Promise<{ enabled: boolean; authenticated: boolean; user: AuthUser | null; publicBaseUrl: string }> {
  const resp = await fetch("/api/auth/me");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "auth state failed");
  return {
    enabled: Boolean(json.auth?.enabled),
    authenticated: Boolean(json.auth?.authenticated),
    publicBaseUrl: String(json.config?.publicBaseUrl || ""),
    user: json.auth?.user && typeof json.auth.user === "object"
      ? {
          username: String(json.auth.user.username || ""),
          role: String(json.auth.user.role || "user") === "admin" ? "admin" : "user",
          accountRole: String(json.auth.user.accountRole || "none") as AuthUser["accountRole"],
          canEdit: Boolean(json.auth.user.canEdit),
        }
      : null,
  };
}

export async function login(username: string, password: string): Promise<void> {
  void username;
  void password;
  const target = `/auth/start?return=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  window.location.assign(target);
  return new Promise(() => {});
}

export async function legacyPasswordLogin(username: string, password: string): Promise<void> {
  const resp = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "login failed");
}

export async function logout(): Promise<void> {
  const resp = await fetch("/api/auth/logout", { method: "POST" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "logout failed");
  if (json.redirect) window.location.assign(String(json.redirect));
}

export type ShortLinkSaveOptions = {
  id?: string;
  hidden?: boolean;
  tags?: string[];
};

export async function createShortLink(payload: SubscriptionPayload, title = "", options: ShortLinkSaveOptions = {}): Promise<{ id: string; shortUrl: string; hidden: boolean; tags: string[] }> {
  const body: Record<string, string | boolean | string[]> = {};
  for (const key of PARAM_KEYS) {
    const v = payload[key];
    if (v) body[key] = String(v);
  }
  if (title.trim()) body.title = title.trim();
  if (options.id?.trim()) body.id = options.id.trim();
  if (options.hidden !== undefined) body.hidden = Boolean(options.hidden);
  if (options.tags) body.tags = options.tags;
  const resp = await fetch("/api/short-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link create failed");
  return {
    id: json.link.id,
    shortUrl: rewriteUrlToBrowserOrigin(String(json.urls.shortUrl || "")),
    hidden: Boolean(json.link.hidden),
    tags: Array.isArray(json.link.tags) ? json.link.tags.map((value: unknown) => String(value || "")).filter(Boolean) : [],
  };
}

export async function updateShortLink(id: string, payload: SubscriptionPayload, title = "", options: ShortLinkSaveOptions = {}): Promise<{ id: string; shortUrl: string; hidden: boolean; tags: string[] }> {
  const body: Record<string, string | boolean | string[]> = {};
  for (const key of PARAM_KEYS) {
    const v = payload[key];
    if (v) body[key] = String(v);
  }
  if (title.trim()) body.title = title.trim();
  if (options.id?.trim()) body.id = options.id.trim();
  if (options.hidden !== undefined) body.hidden = Boolean(options.hidden);
  if (options.tags) body.tags = options.tags;
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link update failed");
  return {
    id: String(json.link?.id || id),
    shortUrl: rewriteUrlToBrowserOrigin(String(json.urls?.shortUrl || "")),
    hidden: Boolean(json.link?.hidden),
    tags: Array.isArray(json.link?.tags) ? json.link.tags.map((value: unknown) => String(value || "")).filter(Boolean) : [],
  };
}

export async function fetchShortLink(id: string): Promise<SubscriptionPayload> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link fetch failed");
  return json.link.params as SubscriptionPayload;
}

export async function fetchShortLinkAccess(id: string): Promise<{ ownerUsername: string; grants: ShortLinkAccessGrant[] }> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/access`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link access fetch failed");
  return {
    ownerUsername: String(json.ownerUsername || ""),
    grants: Array.isArray(json.grants)
      ? json.grants.map((row: unknown) => {
        const item = (row || {}) as Record<string, unknown>;
        return {
          username: String(item.username || ""),
          role: String(item.role || "user") === "admin" ? "admin" : "user",
          accessLevel: String(item.accessLevel || "") === "edit" ? "edit" : "view",
        } as ShortLinkAccessGrant;
      })
      : [],
  };
}

export async function updateShortLinkAccess(id: string, grants: ShortLinkAccessGrant[]): Promise<void> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grants }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link access update failed");
}

export async function fetchShortLinkOverrides(id: string): Promise<{ overrides: Record<string, unknown>; overrideVersion: number }> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/overrides`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link overrides fetch failed");
  return {
    overrides: (json.overrides && typeof json.overrides === "object") ? json.overrides as Record<string, unknown> : {},
    overrideVersion: Number(json.overrideVersion || 0),
  };
}

export async function updateShortLinkOverrides(id: string, overrides: Record<string, unknown>): Promise<{ overrideVersion: number }> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: overrides && typeof overrides === "object" ? overrides : {} }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link overrides update failed");
  return {
    overrideVersion: Number(json.overrideVersion || 0),
  };
}

export async function previewShortLinkOverrides(
  id: string,
  overrides: Record<string, unknown>,
): Promise<{ output: string; contentType: string; conversion: string; servers: string[]; body: string; bodyBytes: number }> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/overrides/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: overrides && typeof overrides === "object" ? overrides : {} }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link overrides preview failed");
  return {
    output: String(json.output || ""),
    contentType: String(json.contentType || ""),
    conversion: String(json.conversion || ""),
    servers: Array.isArray(json.servers) ? json.servers.map((value: unknown) => String(value || "")) : [],
    body: String(json.body || ""),
    bodyBytes: Number(json.bodyBytes || 0),
  };
}

export async function createLocalSource(input: { name?: string; body: string }): Promise<{ id: string; subUrl: string; body: string; name: string }> {
  const resp = await fetch("/api/local-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input || {}),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "local source create failed");
  return {
    id: String(json.source?.id || ""),
    subUrl: String(json.subUrl || ""),
    body: String(json.source?.body || ""),
    name: String(json.source?.name || ""),
  };
}

export async function fetchLocalSource(id: string): Promise<{ id: string; subUrl: string; body: string; name: string }> {
  const resp = await fetch(`/api/local-sources/${encodeURIComponent(id)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "local source fetch failed");
  return {
    id: String(json.source?.id || id),
    subUrl: String(json.subUrl || `local:${id}`),
    body: String(json.source?.body || ""),
    name: String(json.source?.name || ""),
  };
}

function normalizeMergedSource(raw: unknown, fallbackId = ""): MergedSource {
  const source = (raw || {}) as Partial<MergedSource>;
  return {
    id: String(source.id || fallbackId),
    name: String(source.name || ""),
    items: (Array.isArray(source.items) ? source.items : []).map((item) => {
      const row = (item || {}) as MergeItem;
      return {
        ...row,
        title: String(row.title || ""),
        shortId: String(row.shortId || ""),
        filter: {
          pattern: String(row.filter?.pattern || ""),
          onEmpty: (["all", "skip", "error"].includes(String(row.filter?.onEmpty))
            ? row.filter?.onEmpty
            : "all") as MergeOnEmpty,
        },
      };
    }),
    createdAt: String(source.createdAt || ""),
    updatedAt: String(source.updatedAt || ""),
  };
}

export async function createMergedSource(input: { name?: string; items: MergeItem[] }): Promise<{ id: string; subUrl: string; source: MergedSource }> {
  const resp = await fetch("/api/merged-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input || {}),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "merged source create failed");
  return {
    id: String(json.source?.id || ""),
    subUrl: String(json.subUrl || ""),
    source: normalizeMergedSource(json.source),
  };
}

export async function fetchMergedSource(id: string): Promise<MergedSource> {
  const resp = await fetch(`/api/merged-sources/${encodeURIComponent(id)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "merged source fetch failed");
  return normalizeMergedSource(json.source, id);
}

export async function updateMergedSource(id: string, input: { name?: string; items: MergeItem[] }): Promise<MergedSource> {
  const resp = await fetch(`/api/merged-sources/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input || {}),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "merged source update failed");
  return normalizeMergedSource(json.source, id);
}

/** Имена серверов каждого источника — чтобы окно объединения проверяло регулярки без сети. */
export async function previewMergeItems(items: MergeItem[]): Promise<MergePreviewResult[]> {
  const resp = await fetch("/api/merged-sources/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "merge preview failed");
  return (Array.isArray(json.results) ? json.results : []).map((row: unknown) => {
    const item = (row || {}) as Partial<MergePreviewResult>;
    return {
      ok: Boolean(item.ok),
      error: String(item.error || ""),
      names: (Array.isArray(item.names) ? item.names : []).map((name: unknown) => String(name || "")),
    };
  });
}

export async function parseBulkImport(text: string): Promise<ImportedProxyItem[]> {
  const resp = await fetch("/api/import/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "bulk import parse failed");
  return Array.isArray(json.items) ? json.items as ImportedProxyItem[] : [];
}

/**
 * Собрать ссылку `happ://crypt5/...` из обычной.
 *
 * Обратная операция к расшифровке: короткую ссылку панели удобно раздавать в
 * том же виде, в каком её шлют провайдеры — Happ открывает её сам.
 */
export async function encryptHappSubscription(url: string): Promise<string> {
  const resp = await fetch("/api/happ-encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "happ encrypt failed");
  return String(json.link || "");
}

export async function decryptHappSubscription(subUrl: string): Promise<{ originalUrl: string; resolvedUrl: string; changed: boolean }> {
  const resp = await fetch("/api/happ-decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subUrl }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "happ decrypt failed");
  return {
    originalUrl: String(json.originalUrl || subUrl),
    resolvedUrl: String(json.resolvedUrl || ""),
    changed: Boolean(json.changed),
  };
}

export async function fetchShortLinkUsers(id: string): Promise<ShortLinkUsersData> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/users`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link users fetch failed");
  return json.users as ShortLinkUsersData;
}

export async function updateShortLinkUsersPolicy(
  id: string,
  patch: { maxUsers?: number; blockedMessage?: string; limitMessage?: string },
): Promise<void> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/users`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch || {}),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link users policy update failed");
}

export async function updateShortLinkUserState(
  id: string,
  hwid: string,
  patch: { blocked: boolean; blockReason?: string },
): Promise<void> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/users/${encodeURIComponent(hwid)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch || {}),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link user update failed");
}

/**
 * Удалить короткую ссылку насовсем.
 *
 * Не то же самое, что убрать подписку из своего списка: адрес перестаёт
 * отвечать у всех, кому его выдали.
 */
export async function deleteShortLink(id: string): Promise<void> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}`, { method: "DELETE" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link delete failed");
}

export async function deleteShortLinkUserEntry(id: string, hwid: string): Promise<void> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/users/${encodeURIComponent(hwid)}`, {
    method: "DELETE",
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "short-link user delete failed");
}

export async function fetchPublicShortLink(id: string): Promise<{ id: string; shortUrl: string; payload: SubscriptionPayload }> {
  const resp = await fetch(`/api/public-short-links/${encodeURIComponent(id)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "public short-link fetch failed");
  return {
    id: String(json.link?.id || id),
    shortUrl: String(json.urls?.shortUrl || `${window.location.origin}/l/${encodeURIComponent(id)}`),
    payload: (json.link?.params || {}) as SubscriptionPayload,
  };
}

export type PublicShortMeta = {
  providerName: string;
  userName: string;
  active: boolean;
  statusText: string;
  expiresAt: number | null;
  daysLeft: number | null;
  trafficText: string;
  usedBytes: number;
  totalBytes: number;
  provider: string;
  sourceFormat: string;
  sourceFormatToken: "raw" | "json" | "yml" | "";
  serversCount: number;
  serverEntries: Array<{ name: string; uri: string }>;
  app: string;
  device: string;
  deviceModel: string;
  userAgent: string;
  profiles: string[];
};

export async function fetchPublicShortMeta(id: string, typeOverride = ""): Promise<PublicShortMeta> {
  const query = new URLSearchParams();
  const type = String(typeOverride || "").trim().toLowerCase();
  if (type === "raw" || type === "yml") query.set("type", type);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const resp = await fetch(`/api/public-short-links/${encodeURIComponent(id)}/meta${suffix}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "public short-link meta fetch failed");
  const meta = (json.meta || {}) as Record<string, unknown>;
  return {
    providerName: String(meta.providerName || "Подписка"),
    userName: String(meta.userName || id),
    active: Boolean(meta.active),
    statusText: String(meta.statusText || ""),
    expiresAt: typeof meta.expiresAt === "number" ? meta.expiresAt : null,
    daysLeft: typeof meta.daysLeft === "number" ? meta.daysLeft : null,
    trafficText: String(meta.trafficText || ""),
    usedBytes: Number(meta.usedBytes || 0),
    totalBytes: Number(meta.totalBytes || 0),
    provider: String(meta.provider || ""),
    sourceFormat: String(meta.sourceFormat || ""),
    sourceFormatToken: String(meta.sourceFormatToken || "") === "raw"
      ? "raw"
      : (String(meta.sourceFormatToken || "") === "json"
        ? "json"
        : (String(meta.sourceFormatToken || "") === "yml" ? "yml" : "")),
    serversCount: Number(meta.serversCount || 0),
    serverEntries: Array.isArray(meta.serverEntries)
      ? meta.serverEntries
        .map((x) => ({
          name: String((x as Record<string, unknown>)?.name || "").trim(),
          uri: String((x as Record<string, unknown>)?.uri || "").trim(),
        }))
        .filter((x) => Boolean(x.name))
      : [],
    app: String(meta.app || ""),
    device: String(meta.device || ""),
    deviceModel: String(meta.deviceModel || ""),
    userAgent: String(meta.userAgent || ""),
    profiles: Array.isArray(meta.profiles) ? meta.profiles.map((x) => String(x || "")) : [],
  };
}

export async function runSubTest(payload: SubscriptionPayload): Promise<SubTestResponse> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v) params[k] = String(v);
  }
  const resp = await fetch("/api/sub-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params, headers: {} }),
  });
  const json = (await resp.json()) as SubTestResponse;
  if (!resp.ok || !json.ok) throw new Error(json.error || "sub-test failed");
  return json;
}

export async function fetchProfileCatalog(): Promise<ProfileCatalog> {
  const resp = await fetch("/api/profile-editor/list");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "profile catalog failed");
  const catalog = (json.catalog || {}) as Record<string, unknown>;
  return {
    profiles: Array.isArray(catalog.profiles) ? catalog.profiles.map((x: unknown) => String(x || "")) : [],
    items: Array.isArray(catalog.items)
      ? catalog.items.map((row: unknown) => {
        const item = (row || {}) as Record<string, unknown>;
        return {
          name: String(item.name || ""),
          ownerUsername: String(item.ownerUsername || ""),
          editable: Boolean(item.editable),
          visibility: String(item.visibility || "") === "private" ? "private" : "shared",
          source: String(item.source || "") === "custom" ? "custom" : "builtin",
        } as ProfileCatalogItem;
      }).filter((item) => item.name)
      : [],
  };
}

export async function fetchUaCatalog(): Promise<UACatalog> {
  const resp = await fetch("/api/ua-catalog");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "ua catalog failed");
  return {
    options: (json.options && typeof json.options === "object") ? json.options as Record<string, Record<string, string>> : {},
    defaultUa: typeof json.defaultUa === "string" ? json.defaultUa : "",
  };
}

export type AppsCatalogItem = {
  key: string;
  label: string;
  deeplink: string;
  platforms: string[];
  formats: Array<"raw" | "yml">;
};

export type AppGuide = {
  app: string;
  os: string;
  template: string;
};

export async function fetchAppsCatalog(): Promise<{
  apps: string[];
  shareLinks: Record<string, string>;
  items: AppsCatalogItem[];
  recommendedByOs: Record<string, string[]>;
  orderByOs: Record<string, string[]>;
}> {
  const resp = await fetch("/api/apps");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "apps catalog failed");
  const apps = Array.isArray(json.apps)
    ? json.apps
    .map((item: unknown) => String(item || "").trim().toLowerCase())
    .filter((item: string, idx: number, arr: string[]) => Boolean(item) && arr.indexOf(item) === idx)
    : [];
  const shareLinks: Record<string, string> = {};
  if (json.shareLinks && typeof json.shareLinks === "object") {
    for (const [key, value] of Object.entries(json.shareLinks as Record<string, unknown>)) {
      const app = String(key || "").trim().toLowerCase();
      const template = String(value || "").trim();
      if (app && template) shareLinks[app] = template;
    }
  }
  const items: AppsCatalogItem[] = Array.isArray(json.items)
    ? json.items.map((raw: unknown) => {
      const row = (raw || {}) as Record<string, unknown>;
      const key = String(row.key || "").trim().toLowerCase();
      const label = String(row.label || key || "").trim();
      const deeplink = String(row.deeplink || "").trim();
      const platforms = Array.isArray(row.platforms)
        ? row.platforms.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
        : [];
      const formats = Array.isArray(row.formats)
        ? row.formats
          .map((x) => String(x || "").trim().toLowerCase())
          .filter((x): x is "raw" | "yml" => x === "raw" || x === "yml")
        : [];
      return { key, label, deeplink, platforms, formats: formats.length > 0 ? formats : ["raw", "yml"] };
    }).filter((item: AppsCatalogItem) => Boolean(item.key) && Boolean(item.deeplink))
    : [];
  const recommendedByOs: Record<string, string[]> = {};
  if (json.recommendedByOs && typeof json.recommendedByOs === "object") {
    for (const [os, raw] of Object.entries(json.recommendedByOs as Record<string, unknown>)) {
      const token = String(os || "").trim().toLowerCase();
      if (!token || !Array.isArray(raw)) continue;
      recommendedByOs[token] = raw
        .map((x) => String(x || "").trim().toLowerCase())
        .filter((x, i, arr) => Boolean(x) && arr.indexOf(x) === i);
    }
  }
  const orderByOs: Record<string, string[]> = {};
  if (json.orderByOs && typeof json.orderByOs === "object") {
    for (const [os, raw] of Object.entries(json.orderByOs as Record<string, unknown>)) {
      const token = String(os || "").trim().toLowerCase();
      if (!token || !Array.isArray(raw)) continue;
      orderByOs[token] = raw
        .map((x) => String(x || "").trim().toLowerCase())
        .filter((x, i, arr) => Boolean(x) && arr.indexOf(x) === i);
    }
  }
  return { apps, shareLinks, items, recommendedByOs, orderByOs };
}

export async function fetchAppGuide(app: string, os: string): Promise<AppGuide> {
  const resp = await fetch(`/api/apps/guide?app=${encodeURIComponent(app)}&os=${encodeURIComponent(os)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "app guide failed");
  const guide = (json.guide || {}) as Record<string, unknown>;
  return {
    app: String(guide.app || app),
    os: String(guide.os || os),
    template: String(guide.template || ""),
  };
}

export async function readProfile(name: string): Promise<string> {
  const resp = await fetch(`/api/profile-editor/file?kind=profiles&name=${encodeURIComponent(name)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "profile read failed");
  return String(json.content || "");
}

export async function saveProfile(name: string, content: string): Promise<void> {
  const resp = await fetch("/api/profile-editor/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "profiles", name, content }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "profile save failed");
}

export async function deleteProfile(name: string): Promise<void> {
  const resp = await fetch(`/api/profile-editor/file?kind=profiles&name=${encodeURIComponent(name)}`, { method: "DELETE" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "profile delete failed");
}

export async function createMockSource(
  config: Partial<MockSource["config"]> & { mode?: string; label?: string },
): Promise<MockSource> {
  const resp = await fetch("/api/mock-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "mock create failed");
  return json.source as MockSource;
}

export async function getMockSource(id: string): Promise<MockSource> {
  const resp = await fetch(`/api/mock-sources/${encodeURIComponent(id)}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "mock read failed");
  return json.source as MockSource;
}

export async function updateMockSource(
  id: string,
  config: Partial<MockSource["config"]> & { mode?: string; label?: string },
): Promise<MockSource> {
  const resp = await fetch(`/api/mock-sources/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "mock update failed");
  return json.source as MockSource;
}

export async function getMockLogs(id: string): Promise<MockLogEntry[]> {
  const resp = await fetch(`/api/mock-sources/${encodeURIComponent(id)}/logs`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "mock logs failed");
  return Array.isArray(json.logs)
    ? json.logs.map((row: unknown) => {
      const item = (row || {}) as Record<string, unknown>;
      const headersRaw = (item.headers && typeof item.headers === "object") ? item.headers as Record<string, unknown> : {};
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRaw)) {
        headers[String(key || "").toLowerCase()] = String(value ?? "");
      }
      return {
        ts: String(item.ts || ""),
        method: String(item.method || "GET"),
        path: String(item.path || ""),
        query: (item.query && typeof item.query === "object") ? item.query as Record<string, unknown> : {},
        headers,
        body: String(item.body || ""),
        bodyBase64: String(item.bodyBase64 || ""),
        bodyBytes: Number(item.bodyBytes || 0),
      } as MockLogEntry;
    })
    : [];
}

export async function clearMockLogs(id: string): Promise<void> {
  const resp = await fetch(`/api/mock-sources/${encodeURIComponent(id)}/logs`, { method: "POST" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "mock clear logs failed");
}

export async function adminListUsers(): Promise<AuthUser[]> {
  const resp = await fetch("/api/admin/users");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "admin users failed");
  if (!Array.isArray(json.users)) return [];
  return json.users.map((x: unknown) => {
    const row = (x || {}) as Record<string, unknown>;
    return {
      username: String(row.username || ""),
      role: String(row.role || "user") === "admin" ? "admin" : "user",
    } as AuthUser;
  });
}

export async function adminCreateUser(input: { username: string; password: string; role: "user" | "admin" }): Promise<void> {
  const resp = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "admin create user failed");
}

export async function adminUpdateUser(
  username: string,
  input: { password?: string; role?: "user" | "admin" },
): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "admin update user failed");
}

export async function adminDeleteUser(username: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
    method: "DELETE",
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "admin delete user failed");
}

function normalizeFavoriteEntry(entry: unknown): FavoriteItem {
  const item = (entry || {}) as FavoriteItem & { permissions?: ShortLinkPermissions };
  const permissions = item.permissions && typeof item.permissions === "object"
    ? {
      canView: Boolean(item.permissions.canView),
      canEdit: Boolean(item.permissions.canEdit),
      canManageAccess: Boolean(item.permissions.canManageAccess),
      accessLevel: String(item.permissions.accessLevel || "") === "edit"
        ? "edit"
        : (String(item.permissions.accessLevel || "") === "view" ? "view" : ""),
      missing: Boolean(item.permissions.missing),
    } as ShortLinkPermissions
    : undefined;
  return normalizeFavoriteUrl({ ...item, permissions });
}

export async function fetchFavorites(): Promise<FavoriteItem[]> {
  const resp = await fetch("/api/favorites");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "favorites fetch failed");
  return Array.isArray(json.favorites) ? json.favorites.map(normalizeFavoriteEntry) : [];
}

export type FavoritesRestoreReport = {
  total: number;
  created: number;
  kept: number;
  skipped: number;
  skippedTitles: string[];
};

/** Восстановление копии: сервер заново создаёт короткие ссылки, которых уже нет. */
export async function restoreFavorites(list: FavoriteItem[]): Promise<{ favorites: FavoriteItem[]; report: FavoritesRestoreReport }> {
  const resp = await fetch("/api/favorites/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: Array.isArray(list) ? list : [] }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "favorites restore failed");
  return {
    favorites: Array.isArray(json.favorites) ? json.favorites.map(normalizeFavoriteEntry) : [],
    report: {
      total: Number(json.report?.total || 0),
      created: Number(json.report?.created || 0),
      kept: Number(json.report?.kept || 0),
      skipped: Number(json.report?.skipped || 0),
      skippedTitles: Array.isArray(json.report?.skippedTitles) ? json.report.skippedTitles.map(String) : [],
    },
  };
}

export async function saveFavorites(list: FavoriteItem[]): Promise<FavoriteItem[]> {
  const resp = await fetch("/api/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: Array.isArray(list) ? list : [] }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "favorites save failed");
  return Array.isArray(json.favorites) ? json.favorites.map(normalizeFavoriteEntry) : [];
}

export async function fetchUsageStats(days = 30): Promise<UsageStats> {
  const resp = await fetch(`/api/stats?days=${encodeURIComponent(String(days))}`);
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "stats failed");
  const stats = (json.stats || {}) as Partial<UsageStats>;
  const totals = (stats.totals || {}) as Partial<UsageStatsTotals>;
  const num = (value: unknown) => Math.max(0, Number(value || 0));
  return {
    days: num(stats.days) || days,
    scope: stats.scope === "all" ? "all" : "own",
    generatedAt: String(stats.generatedAt || ""),
    totals: {
      subscriptions: num(totals.subscriptions),
      hiddenSubscriptions: num(totals.hiddenSubscriptions),
      devices: num(totals.devices),
      blockedDevices: num(totals.blockedDevices),
      activeDevices24h: num(totals.activeDevices24h),
      activeDevices7d: num(totals.activeDevices7d),
      activeDevices30d: num(totals.activeDevices30d),
      hits: num(totals.hits),
      hitsPeriod: num(totals.hitsPeriod),
      newDevicesPeriod: num(totals.newDevicesPeriod),
    },
    daily: (Array.isArray(stats.daily) ? stats.daily : []).map((row) => ({
      day: String(row?.day || ""),
      hits: num(row?.hits),
      newDevices: num(row?.newDevices),
    })),
    byOs: (Array.isArray(stats.byOs) ? stats.byOs : []).map((row) => ({
      label: String(row?.label || ""),
      count: num(row?.count),
    })),
    byApp: (Array.isArray(stats.byApp) ? stats.byApp : []).map((row) => ({
      label: String(row?.label || ""),
      count: num(row?.count),
    })),
    topLinks: (Array.isArray(stats.topLinks) ? stats.topLinks : []).map((row) => ({
      id: String(row?.id || ""),
      title: String(row?.title || ""),
      hits: num(row?.hits),
      hitsPeriod: num(row?.hitsPeriod),
      devices: num(row?.devices),
      lastSeenAt: String(row?.lastSeenAt || ""),
    })),
    recentDevices: (Array.isArray(stats.recentDevices) ? stats.recentDevices : []).map((row) => ({
      hwid: String(row?.hwid || ""),
      shortLinkId: String(row?.shortLinkId || ""),
      title: String(row?.title || ""),
      os: String(row?.os || ""),
      app: String(row?.app || ""),
      deviceModel: String(row?.deviceModel || ""),
      blocked: Boolean(row?.blocked),
      firstSeenAt: String(row?.firstSeenAt || ""),
      lastSeenAt: String(row?.lastSeenAt || ""),
      links: Math.max(1, Number(row?.links || 1)),
    })),
  };
}

export async function pingSubscription(
  params: SubscriptionPayload,
  options: { mode?: PingMode; attempts?: number; timeoutMs?: number } = {},
): Promise<PingResponse> {
  const resp = await fetch("/api/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params,
      mode: options.mode || "tcp",
      attempts: options.attempts || 1,
      timeoutMs: options.timeoutMs || 3000,
    }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "ping failed");
  const num = (value: unknown) => Math.max(0, Number(value || 0));
  return {
    mode: (["tcp", "tls", "dns"].includes(String(json.mode)) ? json.mode : "tcp") as PingMode,
    attempts: num(json.attempts) || 1,
    timeoutMs: num(json.timeoutMs) || 3000,
    results: (Array.isArray(json.results) ? json.results : []).map((row: unknown) => {
      const item = (row || {}) as Partial<PingResult>;
      return {
        id: String(item.id || ""),
        name: String(item.name || ""),
        host: String(item.host || ""),
        port: num(item.port),
        ok: Boolean(item.ok),
        best: num(item.best),
        worst: num(item.worst),
        average: num(item.average),
        loss: num(item.loss),
        error: String(item.error || ""),
      } as PingResult;
    }),
  };
}

function normalizeSyncPeer(entry: unknown): SyncPeer {
  const row = (entry || {}) as Record<string, unknown>;
  const report = row.lastReport && typeof row.lastReport === "object"
    ? row.lastReport as Record<string, unknown>
    : {};
  return {
    id: String(row.id || ""),
    label: String(row.label || ""),
    remoteUrl: String(row.remoteUrl || ""),
    hasToken: Boolean(row.hasToken),
    enabled: Boolean(row.enabled),
    intervalMinutes: Number(row.intervalMinutes || 0),
    includeProfiles: Boolean(row.includeProfiles),
    pushEnabled: Boolean(row.pushEnabled),
    lastStatus: String(row.lastStatus || ""),
    lastError: String(row.lastError || ""),
    lastReport: report,
    lastSyncedAt: String(row.lastSyncedAt || ""),
    lastAttemptAt: String(row.lastAttemptAt || ""),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || ""),
  };
}

/**
 * Список подключённых установок.
 *
 * `syncApiEnabled` — про эту установку, а не про удалённые: без SYNC_API_TOKEN
 * она сама отдавать выгрузку не станет, и подключиться к ней не выйдет.
 */
export async function listSyncPeers(): Promise<{ peers: SyncPeer[]; syncApiEnabled: boolean }> {
  const resp = await fetch("/api/sync/peers");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync peers fetch failed");
  return {
    peers: Array.isArray(json.peers) ? json.peers.map(normalizeSyncPeer) : [],
    syncApiEnabled: Boolean(json.syncApiEnabled),
  };
}

export async function createSyncPeer(input: SyncPeerInput): Promise<SyncPeer> {
  const resp = await fetch("/api/sync/peers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync peer create failed");
  return normalizeSyncPeer(json.peer);
}

export async function updateSyncPeer(id: string, input: SyncPeerInput): Promise<SyncPeer> {
  const resp = await fetch(`/api/sync/peers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync peer update failed");
  return normalizeSyncPeer(json.peer);
}

export async function deleteSyncPeer(id: string): Promise<void> {
  const resp = await fetch(`/api/sync/peers/${encodeURIComponent(id)}`, { method: "DELETE" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync peer delete failed");
}

/** Проверка связи: импорта не делает, только сообщает, что лежит на той стороне. */
export async function testSyncPeer(input: SyncPeerInput & { id?: string }): Promise<SyncPeerTestResult> {
  const resp = await fetch("/api/sync/peers/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync peer test failed");
  const available = json.available && typeof json.available === "object"
    ? json.available as Record<string, number>
    : {};
  return {
    remoteUrl: String(json.remoteUrl || ""),
    exportedAt: String(json.exportedAt || ""),
    available,
  };
}

export async function runSyncPeer(id: string, options: { dryRun?: boolean } = {}): Promise<{ peer: SyncPeer; imported: Record<string, number>; pushed: Record<string, number> | null }> {
  const resp = await fetch(`/api/sync/peers/${encodeURIComponent(id)}/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: Boolean(options.dryRun) }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "sync failed");
  return {
    peer: normalizeSyncPeer(json.peer),
    imported: json.imported && typeof json.imported === "object" ? json.imported as Record<string, number> : {},
    pushed: json.pushed && typeof json.pushed === "object" ? json.pushed as Record<string, number> : null,
  };
}

function normalizeHealth(entry: unknown): ShortLinkHealth {
  const row = (entry || {}) as Record<string, unknown>;
  return {
    shortLinkId: String(row.shortLinkId || ""),
    checkedAt: String(row.checkedAt || ""),
    ok: Boolean(row.ok),
    unreachable: Boolean(row.unreachable),
    status: Number(row.status || 0),
    error: String(row.error || ""),
    servers: Number(row.servers || 0),
    upload: Number(row.upload || 0),
    download: Number(row.download || 0),
    total: Number(row.total || 0),
    expireAt: Number(row.expireAt || 0),
    supportUrl: String(row.supportUrl || ""),
    webPageUrl: String(row.webPageUrl || ""),
    providerTitle: String(row.providerTitle || ""),
  };
}

function normalizeUserCounts(entry: unknown): ShortLinkUserCounts {
  const row = (entry || {}) as Record<string, unknown>;
  return {
    shortLinkId: String(row.shortLinkId || ""),
    total: Number(row.total || 0),
    active: Number(row.active || 0),
    blocked: Number(row.blocked || 0),
    overLimit: Number(row.overLimit || 0),
    maxUsers: Number(row.maxUsers || 0),
  };
}

/** Проверки и счётчики устройств по всем доступным подпискам — одним запросом. */
export async function fetchShortLinkHealth(): Promise<{ health: ShortLinkHealth[]; users: ShortLinkUserCounts[] }> {
  const resp = await fetch("/api/short-links/health");
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "health fetch failed");
  return {
    health: Array.isArray(json.health) ? json.health.map(normalizeHealth) : [],
    users: Array.isArray(json.users) ? json.users.map(normalizeUserCounts) : [],
  };
}

/** Проверить одну подписку прямо сейчас. */
export async function checkShortLinkHealth(id: string): Promise<ShortLinkHealth> {
  const resp = await fetch(`/api/short-links/${encodeURIComponent(id)}/health`, { method: "POST" });
  const json = await resp.json();
  if (!resp.ok || !json.ok) throw new Error(json.error || "health check failed");
  return normalizeHealth(json.health);
}
