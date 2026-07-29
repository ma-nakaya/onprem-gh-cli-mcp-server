import { describe, expect, it } from "vitest";
import {
  issueComments,
  issueDetails,
  issueEvents,
} from "../src/issue.js";

describe("read-only issue detail response handling", () => {
  it("selects only the requested detail fields from gh issue view JSON", () => {
    expect(issueDetails({
      number: 27,
      title: "Example issue",
      body: "Untrusted issue content",
      state: "CLOSED",
      stateReason: "COMPLETED",
      author: {
        id: "MDQ6VXNlcjE=",
        login: "octocat",
        is_bot: false,
        name: "The Octocat",
        email: "must-not-leak@example.com",
      },
      assignees: [{
        id: "MDQ6VXNlcjI=",
        databaseId: 2,
        login: "hubot",
        name: null,
      }],
      labels: [{
        id: "LA_example",
        name: "bug",
        color: "d73a4a",
        description: null,
        url: "https://api.example.invalid/labels/bug",
      }],
      milestone: {
        id: "MI_example",
        number: 3,
        title: "v1",
        dueOn: null,
        description: "Not returned",
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T01:00:00Z",
      closedAt: "2026-07-29T01:00:00Z",
      url: "https://github.com/example/repo/issues/27",
      comments: [{ body: "must not be returned" }],
      projectItems: ["must not be returned"],
    })).toEqual({
      number: 27,
      title: "Example issue",
      body: "Untrusted issue content",
      state: "CLOSED",
      stateReason: "COMPLETED",
      author: {
        login: "octocat",
        isBot: false,
        name: "The Octocat",
      },
      assignees: [{
        login: "hubot",
        name: null,
      }],
      labels: [{
        name: "bug",
        color: "d73a4a",
        description: null,
      }],
      milestone: {
        number: 3,
        title: "v1",
        dueOn: null,
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T01:00:00Z",
      closedAt: "2026-07-29T01:00:00Z",
      url: "https://github.com/example/repo/issues/27",
    });
  });

  it("accepts the nullable and empty values emitted by gh for an open issue", () => {
    const details = issueDetails({
      number: 27,
      title: "Open issue",
      body: "",
      state: "OPEN",
      stateReason: "",
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      closedAt: null,
      url: "https://github.com/example/repo/issues/27",
    });
    expect(details).toMatchObject({
      body: "",
      stateReason: "",
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      closedAt: null,
    });
  });

  it("normalizes an omitted bot display name to null", () => {
    const details = issueDetails({
      number: 27,
      title: "Bot-authored issue",
      body: "",
      state: "OPEN",
      stateReason: "",
      author: {
        login: "app/example",
        is_bot: true,
      },
      assignees: [{ login: "octocat" }],
      labels: [],
      milestone: null,
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      closedAt: null,
      url: "https://github.com/example/repo/issues/27",
    });
    expect(details.author).toEqual({
      login: "app/example",
      isBot: true,
      name: null,
    });
    expect(details.assignees).toEqual([{ login: "octocat", name: null }]);
  });

  it("rejects malformed detail fields and nested values", () => {
    expect(() => issueDetails(null)).toThrow(/expected an object/);
    expect(() => issueDetails({ number: 0 })).toThrow(/"number".*greater than or equal to 1/);
    expect(() => issueDetails({
      number: 1,
      title: "Issue",
      body: "",
      state: "OPEN",
      stateReason: "",
      author: { login: "octocat", is_bot: "false", name: "Octocat" },
    })).toThrow(/"is_bot".*boolean/);
    expect(() => issueDetails({
      number: 1,
      title: "Issue",
      body: "",
      state: "OPEN",
      stateReason: "",
      author: null,
      assignees: [{ login: "octocat", name: 123 }],
      labels: [],
      milestone: null,
      createdAt: "created",
      updatedAt: "updated",
      closedAt: null,
      url: "url",
    })).toThrow(/issue assignee.*"name".*string, null, or omitted/);
  });
});

describe("read-only issue comment response handling", () => {
  it("selects the fixed REST projection and omits user and API metadata", () => {
    expect(issueComments([{
      id: 101,
      body: "Untrusted comment content",
      author: {
        login: "octocat",
        type: "User",
        id: 1,
        avatarUrl: "https://example.invalid/avatar",
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T01:00:00Z",
      url: "https://github.com/example/repo/issues/27#issuecomment-101",
      authorAssociation: "OWNER",
      reactions: { totalCount: 3 },
      apiUrl: "https://api.example.invalid/comments/101",
    }], 1)).toEqual([{
      id: 101,
      body: "Untrusted comment content",
      author: {
        login: "octocat",
        type: "User",
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T01:00:00Z",
      url: "https://github.com/example/repo/issues/27#issuecomment-101",
    }]);
  });

  it("normalizes a missing or null deleted author to null", () => {
    expect(issueComments([{
      id: 101,
      body: "",
      author: null,
      createdAt: "created",
      updatedAt: "updated",
      url: "url",
    }])[0]?.author).toBeNull();
    expect(issueComments([{
      id: 102,
      body: "",
      createdAt: "created",
      updatedAt: "updated",
      url: "url",
    }])[0]?.author).toBeNull();
  });

  it("rejects malformed, non-array, and oversized comment pages", () => {
    expect(() => issueComments({}, 1)).toThrow(/expected an array/);
    expect(() => issueComments([], -1)).toThrow(/non-negative safe integer/);
    expect(() => issueComments([], 0.5)).toThrow(/non-negative safe integer/);
    expect(() => issueComments([{
      id: 1,
      body: "",
      author: null,
      createdAt: "created",
      updatedAt: "updated",
      url: "url",
    }], 0)).toThrow(/exceeding the requested maximum of 0/);
    expect(() => issueComments([{
      id: 1,
      body: "",
      author: { login: "octocat", type: 7 },
      createdAt: "created",
      updatedAt: "updated",
      url: "url",
    }], 1)).toThrow(/author.*"type".*non-empty string/);
  });
});

describe("read-only issue event response handling", () => {
  it("selects supported event metadata and excludes commit and actor URLs", () => {
    expect(issueEvents([{
      id: 201,
      event: "assigned",
      actor: {
        login: "octocat",
        type: "User",
        id: 1,
        htmlUrl: "https://github.com/octocat",
      },
      createdAt: "2026-07-29T00:00:00Z",
      commitId: "abc123",
      commitUrl: "https://api.example.invalid/commits/abc123",
      label: { name: "bug", color: "d73a4a", id: 9 },
      assignee: { login: "hubot", type: "Bot", id: 2 },
      assigner: { login: "octocat", type: "User", id: 1 },
      milestone: { title: "v1", number: 3 },
      rename: { from: "Old title", to: "New title", extra: true },
      lockReason: "too heated",
      performedViaGithubApp: { id: 3 },
    }], 1)).toEqual([{
      id: 201,
      event: "assigned",
      actor: { login: "octocat", type: "User" },
      createdAt: "2026-07-29T00:00:00Z",
      commitId: "abc123",
      label: { name: "bug", color: "d73a4a" },
      assignee: { login: "hubot", type: "Bot" },
      assigner: { login: "octocat", type: "User" },
      milestone: { title: "v1" },
      rename: { from: "Old title", to: "New title" },
      lockReason: "too heated",
    }]);
  });

  it("normalizes omitted event-specific fields to explicit nulls", () => {
    expect(issueEvents([{
      id: 202,
      event: "closed",
      actor: null,
      createdAt: "2026-07-29T00:00:00Z",
    }])).toEqual([{
      id: 202,
      event: "closed",
      actor: null,
      createdAt: "2026-07-29T00:00:00Z",
      commitId: null,
      label: null,
      assignee: null,
      assigner: null,
      milestone: null,
      rename: null,
      lockReason: null,
    }]);
  });

  it("preserves nullable label members documented by the events API", () => {
    expect(issueEvents([{
      id: 203,
      event: "labeled",
      actor: null,
      createdAt: "2026-07-29T00:00:00Z",
      label: { name: null, color: null },
    }])[0]?.label).toEqual({ name: null, color: null });
  });

  it("rejects malformed optional event fields and oversized pages", () => {
    expect(() => issueEvents("not-an-array", 10)).toThrow(/expected an array/);
    expect(() => issueEvents([], -1)).toThrow(/non-negative safe integer/);
    expect(() => issueEvents([{
      id: 1,
      event: "closed",
      actor: null,
      createdAt: "created",
    }], 0)).toThrow(/exceeding the requested maximum of 0/);
    expect(() => issueEvents([{
      id: 1,
      event: "labeled",
      actor: null,
      createdAt: "created",
      label: { name: "bug", color: 123 },
    }], 1)).toThrow(/label.*"color".*string, null, or omitted/);
    expect(() => issueEvents([{
      id: 1,
      event: "renamed",
      actor: null,
      createdAt: "created",
      rename: { from: "Old", to: null },
    }], 1)).toThrow(/rename.*"to".*string/);
    expect(() => issueEvents([{
      id: 1,
      event: "closed",
      actor: null,
      createdAt: "created",
      commitId: 42,
    }], 1)).toThrow(/"commitId".*string, null, or omitted/);
  });
});
