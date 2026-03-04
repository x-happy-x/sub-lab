import fs from "node:fs";
import path from "node:path";
import { PROFILE_ROOT_DIRS } from "./config.js";

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function listAvailableProfiles() {
  const baseSet = new Set();
  const uaSet = new Set();
  const seenDirs = new Set();

  for (const root of PROFILE_ROOT_DIRS) {
    for (const dir of [path.join(root, "base"), path.join(root, "ua"), root]) {
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(/^(.+)\.(yml|yaml)$/i);
        if (!m) continue;
        const profileName = m[1];
        if (profileName.startsWith("ua-")) uaSet.add(profileName);
        else baseSet.add(profileName);
      }
    }
  }

  return {
    base: Array.from(baseSet).sort(),
    ua: Array.from(uaSet).sort(),
  };
}

function renderHomePage() {
  const profileCatalog = listAvailableProfiles();
  const baseChips = profileCatalog.base
    .map((name) => `<button type="button" class="chip chip-check base-chip" data-profile="${escapeHtmlAttr(name)}">${escapeHtmlAttr(name)}</button>`)
    .join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sub Mirror Studio</title>
  <style>
    :root {
      --bg: #070a14;
      --bg2: #0c1223;
      --line: #243a62;
      --line-soft: #1a2c4a;
      --text: #edf4ff;
      --muted: #99aed7;
      --aqua: #4be4e8;
      --blue: #6aa6ff;
      --rose: #ff7894;
      --warn: #ffc97d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      background:
        radial-gradient(1000px 540px at -10% -8%, rgba(70, 110, 205, 0.36), transparent 68%),
        radial-gradient(840px 420px at 110% 10%, rgba(38, 141, 126, 0.28), transparent 68%),
        linear-gradient(160deg, var(--bg), var(--bg2));
      padding: 22px 18px 30px;
    }
    .page {
      max-width: 1240px;
      margin: 0 auto;
      display: grid;
      gap: 12px;
      grid-template-columns: 1.15fr 0.85fr;
    }
    .section {
      border: 0;
      border-top: 1px solid var(--line-soft);
      border-radius: 0;
      background: transparent;
      padding: 12px 0;
    }
    .hero {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: linear-gradient(140deg, var(--aqua), var(--blue), #9d86ff);
      position: relative;
    }
    .logo::after {
      content: "";
      position: absolute;
      inset: 8px;
      border-radius: 8px;
      background: #0b1326;
    }
    .brand h1 {
      margin: 0;
      font-size: 27px;
      line-height: 1;
    }
    .brand p {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .pill {
      border: 1px solid var(--line);
      background: #11203f;
      color: #c0d3f8;
      border-radius: 999px;
      padding: 7px 10px;
      font-size: 12px;
    }
    .fields {
      display: grid;
      gap: 10px;
      grid-template-columns: 1fr 1fr;
    }
    .field.full { grid-column: 1 / -1; }
    label {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .25px;
      margin-bottom: 6px;
      color: #c6d6f4;
    }
    input[type="text"] {
      width: 100%;
      border: 1px solid var(--line);
      background: #0a1327;
      color: var(--text);
      border-radius: 10px;
      padding: 10px 11px;
      font-size: 14px;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: #5fc5ff;
      box-shadow: 0 0 0 3px rgba(95, 197, 255, 0.18);
    }
    .hint {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .chip-group {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .chip {
      border: 1px solid #2f4a7b;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
      transition: transform .12s ease, filter .15s ease, border-color .15s ease;
      background: #14233f;
      color: #d7e5ff;
    }
    .chip:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .chip.active {
      background: linear-gradient(100deg, var(--aqua), var(--blue));
      color: #061427;
      border-color: rgba(125, 213, 255, 0.45);
      font-weight: 700;
    }
    .chip-wide {
      width: 100%;
      text-align: center;
      padding: 11px 12px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .btn {
      border: 1px solid #2f4a7b;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      cursor: pointer;
      color: #f2f7ff;
      background: #172744;
    }
    .btn:hover { filter: brightness(1.08); }
    .btn-primary {
      background: linear-gradient(105deg, var(--aqua), var(--blue));
      color: #071628;
      border-color: rgba(118, 221, 255, 0.5);
      font-weight: 700;
    }
    .btn-happ {
      background: linear-gradient(105deg, #90e8ff, #7e95ff);
      color: #08152b;
      border-color: rgba(164, 186, 255, 0.45);
    }
    .btn-fl {
      background: linear-gradient(105deg, #9effcd, #5ce0ff);
      color: #062218;
      border-color: rgba(138, 245, 220, 0.45);
    }
    .btn-danger {
      background: #2b1421;
      border-color: #633248;
      color: #ffd6df;
    }
    .result {
      margin-top: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #091224;
      font-family: "JetBrains Mono", "Consolas", monospace;
      font-size: 12px;
      padding: 10px;
      word-break: break-all;
      min-height: 38px;
    }
    .status { min-height: 16px; margin-top: 7px; color: var(--muted); font-size: 12px; }
    .status.warn { color: var(--warn); }
    .status.error { color: var(--rose); }
    .qr {
      margin-top: 10px;
      min-height: 238px;
      display: grid;
      place-items: center;
      border: 1px dashed #35507f;
      border-radius: 12px;
      background: rgba(8, 16, 31, 0.7);
      padding: 10px;
    }
    .qr img {
      width: 220px;
      height: 220px;
      background: #fff;
      border-radius: 10px;
      padding: 8px;
    }
    .saved-list {
      display: grid;
      gap: 8px;
      max-height: 320px;
      overflow: auto;
      padding-right: 2px;
    }
    .saved-item {
      border: 1px solid #2d436e;
      border-radius: 10px;
      background: #0f1d37;
      padding: 9px;
    }
    .saved-name {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .saved-url {
      color: #a4bae6;
      font-size: 11px;
      font-family: "JetBrains Mono", "Consolas", monospace;
      word-break: break-all;
      margin-bottom: 7px;
    }
    .saved-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .modal {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(2, 6, 16, 0.72);
      z-index: 50;
      padding: 16px;
    }
    .modal.open { display: flex; }
    .modal-box {
      width: min(680px, 100%);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #0f1a33;
      padding: 14px;
    }
    .modal-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }
    @media (max-width: 980px) {
      .page { grid-template-columns: 1fr; }
      .fields { grid-template-columns: 1fr; }
      .modal-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="section hero">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <h1>Sub Mirror</h1>
          <p>Subscription Link Studio</p>
        </div>
      </div>
      <div class="pill">UI Builder</div>
    </section>

    <section class="section">
      <div class="fields">
        <div class="field full">
          <label for="sub_url">sub_url</label>
          <input id="sub_url" type="text" placeholder="https://example.com/sub" />
          <div class="hint">URL источника подписки.</div>
        </div>

        <div class="field full">
          <label>Режим запроса</label>
          <input id="endpoint" type="hidden" value="last" />
          <button type="button" id="cacheToggle" class="chip chip-wide active">Кэшировать подписку</button>
          <div class="hint">Включено: <code>/last</code> (с кэшем). Выключено: <code>/sub</code> (без кэша).</div>
        </div>

        <div class="field">
          <label>output</label>
          <input id="output" type="hidden" value="yml" />
          <div id="outputChips" class="chip-group">
            <button type="button" class="chip active" data-value="yml">yml / clash</button>
            <button type="button" class="chip" data-value="raw">raw</button>
          </div>
          <div class="hint">Целевой формат ответа.</div>
        </div>

        <div class="field">
          <label>app</label>
          <input id="app" type="hidden" value="flclashx" />
          <div id="appChips" class="chip-group">
            <button type="button" class="chip active" data-value="flclashx">flclashx</button>
            <button type="button" class="chip" data-value="happ">happ</button>
            <button type="button" class="chip" data-value="">не указывать</button>
          </div>
          <div class="hint">Выбор app для auto UA.</div>
        </div>

        <div class="field full">
          <label>Профили (base)</label>
          <input id="profile" type="hidden" value="" />
          <input id="profiles" type="hidden" value="" />
          <div id="baseProfileChecks" class="chip-group">${baseChips || "<span style=\"color:var(--muted);font-size:12px;\">Нет профилей</span>"}</div>
          <div class="hint">Выберите один или несколько. Первый уйдет в <code>profile</code>, остальные в <code>profiles</code>.</div>
        </div>

        <div class="field">
          <label>device</label>
          <input id="device" type="hidden" value="android" />
          <div id="deviceChips" class="chip-group">
            <button type="button" class="chip active" data-value="android">android</button>
            <button type="button" class="chip" data-value="windows">windows</button>
            <button type="button" class="chip" data-value="ios">ios</button>
            <button type="button" class="chip" data-value="linux">linux</button>
            <button type="button" class="chip" data-value="">не указывать</button>
          </div>
          <div class="hint">Платформа для ua-&lt;app&gt;-&lt;device&gt;.</div>
        </div>

        <div class="field">
          <label for="hwid">hwid</label>
          <input id="hwid" type="text" placeholder="device-hwid" />
          <div class="hint">Переопределение x-hwid.</div>
        </div>
      </div>

      <div class="toolbar">
        <button id="openImportModal" class="btn">Импорт из ссылки</button>
      </div>
    </section>

    <section class="section">
      <label>Готовая ссылка</label>
      <div id="result" class="result"></div>
      <div id="status" class="status"></div>

      <div class="toolbar">
        <button id="openLink" class="btn btn-primary">Открыть ссылку</button>
        <button id="copyLink" class="btn">Копировать</button>
        <button id="saveLink" class="btn">В избранное</button>
        <button id="openHapp" class="btn btn-happ">Подключить в Happ</button>
        <button id="openFl" class="btn btn-fl">Подключить в FlClashX</button>
      </div>

      <div id="qrWrap" class="qr">
        <div style="color:var(--muted);font-size:13px;text-align:center;">Заполните <code>sub_url</code>, чтобы показать QR</div>
      </div>
    </section>

    <section class="section">
      <label>Избранные ссылки</label>
      <div id="savedList" class="saved-list"></div>
      <div class="toolbar">
        <button id="clearSaved" class="btn btn-danger">Очистить избранное</button>
      </div>
    </section>
  </main>

  <div id="importModal" class="modal" role="dialog" aria-modal="true">
    <div class="modal-box">
      <label for="import_link">Импорт из ссылки</label>
      <div class="hint">Вставьте готовую ссылку /sub или /last для автозаполнения формы.</div>
      <div class="modal-row">
        <input id="import_link" type="text" placeholder="http://localhost:25500/last?app=..." />
        <button id="importApply" class="btn btn-primary">Применить</button>
        <button id="importClose" class="btn">Закрыть</button>
      </div>
    </div>
  </div>

  <script>
    const qs = (id) => document.getElementById(id);
    const fields = ["sub_url", "endpoint", "output", "app", "device", "profile", "profiles", "hwid"];
    const state = {};
    for (const k of fields) state[k] = qs(k);

    const resultEl = qs("result");
    const statusEl = qs("status");
    const qrWrap = qs("qrWrap");
    const savedListEl = qs("savedList");
    const STORAGE_KEY = "submirror.favorites.v1";

    function withStatus(message, mode) {
      statusEl.className = mode ? "status " + mode : "status";
      statusEl.textContent = message || "";
    }

    function setupChipGroup(groupId, inputId) {
      const group = qs(groupId);
      group.addEventListener("click", (event) => {
        const chip = event.target.closest("button[data-value]");
        if (!chip) return;
        state[inputId].value = chip.dataset.value || "";
        syncChips();
        update();
      });
    }

    setupChipGroup("outputChips", "output");
    setupChipGroup("appChips", "app");
    setupChipGroup("deviceChips", "device");

    const selectedBaseProfiles = [];

    function syncBaseProfileHidden() {
      state.profile.value = selectedBaseProfiles[0] || "";
      state.profiles.value = selectedBaseProfiles.slice(1).join(",");
    }

    function syncBaseProfileChips() {
      const group = qs("baseProfileChecks");
      for (const chip of group.querySelectorAll("button[data-profile]")) {
        const name = chip.dataset.profile || "";
        chip.classList.toggle("active", selectedBaseProfiles.includes(name));
      }
    }

    function setBaseProfiles(list) {
      selectedBaseProfiles.length = 0;
      for (const raw of list) {
        const name = String(raw || "").trim();
        if (!name || selectedBaseProfiles.includes(name)) continue;
        selectedBaseProfiles.push(name);
      }
      syncBaseProfileHidden();
      syncBaseProfileChips();
    }

    qs("baseProfileChecks").addEventListener("click", (event) => {
      const chip = event.target.closest("button[data-profile]");
      if (!chip) return;
      const name = chip.dataset.profile || "";
      if (!name) return;
      const idx = selectedBaseProfiles.indexOf(name);
      if (idx >= 0) selectedBaseProfiles.splice(idx, 1);
      else selectedBaseProfiles.push(name);
      syncBaseProfileHidden();
      syncBaseProfileChips();
      update();
    });

    const cacheToggle = qs("cacheToggle");
    cacheToggle.addEventListener("click", () => {
      const nextIsCache = state.endpoint.value !== "last";
      state.endpoint.value = nextIsCache ? "last" : "sub";
      cacheToggle.classList.toggle("active", nextIsCache);
      cacheToggle.textContent = nextIsCache ? "Кэшировать подписку" : "Без кэширования";
      update();
    });

    function syncChips() {
      for (const pair of [
        ["outputChips", "output"],
        ["appChips", "app"],
        ["deviceChips", "device"],
      ]) {
        const group = qs(pair[0]);
        const val = state[pair[1]].value;
        for (const el of group.querySelectorAll("button[data-value]")) {
          const active = (el.dataset.value || "") === val;
          el.classList.toggle("active", active);
        }
      }
      const isCache = (state.endpoint.value || "last") === "last";
      cacheToggle.classList.toggle("active", isCache);
      cacheToggle.textContent = isCache ? "Кэшировать подписку" : "Без кэширования";
    }

    function getValues() {
      const out = {};
      for (const key of fields) out[key] = (state[key].value || "").trim();
      return out;
    }

    function setValues(values) {
      for (const key of fields) state[key].value = values[key] || "";
      const mergedProfiles = [];
      if (state.profile.value) mergedProfiles.push(state.profile.value);
      for (const p of (state.profiles.value || "").split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!mergedProfiles.includes(p)) mergedProfiles.push(p);
      }
      setBaseProfiles(mergedProfiles);
      syncChips();
    }

    function buildUrl() {
      const origin = window.location.origin;
      const endpoint = state.endpoint.value || "last";
      const params = new URLSearchParams();
      for (const key of ["sub_url", "output", "app", "device", "profile", "profiles", "hwid"]) {
        const value = (state[key].value || "").trim();
        if (value) params.set(key, value);
      }
      if (!params.get("output")) params.set("output", "yml");
      return origin + "/" + endpoint + "?" + params.toString();
    }

    function parseUrlToValues(raw) {
      try {
        const u = new URL(raw, window.location.origin);
        const routePath = (u.pathname || "").replace(/^\/+/, "");
        const values = {
          endpoint: routePath === "sub" ? "sub" : "last",
          sub_url: u.searchParams.get("sub_url") || "",
          output: u.searchParams.get("output") || "yml",
          app: u.searchParams.get("app") || "",
          device: u.searchParams.get("device") || "",
          profile: u.searchParams.get("profile") || "",
          profiles: u.searchParams.get("profiles") || "",
          hwid: u.searchParams.get("hwid") || "",
        };
        return { ok: true, values: values };
      } catch {
        return { ok: false, error: "Некорректная ссылка" };
      }
    }

    function buildQr(url) {
      if (!state.sub_url.value.trim()) {
        qrWrap.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;">Заполните <code>sub_url</code>, чтобы показать QR</div>';
        return;
      }
      const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=" + encodeURIComponent(url);
      qrWrap.innerHTML = '<img alt="QR" src="' + qrUrl + '">';
    }

    function update() {
      syncBaseProfileHidden();
      const url = buildUrl();
      resultEl.textContent = url;
      buildQr(url);
      withStatus(state.sub_url.value.trim() ? "" : "Укажите sub_url", "warn");
      return url;
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        withStatus("Скопировано");
      } catch {
        withStatus("Не удалось скопировать", "error");
      }
    }

    function readFavorites() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writeFavorites(list) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 30)));
    }

    function renderFavorites() {
      const list = readFavorites();
      if (!list.length) {
        savedListEl.innerHTML = '<div style="border:1px dashed #35507f;border-radius:10px;padding:11px;color:var(--muted);font-size:12px;">Список избранного пуст</div>';
        return;
      }
      savedListEl.innerHTML = list.map((item, idx) => {
        const name = String(item.name || "Избранная ссылка").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const url = String(item.url || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return ''
          + '<div class="saved-item">'
          + '  <div class="saved-name">' + name + '</div>'
          + '  <div class="saved-url">' + url + '</div>'
          + '  <div class="saved-actions">'
          + '    <button class="btn" data-action="open" data-idx="' + idx + '">Открыть</button>'
          + '    <button class="btn" data-action="edit" data-idx="' + idx + '">Редактировать</button>'
          + '    <button class="btn btn-danger" data-action="delete" data-idx="' + idx + '">Удалить</button>'
          + '  </div>'
          + '</div>';
      }).join('');
    }

    function addFavorite() {
      const url = update();
      if (!state.sub_url.value.trim()) {
        withStatus("Сначала заполните sub_url", "warn");
        return;
      }
      const values = getValues();
      const profileLabel = selectedBaseProfiles.length ? selectedBaseProfiles.join("+") : "no-profiles";
      const name = [values.app || "app", values.device || "device", profileLabel].join(" / ");
      const list = readFavorites().filter((it) => it.url !== url);
      list.unshift({ name: name, url: url, ts: Date.now() });
      writeFavorites(list);
      renderFavorites();
      withStatus("Добавлено в избранное");
    }

    function openDeepLink(kind) {
      const link = update();
      if (!state.sub_url.value.trim()) {
        withStatus("Сначала заполните sub_url", "warn");
        return;
      }
      const encoded = encodeURIComponent(link);
      const scheme = kind === "happ"
        ? "happ://add-subscription?url=" + encoded
        : "flclash://install-config?url=" + encoded;
      window.location.href = scheme;
      setTimeout(() => void copyText(link), 300);
      withStatus("Пробую открыть клиент: " + (kind === "happ" ? "Happ" : "FlClashX"));
    }

    for (const key of ["sub_url", "hwid"]) {
      state[key].addEventListener("input", update);
    }

    qs("openLink").addEventListener("click", () => {
      const link = update();
      if (!state.sub_url.value.trim()) {
        withStatus("Сначала заполните sub_url", "warn");
        return;
      }
      window.open(link, "_blank", "noopener,noreferrer");
    });
    qs("copyLink").addEventListener("click", () => void copyText(update()));
    qs("saveLink").addEventListener("click", addFavorite);
    qs("openHapp").addEventListener("click", () => openDeepLink("happ"));
    qs("openFl").addEventListener("click", () => openDeepLink("fl"));

    savedListEl.addEventListener("click", async (event) => {
      const target = event.target.closest("button[data-action]");
      if (!target) return;
      const idx = Number(target.dataset.idx || "-1");
      const list = readFavorites();
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return;
      const item = list[idx];
      const action = target.dataset.action || "";

      if (action === "open") {
        window.open(item.url || "", "_blank", "noopener,noreferrer");
        return;
      }
      if (action === "edit") {
        const parsed = parseUrlToValues(item.url || "");
        if (!parsed.ok) {
          withStatus("Ссылка в избранном повреждена", "error");
          return;
        }
        setValues(parsed.values);
        update();
        withStatus("Избранная ссылка загружена в форму");
        return;
      }
      if (action === "delete") {
        list.splice(idx, 1);
        writeFavorites(list);
        renderFavorites();
        withStatus("Удалено из избранного");
      }
    });

    qs("clearSaved").addEventListener("click", () => {
      writeFavorites([]);
      renderFavorites();
      withStatus("Избранное очищено");
    });

    const modal = qs("importModal");
    const importInput = qs("import_link");
    function closeImportModal() {
      modal.classList.remove("open");
    }
    function openImportModal() {
      modal.classList.add("open");
      setTimeout(() => importInput.focus(), 20);
    }
    function applyImport() {
      const parsed = parseUrlToValues((importInput.value || "").trim());
      if (!parsed.ok) {
        withStatus(parsed.error, "error");
        return;
      }
      setValues(parsed.values);
      update();
      closeImportModal();
      withStatus("Параметры импортированы");
    }
    qs("openImportModal").addEventListener("click", openImportModal);
    qs("importClose").addEventListener("click", closeImportModal);
    qs("importApply").addEventListener("click", applyImport);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeImportModal();
    });

    const from = new URL(window.location.href).searchParams.get("from");
    if (from) {
      importInput.value = from;
      applyImport();
    } else {
      setBaseProfiles([]);
      syncChips();
      update();
    }
    renderFavorites();
  </script>
</body>
</html>`;
}

export { renderHomePage };
