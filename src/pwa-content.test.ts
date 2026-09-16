import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { MANIFEST, PUBLIC_PWA_PATHS, serviceWorkerSource } from "./pwa-content.js";
import { pwaAsset } from "./pwa.js";

test("PWA identity is installable and origin-bound", () => {
  const manifest = JSON.parse(MANIFEST) as {
    name: string; id: string; start_url: string; scope: string; display: string;
    icons: { sizes: string; purpose: string }[];
  };
  const base = "https://example.test/manifest.webmanifest";
  assert.equal(manifest.name, "Family Wilma");
  assert.equal(manifest.display, "standalone");
  assert.equal(new URL(manifest.id, base).href, "https://example.test/family-wilma-pwa");
  assert.equal(new URL(manifest.start_url, base).href, "https://example.test/");
  assert.equal(new URL(manifest.scope, base).href, "https://example.test/");
  assert.deepEqual(new Set(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`)), new Set([
    "192x192:any", "512x512:any", "512x512:maskable",
  ]));
});

test("service worker caches successful pages but never OAuth routes or writes", () => {
  const source = serviceWorkerSource("123456789abc");
  assert.match(source, /family-wilma-123456789abc/);
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /cache\.put\(key, response\.clone\(\)\)/);
  assert.match(source, /"\/oauth\/google\/callback"/);
  assert.match(source, /response\.redirected/);
  assert.match(source, /cache\.match\(key\)/);
  assert.match(source, /url\.pathname === "\/homework"/);
  assert.ok(PUBLIC_PWA_PATHS.includes("/offline"));
  assert.ok(PUBLIC_PWA_PATHS.includes("/message-filters.js"));
  assert.ok(PUBLIC_PWA_PATHS.includes("/message-status.js"));
});

test("client updates immediately without reloading its first service-worker claim", () => {
  const client = String(pwaAsset("/pwa.js")?.body);
  assert.match(client, /var controlled = navigator\.serviceWorker\.controller !== null/);
  assert.match(client, /if \(!controlled\)/);
  assert.doesNotMatch(client, /activelyEditing|hasChangedField|details\[open\]/);
});

test("PWA assets are public-ready with exact response headers", () => {
  assert.match(String(pwaAsset("/manifest.webmanifest")?.headers["content-type"]), /application\/manifest\+json/);
  assert.equal(pwaAsset("/sw.js")?.headers["service-worker-allowed"], "/");
  assert.equal(pwaAsset("/icon-192.png")?.headers["content-type"], "image/png");
  assert.match(String(pwaAsset("/message-filters.js")?.headers["content-type"]), /text\/javascript/);
  assert.match(String(pwaAsset("/message-status.js")?.headers["content-type"]), /text\/javascript/);
  assert.equal(pwaAsset("/missing"), null);
});

test("a calendar checkbox saves in the background instead of reloading the page", async () => {
  const client = String(pwaAsset("/pwa.js")?.body);
  let changeHandler: ((event: unknown) => void) | null = null;
  const requests: Array<{ url: string; init: { method: string; body: string; headers: Record<string, string> } }> = [];
  const label = { className: "" };
  let submitted = false;
  let assigned = false;
  const checkbox = {
    name: "keep",
    value: "1",
    checked: true,
    disabled: false,
    matches: (selector: string) => selector === "[data-autosubmit]",
    form: {
      action: "/calendar/drop",
      submit: () => { submitted = true; },
      querySelector: () => label,
      querySelectorAll: () => [{ name: "sourceId", value: "wilma-exam:1" }, { name: "returnTo", value: "/homework" }],
      setAttribute: () => {},
      removeAttribute: () => {},
    },
  };
  const context = {
    document: {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === "change") changeHandler = handler;
      },
    },
    navigator: {},
    URLSearchParams,
    window: {
      addEventListener: () => {},
      isSecureContext: false,
      fetch: (url: string, init: typeof requests[number]["init"]) => {
        requests.push({ url, init });
        return Promise.resolve({ ok: true });
      },
      // Any navigation at all is the bug: it loses scroll position, the open
      // message and the filter buttons.
      get location(): never { assigned = true; throw new Error("navigated"); },
    },
  } as unknown as Record<string, unknown>;
  (context as { fetch?: unknown }).fetch = (context.window as { fetch: unknown }).fetch;
  runInNewContext(client, context);

  assert.ok(changeHandler, "the client registers a change handler");
  checkbox.checked = false;
  (changeHandler as unknown as (event: unknown) => void)({ target: checkbox });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "/calendar/drop");
  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(requests[0]!.init.headers["x-family-wilma-async"], "1");
  // An unchecked box omits "keep" entirely, which is what the server reads as a drop.
  assert.equal(requests[0]!.init.body, "sourceId=wilma-exam%3A1&returnTo=%2Fhomework");
  assert.equal(label.className, "muted dropped");
  assert.equal(checkbox.disabled, false);
  assert.equal(submitted, false);
  assert.equal(assigned, false);
});

test("a failed save puts the checkbox back rather than lying about it", async () => {
  const client = String(pwaAsset("/pwa.js")?.body);
  let changeHandler: ((event: unknown) => void) | null = null;
  const label = { className: "" };
  const flags: Record<string, string> = {};
  const checkbox = {
    name: "keep",
    value: "1",
    checked: false,
    disabled: false,
    matches: () => true,
    form: {
      action: "/calendar/drop",
      querySelector: () => label,
      querySelectorAll: () => [],
      setAttribute: (name: string, value: string) => { flags[name] = value; },
      removeAttribute: (name: string) => { delete flags[name]; },
    },
  };
  const context = {
    document: { addEventListener: (type: string, handler: (event: unknown) => void) => { if (type === "change") changeHandler = handler; } },
    navigator: {},
    URLSearchParams,
    window: { addEventListener: () => {}, isSecureContext: false, fetch: () => Promise.resolve({ ok: false }) },
  } as unknown as Record<string, unknown>;
  (context as { fetch?: unknown }).fetch = (context.window as { fetch: unknown }).fetch;
  runInNewContext(client, context);

  assert.ok(changeHandler, "the client registers a change handler");
  (changeHandler as unknown as (event: unknown) => void)({ target: checkbox });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(checkbox.checked, true, "the box goes back to what the server still holds");
  assert.equal(label.className, "", "and its styling is not changed");
  assert.equal(flags["data-save-failed"], "1");
  assert.equal(checkbox.disabled, false);
});
