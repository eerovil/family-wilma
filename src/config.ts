export interface ProfileMapping {
  studentNumber: string;
  child: string;
}

export interface WilmaAccountConfig {
  id: string;
  baseUrl: string;
  username: string;
  password: string;
  profiles: ProfileMapping[];
}

export interface AppConfig {
  port: number;
  baseUrl: string;
  dataDir: string;
  anthropicApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleCalendarId: string;
  wilmaAccounts: WilmaAccountConfig[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAccounts(): WilmaAccountConfig[] {
  const raw = process.env.WILMA_ACCOUNTS_JSON?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("WILMA_ACCOUNTS_JSON must be a JSON array");
  const ids = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Wilma account ${index} is not an object`);
    const object = entry as Record<string, unknown>;
    const id = String(object.id ?? "").trim();
    const baseUrl = String(object.baseUrl ?? "").trim().replace(/\/$/, "");
    const username = String(object.username ?? "").trim();
    const password = String(object.password ?? "");
    if (!id || !baseUrl || !username || !password) {
      throw new Error(`Wilma account ${index} requires id, baseUrl, username and password`);
    }
    if (ids.has(id)) throw new Error(`Duplicate Wilma account id: ${id}`);
    ids.add(id);
    const rawProfiles = object.profiles;
    if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
      throw new Error(`Wilma account ${id} needs at least one profile mapping`);
    }
    const profiles = rawProfiles.map((profile, profileIndex) => {
      if (!profile || typeof profile !== "object") {
        throw new Error(`Wilma account ${id} profile ${profileIndex} is not an object`);
      }
      const p = profile as Record<string, unknown>;
      const studentNumber = String(p.studentNumber ?? "").trim();
      const child = String(p.child ?? "").trim();
      if (!studentNumber || !child) {
        throw new Error(`Wilma account ${id} profile ${profileIndex} requires studentNumber and child`);
      }
      return { studentNumber, child };
    });
    return { id, baseUrl, username, password, profiles };
  });
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const baseUrl = (process.env.APP_BASE_URL ?? `http://localhost:${port}`).trim().replace(/\/$/, "");
  return {
    port,
    baseUrl,
    dataDir: process.env.DATA_DIR?.trim() || "./data",
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID?.trim() || "primary",
    wilmaAccounts: parseAccounts(),
  };
}
