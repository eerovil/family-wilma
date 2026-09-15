import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("Wilma accounts do not require manual profile mappings", () => {
  const previous = { ...process.env };
  try {
    delete process.env.GOOGLE_ALLOWED_LOGIN_EMAILS;
    delete process.env.PEDANET_HOMEWORK_URL;
    delete process.env.PEDANET_HOMEWORK_MODULE_ID;
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

    const config = loadConfig();
    assert.equal(config.analysisMode, "anthropic");
    assert.equal(config.pedanetHomeworkUrl, null);
    assert.equal(config.pedanetHomeworkModuleId, null);
    assert.deepEqual(config.wilmaAccounts[0]?.profiles, []);
    assert.deepEqual(config.googleAllowedLoginEmails, ["owner@example.com"]);
  } finally {
    process.env = previous;
  }
});

test("Google login allowlist includes normalized household members and the Calendar owner", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "test",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_ALLOWED_EMAIL: "OWNER@example.com",
      GOOGLE_ALLOWED_LOGIN_EMAILS: "owner@example.com, ANNA@example.com",
      WILMA_ACCOUNTS_JSON: "[]",
    });
    assert.deepEqual(loadConfig().googleAllowedLoginEmails, ["owner@example.com", "anna@example.com"]);
    process.env.GOOGLE_ALLOWED_LOGIN_EMAILS = "anna@example.com";
    assert.throws(loadConfig, /must include GOOGLE_ALLOWED_EMAIL/);
  } finally {
    process.env = previous;
  }
});

test("manual analysis mode does not require an Anthropic API key", () => {
  const previous = { ...process.env };
  try {
    delete process.env.GOOGLE_ALLOWED_LOGIN_EMAILS;
    Object.assign(process.env, {
      ANALYSIS_MODE: "manual",
      ANTHROPIC_API_KEY: "",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_ALLOWED_EMAIL: "owner@example.com",
      WILMA_ACCOUNTS_JSON: "[]",
    });

    const config = loadConfig();
    assert.equal(config.analysisMode, "manual");
    assert.equal(config.anthropicApiKey, null);
  } finally {
    process.env = previous;
  }
});

test("manual analysis mode refuses a non-loopback server", () => {
  const previous = { ...process.env };
  try {
    delete process.env.GOOGLE_ALLOWED_LOGIN_EMAILS;
    Object.assign(process.env, {
      ANALYSIS_MODE: "manual",
      ANTHROPIC_API_KEY: "",
      HOST: "0.0.0.0",
      APP_BASE_URL: "https://wilma.example.com",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_ALLOWED_EMAIL: "owner@example.com",
      WILMA_ACCOUNTS_JSON: "[]",
    });

    assert.throws(loadConfig, /requires loopback/);
  } finally {
    process.env = previous;
  }
});
