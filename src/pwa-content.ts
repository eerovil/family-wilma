export const THEME_COLOR = "#1d4ed8";
export const BACKGROUND_COLOR = "#f5f7fb";

export const MANIFEST = JSON.stringify({
  name: "Family Wilma",
  short_name: "Wilma",
  description: "Perheen Wilma-viestit, kotitehtävät ja kalenterit.",
  lang: "fi",
  id: "./family-wilma-pwa",
  start_url: "./",
  scope: "./",
  display: "standalone",
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  categories: ["education", "productivity"],
  icons: [
    { src: "./icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "./icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "./icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

export const OFFLINE_PAGE = `<!doctype html>
<html lang="fi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${THEME_COLOR}">
<title>Ei verkkoyhteyttä · Family Wilma</title>
<style>:root{font-family:system-ui,-apple-system,sans-serif;color:#18212f;background:${BACKGROUND_COLOR}}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;text-align:center}main{max-width:24rem}img{width:80px;height:80px;border-radius:20px}h1{font-size:1.5rem;margin:18px 0 8px}p{color:#667085;line-height:1.5}a{display:inline-block;margin-top:10px;padding:12px 18px;border-radius:12px;background:${THEME_COLOR};color:white;font-weight:700;text-decoration:none}</style>
</head><body><main><img src="/icon-192.png" alt=""><h1>Family Wilma odottaa verkkoyhteyttä</h1><p>Tätä sivua ei ole vielä tallennettu laitteelle. Yhdistä verkkoon ja yritä uudelleen.</p><a href="">Yritä uudelleen</a></main><script defer src="/pwa.js"></script></body></html>`;

export const PWA_CLIENT_SCRIPT = `"use strict";
(function () {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  var reloading = false;
  var controlled = navigator.serviceWorker.controller !== null;
  window.addEventListener("online", function () { location.reload(); });
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (reloading) return;
    if (!controlled) {
      controlled = navigator.serviceWorker.controller !== null;
      return;
    }
    if (navigator.serviceWorker.controller === null) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(function (registration) { return registration.update(); })
      .catch(function () {});
  });
}());`;

export const PUBLIC_PWA_PATHS = [
  "/manifest.webmanifest",
  "/offline",
  "/pwa.js",
  "/message-filters.js",
  "/message-status.js",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
] as const;

export function serviceWorkerSource(generation: string): string {
  return `"use strict";
var CACHE = "family-wilma-${generation}";
var PREFIX = "family-wilma-";
var ASSETS = ${JSON.stringify(PUBLIC_PWA_PATHS)};
var OFFLINE = "/offline";
var GATEWAY_DOWN = [502, 503, 504];
var NEVER_CACHE = ["/oauth/google/start", "/oauth/google/calendar/start", "/oauth/google/callback", "/sw.js", "/healthz"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(ASSETS.map(function (url) {
      return fetch(url, { cache: "reload" }).then(function (response) {
        if (!response.ok) throw new Error(url + ": " + response.status);
        return cache.put(url, response);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key.indexOf(PREFIX) === 0 && key !== CACHE;
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

function cacheablePage(request, response) {
  if (!response.ok || response.redirected) return false;
  if (new URL(response.url).origin !== self.location.origin) return false;
  if (NEVER_CACHE.indexOf(new URL(request.url).pathname) !== -1) return false;
  return (response.headers.get("content-type") || "").indexOf("text/html") !== -1;
}

function pageKey(request) {
  var url = new URL(request.url);
  if (url.pathname === "/homework") url.search = "";
  return url.toString();
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (NEVER_CACHE.indexOf(url.pathname) !== -1) return;
    event.respondWith(caches.open(CACHE).then(function (cache) {
      var key = pageKey(request);
      return fetch(request).then(function (response) {
        if (GATEWAY_DOWN.indexOf(response.status) !== -1) {
          return cache.match(key).then(function (saved) {
            return saved || cache.match(OFFLINE).then(function (fallback) { return fallback || response; });
          });
        }
        if (!cacheablePage(request, response)) return response;
        return cache.put(key, response.clone()).then(function () { return response; });
      }).catch(function () {
        return cache.match(key).then(function (saved) {
          return saved || cache.match(OFFLINE).then(function (fallback) { return fallback || Response.error(); });
        });
      });
    }));
    return;
  }

  if (ASSETS.indexOf(url.pathname) === -1) return;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return fetch(request).then(function (response) {
      if (!response.ok) return response;
      return cache.put(url.pathname, response.clone()).then(function () { return response; });
    }).catch(function () { return cache.match(url.pathname); });
  }));
});`;
}
