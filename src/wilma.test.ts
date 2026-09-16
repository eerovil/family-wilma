import assert from "node:assert/strict";
import test from "node:test";
import { WilmaClient, type WilmaProfile } from "@wilm-ai/wilma-client";
import type { AppConfig } from "./config.js";
import { MfaCodeRequiredError, WilmaService } from "./wilma.js";

test("homework fetch combines every child into one newest-first list", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  WilmaClient.listStudents = async () => [
    { studentNumber: "101", name: "First Child", href: "/profiles/101" },
    { studentNumber: "202", name: "Second Child", href: "/profiles/202" },
  ];
  WilmaClient.login = async (profile) => ({
    overview: {
      get: async () => ({
        homework: profile.studentNumber === "101"
          ? [{ date: "2026-09-14", subject: "Math", subjectCode: "MA", homework: "Older", teacher: "A", teacherCode: "A" }]
          : [{ date: "2026-09-15", subject: "Finnish", subjectCode: "FI", homework: "Newest", teacher: "B", teacherCode: "B" }],
      }),
    },
  }) as unknown as WilmaClient;
  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [{ studentNumber: "202", child: "Preferred Second" }],
    }],
  } as unknown as AppConfig;

  try {
    const result = await new WilmaService(config).fetchHomework();
    assert.deepEqual(result.map((item) => [item.date, item.child, item.homework]), [
      ["2026-09-15", "Preferred Second", "Newest"],
      ["2026-09-14", "First Child", "Older"],
    ]);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});

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

test("recent fetch skips old message details before they are downloaded", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  const detailIds: number[] = [];

  WilmaClient.listStudents = async () => [
    { studentNumber: "101", name: "First Child", href: "/profiles/101" },
  ];
  WilmaClient.login = async () => ({
    messages: {
      list: async () => [
        { wilmaId: 1, subject: "Recent", sentAt: new Date("2026-09-14T08:00:00Z") },
        { wilmaId: 2, subject: "Old", sentAt: new Date("2026-07-01T08:00:00Z") },
      ],
      get: async (wilmaId: number) => {
        detailIds.push(wilmaId);
        return {
          wilmaId,
          subject: wilmaId === 1 ? "Recent" : "Old",
          senderName: "Teacher",
          sentAt: wilmaId === 1 ? new Date("2026-09-14T08:00:00Z") : new Date("2026-07-01T08:00:00Z"),
          content: "Content",
        };
      },
    },
    exams: { list: async () => [] },
  }) as unknown as WilmaClient;

  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [],
    }],
  } as unknown as AppConfig;

  try {
    const bundle = await new WilmaService(config).fetchAll({
      sentAfter: new Date("2026-08-16T00:00:00Z"),
    });
    assert.deepEqual(detailIds, [1]);
    assert.deepEqual(bundle.messages.map((message) => message.messageId), [1]);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});

test("lesson sync reads each week for six months and groups valid lessons by displayed child", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  const scheduleDates: string[] = [];

  WilmaClient.listStudents = async () => [
    { studentNumber: "101", name: "Wilma Name", href: "/profiles/101" },
  ];
  WilmaClient.login = async () => ({
    messages: { list: async () => [] },
    exams: { list: async () => [] },
    schedule: {
      list: async ({ date }: { date?: string } = {}) => {
        scheduleDates.push(date ?? "");
        if (date === "2026-09-14") {
          return [
            {
              date: "2026-09-15", dayOfWeek: 2, start: "08:15", end: "09:45",
              subject: "Matematiikka", subjectCode: "MA", teacher: "Teacher", teacherCode: "TEA", groupId: 42,
            },
            {
              date: "2026-09-15", dayOfWeek: 2, start: "10:15", end: "11:00",
              subject: "Matematiikka", subjectCode: "MA", teacher: "Teacher", teacherCode: "TEA", groupId: 42,
            },
          ];
        }
        if (date === "2026-09-21") {
          return [{
            date: "2026-09-22", dayOfWeek: 2, start: "", end: "10:00",
            subject: "Invalid", subjectCode: "BAD", teacher: "", teacherCode: "", groupId: 99,
          }];
        }
        return [];
      },
    },
  }) as unknown as WilmaClient;

  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [{ studentNumber: "101", child: "Preferred Name" }],
    }],
  } as unknown as AppConfig;

  try {
    const bundle = await new WilmaService(config, () => new Date("2026-09-15T05:00:00Z"))
      .fetchAll({ includeLessons: true });
    assert.equal(scheduleDates[0], "2026-09-14");
    assert.equal(scheduleDates.at(-1), "2027-03-15");
    assert.equal(scheduleDates.length, 27);
    assert.deepEqual(bundle.lessonWindow, { start: "2026-09-14", end: "2027-03-15", deleteFrom: "2026-09-15" });
    assert.deepEqual(bundle.lessonCalendars, [{
      child: "Preferred Name",
      reconcile: false,
      items: [{
        sourceId: "wilma-lesson:2026-09-15:08:15:42",
        title: "Matematiikka",
        date: "2026-09-15",
        time: "08:15",
        endTime: "09:45",
        endDate: null,
        description: "Opettaja: Teacher (TEA)",
      }, {
        sourceId: "wilma-lesson:2026-09-15:10:15:42",
        title: "Matematiikka",
        date: "2026-09-15",
        time: "10:15",
        endTime: "11:00",
        endDate: null,
        description: "Opettaja: Teacher (TEA)",
      }],
    }]);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});

