import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WilmaSession } from "@wilm-ai/wilma-client";
import { installWilmaRequestLimits, wilmaRequestCount } from "./wilma-http.js";

test("a Wilma request that never answers fails after the time limit and is counted", async () => {
  const server: Server = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    installWilmaRequestLimits(100);
    const session = new WilmaSession(`http://127.0.0.1:${port}`);
    (session as unknown as { loggedIn: boolean }).loggedIn = true;
    const before = wilmaRequestCount();
    const started = Date.now();
    await assert.rejects(session.get("/overview"));
    assert.ok(Date.now() - started < 5_000);
    assert.equal(wilmaRequestCount() - before, 1);
  } finally {
    installWilmaRequestLimits();
    server.closeAllConnections();
    server.close();
  }
});
