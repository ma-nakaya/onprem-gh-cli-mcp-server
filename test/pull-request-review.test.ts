import { describe, expect, it } from "vitest";
import {
  assertInlineReviewTarget,
  assertReviewCommentPullRequest,
  pullRequestReviewComment,
  pullRequestReviewComments,
  pullRequestReviewThreadDetails,
  pullRequestReviewThreadsPage,
  pullRequestReviews,
  reviewThreadMutationSummary,
} from "../src/pull-request-review.js";

const repository = "ma-nakaya/example";

function restComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    nodeId: "PRRC_node101",
    pullRequestReviewId: 88,
    body: "Inline body",
    author: { login: "copilot", type: "Bot" },
    authorAssociation: "CONTRIBUTOR",
    path: "src/index.ts",
    line: 12,
    originalLine: 10,
    startLine: null,
    originalStartLine: null,
    side: "RIGHT",
    startSide: null,
    subjectType: "line",
    commitId: "a".repeat(40),
    originalCommitId: "b".repeat(40),
    replyToId: null,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:01:00Z",
    url: "https://github.com/ma-nakaya/example/pull/7#discussion_r101",
    pullRequestUrl: "https://api.github.com/repos/ma-nakaya/example/pulls/7",
    secret: "must not be returned",
    ...overrides,
  };
}

function graphqlComment() {
  return {
    id: "PRRC_node101",
    fullDatabaseId: "101",
    body: "Inline body",
    author: { login: "copilot", __typename: "Bot" },
    authorAssociation: "CONTRIBUTOR",
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:01:00Z",
    url: "https://github.com/ma-nakaya/example/pull/7#discussion_r101",
    path: "src/index.ts",
    line: 12,
    originalLine: 10,
    startLine: null,
    originalStartLine: null,
    outdated: false,
    state: "SUBMITTED",
    subjectType: "LINE",
    replyTo: null,
    viewerCanDelete: false,
    viewerCanUpdate: false,
  };
}

function graphqlThread() {
  return {
    id: "PRRT_thread101",
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    path: "src/index.ts",
    line: 12,
    originalLine: 10,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    resolvedBy: null,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: "cursor-comment" },
      nodes: [graphqlComment()],
    },
  };
}

describe("pull request review REST response handling", () => {
  it("returns full review bodies while removing unexpected fields", () => {
    expect(pullRequestReviews([{
      id: 88,
      nodeId: "PRR_node88",
      state: "COMMENTED",
      body: "Review body",
      author: { login: "copilot", type: "Bot", email: "hidden@example.com" },
      authorAssociation: "CONTRIBUTOR",
      submittedAt: "2026-08-03T00:00:00Z",
      commitId: "a".repeat(40),
      url: "https://github.com/ma-nakaya/example/pull/7#pullrequestreview-88",
      secret: "must not be returned",
    }], 1)).toEqual([{
      id: 88,
      nodeId: "PRR_node88",
      state: "COMMENTED",
      body: "Review body",
      author: { login: "copilot", type: "Bot" },
      authorAssociation: "CONTRIBUTOR",
      submittedAt: "2026-08-03T00:00:00Z",
      commitId: "a".repeat(40),
      url: "https://github.com/ma-nakaya/example/pull/7#pullrequestreview-88",
    }]);
  });

  it("returns inline bodies and verifies pull request ownership", () => {
    const comment = pullRequestReviewComment(restComment());
    expect(comment.body).toBe("Inline body");
    expect(comment).not.toHaveProperty("secret");
    expect(() => assertReviewCommentPullRequest(comment, repository, 7)).not.toThrow();
    expect(() => assertReviewCommentPullRequest(comment, repository, 8)).toThrow(/does not belong/);
    expect(() => assertReviewCommentPullRequest(
      pullRequestReviewComment(restComment({
        pullRequestUrl: "https://api.github.com/repos/other-owner/example/pulls/7",
      })),
      repository,
      7,
    )).toThrow(/does not belong/);
  });

  it("rejects malformed and oversized inline comment pages", () => {
    expect(() => pullRequestReviewComments({}, 1)).toThrow(/expected an array/);
    expect(() => pullRequestReviewComments([restComment(), restComment({ id: 102 })], 1))
      .toThrow(/exceeding the requested maximum/);
    expect(() => pullRequestReviewComment(restComment({ id: 0 }))).toThrow(/positive|greater than/);
  });
});

