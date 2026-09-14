import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("Wilma accounts do not require manual profile mappings", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "test",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_ALLOWED_EMAIL: "owner@example.com",
      WILMA_ACCOUNTS_JSON: JSON.stringify([{
        id: "school",
        baseUrl: "https://school.inschool.fi",
        username: "guardian",
        password: "secret",
      }]),
    });

    assert.deepEqual(loadConfig().wilmaAccounts[0]?.profiles, []);
  } finally {
    process.env = previous;
  }
});
