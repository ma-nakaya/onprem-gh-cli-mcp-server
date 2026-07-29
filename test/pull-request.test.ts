import { describe, expect, it } from "vitest";
import {
  assertReviewBody,
  pullRequestChecksEnvelope,
  pullRequestDetails,
  pullRequestDiffChunk,
  pullRequestFiles,
  pullRequestReviewSummary,
  pullRequestSummary,
} from "../src/pull-request.js";

describe("pull request response handling", () => {
  it("returns only stable pull request metadata", () => {
    expect(pullRequestSummary({
      number: 42,
      title: "Example",
      body: "sensitive body",
      state: "open",
      draft: true,
      html_url: "https://github.com/example/repo/pull/42",
      head: { ref: "feature" },
      base: { ref: "main" },
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T01:00:00Z",
    })).toEqual({
      number: 42,
      title: "Example",
      state: "open",
      isDraft: true,
      url: "https://github.com/example/repo/pull/42",
      headRefName: "feature",
      baseRefName: "main",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T01:00:00Z",
    });
  });

  it("returns review metadata without its body", () => {
    expect(pullRequestReviewSummary({
      id: 100,
      state: "APPROVED",
      body: "review content",
      html_url: "https://github.com/example/repo/pull/42#pullrequestreview-100",
      submitted_at: "2026-07-22T01:00:00Z",
    })).toEqual({
      id: 100,
      state: "APPROVED",
      url: "https://github.com/example/repo/pull/42#pullrequestreview-100",
      submittedAt: "2026-07-22T01:00:00Z",
    });
  });

  it("requires bodies for comment and request-changes reviews", () => {
    expect(() => assertReviewBody("APPROVE", undefined)).not.toThrow();
    expect(() => assertReviewBody("COMMENT", "Details")).not.toThrow();
    expect(() => assertReviewBody("COMMENT", "  ")).toThrow(/required/);
    expect(() => assertReviewBody("REQUEST_CHANGES", undefined)).toThrow(/required/);
  });
});

