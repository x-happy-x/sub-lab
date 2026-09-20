export type Endpoint = "sub" | "last";
export type Output = "raw" | "raw_base64" | "json" | "yml";
/** Насколько разворачивать записи подписки в форматах без вложенности. */
export type NodesMode = "collapse" | "group" | "expand";

export type SubscriptionPayload = {
  endpoint: Endpoint;
  sub_url: string;
  output: Output;
  output_auto?: string;
  app?: string;
  device?: string;
  profile?: string;
  profiles?: string;
  hwid?: string;
  clash_groups?: string;
  nodes?: NodesMode | "";
};

export type FavoriteItem = {
  title: string;
  url: string;
  payload: SubscriptionPayload;
  labels: string[];
  tags?: string[];
  shortId?: string;
  hidden?: boolean;
  permissions?: ShortLinkPermissions;
  /** Подписка выдана через доступ к короткой ссылке: в своём списке не хранится. */
  derived?: boolean;
  /** Чужая подписка, которую видит админ. В фильтре по умолчанию скрыта. */
  foreign?: boolean;
  /** Владелец короткой ссылки: пусто у ссылок, созданных до появления ролей. */
  ownerUsername?: string;
  ts: number;
};

/**
 * Удалённая установка, с которой этот сервер тянет данные.
 *
 * Токен наружу не отдаётся: интерфейс знает только, задан он или нет.
 */
