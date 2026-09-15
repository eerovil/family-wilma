import { messageSourcePrefix, type GroupedMessage } from "./message-group.js";
import type { CalendarItem } from "./store.js";
import type { SourceCalendarItem } from "./wilma.js";

export interface AnalyzedMessage {
  message: GroupedMessage;
  calendarItems: CalendarItem[];
  hasOtherContent: boolean;
}

export interface MessageCalendarProjection {
  items: SourceCalendarItem[];
  supersededSourcePrefixes: string[];
}

export function messageCalendarProjection(analyzed: AnalyzedMessage[]): MessageCalendarProjection {
  const supersededSourcePrefixes = new Set<string>();
  const items = analyzed.flatMap(({ message, calendarItems }) => {
    const canonicalPrefix = message.logicalMessageId
      ? `wilma-message-group:${message.logicalMessageId}:`
      : messageSourcePrefix(message);
    const messageSupersededPrefixes = message.logicalMessageId ? message.members.map(messageSourcePrefix) : [];
    for (const prefix of messageSupersededPrefixes) supersededSourcePrefixes.add(prefix);
    return calendarItems.map((item, index) => ({
      sourceId: `${canonicalPrefix}${index}`,
      title: `${message.children.join(" & ")}: ${item.title}`,
      date: item.date,
      time: item.time,
      endDate: item.endDate,
      description: item.description ?? `Wilma-viesti: ${message.subject}`,
      supersededSourceIds: messageSupersededPrefixes.map((prefix) => `${prefix}${index}`),
    }));
  });
  return { items, supersededSourcePrefixes: [...supersededSourcePrefixes] };
}
