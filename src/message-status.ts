export const TERMINAL_STATUS_TTL_MS = 10_000;

export interface TransientStatus {
  id: string;
  hideAfterMs: number;
}

export function transientStatus(id: string, finishedAt: string | null, now = Date.now()): TransientStatus | null {
  if (!finishedAt) return null;
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(finished)) return null;
  const hideAfterMs = TERMINAL_STATUS_TTL_MS - Math.max(0, now - finished);
  return hideAfterMs > 0 ? { id, hideAfterMs } : null;
}

export const MESSAGE_STATUS_CLIENT_SCRIPT = `"use strict";
(function () {
  Array.from(document.querySelectorAll("[data-transient-status]")).forEach(function (status) {
    var id = status.getAttribute("data-transient-status");
    var key = "family-wilma-status:" + id;
    try {
      if (sessionStorage.getItem(key)) {
        status.remove();
        return;
      }
      sessionStorage.setItem(key, "shown");
    } catch (_) {}
    var delay = Number(status.getAttribute("data-status-hide-after"));
    setTimeout(function () { status.remove(); }, Number.isFinite(delay) ? Math.max(0, delay) : 0);
  });
}());`;
