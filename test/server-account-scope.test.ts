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

function profile(
  id: string,
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
  profiles: AccountProfile[] = [profile("masa-nakaya")],
): Config {
  return {
    ghPath: "gh",
    allowedHosts: new Set(["github.com"]),
    accountProfiles: new Map(profiles.map((item) => [item.id, item])),
    ...(profiles.length === 1 ? { defaultAccountId: profiles[0].id } : {}),
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    auditLogPath: "audit.jsonl",
  };
}

async function connectedClient(config: Config): Promise<{
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

describe("MCP account and resource isolation", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  it("lists safe account selectors without exposing isolated config paths", async () => {
    const connection = await connectedClient(accountConfig([
      profile("ma-nakaya"),
      profile("masa-nakaya"),
    ]));

    try {
      const result = await connection.client.callTool({
        name: "list_accounts",
        arguments: {},
      });
      const text = JSON.stringify(result.content);

      expect(result.isError).not.toBe(true);
      expect(text).toContain("ma-nakaya");
      expect(text).toContain("masa-nakaya");
      expect(text).not.toContain("C:/secure");
      expect(runGhMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("requires an explicit account for every gh-backed tool when multiple profiles exist", async () => {
    const connection = await connectedClient(accountConfig([
      profile("ma-nakaya"),
      profile("masa-nakaya"),
    ]));

    try {
      const result = await connection.client.callTool({
        name: "list_issues",
        arguments: { repository: "ma-nakaya/example" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/account/i);
      expect(runGhMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("filters repository listing by the selected account profile", async () => {
    const ma = profile("ma-nakaya", {
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set([
        "ma-nakaya/one",
        "ma-nakaya/two",
      ]),
    });
    const masa = profile("masa-nakaya", {
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set(["masa-nakaya/other"]),
    });
    runGhMock.mockImplementation(async (args, _config, context) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: `${context.profile.expectedLogin}\n`, stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          nameWithOwner: args[2],
          url: `https://github.com/${args[2]}`,
          visibility: "PRIVATE",
          isPrivate: true,
          updatedAt: "2026-07-27T00:00:00Z",
        }),
        stderr: "",
      };
    });
    const connection = await connectedClient(accountConfig([ma, masa]));

    try {
      const result = await connection.client.callTool({
        name: "list_repositories",
        arguments: { account: "ma-nakaya", owner: "ma-nakaya", limit: 10 },
      });

      expect(result.isError).not.toBe(true);
      const repositoryCalls = runGhMock.mock.calls.filter(([args]) => args[0] === "repo");
      expect(repositoryCalls.map(([args]) => args[2])).toEqual([
        "ma-nakaya/one",
        "ma-nakaya/two",
      ]);
      expect(repositoryCalls.every(([, , context]) => context.accountId === "ma-nakaya")).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain("masa-nakaya/other");
    } finally {
      await connection.close();
    }
  });

  it("keeps concurrent requests pinned to their own immutable account contexts", async () => {
    const ma = profile("ma-nakaya");
    const masa = profile("masa-nakaya");
    runGhMock.mockImplementation(async (args, _config, context) => {
      if (args[1] === "user") {
        await new Promise((resolve) => setTimeout(resolve, context.accountId === "ma-nakaya" ? 5 : 1));
        return { exitCode: 0, stdout: `${context.profile.expectedLogin}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });
    const connection = await connectedClient(accountConfig([ma, masa]));

    try {
      const [maResult, masaResult] = await Promise.all([
        connection.client.callTool({
          name: "list_issues",
          arguments: { account: "ma-nakaya", repository: "ma-nakaya/example" },
        }),
        connection.client.callTool({
          name: "list_issues",
          arguments: { account: "masa-nakaya", repository: "masa-nakaya/example" },
        }),
      ]);

      expect(maResult.isError).not.toBe(true);
      expect(masaResult.isError).not.toBe(true);
      for (const [args, , context] of runGhMock.mock.calls) {
        const repository = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
        if (repository !== undefined) {
          expect(repository.startsWith(`${context.accountId}/`)).toBe(true);
        }
      }
      expect(new Set(runGhMock.mock.calls.map(([, , context]) => context.accountId))).toEqual(
        new Set(["ma-nakaya", "masa-nakaya"]),
      );
    } finally {
      await connection.close();
    }
  });

  it("requires an explicit owner allowlist on the selected profile for owner-wide Project operations", async () => {
    const ma = profile("ma-nakaya", {
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set(["ma-nakaya/one"]),
    });
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "ma-nakaya\n", stderr: "" });
    const connection = await connectedClient(accountConfig([ma]));

    try {
      const result = await connection.client.callTool({
        name: "create_project",
        arguments: {
          owner: "ma-nakaya",
          ownerType: "user",
          title: "Safe project",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/explicit allowedOwners/i);
      expect(runGhMock).toHaveBeenCalledTimes(1);
      expect(runGhMock.mock.calls[0]?.[0][1]).toBe("user");
    } finally {
      await connection.close();
    }
  });

  it("verifies the selected account twice before a write and correlates its audit lifecycle", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 1,
          title: "Test issue",
          state: "open",
          html_url: "https://github.com/masa-nakaya/example/issues/1",
          created_at: "2026-07-27T00:00:00Z",
          updated_at: "2026-07-27T00:00:00Z",
        }),
        stderr: "",
      };
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_issue",
        arguments: {
          repository: "masa-nakaya/example",
          title: "Test issue",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.slice(0, 2).map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
      ]);
      expect(runGhMock.mock.calls[2]?.[0]).toContain("--method");
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const succeeded = appendAuditRecordMock.mock.calls[1]?.[1];
      expect(started).toMatchObject({
        account: "masa-nakaya",
        repository: "masa-nakaya/example",
        outcome: "started",
      });
      expect(succeeded).toMatchObject({
        account: "masa-nakaya",
        outcome: "succeeded",
      });
      expect(started?.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(succeeded?.operationId).toBe(started?.operationId);
    } finally {
      await connection.close();
    }
  });

  it("fails before mutation and audits a rejected initial account verification", async () => {
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "ma-nakaya\n", stderr: "" });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_issue",
        arguments: {
          repository: "masa-nakaya/example",
          title: "Must not be created",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/expected masa-nakaya, active ma-nakaya/i);
      expect(runGhMock).toHaveBeenCalledTimes(1);
      expect(appendAuditRecordMock).toHaveBeenCalledWith(
        "audit.jsonl",
        expect.objectContaining({
          account: "masa-nakaya",
          repository: "masa-nakaya/example",
          operationId: expect.any(String),
          outcome: "failed",
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("does not create Git objects when the commit audit cannot be started", async () => {
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "masa-nakaya\n", stderr: "" });
    appendAuditRecordMock.mockRejectedValueOnce(new Error("audit unavailable"));
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "commit_files",
        arguments: {
          repository: "masa-nakaya/example",
          branch: "agent/change",
          expectedHeadSha: "a".repeat(40),
          message: "Test commit",
          files: [{ path: "README.md", operation: "upsert", content: "test" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/audit unavailable/i);
      expect(runGhMock).toHaveBeenCalledTimes(1);
      expect(runGhMock.mock.calls[0]?.[0][1]).toBe("user");
    } finally {
      await connection.close();
    }
  });

  it("records a correlated failed lifecycle when an intermediate Git object request fails", async () => {
    const headSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    runGhMock.mockImplementation(async (args) => {
      const endpoint = args[1] ?? "";
      if (endpoint === "user") return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      if (endpoint.includes("/git/ref/heads/")) {
        return { exitCode: 0, stdout: JSON.stringify({ object: { sha: headSha } }), stderr: "" };
      }
      if (endpoint.endsWith(`/git/commits/${headSha}`)) {
        return { exitCode: 0, stdout: JSON.stringify({ tree: { sha: treeSha } }), stderr: "" };
      }
      if (endpoint.endsWith("/git/blobs")) throw new Error("blob request failed");
      throw new Error(`Unexpected gh endpoint in test: ${endpoint}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "commit_files",
        arguments: {
          repository: "masa-nakaya/example",
          branch: "agent/change",
          expectedHeadSha: headSha,
          message: "Test commit",
          files: [{ path: "README.md", operation: "upsert", content: "test" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/blob request failed/i);
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const failed = appendAuditRecordMock.mock.calls[1]?.[1];
      expect(started).toMatchObject({ tool: "commit_files", outcome: "started" });
      expect(failed).toMatchObject({ tool: "commit_files", outcome: "failed" });
      expect(failed?.operationId).toBe(started?.operationId);
    } finally {
      await connection.close();
    }
  });

  it("re-verifies the account before advancing a branch after creating Git objects", async () => {
    const headSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    let identityChecks = 0;
    runGhMock.mockImplementation(async (args) => {
      const endpoint = args[1] ?? "";
      if (endpoint === "user") {
        identityChecks += 1;
        return {
          exitCode: 0,
          stdout: identityChecks < 3 ? "masa-nakaya\n" : "ma-nakaya\n",
          stderr: "",
        };
      }
      if (endpoint.includes("/git/ref/heads/")) {
        return { exitCode: 0, stdout: JSON.stringify({ object: { sha: headSha } }), stderr: "" };
      }
      if (endpoint.endsWith(`/git/commits/${headSha}`)) {
        return { exitCode: 0, stdout: JSON.stringify({ tree: { sha: treeSha } }), stderr: "" };
      }
      if (endpoint.endsWith("/git/blobs")) {
        return { exitCode: 0, stdout: JSON.stringify({ sha: "c".repeat(40) }), stderr: "" };
      }
      if (endpoint.endsWith("/git/trees")) {
        return { exitCode: 0, stdout: JSON.stringify({ sha: "d".repeat(40) }), stderr: "" };
      }
      if (endpoint.endsWith("/git/commits")) {
        return { exitCode: 0, stdout: JSON.stringify({ sha: "e".repeat(40) }), stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${endpoint}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "commit_files",
        arguments: {
          repository: "masa-nakaya/example",
          branch: "agent/change",
          expectedHeadSha: headSha,
          message: "Test commit",
          files: [{ path: "README.md", operation: "upsert", content: "test" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/expected masa-nakaya, active ma-nakaya/i);
      expect(identityChecks).toBe(3);
      expect(runGhMock.mock.calls.some(([args]) =>
        (args[1] ?? "").includes("/git/refs/heads/")
      )).toBe(false);
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const failed = appendAuditRecordMock.mock.calls[1]?.[1];
      expect(started).toMatchObject({ tool: "commit_files", outcome: "started" });
      expect(failed).toMatchObject({ tool: "commit_files", outcome: "failed" });
      expect(failed?.operationId).toBe(started?.operationId);
    } finally {
      await connection.close();
    }
  });

  it("audits a successful mutation as succeeded when only response metadata parsing fails", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ draft: true, tag_name: "v1.0.0" }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_release",
        arguments: {
          repository: "masa-nakaya/example",
          tagName: "v1.0.0",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/without a valid ID/i);
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const succeeded = appendAuditRecordMock.mock.calls[1]?.[1];
      expect(started).toMatchObject({ tool: "create_release", outcome: "started" });
      expect(succeeded).toMatchObject({ tool: "create_release", outcome: "succeeded" });
      expect(succeeded?.operationId).toBe(started?.operationId);
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("audits a GraphQL mutation rejected through top-level errors as failed", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "users/masa-nakaya") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ node_id: "U_example" }),
          stderr: "",
        };
      }
      if (args[1] === "graphql") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ errors: [{ message: "forbidden" }] }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_project",
        arguments: {
          ownerType: "user",
          owner: "masa-nakaya",
          title: "Rejected project",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/GraphQL returned one or more errors/i);
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const failed = appendAuditRecordMock.mock.calls[1]?.[1];
      expect(started).toMatchObject({ tool: "create_project", outcome: "started" });
      expect(failed).toMatchObject({ tool: "create_project", outcome: "failed" });
      expect(failed?.operationId).toBe(started?.operationId);
      expect(appendAuditRecordMock).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });
});
