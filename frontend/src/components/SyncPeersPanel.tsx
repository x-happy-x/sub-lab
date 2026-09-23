import { useEffect, useMemo, useState } from "react";
import type { SyncPeer } from "../types";
import {
  createSyncPeer,
  deleteSyncPeer,
  listSyncPeers,
  runSyncPeer,
  testSyncPeer,
  updateSyncPeer,
} from "../lib/api";
import { Badge, Button, TextInput, Tooltip } from "../ui";

type Props = {
  /** Сообщения наверх: панель сама тостов не рисует. */
  notify: (level: "success" | "error" | "info", text: string) => void;
  /** Синхронизация меняет подписки — список на главной надо перечитать. */
  onSynced?: () => void;
};

type Draft = {
  label: string;
  remoteUrl: string;
  remoteToken: string;
  enabled: boolean;
  intervalMinutes: number;
  includeProfiles: boolean;
  pushEnabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  label: "",
  remoteUrl: "",
  remoteToken: "",
  enabled: true,
  intervalMinutes: 0,
  includeProfiles: true,
  pushEnabled: true,
};

const INTERVALS: Array<[number, string]> = [
  [0, "вручную"],
  [5, "каждые 5 минут"],
  [15, "каждые 15 минут"],
  [60, "раз в час"],
  [360, "раз в 6 часов"],
  [1440, "раз в сутки"],
];

const SECTION_TITLES: Record<string, string> = {
  shortLinks: "ссылки",
  access: "доступы",
  favorites: "списки",
  userPolicies: "лимиты",
  linkUsers: "устройства",
  userHistory: "история",
  subscriptionOverrides: "overrides",
  profileFiles: "профили",
  hitCounters: "счётчики",
};

