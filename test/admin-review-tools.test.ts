import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";
import type { AccountProfile, Config } from "../src/config.js";
import { runGh } from "../src/gh-runner.js";
import { createServer } from "../src/server.js";

vi.mock("../src/gh-runner.js", () => ({
  runGh: vi.fn(),
}));
vi.mock("../src/audit-log.js", () => ({
  appendAuditRecord: vi.fn(),
}));

const runGhMock = vi.mocked(runGh);
const appendAuditRecordMock = vi.mocked(appendAuditRecord);
const repository = "ma-nakaya/example";
const headSha = "a".repeat(40);

function profile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return Object.freeze({
    id: "ma-nakaya",
    expectedLogin: "ma-nakaya",
    hostname: "github.com",
    configDir: "C:/secure/gh-ma-nakaya",
    allowedOwners: new Set(["ma-nakaya"]),
    allowedRepositories: new Set<string>(),
    ...overrides,
  });
}

function accountConfig(accountProfile = profile()): Config {
  return {
    ghPath: "gh",
    allowedHosts: new Set(["github.com"]),
    accountProfiles: new Map([[accountProfile.id, accountProfile]]),
    defaultAccountId: accountProfile.id,
    timeoutMs: 1000,
    maxOutputBytes: 500_000,
    auditLogPath: "audit.jsonl",
  };
}

async function connectedClient(config = accountConfig()): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer(config);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function result(value: unknown) {
  return { exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
}

function identityResult() {
  return result("ma-nakaya\n");
}

function repositoryIdentityResult() {
  return result({ fullName: repository });
}

function repositoryDetails(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    nodeId: "R_node123",
    fullName: repository,
    name: "example",
    owner: { login: "ma-nakaya", type: "User" },
    description: "Description",
    visibility: "private",
    isPrivate: true,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    defaultBranch: "main",
    hasIssues: true,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
    pushedAt: "2026-08-03T00:00:00Z",
    url: `https://github.com/${repository}`,
    ...overrides,
  };
}

function pullIdentity(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    nodeId: "PR_node7",
    state: "open",
    merged: false,
    headSha,
    url: `https://github.com/${repository}/pull/7`,
    ...overrides,
  };
}

function reviewComment(overrides: Record<string, unknown> = {}) {
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
    commitId: headSha,
    originalCommitId: headSha,
    replyToId: null,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:01:00Z",
    url: `https://github.com/${repository}/pull/7#discussion_r101`,
    pullRequestUrl: `https://api.github.com/repos/${repository}/pulls/7`,
    ...overrides,
  };
}

function label(name = "priority-high") {
  return {
    id: 5,
    nodeId: "LA_node5",
    name,
    color: "ff0000",
    description: "Priority label",
    isDefault: false,
    url: `https://api.github.com/repos/${repository}/labels/${name}`,
  };
}

function threadNode(isResolved = false) {
  return {
    id: "PRRT_thread101",
    isResolved,
    isOutdated: false,
    isCollapsed: isResolved,
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
    viewerCanResolve: !isResolved,
    viewerCanUnresolve: isResolved,
    repository: { nameWithOwner: repository },
    pullRequest: { id: "PR_node7", number: 7 },
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: "comment-cursor" },
      nodes: [{
        id: "PRRC_node101",
        fullDatabaseId: "101",
        body: "Inline body",
        author: { login: "copilot", __typename: "Bot" },
        authorAssociation: "CONTRIBUTOR",
        createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T00:01:00Z",
        url: `https://github.com/${repository}/pull/7#discussion_r101`,
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
      }],
    },
  };
}

function parseToolJson(toolResult: { content: unknown }): Record<string, unknown> {
  const blocks = toolResult.content as Array<{ type: string; text?: string }>;
  return JSON.parse(blocks[0]?.text ?? "null") as Record<string, unknown>;
}

function stdinPayload(callIndex: number): Record<string, unknown> {
  const options = runGhMock.mock.calls[callIndex]?.[3] as { stdin?: string } | undefined;
  return JSON.parse(options?.stdin ?? "null") as Record<string, unknown>;
}

