import { WilmaSession } from "@wilm-ai/wilma-client";

/** Longest one Wilma request may take, body included, before it fails. */
export const WILMA_REQUEST_TIMEOUT_MS = 30_000;

type RawRequest = (this: WilmaSession, path: string, init?: RequestInit) => Promise<Response>;

const prototype = WilmaSession.prototype as unknown as { rawRequest: RawRequest };
const originalRawRequest = prototype.rawRequest;
let requests = 0;

/**
 * The Wilma client sets no time limit, so a server that never answers left a
 * refresh on "päivitetään…" for good, and every other Wilma job waited behind
 * it. The client offers no hook for this, so its one request method is wrapped:
 * every Wilma request, logins included, gets a time limit and is counted for
 * the server log.
 */
export function installWilmaRequestLimits(timeoutMs = WILMA_REQUEST_TIMEOUT_MS): void {
  prototype.rawRequest = function (path, init) {
    requests += 1;
    return originalRawRequest.call(this, path, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}

export function wilmaRequestCount(): number {
  return requests;
}
