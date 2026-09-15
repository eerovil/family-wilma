import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(pwaAsset("/missing"), null);
});
