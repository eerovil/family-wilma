import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LIVE_REFRESH_CLIENT_SCRIPT, pollHead } from "./live-refresh.js";
import { pwaAsset } from "./pwa.js";

interface FakeElement {
  height: number;
  top: number;
  removed: boolean;
  replacedBy: FakeElement | null;
  banners: FakeElement[];
  children: FakeElement[];
  attributes: Record<string, string>;
  listeners: Record<string, () => void>;
  className?: string;
  type?: string;
  textContent?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { top: number; height: number };
  querySelectorAll(selector: string): FakeElement[];
  remove(): void;
  replaceWith(next: FakeElement): void;
  appendChild(child: FakeElement): void;
  addEventListener(type: string, handler: () => void): void;
}

function element(options: { height?: number; top?: number; content?: string; banners?: number } = {}): FakeElement {
  const node: FakeElement = {
    height: options.height ?? 100,
    top: options.top ?? 0,
    removed: false,
    replacedBy: null,
    banners: [],
    children: [],
    attributes: options.content ? { content: options.content } : {},
    listeners: {},
    getAttribute: (name) => node.attributes[name] ?? null,
    setAttribute: (name, value) => { node.attributes[name] = value; },
    getBoundingClientRect: () => ({ top: node.top, height: node.height }),
    querySelectorAll: (selector) => selector === "[data-transient-status]" ? node.banners.filter((banner) => !banner.removed) : [],
    remove: () => { node.removed = true; },
    replaceWith: (next) => { node.replacedBy = next; },
    appendChild: (child) => { node.children.push(child); },
    addEventListener: (type, handler) => { node.listeners[type] = handler; },
  };
  for (let index = 0; index < (options.banners ?? 0); index += 1) node.banners.push(element());
  return node;
}

/** A reply page as the client would find it after parsing. */
interface Page { status?: FakeElement; polling?: boolean; mfa?: boolean }
interface Reply { page?: Page; ok?: boolean; type?: string; reject?: boolean }