describe("read-only pull request response handling", () => {
  it("selects detailed pull request fields and minimizes the author", () => {
    expect(pullRequestDetails({
      number: 42,
      title: "Example",
      body: "Untrusted repository content",
      state: "OPEN",
      isDraft: false,
      author: {
        id: "MDQ6VXNlcjE=",
        login: "octocat",
        is_bot: false,
        name: "The Octocat",
        email: "must-not-leak@example.com",
      },
      headRefName: "feature",
      headRefOid: "abc123",
      baseRefName: "main",
      baseRefOid: "def456",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T01:00:00Z",
      closedAt: null,
      mergedAt: null,
      url: "https://github.com/example/repo/pull/42",
      comments: ["must not be returned"],
    })).toEqual({
      number: 42,
      title: "Example",
      body: "Untrusted repository content",
      state: "OPEN",
      isDraft: false,
      author: {
        login: "octocat",
        isBot: false,
        name: "The Octocat",
      },
      headRefName: "feature",
      headRefOid: "abc123",
      baseRefName: "main",
      baseRefOid: "def456",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T01:00:00Z",
      closedAt: null,
      mergedAt: null,
      url: "https://github.com/example/repo/pull/42",
    });
  });

  it("accepts a null pull request author and closed timestamps", () => {
    const details = pullRequestDetails({
      number: 42,
      title: "Example",
      body: "",
      state: "MERGED",
      isDraft: false,
      author: null,
      headRefName: "feature",
      headRefOid: "abc123",
      baseRefName: "main",
      baseRefOid: "def456",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      reviewDecision: "APPROVED",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T01:00:00Z",
      closedAt: "2026-07-23T00:00:00Z",
      mergedAt: "2026-07-23T00:00:00Z",
      url: "https://github.com/example/repo/pull/42",
    });
    expect(details.author).toBeNull();
    expect(details.closedAt).toBe("2026-07-23T00:00:00Z");
    expect(details.mergedAt).toBe("2026-07-23T00:00:00Z");
  });

  it("rejects malformed detailed pull request fields", () => {
    expect(() => pullRequestDetails(null)).toThrow(/expected an object/);
    expect(() => pullRequestDetails({
      number: 0,
    })).toThrow(/"number".*greater than or equal to 1/);
    expect(() => pullRequestDetails({
      number: 1,
      title: "Example",
      body: "",
      state: "OPEN",
      isDraft: false,
      author: { login: "octocat", is_bot: "false", name: "Octocat" },
    })).toThrow(/"is_bot".*boolean/);
  });

  it("selects fixed pull request file metadata and omits patches and URLs", () => {
    expect(pullRequestFiles([
      {
        path: "src/index.ts",
        status: "modified",
        previousPath: null,
        additions: 10,
        deletions: 2,
        changes: 12,
        patch: "@@ potentially large or untrusted patch @@",
        rawUrl: "https://example.invalid/raw",
      },
      {
        path: "src/new-name.ts",
        status: "renamed",
        previousPath: "src/old-name.ts",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ], 2)).toEqual([
      {
        path: "src/index.ts",
        status: "modified",
        previousPath: null,
        additions: 10,
        deletions: 2,
        changes: 12,
      },
      {
        path: "src/new-name.ts",
        status: "renamed",
        previousPath: "src/old-name.ts",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ]);
  });

  it("rejects malformed or oversized pull request file responses", () => {
    expect(() => pullRequestFiles({ files: [] })).toThrow(/expected an array/);
    expect(() => pullRequestFiles([], -1)).toThrow(/non-negative safe integer/);
    expect(() => pullRequestFiles([
      {
        path: "one.ts",
        status: "modified",
        previousPath: null,
        additions: 1,
        deletions: 0,
        changes: 1,
      },
      {
        path: "two.ts",
        status: "modified",
        previousPath: null,
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ], 1)).toThrow(/exceeding the requested maximum/);
    expect(() => pullRequestFiles([
      {
        path: "one.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ])).toThrow(/"previousPath".*string or null/);
  });

  it("validates and selects the checks envelope", () => {
    expect(pullRequestChecksEnvelope({
      total: 3,
      buckets: {
        pass: 1,
        fail: 1,
        pending: 1,
        skipping: 0,
        cancel: 0,
        unknown: 99,
      },
      checks: [
        {
          bucket: "pass",
          completedAt: "2026-07-22T01:00:00Z",
          event: "pull_request",
          name: "test",
          startedAt: "2026-07-22T00:59:00Z",
          state: "SUCCESS",
          workflow: "CI",
          link: "https://example.invalid/check",
          description: "must not be returned",
        },
        {
          bucket: "pending",
          completedAt: null,
          event: "pull_request",
          name: "build",
          startedAt: null,
          state: "QUEUED",
          workflow: "",
        },
      ],
    }, 2)).toEqual({
      total: 3,
      buckets: {
        pass: 1,
        fail: 1,
        pending: 1,
        skipping: 0,
        cancel: 0,
      },
      checks: [
        {
          bucket: "pass",
          completedAt: "2026-07-22T01:00:00Z",
          event: "pull_request",
          name: "test",
          startedAt: "2026-07-22T00:59:00Z",
          state: "SUCCESS",
          workflow: "CI",
        },
        {
          bucket: "pending",
          completedAt: null,
          event: "pull_request",
          name: "build",
          startedAt: null,
          state: "QUEUED",
          workflow: "",
        },
      ],
    });
  });

  it("rejects invalid pull request checks envelopes", () => {
    expect(() => pullRequestChecksEnvelope([], 10)).toThrow(/expected an object/);
    expect(() => pullRequestChecksEnvelope({
      total: 2,
      buckets: { pass: 1, fail: 0, pending: 0, skipping: 0, cancel: 0 },
      checks: [],
    }, 10)).toThrow(/bucket counts do not equal total/);
    expect(() => pullRequestChecksEnvelope({
      total: 1,
      buckets: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 1 },
      checks: [{
        bucket: "unknown",
        completedAt: null,
        event: "pull_request",
        name: "test",
        startedAt: null,
        state: "QUEUED",
        workflow: "CI",
      }],
    }, 1)).toThrow(/bucket.*must be one of/);
    expect(() => pullRequestChecksEnvelope({
      total: 2,
      buckets: { pass: 2, fail: 0, pending: 0, skipping: 0, cancel: 0 },
      checks: [
        {
          bucket: "pass",
          completedAt: null,
          event: "pull_request",
          name: "one",
          startedAt: null,
          state: "SUCCESS",
          workflow: "CI",
        },
        {
          bucket: "pass",
          completedAt: null,
          event: "pull_request",
          name: "two",
          startedAt: null,
          state: "SUCCESS",
          workflow: "CI",
        },
      ],
    }, 1)).toThrow(/exceeding the requested limit/);
  });
});

describe("pull request diff byte chunking", () => {
  it("prefers a newline without exceeding the byte limit", () => {
    expect(pullRequestDiffChunk("line 1\nline 2\n", 0, 10)).toEqual({
      diff: "line 1\n",
      offsetBytes: 0,
      limitBytes: 10,
      totalBytes: 14,
      returnedBytes: 7,
      nextOffsetBytes: 7,
      truncated: true,
      endedAtLineBoundary: true,
      completeness: "not_guaranteed",
      githubMayLimitLargeDiffs: true,
    });
  });

  it("uses exact UTF-8 byte offsets and never splits a character", () => {
    expect(pullRequestDiffChunk("AあB\n", 1, 3)).toEqual({
      diff: "あ",
      offsetBytes: 1,
      limitBytes: 3,
      totalBytes: 6,
      returnedBytes: 3,
      nextOffsetBytes: 4,
      truncated: true,
      endedAtLineBoundary: false,
      completeness: "not_guaranteed",
      githubMayLimitLargeDiffs: true,
    });
  });

  it("marks a final continuation chunk as partial because its prefix is omitted", () => {
    expect(pullRequestDiffChunk("line 1\nline 2\n", 7, 100)).toEqual({
      diff: "line 2\n",
      offsetBytes: 7,
      limitBytes: 100,
      totalBytes: 14,
      returnedBytes: 7,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
      completeness: "not_guaranteed",
      githubMayLimitLargeDiffs: true,
    });
    expect(pullRequestDiffChunk("line 1\n", 0, 100).truncated).toBe(false);
  });

  it("accepts an exact end offset and an empty diff", () => {
    expect(pullRequestDiffChunk("abc", 3, 1)).toMatchObject({
      diff: "",
      totalBytes: 3,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
    });
    expect(pullRequestDiffChunk("", 0, 1)).toMatchObject({
      diff: "",
      totalBytes: 0,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: false,
      endedAtLineBoundary: true,
    });
  });

  it("rejects invalid or unsafe byte ranges", () => {
    expect(() => pullRequestDiffChunk("AあB", 2, 4)).toThrow(/UTF-8 character boundary/);
    expect(() => pullRequestDiffChunk("AあB", 1, 2)).toThrow(/too small.*UTF-8 character/);
    expect(() => pullRequestDiffChunk("abc", 4, 1)).toThrow(/exceeds.*3 bytes/);
    expect(() => pullRequestDiffChunk("abc", -1, 1)).toThrow(/offsetBytes.*greater than or equal to 0/);
    expect(() => pullRequestDiffChunk("abc", 0, 0)).toThrow(/limitBytes.*greater than or equal to 1/);
    expect(() => pullRequestDiffChunk("abc", 0.5, 1)).toThrow(/offsetBytes.*safe integer/);
  });
});
