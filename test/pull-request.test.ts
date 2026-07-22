import { describe, expect, it } from "vitest";
import { assertReviewBody, pullRequestReviewSummary, pullRequestSummary } from "../src/pull-request.js";

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
