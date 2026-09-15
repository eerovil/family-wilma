import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MANIFEST, OFFLINE_PAGE, PWA_CLIENT_SCRIPT, serviceWorkerSource } from "./pwa-content.js";

export interface PwaAsset {
  body: Buffer | string;
  headers: Record<string, string>;
}

const assetDir = fileURLToPath(new URL("../assets/pwa/", import.meta.url));
const favicon = readFileSync(`${assetDir}family-wilma-mark.svg`);
const icon192 = readFileSync(`${assetDir}generated/icon-192.png`);
const icon512 = readFileSync(`${assetDir}generated/icon-512.png`);
const maskableIcon512 = readFileSync(`${assetDir}generated/icon-maskable-512.png`);
const appleTouchIcon = readFileSync(`${assetDir}generated/apple-touch-icon.png`);
const generation = createHash("sha256").update(MANIFEST).update(OFFLINE_PAGE).update(PWA_CLIENT_SCRIPT)
  .update(favicon).update(icon192).update(icon512).update(maskableIcon512).update(appleTouchIcon)
  .digest("hex").slice(0, 12);

const noCache = { "cache-control": "no-cache" };
const text = (body: string, contentType: string, headers: Record<string, string> = {}): PwaAsset => ({
  body,
  headers: { ...noCache, "content-type": contentType, ...headers },
});
const binary = (body: Buffer, contentType: string): PwaAsset => ({
  body,
  headers: { ...noCache, "content-type": contentType },
});

export function pwaAsset(pathname: string): PwaAsset | null {
  switch (pathname) {
    case "/manifest.webmanifest": return text(MANIFEST, "application/manifest+json; charset=utf-8");
    case "/offline": return text(OFFLINE_PAGE, "text/html; charset=utf-8");
    case "/pwa.js": return text(PWA_CLIENT_SCRIPT, "text/javascript; charset=utf-8");
    case "/sw.js": return text(serviceWorkerSource(generation), "text/javascript; charset=utf-8", { "service-worker-allowed": "/" });
    case "/favicon.svg": return binary(favicon, "image/svg+xml");
    case "/icon-192.png": return binary(icon192, "image/png");
    case "/icon-512.png": return binary(icon512, "image/png");
    case "/icon-maskable-512.png": return binary(maskableIcon512, "image/png");
    case "/apple-touch-icon.png": return binary(appleTouchIcon, "image/png");
    default: return null;
  }
}
