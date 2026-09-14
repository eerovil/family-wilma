import assert from "node:assert/strict";
import test from "node:test";
import { WilmaClient, type WilmaProfile } from "@wilm-ai/wilma-client";
import type { AppConfig } from "./config.js";
import { MfaCodeRequiredError, WilmaService } from "./wilma.js";

test("message fetch discovers every Wilma profile and uses optional child-name overrides", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  const loggedInProfiles: WilmaProfile[] = [];
  let discoveryCalls = 0;

  WilmaClient.listStudents = async () => {
    discoveryCalls += 1;
    return [
      { studentNumber: "101", name: "Wilma Name", href: "/profiles/101" },
      { studentNumber: "202", name: "Second Child", href: "/profiles/202" },
    ];
  };
  WilmaClient.login = async (profile) => {
    loggedInProfiles.push(profile);
    const messageId = Number(profile.studentNumber);
    return {
      messages: {
        list: async () => [{ wilmaId: messageId, subject: "Subject" }],
        get: async () => ({
          wilmaId: messageId,
          subject: "Subject",
          senderName: "Teacher",
          sentAt: new Date("2026-09-15T08:00:00Z"),
          content: "Content",
        }),
      },
      exams: { list: async () => [] },
    } as unknown as WilmaClient;
  };

  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [
        { studentNumber: "101", child: "Preferred Name" },
        { studentNumber: "TEMP", child: "Must Not Be Fetched" },
      ],
    }],
  } as unknown as AppConfig;

  try {
    const bundle = await new WilmaService(config).fetchAll();
    assert.equal(discoveryCalls, 1);
    assert.deepEqual(loggedInProfiles.map((profile) => profile.studentNumber), ["101", "202"]);
    assert.deepEqual(bundle.messages.map((message) => message.child), ["Preferred Name", "Second Child"]);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});

test("MFA retries resume after completed discovery and profile logins", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  let discoveryAttempts = 0;
  const loginAttempts: string[] = [];

  WilmaClient.listStudents = async (_profile, onMfaRequired) => {
    discoveryAttempts += 1;
    await onMfaRequired?.("discovery-form");
    return [
      { studentNumber: "101", name: "First Child", href: "/profiles/101" },
      { studentNumber: "202", name: "Second Child", href: "/profiles/202" },
    ];
  };
  WilmaClient.login = async (profile, onMfaRequired) => {
    loginAttempts.push(profile.studentNumber ?? "");
    await onMfaRequired?.(`profile-${profile.studentNumber}`);
    return {
      messages: { list: async () => [] },
      exams: { list: async () => [] },
    } as unknown as WilmaClient;
  };

  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [],
    }],
  } as unknown as AppConfig;
  const service = new WilmaService(config);

  try {
    await assert.rejects(service.fetchAll(), MfaCodeRequiredError);
    service.submitMfaCode("school", "111111");
    await assert.rejects(service.fetchAll(), MfaCodeRequiredError);
    service.submitMfaCode("school", "222222");
    await assert.rejects(service.fetchAll(), MfaCodeRequiredError);
    service.submitMfaCode("school", "333333");
    await service.fetchAll();

    assert.equal(discoveryAttempts, 2);
    assert.deepEqual(loginAttempts, ["101", "101", "202", "202"]);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});
