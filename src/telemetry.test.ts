import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import * as Sentry from "@sentry/node";
import { configureErrorReportingSecrets, initializeErrorReporting, reportError, sanitizeErrorForReporting, scrubEvent } from "./telemetry.js";

test("error reporting replaces arbitrary provider text and preserves only stack frames", () => {
  const original = new Error("Student Name said private message 123456 to eero@example.com using hunter2");
  original.stack = `Error: ${original.message}\n    at handler (/app/src/index.ts:1:1)`;

  const safe = sanitizeErrorForReporting(original, ["hunter2"]);
  assert.equal(safe.message, "Unexpected application error");
  assert.equal(safe.stack?.includes("Student Name"), false);
  assert.equal(safe.stack?.includes("private message"), false);
  assert.equal(safe.stack?.includes("123456"), false);
  assert.equal(safe.stack?.includes("hunter2"), false);
  assert.match(safe.stack ?? "", /handler/);
});

test("Sentry events discard request, user, breadcrumbs, extras, and contexts", () => {
  const event = scrubEvent({
    type: undefined,
    request: { data: "private body", cookies: { session: "secret" } },
    user: { email: "eero@example.com" },
    breadcrumbs: [{ message: "private" }],
    extra: { message: "private" },
    contexts: { private: { value: "private" } },
    server_name: "private-hostname",
    tags: { operation: "calendar.sync" },
  });
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.breadcrumbs, undefined);
  assert.equal(event.extra, undefined);
  assert.equal(event.contexts, undefined);
  assert.equal(event.server_name, undefined);
  assert.deepEqual(event.tags, { operation: "calendar.sync" });
});

test("the emitted Sentry envelope contains fixed diagnostics but no private source text", async () => {
  let envelope = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) envelope += chunk;
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  initializeErrorReporting({
    dsn: `http://public@127.0.0.1:${address.port}/1`,
    environment: "test",
    release: "test-release",
  });
  configureErrorReportingSecrets(["wilma-password"]);
  reportError(new Error("Student Name private message 123456 eero@example.com wilma-password"), {
    operation: "calendar.sync",
    tags: { route: "/calendar/sync" },
  });
  assert.equal(await Sentry.flush(2_000), true);
  server.close();

  for (const forbidden of ["Student Name", "private message", "123456", "eero@example.com", "wilma-password"]) {
    assert.equal(envelope.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  assert.match(envelope, /Unexpected application error/);
  assert.match(envelope, /calendar\.sync/);
  assert.match(envelope, /test-release/);
});