test("lesson sync skips accounts without timetable support but keeps their messages and exams", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  const scheduleAccounts: string[] = [];

  WilmaClient.listStudents = async (profile) => [{
    studentNumber: profile.baseUrl.includes("conservatory") ? "202" : "101",
    name: profile.baseUrl.includes("conservatory") ? "Music Child" : "School Child",
    href: "/profiles/child",
  }];
  WilmaClient.login = async (profile) => {
    const account = profile.baseUrl.includes("conservatory") ? "conservatory" : "school";
    return {
      messages: {
        list: async () => [{ wilmaId: account === "school" ? 1 : 2, subject: "Message" }],
        get: async (wilmaId: number) => ({
          wilmaId,
          subject: "Message",
          senderName: "Teacher",
          sentAt: new Date("2026-09-15T08:00:00Z"),
          content: account,
        }),
      },
      exams: {
        list: async () => [{
          wilmaId: account === "school" ? 11 : 22,
          subject: account,
          dateString: "2026-09-20",
        }],
      },
      schedule: {
        list: async () => {
          scheduleAccounts.push(account);
          if (account === "conservatory") throw new Error("Wilma HTTP 403 at schedule");
          return [];
        },
      },
    } as unknown as WilmaClient;
  };

  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [],
      includeLessons: true,
    }, {
      id: "conservatory",
      baseUrl: "https://conservatory.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [],
      includeLessons: false,
    }],
  } as unknown as AppConfig;

  try {
    const bundle = await new WilmaService(config, () => new Date("2026-09-15T05:00:00Z"))
      .fetchAll({ includeLessons: true });
    assert.deepEqual(new Set(bundle.messages.map((message) => message.accountId)), new Set(["school", "conservatory"]));
    assert.deepEqual(new Set(bundle.structuredCalendarItems.map((item) => item.title)), new Set([
      "School Child: school",
      "Music Child: conservatory",
    ]));
    assert.ok(scheduleAccounts.length > 0);
    assert.deepEqual(new Set(scheduleAccounts), new Set(["school"]));
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});

test("a non-MFA fetch failure clears cached Wilma clients before retry", async () => {
  const originalListStudents = WilmaClient.listStudents;
  const originalLogin = WilmaClient.login;
  let discoveryCalls = 0;
  let loginCalls = 0;

  WilmaClient.listStudents = async () => {
    discoveryCalls += 1;
    return [{ studentNumber: "101", name: "Child", href: "/profiles/101" }];
  };
  WilmaClient.login = async () => {
    loginCalls += 1;
    const attempt = loginCalls;
    return {
      messages: { list: async () => [] },
      exams: { list: async () => [] },
      schedule: {
        list: async () => attempt === 1
          ? Promise.reject(new Error("Wilma HTTP 403 at schedule"))
          : [],
      },
    } as unknown as WilmaClient;
  };
  const config = {
    wilmaAccounts: [{
      id: "school",
      baseUrl: "https://school.inschool.fi",
      username: "guardian",
      password: "secret",
      profiles: [],
      includeLessons: true,
    }],
  } as unknown as AppConfig;
  const service = new WilmaService(config, () => new Date("2026-09-15T05:00:00Z"));

  try {
    await assert.rejects(service.fetchAll({ includeLessons: true }), /403/);
    await service.fetchAll();
    assert.equal(discoveryCalls, 2);
    assert.equal(loginCalls, 2);
  } finally {
    WilmaClient.listStudents = originalListStudents;
    WilmaClient.login = originalLogin;
  }
});
