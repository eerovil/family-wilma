import * as Sentry from "@sentry/node";

const MAX_STACK_LENGTH = 4_000;
const SAFE_ERROR_NAMES = new Set([
  "AggregateError", "Error", "FetchError", "GaxiosError", "RangeError", "SyntaxError", "TypeError",
]);
const SAFE_MESSAGES = new Set([
  "A previous Google calendar creation has an uncertain result; inspect google-calendar-map.json before retrying",
  "Google Calendar is not connected",
  "Google Calendar permission was not granted",
  "Google did not return a calendar id",
  "Google did not return a refresh token for the calendar permission",
  "Google did not return an access token",
  "Google did not return an ID token",
  "Invalid Google calendar map",
  "Invalid lesson calendar ids in Google calendar map",
  "Invalid provisioning state in Google calendar map",
  "Invalid shared calendar id in Google calendar map",
  "Lesson window was not returned",
]);

interface ErrorReportingOptions {
  dsn: string | undefined;
  environment: string | undefined;
  release: string | undefined;
}

interface ErrorContext {
  operation: string;
  tags?: Record<string, string>;
}

let enabled = false;
let configuredSecrets: string[] = [];

export function initializeErrorReporting(options: ErrorReportingOptions): boolean {
  const dsn = options.dsn?.trim();
  configuredSecrets = dsn ? [dsn] : [];
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: options.environment?.trim() || "production",
    release: options.release?.trim() || undefined,
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    includeLocalVariables: false,
    beforeSend: scrubEvent,
  });
  enabled = true;
  return true;
}

export function configureErrorReportingSecrets(secrets: string[]): void {
  configuredSecrets = [...new Set([...configuredSecrets, ...secrets].filter((value) => value.length >= 4))];
}

export function reportError(error: unknown, context: ErrorContext): void {
  const safe = sanitizeErrorForReporting(error, configuredSecrets);
  const operation = safeTag(context.operation);
  const errorTags = safeErrorTags(error);
  const diagnosticTags = Object.entries(errorTags).map(([name, value]) => `${name}=${value}`).join(" ");
  console.error(`${operation} failed: ${safe.name}: ${safe.message}${diagnosticTags ? ` (${diagnosticTags})` : ""}`);
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag("operation", operation);
    for (const [name, value] of Object.entries(context.tags ?? {})) scope.setTag(name, safeTag(value));
    for (const [name, value] of Object.entries(errorTags)) scope.setTag(name, value);
    Sentry.captureException(safe);
  });
}

export function sanitizeErrorForReporting(error: unknown, secrets: string[] = []): Error {
  const name = safeErrorName(error);
  const originalMessage = error instanceof Error ? error.message : "";
  const message = SAFE_MESSAGES.has(originalMessage) ? originalMessage : errorCategory(error);
  const safe = new Error(message);
  safe.name = name;
  if (error instanceof Error && error.stack) {
    const frames = error.stack.split("\n").slice(1).filter((line) => /^\s*at\s/.test(line));
    safe.stack = sanitizeText(`${name}: ${message}${frames.length ? `\n${frames.join("\n")}` : ""}`, secrets, MAX_STACK_LENGTH);
  }
  return safe;
}

export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.contexts;
  delete event.server_name;
  return event;
}

function sanitizeText(value: string, secrets: string[], limit: number): string {
  let safe = value;
  for (const secret of secrets) safe = safe.replaceAll(secret, "[redacted]");
  safe = safe
    .replace(/([?&](?:code|state|token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return safe.slice(0, limit);
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

function errorCategory(error: unknown): string {
  const status = errorStatus(error);
  if (status !== null) return status >= 500 ? "External service server error" : "External service request rejected";
  if (error instanceof SyntaxError) return "Invalid structured data";
  if (error instanceof TypeError) return "Unexpected data or operation";
  return "Unexpected application error";
}

function safeErrorTags(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    code?: unknown;
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } } };
  };
  const tags: Record<string, string> = {};
  const status = errorStatus(error);
  if (status !== null) tags.http_status = String(status);
  if (typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(candidate.code)) {
    tags.error_code = candidate.code;
  }
  const providerReason = candidate.response?.data?.error?.errors?.[0]?.reason ?? candidate.errors?.[0]?.reason;
  if (typeof providerReason === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(providerReason)) {
    tags.provider_reason = providerReason;
  }
  const providerStatus = candidate.response?.data?.error?.status;
  if (typeof providerStatus === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(providerStatus)) {
    tags.provider_status = providerStatus;
  }
  return tags;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeTag(value: string): string {
  return /^[A-Za-z0-9_./-]{1,64}$/.test(value) ? value : "UNKNOWN";
}

export async function flushErrorReporting(timeoutMs = 2_000): Promise<boolean> {
  return enabled ? await Sentry.flush(timeoutMs) : true;
}
