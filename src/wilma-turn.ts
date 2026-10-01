import type { AnalyzeSyncSnapshot } from "./analyze-sync.js";
import type { HomeworkRefreshSnapshot } from "./homework-refresh.js";
import type { MessageLoadSnapshot } from "./message-load.js";

export interface WilmaJobStates {
  homework: Pick<HomeworkRefreshSnapshot, "state" | "waiting">;
  messages: MessageLoadSnapshot["state"];
  sync: AnalyzeSyncSnapshot["state"];
}

/*
 * Only one job reads Wilma at a time. An analysis batch runs at Anthropic and
 * never reads Wilma, so "analyzing" blocks nothing: before this, a batch that
 * took hours held every homework and message refresh for those hours.
 */

/** A homework refresh waits while messages are loading or the calendar is syncing. */
export function homeworkMustWait(jobs: WilmaJobStates): boolean {
  return jobs.messages === "fetching" || jobs.messages === "mfa"
    || jobs.sync === "syncing" || jobs.sync === "mfa";
}

/** A message refresh is refused while homework or the calendar sync is using Wilma. */
export function messageRefreshBlocked(jobs: WilmaJobStates): boolean {
  return jobs.homework.state === "running" || jobs.homework.state === "mfa"
    || jobs.sync === "syncing" || jobs.sync === "mfa";
}

/**
 * The calendar sync, after its batch, waits for a homework refresh or message
 * load that is actually reading Wilma. A homework refresh that is itself waiting
 * is not counted, so the two can never wait for each other.
 */
export function calendarSyncMustWait(jobs: WilmaJobStates): boolean {
  return (jobs.homework.state === "running" && !jobs.homework.waiting) || jobs.messages === "fetching";
}