function harness(options: {
  scrollY?: number; openMessage?: boolean; filter?: boolean; statusTop?: number; polling?: boolean;
  anchors?: boolean; replies: Reply[];
}) {
  const status = element({ top: options.statusTop ?? 0 });
  const main = element();
  const timers: (() => void)[] = [];
  const fetches: { url: string; init: Record<string, string> }[] = [];
  const navigations: string[] = [];
  const scrolls: number[] = [];
  const pages = new Map<string, Page>();
  const view = {
    scrollY: options.scrollY ?? 0,
    setTimeout: (callback: () => void) => { timers.push(callback); },
    scrollBy: (_x: number, y: number) => { scrolls.push(y); },
    location: {
      replace: (url: string) => { navigations.push(`replace ${url}`); },
      assign: (url: string) => { navigations.push(`assign ${url}`); },
    },
    fetch: (url: string, init: Record<string, string>) => {
      fetches.push({ url, init });
      const reply = options.replies.shift();
      if (!reply || reply.reject) return Promise.reject(new TypeError("offline"));
      const key = `page-${fetches.length}`;
      if (reply.page) pages.set(key, reply.page);
      return Promise.resolve({ ok: reply.ok ?? true, type: reply.type ?? "basic", text: () => Promise.resolve(key) });
    },
    DOMParser: class {
      parseFromString(key: string) {
        const page = pages.get(key) ?? {};
        return {
          querySelector: (selector: string) => {
            if (selector === '[data-live="status"]') return page.status ?? null;
            if (selector === 'meta[name="family-wilma-poll"]') return page.polling ? element() : null;
            if (selector === 'form[action="/mfa"]') return page.mfa ? element() : null;
            return null;
          },
        };
      }
    },
  };
  const document = {
    querySelector: (selector: string) => {
      if (selector === 'meta[name="family-wilma-poll"]') {
        return options.polling === false ? null : element({ content: "5;url=/messages" });
      }
      if (selector === '[data-live="status"]') return status;
      if (selector === "details[open]") return options.openMessage ? element() : null;
      if (selector === '[data-message-filter][aria-pressed="true"]') return options.filter ? element() : null;
      if (selector === "main") return main;
      return null;
    },
    createElement: () => element(),
  };
  // Browsers with scroll anchoring correct scrollY themselves during the swap.
  status.replaceWith = (next) => {
    status.replacedBy = next;
    if (options.anchors && status.top < 0) view.scrollY += next.height - status.height;
  };
  runInNewContext(LIVE_REFRESH_CLIENT_SCRIPT, { window: view, document });
  return {
    status, main, fetches, navigations, scrolls,
    timersPending: () => timers.length,
    async tick() {
      const next = timers.shift();
      assert.ok(next, "a check is scheduled");
      next();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("poll head keeps a self-reload only for browsers without scripts", () => {
  const head = pollHead(5, "/messages");
  assert.match(head, /<meta name="family-wilma-poll" content="5;url=\/messages">/);
  assert.equal(head.match(/http-equiv="refresh"/g)?.length, 1);
  assert.match(head, /<noscript><meta http-equiv="refresh" content="5;url=\/messages"><\/noscript>/);
});

test("the client is served and does nothing on a page that is not following a job", () => {
  assert.match(String(pwaAsset("/live-refresh.js")?.headers["content-type"]), /text\/javascript/);
  const page = harness({ polling: false, replies: [] });
  assert.equal(page.timersPending(), 0);
  assert.equal(page.fetches.length, 0);
});

test("while the job runs only the status area changes and nothing navigates", async () => {
  const fresh = element();
  const page = harness({ scrollY: 900, replies: [{ page: { status: fresh, polling: true } }] });
  await page.tick();
  assert.equal(page.fetches[0]!.url, "/messages");
  assert.equal(page.fetches[0]!.init.redirect, "manual");
  assert.equal(page.status.replacedBy, fresh);
  assert.deepEqual(page.navigations, []);
  assert.deepEqual(page.scrolls, []);
  assert.equal(page.timersPending(), 1, "the next check is scheduled");
});

test("a status area above the screen keeps the reader's text still when it changes height", async () => {
  const page = harness({ scrollY: 900, statusTop: -300, replies: [{ page: { status: element({ height: 140 }), polling: true } }] });
  await page.tick();
  assert.deepEqual(page.scrolls, [40]);
});

test("a browser that already anchored the scroll is not corrected twice", async () => {
  const page = harness({ scrollY: 900, statusTop: -300, anchors: true, replies: [{ page: { status: element({ height: 140 }), polling: true } }] });
  await page.tick();
  assert.deepEqual(page.scrolls, []);
});

test("finished at the top with nothing open reloads quietly after the last status swap", async () => {
  const fresh = element();
  const page = harness({ replies: [{ page: { status: fresh, polling: false } }] });
  await page.tick();
  assert.equal(page.status.replacedBy, fresh, "no stale running status is left behind");
  assert.deepEqual(page.navigations, ["replace /messages"]);
  assert.equal(page.timersPending(), 0);
});

for (const [name, state] of [
  ["scrolled down", { scrollY: 600 }],
  ["reading a message", { openMessage: true }],
  ["filtering", { filter: true }],
] as const) {
  test(`finished while ${name} shows the bar instead of moving the page`, async () => {
    const fresh = element();
    const page = harness({ ...state, replies: [{ page: { status: fresh, polling: false } }] });
    await page.tick();
    assert.equal(page.status.replacedBy, fresh);
    assert.deepEqual(page.navigations, []);
    assert.equal(page.timersPending(), 0, "checking stops");
    const bar = page.main.children.at(-1);
    assert.equal(bar?.className, "refresh-ready");
    const button = bar?.children[0];
    assert.equal(button?.textContent, "Uudet tiedot valmiina — Näytä");
    button?.listeners.click?.();
    assert.deepEqual(page.navigations, ["replace /messages"]);
  });
}

test("a Wilma code prompt opens even when its reply is an error", async () => {
  for (const ok of [true, false]) {
    const page = harness({ scrollY: 600, replies: [{ ok, page: { mfa: true } }] });
    await page.tick();
    assert.deepEqual(page.navigations, ["assign /messages"]);
    assert.equal(page.main.children.length, 0, "no new-data bar for a page that needs input");
  }
});

test("an expired session goes to sign-in instead of retrying forever", async () => {
  const page = harness({ scrollY: 600, replies: [{ type: "opaqueredirect", ok: false }] });
  await page.tick();
  assert.deepEqual(page.navigations, ["assign /messages"]);
});

test("errors, busy pages and lost connections are retried quietly", async () => {
  const page = harness({ replies: [{ ok: false, page: { status: element(), polling: true } }, { page: {} }, { reject: true }] });
  for (let check = 0; check < 3; check += 1) {
    await page.tick();
    assert.equal(page.timersPending(), 1, `check ${check + 1} schedules another`);
  }
  assert.equal(page.status.replacedBy, null);
  assert.deepEqual(page.navigations, []);
});

test("finished-job banners are left for the next page load", async () => {
  const fresh = element({ banners: 1 });
  const page = harness({ replies: [{ page: { status: fresh, polling: true } }] });
  await page.tick();
  assert.equal(fresh.banners[0]!.removed, true);
  assert.equal(page.status.replacedBy, fresh);
});
