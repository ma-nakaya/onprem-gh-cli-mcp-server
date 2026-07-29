import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const repository = "masa-nakaya/example";
const contentTrust = "untrusted_repository_content";
const issueFields = [
  "number",
  "title",
  "body",
  "state",
  "stateReason",
  "author",
  "assignees",
  "labels",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedAt",
  "url",
].join(",");
const commentsJq =
  "map({id: .id, body: .body, author: (if .user == null then null else {login: .user.login, type: .user.type} end), createdAt: .created_at, updatedAt: .updated_at, url: .html_url})";
const eventsJq =
  "map({id: .id, event: .event, actor: (if .actor == null then null else {login: .actor.login, type: .actor.type} end), createdAt: .created_at, commitId: (.commit_id // null), label: (if .label == null then null else {name: .label.name, color: .label.color} end), assignee: (if .assignee == null then null else {login: .assignee.login, type: .assignee.type} end), assigner: (if .assigner == null then null else {login: .assigner.login, type: .assigner.type} end), milestone: (if .milestone == null then null else {title: .milestone.title} end), rename: (if .rename == null then null else {from: .rename.from, to: .rename.to} end), lockReason: (.lock_reason // null)})";
const jobsJq =
  ".jobs | map({id: .id, name: .name, status: .status, conclusion: (.conclusion // null), startedAt: (.started_at // null), completedAt: (.completed_at // null), runnerName: (.runner_name // null), runnerGroupName: (.runner_group_name // null), labels: (.labels // [])})";
const jobIdentityJq = "{id: .id, runId: .run_id, status: .status}";

