import type { FavoriteItem } from "../types";

const STORAGE_KEY = "sublab.favorites.v2";
/** Ключ прежнего имени сервиса: читаем один раз и переносим. */
const LEGACY_STORAGE_KEY = "submirror.favorites.v2";

function readRaw(): string | null {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current !== null) return current;
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy === null) return null;
  localStorage.setItem(STORAGE_KEY, legacy);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return legacy;
}

export function readFavorites(): FavoriteItem[] {
  try {
    const raw = readRaw();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === "object");
  } catch {
    return [];
  }
}

export function writeFavorites(list: FavoriteItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
}
