import { load } from "cheerio";

const DATE_HEADING = /^(ma|ti|ke|to|pe|la|su)\s+(\d{1,2})\.(\d{1,2})\.$/i;
const WEEKDAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"] as const;

export interface PedanetHomework {
  date: string;
  heading: string;
  content: string;
  sourceUrl: string;
  personalizationStatus: "unresolved";
}

interface DatedBlock {
  date: string;
  heading: string;
  content: string;
}

export class PedanetHomeworkService {
  constructor(
    private readonly sourceUrl: string,
    private readonly expectedModuleId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async latest(): Promise<PedanetHomework> {
    const response = await this.fetchImpl(this.sourceUrl, {
      headers: {
        accept: "text/html",
        "user-agent": "family-wilma/0.1 homework reader",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Peda.net homework request failed");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html")) throw new Error("Peda.net homework response was not HTML");
    const parsed = parseLatestPedanetHomework(await response.text(), this.expectedModuleId, this.now());
    return { ...parsed, sourceUrl: this.sourceUrl, personalizationStatus: "unresolved" };
  }
}

export function parseLatestPedanetHomework(html: string, expectedModuleId: string, now = new Date()): DatedBlock {
  const $ = load(html);
  const article = $("article.textmodule.document[data-draft-type='published']")
    .filter((_index, element) => $(element).find("h1").first().text().trim().toLocaleUpperCase("fi") === "LÄKSYT")
    .first();
  if (!article.length) throw new Error("Peda.net homework module was not found");

  if (article.attr("data-id") !== expectedModuleId) throw new Error("Peda.net homework module identity changed");
  const content = article.find("div.main > div.content.enclose").first().clone();
  if (!content.length) throw new Error("Peda.net homework content was not found");
  content.find("br").replaceWith("\n");

  const schoolYear = $("body").text().match(/(20\d{2})\s*[-–]\s*(20\d{2})/);
  if (!schoolYear?.[1] || !schoolYear[2]) throw new Error("Peda.net school year was not found");
  const startYear = Number(schoolYear[1]);
  const endYear = Number(schoolYear[2]);
  if (endYear !== startYear + 1) throw new Error("Peda.net school year was invalid");

  const lines = content.text()
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const blocks: DatedBlock[] = [];
  let current: { heading: string; date: string; lines: string[] } | null = null;
  const seen = new Set<string>();
  for (const line of lines) {
    const match = DATE_HEADING.exec(line);
    if (match?.[1] && match[2] && match[3]) {
      if (current) blocks.push(finishBlock(current));
      const day = Number(match[2]);
      const month = Number(match[3]);
      const year = month >= 8 ? startYear : endYear;
      const date = validDate(year, month, day, match[1].toLowerCase());
      if (seen.has(date)) throw new Error("Peda.net homework date was duplicated");
      seen.add(date);
      current = { heading: line, date, lines: [] };
    } else if (current && line) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(finishBlock(current));
  const today = helsinkiDate(now);
  const latest = blocks.filter((block) => block.date <= today).sort((left, right) => right.date.localeCompare(left.date))[0];
  if (!latest) throw new Error("Peda.net homework had no current dated block");
  if (!latest.content) throw new Error("Peda.net homework current dated block was empty");
  return latest;
}

function finishBlock(block: { heading: string; date: string; lines: string[] }): DatedBlock {
  const content = block.lines.join("\n").trim();
  return { date: block.date, heading: block.heading, content };
}

function validDate(year: number, month: number, day: number, weekday: string): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new Error("Peda.net homework date was invalid");
  }
  if (WEEKDAYS[value.getUTCDay()] !== weekday) throw new Error("Peda.net homework weekday did not match its date");
  return value.toISOString().slice(0, 10);
}

function helsinkiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
