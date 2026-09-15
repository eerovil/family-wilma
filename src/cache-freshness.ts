export const CACHE_FRESHNESS_MS = 15 * 60 * 1_000;

export function cacheIsFresh(updatedAt: string | null, now: Date): boolean {
  if (!updatedAt) return false;
  const savedAt = new Date(updatedAt).getTime();
  if (!Number.isFinite(savedAt)) return false;
  const age = now.getTime() - savedAt;
  return age >= 0 && age < CACHE_FRESHNESS_MS;
}