describe("review and administration MCP tools", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  it("reads inline review bodies only after canonical repository verification", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result([reviewComment()]));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "list_pull_request_review_comments",
        arguments: { repository, pullRequestNumber: 7, page: 1, perPage: 50 },
      });
      expect(toolResult.isError).not.toBe(true);
      const value = parseToolJson(toolResult);
      expect((value.comments as Array<Record<string, unknown>>)[0]?.body).toBe("Inline body");
      expect(value.contentTrust).toBe("untrusted_repository_content");
      expect(runGhMock.mock.calls.map(([args]) => args[1])).toEqual([
        "user",
        `repos/${repository}`,
        `repos/${repository}/pulls/7/comments?per_page=50&page=1`,
      ]);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("replies only to a top-level comment belonging to the requested pull request", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(pullIdentity()))
      .mockResolvedValueOnce(result(reviewComment()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(reviewComment({ id: 102, nodeId: "PRRC_node102", replyToId: 101 })));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "reply_pull_request_review_comment",
        arguments: {
          repository,
          pullRequestNumber: 7,
          reviewCommentId: 101,
          body: "Reply body",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      const writeCallIndex = runGhMock.mock.calls.findIndex(([args]) => args.includes("POST"));
      expect(writeCallIndex).toBeGreaterThan(0);
      expect(stdinPayload(writeCallIndex)).toEqual({ body: "Reply body" });
      expect(JSON.stringify(appendAuditRecordMock.mock.calls)).not.toContain("Reply body");
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("rejects a review comment ID from a different pull request before auditing or writing", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(pullIdentity()))
      .mockResolvedValueOnce(result(reviewComment({
        pullRequestUrl: `https://api.github.com/repos/${repository}/pulls/8`,
      })));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "reply_pull_request_review_comment",
        arguments: {
          repository,
          pullRequestNumber: 7,
          reviewCommentId: 101,
          body: "Must not post",
        },
      });
      expect(toolResult.isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toMatch(/does not belong/);
      expect(runGhMock).toHaveBeenCalledTimes(4);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("creates a line-level review comment only on the expected head", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(pullIdentity()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(reviewComment()));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "create_pull_request_review_comment",
        arguments: {
          repository,
          pullRequestNumber: 7,
          expectedHeadSha: headSha,
          body: "Inline body",
          path: "src/index.ts",
          subjectType: "line",
          line: 12,
          side: "RIGHT",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(4)).toEqual({
        body: "Inline body",
        commit_id: headSha,
        path: "src/index.ts",
        subject_type: "line",
        line: 12,
        side: "RIGHT",
      });
      expect(JSON.stringify(appendAuditRecordMock.mock.calls)).not.toContain("Inline body");
      expect(appendAuditRecordMock.mock.calls[1]?.[1]).toMatchObject({ reviewCommentId: 101 });
    } finally {
      await connection.close();
    }
  });

  it("edits a review comment only when updatedAt still matches", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(reviewComment()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(reviewComment({
        body: "Edited body",
        updatedAt: "2026-08-03T00:02:00Z",
      })));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "update_pull_request_review_comment",
        arguments: {
          repository,
          pullRequestNumber: 7,
          reviewCommentId: 101,
          expectedUpdatedAt: "2026-08-03T00:01:00Z",
          body: "Edited body",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(4)).toEqual({ body: "Edited body" });
      expect(JSON.stringify(appendAuditRecordMock.mock.calls)).not.toContain("Edited body");
    } finally {
      await connection.close();
    }
  });

  it("deletes an inline comment only after node ID and updatedAt confirmation", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(reviewComment()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(""));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "delete_pull_request_review_comment",
        arguments: {
          repository,
          pullRequestNumber: 7,
          reviewCommentId: 101,
          expectedNodeId: "PRRC_node101",
          expectedUpdatedAt: "2026-08-03T00:01:00Z",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(runGhMock.mock.calls[4]?.[0]).toEqual([
        "api",
        `repos/${repository}/pulls/comments/101`,
        "--hostname",
        "github.com",
        "--method",
        "DELETE",
      ]);
      expect(parseToolJson(toolResult)).toMatchObject({
        deleted: { reviewCommentId: 101, nodeId: "PRRC_node101" },
      });
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("resolves a verified review thread through GraphQL and audits no body", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result({ data: { node: threadNode(false) } }))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result({
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
      }));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "resolve_pull_request_review_thread",
        arguments: {
          repository,
          pullRequestNumber: 7,
          reviewThreadId: "PRRT_thread101",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(parseToolJson(toolResult)).toMatchObject({
        thread: { id: "PRRT_thread101", isResolved: true },
        changed: true,
      });
      const mutationPayload = stdinPayload(4);
      expect(String(mutationPayload.query)).toContain("resolveReviewThread");
      expect(mutationPayload.variables).toMatchObject({ threadId: "PRRT_thread101" });
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("merges only the exact expected head SHA with an explicit method", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(pullIdentity()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result({
        merged: true,
        sha: "b".repeat(40),
        message: "Pull Request successfully merged",
      }));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "merge_pull_request",
        arguments: {
          repository,
          pullRequestNumber: 7,
          expectedHeadSha: headSha,
          mergeMethod: "squash",
          commitTitle: "Safe title",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(4)).toEqual({
        sha: headSha,
        merge_method: "squash",
        commit_title: "Safe title",
      });
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
      expect(appendAuditRecordMock.mock.calls[1]?.[1]).toMatchObject({
        tool: "merge_pull_request",
        commitSha: "b".repeat(40),
        outcome: "succeeded",
      });
      expect(JSON.stringify(appendAuditRecordMock.mock.calls)).not.toContain("Safe title");
    } finally {
      await connection.close();
    }
  });

  it("rejects a stale merge SHA before the audit lifecycle or mutation", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result(pullIdentity()));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "merge_pull_request",
        arguments: {
          repository,
          pullRequestNumber: 7,
          expectedHeadSha: "c".repeat(40),
          mergeMethod: "merge",
        },
      });
      expect(toolResult.isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toMatch(/does not match/);
      expect(runGhMock).toHaveBeenCalledTimes(3);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("creates repositories as private by default for the authenticated user", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result({ login: "ma-nakaya", type: "User" }))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(repositoryDetails()));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "create_repository",
        arguments: { owner: "ma-nakaya", name: "example" },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(3)).toEqual({
        name: "example",
        auto_init: false,
        has_issues: true,
        private: true,
      });
      expect(runGhMock.mock.calls[3]?.[0]).toContain("user/repos");
      expect(appendAuditRecordMock.mock.calls[1]?.[1]).toMatchObject({
        repository,
        repositoryId: 123,
      });
    } finally {
      await connection.close();
    }
  });

  it("deletes only after both stable repository ID and owner/name confirmation match", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(repositoryDetails()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(""));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "delete_repository",
        arguments: {
          repository,
          expectedRepositoryId: 123,
          confirmRepository: repository,
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(runGhMock.mock.calls[3]?.[0]).toEqual([
        "api",
        `repos/${repository}`,
        "--hostname",
        "github.com",
        "--method",
        "DELETE",
      ]);
      expect(parseToolJson(toolResult)).toMatchObject({
        deleted: { repository, repositoryId: 123 },
      });
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("updates a repository description only when its stable ID matches", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(repositoryDetails()))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(repositoryDetails({ description: "New description" })));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "update_repository_description",
        arguments: {
          repository,
          expectedRepositoryId: 123,
          description: "New description",
        },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(3)).toEqual({ description: "New description" });
      expect(JSON.stringify(appendAuditRecordMock.mock.calls)).not.toContain("New description");
      expect(parseToolJson(toolResult)).toMatchObject({
        repository: { id: 123, description: "New description" },
      });
    } finally {
      await connection.close();
    }
  });

  it("rejects repository deletion confirmation mismatch before auditing", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result(repositoryDetails()));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "delete_repository",
        arguments: {
          repository,
          expectedRepositoryId: 123,
          confirmRepository: "ma-nakaya/other",
        },
      });
      expect(toolResult.isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toMatch(/confirmRepository/);
      expect(runGhMock).toHaveBeenCalledTimes(2);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("adds labels to either issues or pull requests without replacing current labels", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(result({ number: 7 }))
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result([label()]));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "add_issue_labels",
        arguments: { repository, issueNumber: 7, labels: ["priority-high"] },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(stdinPayload(4)).toEqual({ labels: ["priority-high"] });
      expect(runGhMock.mock.calls[4]?.[0]).toContain("POST");
      expect(parseToolJson(toolResult)).toMatchObject({
        labels: [{ name: "priority-high" }],
        contentTrust: "untrusted_repository_content",
      });
    } finally {
      await connection.close();
    }
  });

  it("removes one issue or pull request label without replacing the others", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(repositoryIdentityResult())
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(result([label("remaining") ]));
    const connection = await connectedClient();
    try {
      const toolResult = await connection.client.callTool({
        name: "remove_issue_label",
        arguments: { repository, issueNumber: 7, label: "priority-high" },
      });
      expect(toolResult.isError).not.toBe(true);
      expect(runGhMock.mock.calls[3]?.[0]).toContain("DELETE");
      expect(runGhMock.mock.calls[3]?.[0][1]).toContain("priority-high");
      expect(parseToolJson(toolResult)).toMatchObject({
        removedLabel: "priority-high",
        labels: [{ name: "remaining" }],
      });
    } finally {
      await connection.close();
    }
  });
});
