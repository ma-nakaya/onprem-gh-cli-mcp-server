import { describe, expect, it } from "vitest";
import {
  assertCommentPullRequest,
  PULL_REQUEST_COMMENT_JQ,
  PULL_REQUEST_COMMENTS_JQ,
  pullRequestComment,
  pullRequestComments,
} from "../src/pull-request-comment.js";

const repository = "ma-nakaya/example";

function restComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    nodeId: "IC_node101",
    body: "Top-level pull request comment",
    author: { login: "octocat", type: "User", email: "must-not-leak@example.com" },
    authorAssociation: "CONTRIBUTOR",
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:01:00Z",
    url: "https://github.com/ma-nakaya/example/pull/7#issuecomment-101",
    issueUrl: "https://api.github.com/repos/ma-nakaya/example/issues/7",
    secret: "must not be returned",
    ...overrides,
  };
}

describe("pull request top-level comment REST response handling", () => {
  it("exports jq projections for list and single-comment endpoints", () => {
    expect(PULL_REQUEST_COMMENTS_JQ).toContain("if type == \"array\"");
    expect(PULL_REQUEST_COMMENTS_JQ).toContain("map({id: .id");
    expect(PULL_REQUEST_COMMENT_JQ).toContain("{id: .id");
    for (const projection of [PULL_REQUEST_COMMENTS_JQ, PULL_REQUEST_COMMENT_JQ]) {
      expect(projection).toContain("body: (.body // \"\")");
      expect(projection).toContain("issueUrl: .issue_url");
      expect(projection).toContain("authorAssociation: (.author_association // null)");
    }
  });

  it("returns full bodies while removing unexpected comment and author fields", () => {
    expect(pullRequestComments([restComment()], 1)).toEqual([{
      id: 101,
      nodeId: "IC_node101",
      body: "Top-level pull request comment",
      author: { login: "octocat", type: "User" },
      authorAssociation: "CONTRIBUTOR",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:01:00Z",
      url: "https://github.com/ma-nakaya/example/pull/7#issuecomment-101",
      issueUrl: "https://api.github.com/repos/ma-nakaya/example/issues/7",
    }]);
  });

  it("accepts empty bodies, null authors, and null author associations", () => {
    expect(pullRequestComment(restComment({
      body: "",
      author: null,
      authorAssociation: null,
    }))).toMatchObject({
      body: "",
      author: null,
      authorAssociation: null,
    });
  });

  it("rejects malformed fields and oversized pages", () => {
    expect(() => pullRequestComments({}, 1)).toThrow(/expected an array/);
    expect(() => pullRequestComments([], -1)).toThrow(/non-negative safe integer/);
    expect(() => pullRequestComments([], 0.5)).toThrow(/non-negative safe integer/);
    expect(() => pullRequestComments([restComment()], 0))
      .toThrow(/exceeding the requested maximum of 0/);
    expect(() => pullRequestComment(restComment({ id: 0 }))).toThrow(/positive safe integer/);
    expect(() => pullRequestComment(restComment({ id: Number.MAX_SAFE_INTEGER + 1 })))
      .toThrow(/positive safe integer/);
    expect(() => pullRequestComment(restComment({ nodeId: "" }))).toThrow(/"nodeId".*non-empty/);
    expect(() => pullRequestComment(restComment({ body: null }))).toThrow(/"body".*string/);
    expect(() => pullRequestComment(restComment({ author: { login: "", type: "User" } })))
      .toThrow(/"login".*non-empty/);
    expect(() => pullRequestComment(restComment({ authorAssociation: undefined })))
      .toThrow(/"authorAssociation".*string or null/);
    expect(() => pullRequestComment(restComment({ createdAt: "" })))
      .toThrow(/"createdAt".*non-empty/);
    expect(() => pullRequestComment(restComment({ issueUrl: "" })))
      .toThrow(/"issueUrl".*non-empty/);
  });
});

describe("pull request top-level comment ownership validation", () => {
  it("accepts GitHub.com and GHES API URLs with canonical repository casing", () => {
    expect(() => assertCommentPullRequest(
      pullRequestComment(restComment()),
      repository,
      7,
      "github.com",
    ))
      .not.toThrow();
    expect(() => assertCommentPullRequest(pullRequestComment(restComment({
      issueUrl: "https://github.example.test/api/v3/repos/MA-NAKAYA/EXAMPLE/issues/7",
    })), repository, 7, "github.example.test")).not.toThrow();
  });

  it("rejects another repository, pull request number, or malformed URL", () => {
    expect(() => assertCommentPullRequest(
      pullRequestComment(restComment()),
      repository,
      8,
      "github.com",
    ))
      .toThrow(/does not belong/);
    expect(() => assertCommentPullRequest(pullRequestComment(restComment({
      issueUrl: "https://api.github.com/repos/other-owner/example/issues/7",
    })), repository, 7, "github.com")).toThrow(/does not belong/);
    expect(() => assertCommentPullRequest(pullRequestComment(restComment({
      issueUrl: "not a URL",
    })), repository, 7, "github.com")).toThrow(/invalid issue URL/);
  });

  it("rejects an unexpected API host, scheme, path prefix, or query", () => {
    for (const issueUrl of [
      "https://evil.example/repos/ma-nakaya/example/issues/7",
      "ftp://api.github.com/repos/ma-nakaya/example/issues/7",
      "https://api.github.com/unexpected/repos/ma-nakaya/example/issues/7",
      "https://api.github.com/repos/ma-nakaya/example/issues/7?redirected=true",
      "https://api.github.com:8443/repos/ma-nakaya/example/issues/7",
    ]) {
      expect(() => assertCommentPullRequest(
        pullRequestComment(restComment({ issueUrl })),
        repository,
        7,
        "github.com",
      ), issueUrl).toThrow(/does not belong/);
    }
  });
});
