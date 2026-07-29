import { Buffer } from "node:buffer";
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

const repository = "masa-nakaya/example";
const pullRequestFields = [
  "number",
  "title",
  "body",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "baseRefOid",
  "additions",
  "deletions",
  "changedFiles",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "url",
].join(",");
const checkFields =
  "bucket,completedAt,event,name,startedAt,state,workflow";
const contentTrust = "untrusted_repository_content";

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

const readToolCalls = [
  {
    name: "get_pull_request",
    arguments: { repository, pullRequestNumber: 7 },
  },
  {
    name: "list_pull_request_files",
    arguments: { repository, pullRequestNumber: 7 },
  },
  {
    name: "get_pull_request_diff",
    arguments: { repository, pullRequestNumber: 7 },
  },
  {
    name: "list_pull_request_checks",
    arguments: { repository, pullRequestNumber: 7 },
  },
] as const;

describe("typed pull request read tools", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  it("registers all four tools as typed, non-destructive reads", async () => {
    const connection = await connectedClient();

    try {
      const result = await connection.client.listTools();
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

      for (const { name } of readToolCalls) {
        const tool = tools.get(name);
        expect(tool, `${name} should be registered`).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);

        const schema = tool?.inputSchema as {
          required?: string[];
          properties?: Record<string, {
            type?: string;
            minimum?: number;
            exclusiveMinimum?: number;
          }>;
        };
        expect(schema.required).toContain("repository");
        expect(schema.required).toContain("pullRequestNumber");
        expect(schema.properties?.pullRequestNumber?.type).toBe("integer");
        expect(
          schema.properties?.pullRequestNumber?.minimum === 1 ||
            schema.properties?.pullRequestNumber?.exclusiveMinimum === 0,
        ).toBe(true);
      }
    } finally {
      await connection.close();
    }
  });

  it("gets strictly selected pull request details with the fixed gh command", async () => {
    const pullRequest = {
      number: 7,
      title: "Read PR details",
      body: "Repository-authored body",
      state: "OPEN",
      isDraft: false,
      author: {
        login: "contributor",
        is_bot: false,
        name: "Contributor",
      },
      headRefName: "feature/read",
      headRefOid: "a".repeat(40),
      baseRefName: "main",
      baseRefOid: "b".repeat(40),
      additions: 8,
      deletions: 3,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      closedAt: null,
      mergedAt: null,
      url: "https://github.com/masa-nakaya/example/pull/7",
      unexpectedSecret: "must not be returned",
    };
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify(pullRequest),
        stderr: "",
      };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request",
        arguments: { repository, pullRequestNumber: 7 },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "pr",
          "view",
          "7",
          "--repo",
          repository,
          "--json",
          pullRequestFields,
        ],
      ]);
      expect(runGhMock.mock.calls[1]?.[2]).toMatchObject({
        accountId: "masa-nakaya",
      });

      const value = parseToolJson(result);
      const details = value.pullRequest as Record<string, unknown>;
      expect(value.contentTrust).toBe(contentTrust);
      expect(details.body).toBe("Repository-authored body");
      expect(details.number).toBe(7);
      expect(details).not.toHaveProperty("unexpectedSecret");
      expect(JSON.stringify(value)).not.toContain("must not be returned");
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects pull request details for a different number than requested", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 8,
          title: "Wrong PR",
          body: "",
          state: "OPEN",
          isDraft: false,
          author: null,
          headRefName: "feature/read",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          baseRefOid: "b".repeat(40),
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          reviewDecision: "",
          createdAt: "2026-07-28T00:00:00Z",
          updatedAt: "2026-07-29T00:00:00Z",
          closedAt: null,
          mergedAt: null,
          url: "https://github.com/masa-nakaya/example/pull/8",
        }),
        stderr: "",
      };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request",
        arguments: { repository, pullRequestNumber: 7 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /returned pull request #8 when #7 was requested/i,
      );
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("lists a bounded page of strictly selected pull request file metadata", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            path: "src/new-name.ts",
            status: "renamed",
            previousPath: "src/old-name.ts",
            additions: 12,
            deletions: 4,
            changes: 16,
            patch: "@@ repository content that must not escape",
            raw_url: "https://raw.githubusercontent.invalid/secret",
            blob_url: "https://github.invalid/blob",
            contents_url: "https://api.github.invalid/contents",
          },
        ]),
        stderr: "",
      };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_files",
        arguments: {
          repository,
          pullRequestNumber: 7,
          page: 2,
          perPage: 2,
        },
      });

      expect(result.isError).not.toBe(true);
      const calls = runGhMock.mock.calls.map(([args]) => args);
      expect(calls[0]).toEqual([
        "api",
        "user",
        "--hostname",
        "github.com",
        "--jq",
        ".login",
      ]);
      expect(calls[1]).toEqual([
        "api",
        `repos/${repository}/pulls/7/files?per_page=2&page=2`,
        "--hostname",
        "github.com",
        "--jq",
        expect.any(String),
      ]);
      const jq = calls[1]?.[5] ?? "";
      expect(jq).toMatch(/filename/);
      expect(jq).toMatch(/previous_filename/);
      expect(jq).toMatch(/additions/);
      expect(jq).toMatch(/deletions/);
      expect(jq).toMatch(/changes/);
      expect(jq).not.toMatch(/patch|raw_url|blob_url|contents_url/);

      const value = parseToolJson(result);
      expect(value.contentTrust).toBe(contentTrust);
      expect(value.files).toEqual([
        {
          path: "src/new-name.ts",
          status: "renamed",
          previousPath: "src/old-name.ts",
          additions: 12,
          deletions: 4,
          changes: 16,
        },
      ]);
      expect(value.pagination).toMatchObject({
        page: 2,
        perPage: 2,
        returnedCount: 1,
        githubMaximumFiles: 3000,
      });
      expect(JSON.stringify(value)).not.toMatch(
        /repository content that must not escape|raw\.githubusercontent|github\.invalid/,
      );
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("gets a byte-bounded UTF-8-safe diff chunk with the fixed gh command", async () => {
    const diff = "αβ\n次の行\n";
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return { exitCode: 0, stdout: diff, stderr: "" };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_diff",
        arguments: {
          repository,
          pullRequestNumber: 7,
          offsetBytes: 0,
          limitBytes: 5,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        ["pr", "diff", "7", "--repo", repository, "--color", "never"],
      ]);

      const value = parseToolJson(result);
      expect(value.contentTrust).toBe(contentTrust);
      expect(value.diff).toBe("αβ\n");
      expect(Buffer.byteLength(value.diff as string, "utf8")).toBe(5);
      expect(value).toMatchObject({
        offsetBytes: 0,
        limitBytes: 5,
        returnedBytes: 5,
        totalBytes: Buffer.byteLength(diff, "utf8"),
        nextOffsetBytes: 5,
        truncated: true,
        endedAtLineBoundary: true,
        completeness: "not_guaranteed",
        githubMayLimitLargeDiffs: true,
      });
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects a diff offset that splits a UTF-8 code point", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return { exitCode: 0, stdout: "あいう\n", stderr: "" };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request_diff",
        arguments: {
          repository,
          pullRequestNumber: 7,
          offsetBytes: 1,
          limitBytes: 5,
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/UTF-8|code point/i);
      expect(runGhMock.mock.calls[1]?.[0]).toEqual([
        "pr",
        "diff",
        "7",
        "--repo",
        repository,
        "--color",
        "never",
      ]);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("lists strictly selected checks and pagination with the fixed gh command", async () => {
    const checksEnvelope = {
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
          completedAt: "2026-07-29T00:01:00Z",
          event: "pull_request",
          name: "unit",
          startedAt: "2026-07-29T00:00:00Z",
          state: "SUCCESS",
          workflow: "CI",
          link: "https://github.invalid/actions/runs/1",
          description: "untrusted output that must not escape",
        },
        {
          bucket: "fail",
          completedAt: "2026-07-29T00:02:00Z",
          event: "pull_request",
          name: "lint",
          startedAt: "2026-07-29T00:00:00Z",
          state: "FAILURE",
          workflow: "CI",
        },
      ],
    };
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify(checksEnvelope),
        stderr: "",
      };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_checks",
        arguments: {
          repository,
          pullRequestNumber: 7,
          offset: 0,
          limit: 2,
        },
      });

      expect(result.isError).not.toBe(true);
      const calls = runGhMock.mock.calls.map(([args]) => args);
      expect(calls[0]).toEqual([
        "api",
        "user",
        "--hostname",
        "github.com",
        "--jq",
        ".login",
      ]);
      expect(calls[1]).toEqual([
        "pr",
        "checks",
        "7",
        "--repo",
        repository,
        "--json",
        checkFields,
        "--jq",
        expect.any(String),
      ]);
      const jqIndex = calls[1]?.indexOf("--jq") ?? -1;
      const jq = calls[1]?.[jqIndex + 1] ?? "";
      expect(jq).toMatch(/bucket/);
      expect(jq).toMatch(/completedAt/);
      expect(jq).toMatch(/workflow/);
      expect(jq).not.toMatch(/description|link|annotation|output/);

      const value = parseToolJson(result);
      expect(value.contentTrust).toBe(contentTrust);
      expect(value.buckets).toEqual(checksEnvelope.buckets);
      expect(value.pagination).toMatchObject({
        offset: 0,
        limit: 2,
        total: 3,
        returnedCount: 2,
        nextOffset: 2,
      });
      expect(value.checks).toEqual([
        {
          bucket: "pass",
          completedAt: "2026-07-29T00:01:00Z",
          event: "pull_request",
          name: "unit",
          startedAt: "2026-07-29T00:00:00Z",
          state: "SUCCESS",
          workflow: "CI",
        },
        {
          bucket: "fail",
          completedAt: "2026-07-29T00:02:00Z",
          event: "pull_request",
          name: "lint",
          startedAt: "2026-07-29T00:00:00Z",
          state: "FAILURE",
          workflow: "CI",
        },
      ]);
      expect(JSON.stringify(value)).not.toMatch(
        /untrusted output that must not escape|github\.invalid/,
      );
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("uses only the fixed required-checks flag when requiredOnly is true", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          total: 0,
          buckets: {
            pass: 0,
            fail: 0,
            pending: 0,
            skipping: 0,
            cancel: 0,
          },
          checks: [],
        }),
        stderr: "",
      };
    });
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_checks",
        arguments: {
          repository,
          pullRequestNumber: 7,
          requiredOnly: true,
          offset: 0,
          limit: 10,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls[1]?.[0]).toEqual([
        "pr",
        "checks",
        "7",
        "--repo",
        repository,
        "--required",
        "--json",
        checkFields,
        "--jq",
        expect.any(String),
      ]);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each(readToolCalls)(
    "rejects a disallowed repository before account or target access: $name",
    async ({ name, arguments: toolArguments }) => {
      const restrictedProfile = profile("masa-nakaya", {
        allowedOwners: new Set<string>(),
        allowedRepositories: new Set(["masa-nakaya/allowed"]),
      });
      const connection = await connectedClient(
        accountConfig(restrictedProfile),
      );

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
        expect(appendAuditRecordMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it.each(readToolCalls)(
    "stops after one identity check when the selected account mismatches: $name",
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
        expect(appendAuditRecordMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it("rejects a file page beyond GitHub's 3000-file window before running gh", async () => {
    const connection = await connectedClient();

    try {
      const result = await connection.client.callTool({
        name: "list_pull_request_files",
        arguments: {
          repository,
          pullRequestNumber: 7,
          page: 31,
          perPage: 100,
        },
      });

      expect(result.isError).toBe(true);
      expect(runGhMock).not.toHaveBeenCalled();
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("fails closed when pull request content would exceed the configured response limit", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return identityResult();
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 7,
          title: "Oversized",
          body: "x".repeat(2_000),
          state: "OPEN",
        }),
        stderr: "",
      };
    });
    const connection = await connectedClient(
      accountConfig(profile(), { maxOutputBytes: 512 }),
    );

    try {
      const result = await connection.client.callTool({
        name: "get_pull_request",
        arguments: { repository, pullRequestNumber: 7 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /output|response|size|limit|large|maximum/i,
      );
      expect(runGhMock).toHaveBeenCalledTimes(2);
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });
});