function profile(
  id = "masa-nakaya",
  overrides: Partial<AccountProfile> = {},
): AccountProfile {
  return Object.freeze({
    id,
    expectedLogin: id,
    hostname: "github.com",
    configDir: `C:/secure/gh-${id}`,
    allowedOwners: new Set([id]),
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
    allowedHosts: new Set(["github.com"]),
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
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
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

function identityResult(login = "masa-nakaya") {
  return { exitCode: 0, stdout: `${login}\n`, stderr: "" };
}

function issueDetailsResponse(body = "Repository-authored issue body") {
  return {
    number: 27,
    title: "Example issue",
    body,
    state: "OPEN",
    stateReason: "",
    author: {
      login: "octocat",
      is_bot: false,
      name: "The Octocat",
      email: "must-not-leak@example.invalid",
    },
    assignees: [{
      login: "hubot",
      name: null,
      id: "must-not-leak",
    }],
    labels: [{
      name: "bug",
      color: "d73a4a",
      description: null,
      url: "https://api.example.invalid/label",
    }],
    milestone: {
      number: 3,
      title: "v1",
      dueOn: null,
      description: "must not be returned",
    },
    createdAt: "2026-07-29T06:06:00Z",
    updatedAt: "2026-07-29T06:06:00Z",
    closedAt: null,
    url: "https://github.com/masa-nakaya/example/issues/27",
    comments: [{ body: "must not be returned by get_issue" }],
    projectItems: ["must not be returned"],
  };
}

const readToolCalls = [
  {
    name: "get_issue",
    arguments: { repository, issueNumber: 27 },
    requiredIds: ["issueNumber"],
  },
  {
    name: "list_issue_comments",
    arguments: { repository, issueNumber: 27 },
    requiredIds: ["issueNumber"],
  },
  {
    name: "list_issue_events",
    arguments: { repository, issueNumber: 27 },
    requiredIds: ["issueNumber"],
  },
  {
    name: "list_workflow_run_jobs",
    arguments: { repository, runId: 456 },
    requiredIds: ["runId"],
  },
  {
    name: "get_workflow_job_log",
    arguments: { repository, runId: 456, jobId: 123 },
    requiredIds: ["runId", "jobId"],
  },
] as const;

describe("typed issue and Actions read tools", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  afterEach(() => {
    expect(appendAuditRecordMock).not.toHaveBeenCalled();
  });

  it("registers all five tools as typed, non-destructive reads", async () => {
    const connection = await connectedClient();

    try {
      const result = await connection.client.listTools();
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

      for (const { name, requiredIds } of readToolCalls) {
        const tool = tools.get(name);
        expect(tool, `${name} should be registered`).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);
        expect(tool?.description).toMatch(/untrusted/i);

        const schema = tool?.inputSchema as {
          required?: string[];
          properties?: Record<string, {
            type?: string;
            minimum?: number;
            exclusiveMinimum?: number;
          }>;
        };
        expect(schema.required).toContain("repository");
        for (const id of requiredIds) {
          expect(schema.required).toContain(id);
          expect(schema.properties?.[id]?.type).toBe("integer");
          expect(
            schema.properties?.[id]?.minimum === 1
              || schema.properties?.[id]?.exclusiveMinimum === 0,
          ).toBe(true);
        }
      }
    } finally {
      await connection.close();
    }
  });

  it.each(readToolCalls)(
    "rejects a disallowed repository before account or target access: $name",
    async ({ name, arguments: toolArguments }) => {
      const restricted = profile("masa-nakaya", {
        allowedOwners: new Set<string>(),
        allowedRepositories: new Set(["masa-nakaya/allowed"]),
      });
      const connection = await connectedClient(accountConfig(restricted));

      try {
        const result = await connection.client.callTool({
          name,
          arguments: toolArguments,
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(
          /repository owner is not allowed|repository is not allowed/i,
        );
        expect(runGhMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it.each(readToolCalls)(
    "stops after the selected account identity mismatches: $name",
    async ({ name, arguments: toolArguments }) => {
      runGhMock.mockResolvedValue(identityResult("ma-nakaya"));
      const connection = await connectedClient();

      try {
        const result = await connection.client.callTool({
          name,
          arguments: toolArguments,
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(
          /expected masa-nakaya, active ma-nakaya/i,
        );
        expect(runGhMock).toHaveBeenCalledTimes(1);
        expect(runGhMock.mock.calls[0]?.[0]).toEqual([
          "api",
          "user",
          "--hostname",
          "github.com",
          "--jq",
          ".login",
        ]);
      } finally {
        await connection.close();
      }
    },
  );

  it("preflights a standalone issue, then gets strictly minimized issue details", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 27,
          number: 27,
          body: "not returned from the preflight",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issueDetailsResponse()),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_issue",
        arguments: { repository, issueNumber: 27 },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/issues/27`,
          "--hostname",
          "github.com",
        ],
        [
          "issue",
          "view",
          "27",
          "--repo",
          repository,
          "--json",
          issueFields,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value.contentTrust).toBe(contentTrust);
      expect(value.source).toEqual({
        provider: "github",
        hostname: "github.com",
        account: "masa-nakaya",
        repository,
        issueNumber: 27,
      });
      expect(value.issue).toEqual({
        number: 27,
        title: "Example issue",
        body: "Repository-authored issue body",
        state: "OPEN",
        stateReason: "",
        author: {
          login: "octocat",
          isBot: false,
          name: "The Octocat",
        },
        assignees: [{ login: "hubot", name: null }],
        labels: [{ name: "bug", color: "d73a4a", description: null }],
        milestone: { number: 3, title: "v1", dueOn: null },
        createdAt: "2026-07-29T06:06:00Z",
        updatedAt: "2026-07-29T06:06:00Z",
        closedAt: null,
        url: "https://github.com/masa-nakaya/example/issues/27",
      });
      expect(JSON.stringify(value)).not.toMatch(
        /must-not-leak|must not be returned|api\.example\.invalid/,
      );
    } finally {
      await connection.close();
    }
  });

  it("rejects a pull request during the standalone-issue preflight", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 27,
          number: 27,
          pull_request: {
            url: `https://api.github.com/repos/${repository}/pulls/27`,
          },
        }),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_issue",
        arguments: { repository, issueNumber: 27 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /is a pull request.*pull request-specific tool/i,
      );
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/issues/27`,
          "--hostname",
          "github.com",
        ],
      ]);
    } finally {
      await connection.close();
    }
  });

  it("reads one strictly projected comment page with fixed pagination", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ id: 27 }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{
          id: 101,
          body: "Untrusted comment",
          author: {
            login: "octocat",
            type: "User",
            email: "must-not-leak@example.invalid",
          },
          createdAt: "2026-07-29T06:10:00Z",
          updatedAt: "2026-07-29T06:11:00Z",
          url: "https://github.com/masa-nakaya/example/issues/27#issuecomment-101",
          reactions: { totalCount: 99 },
          apiUrl: "https://api.example.invalid/comment/101",
        }]),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_issue_comments",
        arguments: {
          repository,
          issueNumber: 27,
          page: 2,
          perPage: 25,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/issues/27`,
          "--hostname",
          "github.com",
        ],
        [
          "api",
          `repos/${repository}/issues/27/comments?per_page=25&page=2`,
          "--hostname",
          "github.com",
          "--jq",
          commentsJq,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value).toMatchObject({
        contentTrust,
        pagination: { page: 2, perPage: 25, returnedCount: 1 },
      });
      expect(value.comments).toEqual([{
        id: 101,
        body: "Untrusted comment",
        author: { login: "octocat", type: "User" },
        createdAt: "2026-07-29T06:10:00Z",
        updatedAt: "2026-07-29T06:11:00Z",
        url: "https://github.com/masa-nakaya/example/issues/27#issuecomment-101",
      }]);
      expect(JSON.stringify(value)).not.toMatch(
        /must-not-leak|reactions|api\.example\.invalid/,
      );
    } finally {
      await connection.close();
    }
  });

  it("reads one strictly projected issue-event page with fixed pagination", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ id: 27 }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{
          id: 201,
          event: "assigned",
          actor: {
            login: "octocat",
            type: "User",
            id: "must-not-leak",
          },
          createdAt: "2026-07-29T06:20:00Z",
          commitId: null,
          label: null,
          assignee: { login: "hubot", type: "Bot", id: 2 },
          assigner: { login: "octocat", type: "User", id: 1 },
          milestone: null,
          rename: null,
          lockReason: null,
          performedViaGithubApp: { id: 3 },
        }]),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_issue_events",
        arguments: {
          repository,
          issueNumber: 27,
          page: 3,
          perPage: 20,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/issues/27`,
          "--hostname",
          "github.com",
        ],
        [
          "api",
          `repos/${repository}/issues/27/events?per_page=20&page=3`,
          "--hostname",
          "github.com",
          "--jq",
          eventsJq,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value).toMatchObject({
        contentTrust,
        pagination: { page: 3, perPage: 20, returnedCount: 1 },
      });
      expect(value.events).toEqual([{
        id: 201,
        event: "assigned",
        actor: { login: "octocat", type: "User" },
        createdAt: "2026-07-29T06:20:00Z",
        commitId: null,
        label: null,
        assignee: { login: "hubot", type: "Bot" },
        assigner: { login: "octocat", type: "User" },
        milestone: null,
        rename: null,
        lockReason: null,
      }]);
      expect(JSON.stringify(value)).not.toMatch(
        /must-not-leak|performedViaGithubApp/,
      );
    } finally {
      await connection.close();
    }
  });

  it("lists the latest workflow-run jobs with fixed fields and pagination", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{
          id: 123,
          name: "test",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-07-30T00:00:00Z",
          completedAt: "2026-07-30T00:01:00Z",
          runnerName: "GitHub Actions 1",
          runnerGroupName: "GitHub Actions",
          labels: ["ubuntu-latest", "x64"],
          steps: [{ name: "must not be returned" }],
          htmlUrl: "https://github.com/masa-nakaya/example/actions/runs/456/job/123",
        }]),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_workflow_run_jobs",
        arguments: {
          repository,
          runId: 456,
          page: 2,
          perPage: 25,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/actions/runs/456/jobs?filter=latest&per_page=25&page=2`,
          "--hostname",
          "github.com",
          "--jq",
          jobsJq,
        ],
      ]);

      const value = parseToolJson(result);
      expect(value).toMatchObject({
        contentTrust,
        pagination: { page: 2, perPage: 25, returnedCount: 1 },
        source: {
          provider: "github",
          hostname: "github.com",
          account: "masa-nakaya",
          repository,
          runId: 456,
        },
      });
      expect(value.jobs).toEqual([{
        id: 123,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: "GitHub Actions 1",
        runnerGroupName: "GitHub Actions",
        labels: ["ubuntu-latest", "x64"],
      }]);
      expect(JSON.stringify(value)).not.toMatch(/steps|must not be returned|htmlUrl/);
    } finally {
      await connection.close();
    }
  });

  it("uses the fixed workflow-attempt jobs endpoint when attempt is provided", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "[]",
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_workflow_run_jobs",
        arguments: {
          repository,
          runId: 456,
          attempt: 3,
          page: 1,
          perPage: 20,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/actions/runs/456/attempts/3/jobs?per_page=20&page=1`,
          "--hostname",
          "github.com",
          "--jq",
          jobsJq,
        ],
      ]);
      expect(parseToolJson(result).source).toMatchObject({
        repository,
        runId: 456,
        attempt: 3,
      });
    } finally {
      await connection.close();
    }
  });

  it("preflights the job identity and returns a UTF-8-safe failed-log chunk", async () => {
    const log = "αβ\n次の行\n";
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 123,
          runId: 456,
          status: "completed",
          name: "must not be returned",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: log,
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_workflow_job_log",
        arguments: {
          repository,
          runId: 456,
          jobId: 123,
          offsetBytes: 0,
          limitBytes: 5,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/actions/jobs/123`,
          "--hostname",
          "github.com",
          "--jq",
          jobIdentityJq,
        ],
        [
          "run",
          "view",
          "--job",
          "123",
          "--repo",
          repository,
          "--log-failed",
        ],
      ]);

      const value = parseToolJson(result);
      expect(value).toMatchObject({
        log: "αβ\n",
        offsetBytes: 0,
        limitBytes: 5,
        returnedBytes: 5,
        totalBytes: Buffer.byteLength(log, "utf8"),
        nextOffsetBytes: 5,
        truncated: true,
        endedAtLineBoundary: true,
        completeness: "not_guaranteed",
        failedOnly: true,
        contentTrust,
        source: {
          provider: "github",
          hostname: "github.com",
          account: "masa-nakaya",
          repository,
          runId: 456,
          jobId: 123,
        },
      });
      expect(JSON.stringify(value)).not.toContain("must not be returned");
    } finally {
      await connection.close();
    }
  });

  it("uses only the fixed full-log flag when failedOnly is false", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 123,
          runId: 456,
          status: "completed",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "all steps\n",
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_workflow_job_log",
        arguments: {
          repository,
          runId: 456,
          jobId: 123,
          failedOnly: false,
          offsetBytes: 0,
          limitBytes: 100,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls[2]?.[0]).toEqual([
        "run",
        "view",
        "--job",
        "123",
        "--repo",
        repository,
        "--log",
      ]);
      expect(parseToolJson(result)).toMatchObject({
        log: "all steps\n",
        failedOnly: false,
        truncated: false,
      });
    } finally {
      await connection.close();
    }
  });

  it("stops before reading a log when the job belongs to another run", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 123,
          runId: 457,
          status: "completed",
        }),
        stderr: "",
      });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_workflow_job_log",
        arguments: {
          repository,
          runId: 456,
          jobId: 123,
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/run 457.*run 456/i);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}/actions/jobs/123`,
          "--hostname",
          "github.com",
          "--jq",
          jobIdentityJq,
        ],
      ]);
    } finally {
      await connection.close();
    }
  });

  it("fails closed when issue content exceeds the configured response cap", async () => {
    runGhMock
      .mockResolvedValueOnce(identityResult())
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ id: 27 }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issueDetailsResponse("x".repeat(2_000))),
        stderr: "",
      });
    const connection = await connectedClient(
      accountConfig(profile(), { maxOutputBytes: 512 }),
    );

    try {
      const result = await connection.client.callTool({
        name: "get_issue",
        arguments: { repository, issueNumber: 27 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /response.*configured.*512-byte output limit/i,
      );
      expect(runGhMock).toHaveBeenCalledTimes(3);
    } finally {
      await connection.close();
    }
  });
});
