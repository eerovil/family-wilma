import { WilmaClient, type StudentInfo, type WilmaProfile } from "@wilm-ai/wilma-client";
import type { AppConfig, ProfileMapping, WilmaAccountConfig } from "./config.js";

export class MfaCodeRequiredError extends Error {
  constructor(readonly accountId: string) {
    super(`Wilma MFA code required for ${accountId}`);
    this.name = "MfaCodeRequiredError";
  }
}

export interface FetchedMessage {
  accountId: string;
  studentNumber: string;
  child: string;
  messageId: number;
  subject: string;
  sender: string;
  sentAt: Date;
  content: string;
}

export interface SourceCalendarItem {
  sourceId: string;
  title: string;
  date: string;
  time: string | null;
  endDate: string | null;
  description: string | null;
}

export interface WilmaBundle {
  messages: FetchedMessage[];
  structuredCalendarItems: SourceCalendarItem[];
}

export class WilmaService {
  private readonly mfaCodes = new Map<string, string>();

  constructor(private readonly config: AppConfig) {}

  submitMfaCode(accountId: string, code: string): void {
    if (!this.config.wilmaAccounts.some((account) => account.id === accountId)) {
      throw new Error("Unknown Wilma account");
    }
    const clean = code.trim();
    if (!clean) throw new Error("MFA code cannot be empty");
    this.mfaCodes.set(accountId, clean);
  }

  async discoverProfiles(accountId: string): Promise<StudentInfo[]> {
    const account = this.account(accountId);
    return WilmaClient.listStudents(this.baseProfile(account), this.mfaCallback(account));
  }

  async fetchAll(): Promise<WilmaBundle> {
    const messages: FetchedMessage[] = [];
    const structuredCalendarItems: SourceCalendarItem[] = [];
    for (const account of this.config.wilmaAccounts) {
      for (const profile of account.profiles) {
        const client = await WilmaClient.login(this.profile(account, profile), this.mfaCallback(account));
        const listed = await client.messages.list("inbox");
        for (const summary of listed) {
          const detail = await client.messages.get(summary.wilmaId);
          messages.push({
            accountId: account.id,
            studentNumber: profile.studentNumber,
            child: profile.child,
            messageId: detail.wilmaId,
            subject: detail.subject || summary.subject || "(ei otsikkoa)",
            sender: detail.senderName?.trim() || "Wilma",
            sentAt: detail.sentAt,
            content: detail.content?.trim() || "",
          });
        }
        const exams = await client.exams.list();
        for (const exam of exams) {
          structuredCalendarItems.push({
            sourceId: `wilma-exam:${account.id}:${profile.studentNumber}:${exam.wilmaId}`,
            title: `${profile.child}: ${exam.subject}`,
            date: exam.dateString,
            time: null,
            endDate: null,
            description: [exam.description, exam.notes, exam.teacher ? `Opettaja: ${exam.teacher}` : null]
              .filter((value): value is string => Boolean(value && value.trim()))
              .join("\n") || null,
          });
        }
      }
    }
    messages.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    return { messages, structuredCalendarItems };
  }

  private account(accountId: string): WilmaAccountConfig {
    const account = this.config.wilmaAccounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("Unknown Wilma account");
    return account;
  }

  private baseProfile(account: WilmaAccountConfig): WilmaProfile {
    return { baseUrl: account.baseUrl, username: account.username, password: account.password };
  }

  private profile(account: WilmaAccountConfig, mapping: ProfileMapping): WilmaProfile {
    return { ...this.baseProfile(account), studentNumber: mapping.studentNumber };
  }

  private mfaCallback(account: WilmaAccountConfig): (formkey: string) => Promise<string> {
    return async () => {
      const code = this.mfaCodes.get(account.id);
      if (!code) throw new MfaCodeRequiredError(account.id);
      this.mfaCodes.delete(account.id);
      return code;
    };
  }
}
