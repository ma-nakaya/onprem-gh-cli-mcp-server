import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";
import type { AccountProfile, Config } from "../src/config.js";
import { runGh } from "../src/gh-runner.js";
import {
  PULL_REQUEST_COMMENT_JQ,
  PULL_REQUEST_COMMENTS_JQ,
} from "../src/pull-request-comment.js";
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
const pullRequestNumber = 7;
const commentId = 5_364_709_842;
const contentTrust = "untrusted_repository_content";
const pullRequestIdentityJq = "{number:.number,repository:(.base.repo.full_name // null)}";

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

function accountConfig(
  accountProfile = profile(),
  overrides: Partial<Config> = {},
): Config {
  return {
    ghPath: "gh",
    allowedHosts: new Set([accountProfile.hostname]),
    accountProfiles: new Map([[accountProfile.id, accountProfile]]),
    defaultAccountId: accountProfile.id,
    timeoutMs: 1000,
    maxOutputBytes: 200_000,
    auditLogPath: "audit.jsonl",
    ...overrides,
  };
}

async function connectedClient(config = accountConfig()): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer(config);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseToolJson(result: { content: unknown }): Record<string, unknown> {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  return JSON.parse(blocks[0]?.text ?? "null") as Record<string, unknown>;
}

function ghResult(value: unknown) {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function identityResult(login = "ma-nakaya") {
  return { exitCode: 0, stdout: `${login}\n`, stderr: "" };
}

function conversationComment(overrides: Record<string, unknown> = {}) {
  return {
    id: commentId,
    nodeId: "IC_kwDOExample",
    body: "Top-level Conversation body",
    author: { login: "coderabbitai", type: "Bot" },
    authorAssociation: "NONE",
    createdAt: "2026-08-21T01:02:03Z",
    updatedAt: "2026-08-21T01:02:04Z",
    url: `https://github.com/${repository}/pull/${pullRequestNumber}#issuecomment-${commentId}`,
    issueUrl: `https://api.github.com/repos/${repository}/issues/${pullRequestNumber}`,
    ...overrides,
  };
}

function mockVerifiedTarget() {
  runGhMock
    .mockResolvedValueOnce(identityResult())
    .mockResolvedValueOnce(ghResult({ fullName: repository }))
    .mockResolvedValueOnce(ghResult({ number: pullRequestNumber, repository }));
}

describe("pull request Conversation comment tools", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  it("registers list and single-comment reads with distinct typed inputs", async () => {
    const connection = await connectedClient();

    try {
      const result = await connection.client.listTools();
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

      for (const name of ["list_pull_request_comments", "get_pull_request_comment"]) {
        const tool = tools.get(name);
        expect(tool).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);
        expect(tool?.description).toMatch(/top-level|Conversation/i);
        expect(tool?.description).toMatch(/untrusted/i);
        const schema = tool?.inputSchema as {
          required?: string[];
          properties?: Record<string, { type?: string; minimum?: number; exclusiveMinimum?: number }>;
        };
        expect(schema.required).toEqual(expect.arrayContaining(["repository", "pullRequestNumber"]));
        expect(schema.properties?.pullRequestNumber?.type).toBe("integer");
      }

      const getSchema = tools.get("get_pull_request_comment")?.inputSchema as {
        required?: string[];
        properties?: Record<string, { type?: string; minimum?: number; exclusiveMinimum?: number }>;
      };
      expect(getSchema.required).toContain("commentId");
      expect(getSchema.properties?.commentId?.type).toBe("integer");
      expect(
        getSchema.properties?.commentId?.minimum === 1
          || getSchema.properties?.commentId?.exclusiveMinimum === 0,
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it.each([
    ["get_pull_request_comment", { repository, pullRequestNumber, commentId: 0 }],
    ["list_pull_request_comments", { repository, pullRequestNumber, page: 0 }],
    ["list_pull_request_comments", { repository, pullRequestNumber, perPage: 101 }],
  ])("rejects invalid bounded input before GitHub access: %s", async (name, arguments_) => {
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({ name, arguments: arguments_ });

      expect(result.isError).toBe(true);
      expect(runGhMock).not.toHaveBeenCalled();
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("lists a bounded page of top-level pull request comments after PR verification", async () => {
    mockVerifiedTarget();
    runGhMock.mockResolvedValueOnce(ghResult([
      conversationComment(),
      conversationComment({
        id: commentId + 1,
        nodeId: "IC_kwDOExample2",
        body: "Second body",
        url: `https://github.com/${repository}/pull/${pullRequestNumber}#issuecomment-${commentId + 1}`,
      }),
    ]));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_comments",
        arguments: { repository, pullRequestNumber, page: 2, perPage: 2 },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        ["api", `repos/${repository}`, "--hostname", "github.com", "--jq", "{fullName:.full_name}"],
        [
          "api",
          `repos/${repository}/pulls/${pullRequestNumber}`,
          "--hostname",
          "github.com",
          "--jq",
          pullRequestIdentityJq,
        ],
        [
          "api",
          `repos/${repository}/issues/${pullRequestNumber}/comments?per_page=2&page=2`,
          "--hostname",
          "github.com",
          "--jq",
          PULL_REQUEST_COMMENTS_JQ,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value.contentTrust).toBe(contentTrust);
      expect(value.pagination).toEqual({
        page: 2,
        perPage: 2,
        returnedCount: 2,
      });
      expect((value.comments as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: commentId,
        body: "Top-level Conversation body",
        issueUrl: `https://api.github.com/repos/${repository}/issues/${pullRequestNumber}`,
      });
      expect(value.source).toEqual({
        provider: "github",
        hostname: "github.com",
        account: "ma-nakaya",
        repository,
        pullRequestNumber,
      });
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("gets one #issuecomment on GitHub Enterprise Server and returns only selected fields", async () => {
    const hostname = "github.example.internal";
    const enterpriseProfile = profile({ hostname });
    mockVerifiedTarget();
    runGhMock.mockResolvedValueOnce(ghResult(conversationComment({
      url: `https://${hostname}/${repository}/pull/${pullRequestNumber}#issuecomment-${commentId}`,
      issueUrl: `https://${hostname}/api/v3/repos/${repository}/issues/${pullRequestNumber}`,
      unexpectedSecret: "must-not-escape",
    })));
    const connection = await connectedClient(accountConfig(enterpriseProfile));

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", hostname, "--jq", ".login"],
        ["api", `repos/${repository}`, "--hostname", hostname, "--jq", "{fullName:.full_name}"],
        [
          "api",
          `repos/${repository}/pulls/${pullRequestNumber}`,
          "--hostname",
          hostname,
          "--jq",
          pullRequestIdentityJq,
        ],
        [
          "api",
          `repos/${repository}/issues/comments/${commentId}`,
          "--hostname",
          hostname,
          "--jq",
          PULL_REQUEST_COMMENT_JQ,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value.comment).toEqual({
        id: commentId,
        nodeId: "IC_kwDOExample",
        body: "Top-level Conversation body",
        author: { login: "coderabbitai", type: "Bot" },
        authorAssociation: "NONE",
        createdAt: "2026-08-21T01:02:03Z",
        updatedAt: "2026-08-21T01:02:04Z",
        url: `https://${hostname}/${repository}/pull/${pullRequestNumber}#issuecomment-${commentId}`,
        issueUrl: `https://${hostname}/api/v3/repos/${repository}/issues/${pullRequestNumber}`,
      });
      expect(value.source).toEqual({
        provider: "github",
        hostname,
        account: "ma-nakaya",
        repository,
        pullRequestNumber,
        commentId,
      });
      expect(JSON.stringify(value)).not.toContain("must-not-escape");
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects a comment that belongs to another pull request", async () => {
    mockVerifiedTarget();
    runGhMock.mockResolvedValueOnce(ghResult(conversationComment({
      issueUrl: `https://api.github.com/repos/${repository}/issues/8`,
    })));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/does not belong.*pull request #7/i);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects a single-comment response with a different numeric ID", async () => {
    mockVerifiedTarget();
    runGhMock.mockResolvedValueOnce(ghResult(conversationComment({ id: commentId + 1 })));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        new RegExp(`comment ${commentId + 1} instead of ${commentId}`, "i"),
      );
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("fails the whole page when any listed comment belongs to another pull request", async () => {
    mockVerifiedTarget();
    runGhMock.mockResolvedValueOnce(ghResult([
      conversationComment(),
      conversationComment({
        id: commentId + 1,
        issueUrl: `https://api.github.com/repos/${repository}/issues/8`,
      }),
    ]));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_comments",
        arguments: { repository, pullRequestNumber, perPage: 2 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/does not belong.*pull request #7/i);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("stops before comment access when the target is not a pull request", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(ghResult({ fullName: repository }))
      .mockRejectedValueOnce(new Error("GitHub API: Not Found (HTTP 404)"));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/not found|404/i);
      expect(runGhMock).toHaveBeenCalledTimes(3);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each([
    [{}, /invalid pull request identity/i],
    [{ number: 8, repository }, /pull request #8 instead of #7/i],
    [{ number: pullRequestNumber, repository: "ma-nakaya/other" }, /repository ma-nakaya\/other instead of ma-nakaya\/example/i],
  ])("rejects a mismatched pull request identity before comment access", async (identity, errorPattern) => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce(ghResult({ fullName: repository }))
      .mockResolvedValueOnce(ghResult(identity));
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(errorPattern);
      expect(runGhMock).toHaveBeenCalledTimes(3);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects a disallowed repository before selecting an account or reading a comment", async () => {
    const restrictedProfile = profile({
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set(["ma-nakaya/allowed"]),
    });
    const connection = await connectedClient(accountConfig(restrictedProfile));

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_comment",
        arguments: { repository, pullRequestNumber, commentId },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/repository is not allowed/i);
      expect(runGhMock).not.toHaveBeenCalled();
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });
});