function formatCounts(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${SECTION_TITLES[key] || key}: ${Number(count)}`)
    .join(", ");
}

function formatMoment(value: string): string {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

function draftFromPeer(peer: SyncPeer): Draft {
  return {
    label: peer.label,
    remoteUrl: peer.remoteUrl,
    // Токен не приходит с сервера, поле остаётся пустым: пустое — «не менять».
    remoteToken: "",
    enabled: peer.enabled,
    intervalMinutes: peer.intervalMinutes,
    includeProfiles: peer.includeProfiles,
    pushEnabled: peer.pushEnabled,
  };
}

function PeerForm({ draft, onChange, tokenHint }: {
  draft: Draft;
  onChange: (next: Draft) => void;
  tokenHint: string;
}) {
  return (
    <div className="sync-form">
      <label className="field">
        <span className="field-label">Название</span>
        <TextInput
          value={draft.label}
          placeholder="Например, дом"
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">Адрес установки</span>
        <TextInput
          value={draft.remoteUrl}
          placeholder="https://sub.example.com"
          onChange={(e) => onChange({ ...draft, remoteUrl: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">Токен синхронизации</span>
        <TextInput
          type="password"
          value={draft.remoteToken}
          autoComplete="off"
          placeholder={tokenHint}
          onChange={(e) => onChange({ ...draft, remoteToken: e.target.value })}
        />
        <span className="field-hint">Значение SYNC_API_TOKEN удалённой установки. Обратно он не отдаётся.</span>
      </label>
      <label className="field">
        <span className="field-label">Расписание</span>
        <select
          value={String(draft.intervalMinutes)}
          onChange={(e) => onChange({ ...draft, intervalMinutes: Number(e.target.value) || 0 })}
        >
          {INTERVALS.map(([minutes, label]) => (
            <option key={minutes} value={minutes}>{label}</option>
          ))}
        </select>
      </label>
      <label className="sync-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
        />
        <span>Синхронизация включена</span>
      </label>
      <label className="sync-check">
        <input
          type="checkbox"
          checked={draft.includeProfiles}
          onChange={(e) => onChange({ ...draft, includeProfiles: e.target.checked })}
        />
        <span>Забирать профили и UA-каталог</span>
      </label>
      <label className="sync-check">
        <input
          type="checkbox"
          checked={draft.pushEnabled}
          onChange={(e) => onChange({ ...draft, pushEnabled: e.target.checked })}
        />
        <span>Досылать туда то, чего там нет</span>
      </label>
    </div>
  );
}

export function SyncPeersPanel({ notify, onSynced }: Props) {
  const [peers, setPeers] = useState<SyncPeer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [syncApiEnabled, setSyncApiEnabled] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await listSyncPeers();
      setPeers(result.peers);
      setSyncApiEnabled(result.syncApiEnabled);
    } catch (e) {
      notify("error", (e as Error).message || "не удалось получить список серверов");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Список нужен один раз при открытии админки: дальше его двигают кнопки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduled = useMemo(
    () => peers.filter((peer) => peer.enabled && peer.intervalMinutes > 0).length,
    [peers],
  );

  const guard = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (e) {
      notify("error", (e as Error).message || "не получилось");
    } finally {
      setBusy("");
    }
  };

  const onTest = (draft: Draft, id?: string) => guard(`test:${id || "new"}`, async () => {
    const result = await testSyncPeer({
      id,
      remoteUrl: draft.remoteUrl.trim(),
      remoteToken: draft.remoteToken.trim(),
    });
    const counts = formatCounts(result.available);
    notify("success", `${result.remoteUrl} отвечает${counts ? ` — ${counts}` : ""}`);
  });

  const onAdd = () => guard("add", async () => {
    const peer = await createSyncPeer({
      label: addDraft.label.trim(),
      remoteUrl: addDraft.remoteUrl.trim(),
      remoteToken: addDraft.remoteToken.trim(),
      enabled: addDraft.enabled,
      intervalMinutes: addDraft.intervalMinutes,
      includeProfiles: addDraft.includeProfiles,
      pushEnabled: addDraft.pushEnabled,
    });
    setAddDraft(EMPTY_DRAFT);
    setAddOpen(false);
    notify("success", `Сервер ${peer.remoteUrl} подключён`);
    await refresh();
  });

  const onSave = (id: string) => guard(`save:${id}`, async () => {
    await updateSyncPeer(id, {
      label: editDraft.label.trim(),
      remoteUrl: editDraft.remoteUrl.trim(),
      remoteToken: editDraft.remoteToken.trim(),
      enabled: editDraft.enabled,
      intervalMinutes: editDraft.intervalMinutes,
      includeProfiles: editDraft.includeProfiles,
      pushEnabled: editDraft.pushEnabled,
    });
    setEditingId("");
    notify("success", "Настройки сохранены");
    await refresh();
  });

  const onRun = (peer: SyncPeer, dryRun: boolean) => guard(`run:${peer.id}`, async () => {
    const result = await runSyncPeer(peer.id, { dryRun });
    const counts = formatCounts(result.imported);
    const pushedCounts = formatCounts(result.pushed);
    notify(
      "success",
      dryRun
        ? `Проверка прошла, импорта не было${counts ? ` — ${counts}` : ""}`
        : [
          `Забрали${counts ? `: ${counts}` : " — нового нет"}`,
          result.pushed ? `отдали${pushedCounts ? `: ${pushedCounts}` : " — нового нет"}` : "",
        ].filter(Boolean).join("; "),
    );
    await refresh();
    if (!dryRun) onSynced?.();
  });

  const onRemove = (peer: SyncPeer) => {
    if (!window.confirm(`Отключить синхронизацию с ${peer.remoteUrl}? Уже загруженные данные останутся.`)) return;
    void guard(`del:${peer.id}`, async () => {
      await deleteSyncPeer(peer.id);
      notify("success", "Сервер отключён");
      await refresh();
    });
  };

  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <h2>Синхронизация</h2>
        <p>
          Ходит всегда только эта установка: забирает изменения с удалённой и, если включена досылка,
          отдаёт туда то, чего там нет. Удалённая ничего не инициирует — ей достаточно отдавать выгрузку
          и принимать импорт по токену.
          {scheduled > 0 ? ` Сейчас по расписанию: ${scheduled}.` : ""}
        </p>
      </div>

      {!loading && !syncApiEnabled ? (
        <div className="status">
          У этой установки не задан SYNC_API_TOKEN — значит, забирать данные <em>у неё</em> никто не сможет.
          Забирать чужие она умеет и без него.
        </div>
      ) : null}

      {loading ? <div className="status">Загрузка...</div> : null}

      <div className="cards sync-peers-list">
        {!loading && peers.length === 0 ? (
          <article className="card empty-state">
            <div className="empty-state-title">Серверов нет</div>
            <div className="empty-state-text">
              Подключите удалённую установку один раз — дальше изменения будут приезжать сами.
            </div>
          </article>
        ) : null}

        {peers.map((peer) => {
          const editing = editingId === peer.id;
          const counts = formatCounts(peer.lastReport && (peer.lastReport as Record<string, unknown>).available);
          return (
            <article key={peer.id} className="card sync-peer-card">
              <div className="sync-peer-head">
                <div className="sync-peer-main">
                  <div className="sub-name">{peer.label || peer.remoteUrl}</div>
                  <div className="sync-peer-url">{peer.remoteUrl}</div>
                </div>
                <div className="labels">
                  {peer.enabled ? null : <Badge>выключен</Badge>}
                  <Badge>{peer.pushEnabled ? "в обе стороны" : "только забирать"}</Badge>
                  <Badge>
                    {peer.intervalMinutes > 0
                      ? (INTERVALS.find(([m]) => m === peer.intervalMinutes)?.[1] || `раз в ${peer.intervalMinutes} мин`)
                      : "вручную"}
                  </Badge>
                  {peer.lastStatus === "ok" ? <Badge tone="ok">последняя: успех</Badge> : null}
                  {peer.lastStatus === "dry-run" ? <Badge>последняя: проверка</Badge> : null}
                  {peer.lastStatus === "error" ? <Badge tone="danger">последняя: ошибка</Badge> : null}
                </div>
              </div>

              <div className="sync-peer-meta">
                <div>Успешно синхронизировано: {formatMoment(peer.lastSyncedAt)}</div>
                <div>Последняя попытка: {formatMoment(peer.lastAttemptAt)}</div>
                {counts ? <div>На той стороне: {counts}</div> : null}
                {peer.lastError ? <div className="sync-peer-error">{peer.lastError}</div> : null}
              </div>

              {editing ? (
                <>
                  <PeerForm
                    draft={editDraft}
                    onChange={setEditDraft}
                    tokenHint={peer.hasToken ? "оставьте пустым, чтобы не менять" : "токен не задан"}
                  />
                  <div className="toolbar">
                    <Button tone="primary" disabled={Boolean(busy)} onClick={() => onSave(peer.id)}>Сохранить</Button>
                    <Button disabled={Boolean(busy)} onClick={() => onTest(editDraft, peer.id)}>Проверить связь</Button>
                    <Button disabled={Boolean(busy)} onClick={() => setEditingId("")}>Отмена</Button>
                  </div>
                </>
              ) : (
                <div className="toolbar">
                  <Tooltip content="Забрать изменения прямо сейчас">
                    <Button tone="primary" disabled={Boolean(busy)} onClick={() => onRun(peer, false)}>
                      {busy === `run:${peer.id}` ? "Синхронизирую..." : "Синхронизировать"}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Показать, что приедет, ничего не меняя">
                    <Button disabled={Boolean(busy)} onClick={() => onRun(peer, true)}>Проверить</Button>
                  </Tooltip>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => { setEditingId(peer.id); setEditDraft(draftFromPeer(peer)); }}
                  >
                    Настроить
                  </Button>
                  <Button tone="danger" disabled={Boolean(busy)} onClick={() => onRemove(peer)}>Отключить</Button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {addOpen ? (
        <article className="card sync-peer-card">
          <div className="admin-section-head">
            <h2>Новый сервер</h2>
            <p>Адрес удалённой установки и её токен синхронизации.</p>
          </div>
          <PeerForm draft={addDraft} onChange={setAddDraft} tokenHint="SYNC_API_TOKEN удалённой установки" />
          <div className="toolbar">
            <Button tone="primary" disabled={Boolean(busy)} onClick={onAdd}>Подключить</Button>
            <Button disabled={Boolean(busy)} onClick={() => onTest(addDraft)}>Проверить связь</Button>
            <Button disabled={Boolean(busy)} onClick={() => { setAddOpen(false); setAddDraft(EMPTY_DRAFT); }}>Отмена</Button>
          </div>
        </article>
      ) : (
        <div className="toolbar">
          <Button tone="primary" onClick={() => setAddOpen(true)}>Подключить сервер</Button>
        </div>
      )}
    </section>
  );
}
