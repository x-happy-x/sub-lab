import type { FavoriteItem } from "../types";

const STORAGE_KEY = "submirror.favorites.v2";

export function readFavorites(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
