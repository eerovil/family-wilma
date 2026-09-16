import { createHash } from "node:crypto";
import type { FetchedMessage } from "./wilma.js";

const HELSINKI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Helsinki",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface MessageMember {
  sourceType?: "message" | "notice";
  accountId: string;
  studentNumber: string;
  messageId: number;
  child: string;
}

export interface GroupedMessage extends FetchedMessage {
  children: string[];
  members: MessageMember[];
  groupId: string;
  displaySentAt: Date;
  analysisAliases: FetchedMessage[];
  logicalMessageId?: string;
  logicalSentDate?: string;
}

function helsinkiDate(date: Date): string {
  const parts = Object.fromEntries(HELSINKI_DATE.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function duplicateKey(message: FetchedMessage): string {
  return [message.sourceType ?? "message", helsinkiDate(message.sentAt), message.sender, message.subject, message.content].join("\0");
}

function canonicalOrder(left: FetchedMessage, right: FetchedMessage): number {
  return left.accountId.localeCompare(right.accountId)
    || left.studentNumber.localeCompare(right.studentNumber)
    || left.messageId - right.messageId;
}

export function messageSourcePrefix(message: MessageMember): string {
  const source = message.sourceType === "notice" ? "wilma-notice" : "wilma-message";
  return `${source}:${message.accountId}:${message.studentNumber}:${message.messageId}:`;
}

export function groupMessages(messages: FetchedMessage[]): GroupedMessage[] {
  const groups = new Map<string, FetchedMessage[]>();
  for (const message of messages) {
    const key = duplicateKey(message);
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }

  return [...groups.entries()].flatMap(([key, members]) => {
    const orderedMembers = [...members].sort(canonicalOrder);
    const children = [...new Set(members.map((message) => message.child))]
      .sort((left, right) => left.localeCompare(right, "fi"));
    if (children.length === 1 && members.length > 1) {
      return orderedMembers.map((message) => groupedMessage(duplicateKey(message), [message], [message.child], false));
    }
    return [groupedMessage(key, orderedMembers, children, true)];
  }).sort((left, right) => {
    return right.displaySentAt.getTime() - left.displaySentAt.getTime()
      || left.groupId.localeCompare(right.groupId)
      || canonicalOrder(left, right);
  });
}

function groupedMessage(key: string, orderedMembers: FetchedMessage[], children: string[], stableIdentity: boolean): GroupedMessage {
  const canonical = orderedMembers[0]!;
  const newest = orderedMembers.reduce((latest, message) => message.sentAt > latest ? message.sentAt : latest, canonical.sentAt);
  const groupId = createHash("sha256").update(key).digest("hex");
  return {
    ...canonical,
    child: children.join(" & "),
    children,
    members: orderedMembers.map(({ sourceType, accountId, studentNumber, messageId, child }) => ({
      ...(sourceType ? { sourceType } : {}),
      accountId,
      studentNumber,
      messageId,
      child,
    })),
    groupId,
    displaySentAt: newest,
    analysisAliases: stableIdentity ? orderedMembers : [],
    ...(stableIdentity ? { logicalMessageId: groupId, logicalSentDate: helsinkiDate(canonical.sentAt) } : {}),
  };
}
