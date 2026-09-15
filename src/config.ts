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
  host: string;
  baseUrl: string;
  dataDir: string;
  analysisMode: "anthropic" | "manual";
  anthropicApiKey: string | null;
  googleClientId: string;
  googleClientSecret: string;
  googleAllowedEmail: string;
  googleAllowedLoginEmails: string[];
  pedanetHomeworkUrl: string | null;
  pedanetHomeworkModuleId: string | null;
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
    const rawProfiles = object.profiles ?? [];
    if (!Array.isArray(rawProfiles)) throw new Error(`Wilma account ${id} profiles must be an array`);
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
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const analysisMode = process.env.ANALYSIS_MODE?.trim() || "anthropic";
  if (analysisMode !== "anthropic" && analysisMode !== "manual") {
    throw new Error("ANALYSIS_MODE must be anthropic or manual");
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  if (analysisMode === "anthropic" && !anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");
  if (analysisMode === "manual") {
    let hostname: string;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      throw new Error("APP_BASE_URL must be a valid URL");
    }
    const loopbackNames = new Set(["localhost", "127.0.0.1", "::1"]);
    if (!loopbackNames.has(host) || !loopbackNames.has(hostname)) {
      throw new Error("Manual analysis requires loopback HOST and APP_BASE_URL");
    }
  }
  const googleAllowedEmail = required("GOOGLE_ALLOWED_EMAIL").toLowerCase();
  const googleAllowedLoginEmails = (process.env.GOOGLE_ALLOWED_LOGIN_EMAILS?.trim() || googleAllowedEmail)
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (new Set(googleAllowedLoginEmails).size !== googleAllowedLoginEmails.length) {
    throw new Error("GOOGLE_ALLOWED_LOGIN_EMAILS must not contain duplicates");
  }
  if (!googleAllowedLoginEmails.includes(googleAllowedEmail)) {
    throw new Error("GOOGLE_ALLOWED_LOGIN_EMAILS must include GOOGLE_ALLOWED_EMAIL");
  }
  return {
    port,
    host,
    baseUrl,
    dataDir: process.env.DATA_DIR?.trim() || "./data",
    analysisMode,
    anthropicApiKey,
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    googleAllowedEmail,
    googleAllowedLoginEmails,
    pedanetHomeworkUrl: process.env.PEDANET_HOMEWORK_URL?.trim() || null,
    pedanetHomeworkModuleId: process.env.PEDANET_HOMEWORK_MODULE_ID?.trim() || null,
    wilmaAccounts: parseAccounts(),
  };
}