export type SyncPeer = {
  id: string;
  label: string;
  remoteUrl: string;
  hasToken: boolean;
  enabled: boolean;
  intervalMinutes: number;
  includeProfiles: boolean;
  lastStatus: string;
  lastError: string;
  lastReport: Record<string, unknown>;
  lastSyncedAt: string;
  lastAttemptAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SyncPeerInput = {
  label?: string;
  remoteUrl?: string;
  remoteToken?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  includeProfiles?: boolean;
};

export type SyncPeerTestResult = {
  remoteUrl: string;
  exportedAt: string;
  available: Record<string, number>;
};

export type ShortLinkPermissions = {
  canView: boolean;
  canEdit: boolean;
  canManageAccess: boolean;
  accessLevel: "" | "view" | "edit";
  /** Короткой ссылки нет в базе: запись осталась от прежней установки. */
  missing?: boolean;
};

export type ShortLinkAccessGrant = {
  username: string;
  role: "user" | "admin";
  accessLevel: "view" | "edit";
};

export type ImportedProxyItem = {
  index: number;
  flag: string;
  name: string;
  normalizedName: string;
  normalizedUri: string;
  uri: string;
  type: string;
  server: string;
  port: number;
  uuid: string;
  password: string;
  network: string;
  security: string;
  sni: string;
  servername: string;
  flow: string;
  fp: string;
  clientFingerprint: string;
  pbk: string;
  publicKey: string;
  sid: string;
  shortId: string;
  path: string;
  host: string;
  serviceName: string;
  transport: Record<string, string>;
};

export type SubTestResponse = {
  ok: boolean;
  request?: {
    endpoint: Endpoint;
    subUrl: string;
    output: string;
    app?: string;
    device?: string;
    profiles?: string[];
  };
  upstream?: {
    status: number;
    url: string;
    bodyBytes: number;
    sourceFormat: string;
    servers: string[];
    body?: string;
  };
  conversion?: {
    ok: boolean;
    conversion?: string;
    outputFormat?: string;
    error?: string;
    servers?: string[];
    body?: string;
  };
  cache?: {
    exists: boolean;
    validation?: {
      ok: boolean;
      error?: string;
    };
  };
  error?: string;
};

export type ProfileCatalog = {
  profiles: string[];
  items?: ProfileCatalogItem[];
};

export type ProfileCatalogItem = {
  name: string;
  ownerUsername: string;
  editable: boolean;
  visibility: "shared" | "private";
  source: "builtin" | "custom";
};

export type UACatalog = {
  options: Record<string, Record<string, string>>;
  defaultUa?: string;
};

export type MockSourceConfig = {
  preset: string;
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  delayMs: number;
};

export type MockSource = {
  id: string;
  config: MockSourceConfig;
  logsCount?: number;
  meta?: {
    ownerUsername?: string;
    mode?: string;
    label?: string;
  };
};

export type MockLogEntry = {
  ts: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  bodyBytes?: number;
};

/** Роль в account: `viewer` смотрит, `editor` правит, `admin` управляет всем. */
export type AccountRole = "none" | "viewer" | "editor" | "admin";

export type AuthUser = {
  username: string;
  role: "user" | "admin";
  accountRole?: AccountRole;
  canEdit?: boolean;
};

export type ShortLinkUserHistoryEntry = {
  eventType: string;
  changedAt: string;
  ip: string;
  userAgent: string;
  deviceModel: string;
  deviceOs: string;
  app: string;
  device: string;
  acceptLanguage: string;
};

export type ShortLinkUserItem = {
  hwid: string;
  firstSeenAt: string;
  lastSeenAt: string;
  blocked: boolean;
  blockReason: string;
  lastSeen: {
    ip: string;
    userAgent: string;
    deviceModel: string;
    deviceOs: string;
    app: string;
    device: string;
    acceptLanguage: string;
  };
  history: ShortLinkUserHistoryEntry[];
};

export type ShortLinkUsersData = {
  shortLinkId: string;
  policy: {
    maxUsers: number;
    blockedMessage: string;
    limitMessage: string;
    updatedAt: string;
  };
  summary: {
    usersCount: number;
    blockedCount: number;
    activeCount: number;
  };
  users: ShortLinkUserItem[];
};

export type UsageStatsTotals = {
  subscriptions: number;
  hiddenSubscriptions: number;
  devices: number;
  blockedDevices: number;
  activeDevices24h: number;
  activeDevices7d: number;
  activeDevices30d: number;
  hits: number;
  hitsPeriod: number;
  newDevicesPeriod: number;
};

export type UsageStatsDay = {
  day: string;
  hits: number;
  newDevices: number;
};

export type UsageStatsBreakdown = {
  label: string;
  count: number;
};

export type UsageStatsTopLink = {
  id: string;
  title: string;
  hits: number;
  hitsPeriod: number;
  devices: number;
  lastSeenAt: string;
};

export type UsageStatsDevice = {
  hwid: string;
  shortLinkId: string;
  title: string;
  os: string;
  app: string;
  deviceModel: string;
  blocked: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type UsageStats = {
  days: number;
  scope: "all" | "own";
  generatedAt: string;
  totals: UsageStatsTotals;
  daily: UsageStatsDay[];
  byOs: UsageStatsBreakdown[];
  byApp: UsageStatsBreakdown[];
  topLinks: UsageStatsTopLink[];
  recentDevices: UsageStatsDevice[];
};

/** Что делать, когда регулярка не нашла ни одного сервера источника. */
export type MergeOnEmpty = "all" | "skip" | "error";

export type MergeItem = SubscriptionPayload & {
  title?: string;
  shortId?: string;
  filter?: { pattern: string; onEmpty: MergeOnEmpty };
};

export type MergedSource = {
  id: string;
  name: string;
  items: MergeItem[];
  createdAt: string;
  updatedAt: string;
};

export type MergePreviewResult = {
  ok: boolean;
  error: string;
  names: string[];
};

/** Вариант замера: что именно пингуем до сервера. */
export type PingMode = "tcp" | "tls" | "dns";

export type PingResult = {
  id: string;
  name: string;
  host: string;
  port: number;
  ok: boolean;
  best: number;
  worst: number;
  average: number;
  loss: number;
  error: string;
};

export type PingResponse = {
  mode: PingMode;
  attempts: number;
  timeoutMs: number;
  results: PingResult[];
};
