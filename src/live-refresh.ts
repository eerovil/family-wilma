/**
 * Head tags for a page that should follow a background job. Scripted browsers
 * read the poll hint and update the status area in place; a self-reload would
 * throw the reader back to the top and close the open message on every tick.
 * Browsers without scripts keep the old self-reload.
 */
export function pollHead(seconds: number, url: string): string {
  return `<meta name="family-wilma-poll" content="${seconds};url=${url}"><noscript><meta http-equiv="refresh" content="${seconds};url=${url}"></noscript>`;
}

export const LIVE_REFRESH_CLIENT_SCRIPT = `"use strict";
(function () {
  var hint = document.querySelector('meta[name="family-wilma-poll"]');
  var match = hint && /^(\\d+);url=(\\S+)$/.exec(hint.getAttribute("content") || "");
  if (!match || !window.fetch || !window.DOMParser) return;
  var delay = Number(match[1]) * 1000;
  var url = match[2];

  function schedule() { window.setTimeout(check, delay); }

  // The reader is using the page when it is scrolled, a message is open or a
  // filter is chosen; reloading then is exactly the jump this script avoids.
  function busy() {
    return window.scrollY >= 40
      || document.querySelector("details[open]") !== null
      || document.querySelector('[data-message-filter][aria-pressed="true"]') !== null;
  }

  function swap(fresh) {
    var current = document.querySelector('[data-live="status"]');
    if (!current) return;
    // Banners are left for the next real page load, where message-status.js
    // shows each one once for its full time.
    Array.prototype.forEach.call(fresh.querySelectorAll("[data-transient-status]"), function (banner) {
      banner.remove();
    });
    var before = current.getBoundingClientRect();
    var scrolled = window.scrollY;
    current.replaceWith(fresh);
    // Safari has no scroll anchoring, so a status area above the screen that
    // changes height would move the text being read. Other browsers have
    // already corrected for it by the time scrollY is read again.
    if (before.top < 0 && window.scrollY === scrolled) {
      var change = fresh.getBoundingClientRect().height - before.height;
      if (change) window.scrollBy(0, change);
    }
  }

  function finish() {
    if (!busy()) {
      window.location.replace(url);
      return;
    }
    var bar = document.createElement("div");
    bar.className = "refresh-ready";
    bar.setAttribute("role", "status");
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Uudet tiedot valmiina — Näytä";
    button.addEventListener("click", function () { window.location.replace(url); });
    bar.appendChild(button);
    // Last in main, so the sticky bottom position holds it on screen.
    document.querySelector("main").appendChild(bar);
  }

  function check() {
    window.fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual" }).then(function (response) {
      // A signed-out session redirects to Google sign-in: go there as the old
      // self-reload did.
      if (response.type === "opaqueredirect") {
        window.location.assign(url);
        return;
      }
      return response.text().then(function (html) {
        var page = new window.DOMParser().parseFromString(html, "text/html");
        if (page.querySelector('form[action="/mfa"]')) {
          window.location.assign(url);
          return;
        }
        var fresh = page.querySelector('[data-live="status"]');
        if (!response.ok || !fresh) {
          schedule();
          return;
        }
        swap(fresh);
        if (page.querySelector('meta[name="family-wilma-poll"]')) schedule();
        else finish();
      });
    }).catch(schedule);
  }

  schedule();
}());`;