describe("pull request review thread GraphQL response handling", () => {
  it("returns thread state, permissions, bodies, and independent pagination", () => {
    const value = {
      data: {
        repository: {
          nameWithOwner: repository,
          pullRequest: {
            id: "PR_node7",
            number: 7,
            reviewThreads: {
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "cursor-thread" },
              nodes: [graphqlThread()],
            },
          },
        },
      },
    };
    const page = pullRequestReviewThreadsPage(value, repository, 7, 1, 1);
    expect(page.pullRequestNodeId).toBe("PR_node7");
    expect(page.pagination).toEqual({
      total: 2,
      returnedCount: 1,
      hasNextPage: true,
      endCursor: "cursor-thread",
    });
    expect(page.threads[0]).toMatchObject({
      id: "PRRT_thread101",
      isResolved: false,
      viewerCanResolve: true,
      comments: [{ body: "Inline body", databaseId: "101" }],
      commentsPagination: {
        total: 1,
        returnedCount: 1,
        hasNextPage: false,
      },
    });
  });

  it("verifies a thread node belongs to the requested repository and PR", () => {
    const node = {
      ...graphqlThread(),
      repository: { nameWithOwner: repository },
      pullRequest: { id: "PR_node7", number: 7 },
    };
    const value = { data: { node } };
    expect(pullRequestReviewThreadDetails(value, repository, 7, "PRRT_thread101", 1).id)
      .toBe("PRRT_thread101");
    expect(() => pullRequestReviewThreadDetails(value, "other/repo", 7, "PRRT_thread101", 1))
      .toThrow(/instead of/);
    expect(() => pullRequestReviewThreadDetails(value, repository, 8, "PRRT_thread101", 1))
      .toThrow(/instead of #8/);
  });

  it("requires mutation results to match the requested thread and state", () => {
    const result = {
      data: {
        resolveReviewThread: {
          thread: {
            id: "PRRT_thread101",
            isResolved: true,
            viewerCanResolve: false,
            viewerCanUnresolve: true,
          },
        },
      },
    };
    expect(reviewThreadMutationSummary(
      result,
      "resolveReviewThread",
      "PRRT_thread101",
      true,
    )).toMatchObject({ id: "PRRT_thread101", isResolved: true });
    expect(() => reviewThreadMutationSummary(
      result,
      "resolveReviewThread",
      "PRRT_other",
      true,
    )).toThrow(/unexpected/);
  });
});

describe("inline review target validation", () => {
  it("accepts line, range, and file targets", () => {
    expect(() => assertInlineReviewTarget({
      subjectType: "line",
      path: "src/index.ts",
      line: 12,
      side: "RIGHT",
    })).not.toThrow();
    expect(() => assertInlineReviewTarget({
      subjectType: "line",
      path: "src/index.ts",
      line: 12,
      side: "RIGHT",
      startLine: 10,
      startSide: "RIGHT",
    })).not.toThrow();
    expect(() => assertInlineReviewTarget({
      subjectType: "file",
      path: "src/index.ts",
    })).not.toThrow();
  });

  it("rejects ambiguous or unsafe targets", () => {
    expect(() => assertInlineReviewTarget({
      subjectType: "line",
      path: "../secret",
      line: 1,
      side: "RIGHT",
    })).toThrow(/normalized/);
    expect(() => assertInlineReviewTarget({
      subjectType: "line",
      path: "src/index.ts",
    })).toThrow(/require line and side/);
    expect(() => assertInlineReviewTarget({
      subjectType: "file",
      path: "src/index.ts",
      line: 1,
    })).toThrow(/must not specify/);
    expect(() => assertInlineReviewTarget({
      subjectType: "line",
      path: "src/index.ts",
      line: 5,
      side: "RIGHT",
      startLine: 7,
      startSide: "RIGHT",
    })).toThrow(/must not exceed/);
  });
});
