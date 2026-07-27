import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";
import type { Config } from "../src/config.js";
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

function accountConfig(overrides: Partial<Config> = {}): Config {
  return {
    ghPath: "gh",
    allowedHosts: new Set(["github.com"]),
    allowedOwners: new Set(["masa-nakaya"]),
    allowedRepositories: new Set(),
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    auditLogPath: "audit.jsonl",
    accountProfile: {
      expectedLogin: "masa-nakaya",
      hostname: "github.com",
      configDir: "C:/secure/gh-masa",
    },
    ...overrides,
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

  it("filters repository listing to repositories explicitly allowed for the requested owner", async () => {
    const config = accountConfig({
      allowedOwners: new Set(),
      allowedRepositories: new Set([
        "ma-nakaya/one",
        "ma-nakaya/two",
        "masa-nakaya/other",
      ]),
    });
    runGhMock.mockImplementation(async (args) => ({
      exitCode: 0,
      stdout: JSON.stringify({
        nameWithOwner: args[2],
        url: `https://github.com/${args[2]}`,
        visibility: "PRIVATE",
        isPrivate: true,
        updatedAt: "2026-07-27T00:00:00Z",
      }),
      stderr: "",
    }));
    const connection = await connectedClient(config);

    try {
      const result = await connection.client.callTool({
        name: "list_repositories",
        arguments: { owner: "ma-nakaya", limit: 10 },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args[2])).toEqual([
        "ma-nakaya/one",
        "ma-nakaya/two",
      ]);
      expect(JSON.stringify(result.content)).not.toContain("masa-nakaya/other");
    } finally {
      await connection.close();
    }
  });

  it("requires an explicit owner allowlist for owner-wide Project operations", async () => {
    const config = accountConfig({
      allowedOwners: new Set(),
      allowedRepositories: new Set(["ma-nakaya/one"]),
    });
    const connection = await connectedClient(config);

    try {
      const result = await connection.client.callTool({
        name: "create_project",
        arguments: {
          owner: "ma-nakaya",
          ownerType: "user",
          title: "Safe project",
          hostname: "github.com",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/explicit GH_MCP_ALLOWED_OWNERS/i);
      expect(runGhMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("verifies the expected account before a write and records that account in audit metadata", async () => {
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
          hostname: "github.com",
          title: "Test issue",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls[0]?.[0]).toEqual([
        "api",
        "user",
        "--hostname",
        "github.com",
        "--jq",
        ".login",
      ]);
      expect(runGhMock.mock.calls[1]?.[0]).toContain("--method");
      expect(appendAuditRecordMock).toHaveBeenNthCalledWith(
        1,
        "audit.jsonl",
        expect.objectContaining({
          account: "masa-nakaya",
          repository: "masa-nakaya/example",
          outcome: "started",
        }),
      );
      expect(appendAuditRecordMock).toHaveBeenNthCalledWith(
        2,
        "audit.jsonl",
        expect.objectContaining({
          account: "masa-nakaya",
          outcome: "succeeded",
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("fails before mutation and audits a rejected write when the active account differs", async () => {
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "ma-nakaya\n", stderr: "" });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_issue",
        arguments: {
          repository: "masa-nakaya/example",
          hostname: "github.com",
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
          hostname: "github.com",
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

  it("records a failed commit lifecycle when an intermediate Git object request fails", async () => {
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
          hostname: "github.com",
          branch: "agent/change",
          expectedHeadSha: headSha,
          message: "Test commit",
          files: [{ path: "README.md", operation: "upsert", content: "test" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/blob request failed/i);
      expect(appendAuditRecordMock).toHaveBeenNthCalledWith(
        1,
        "audit.jsonl",
        expect.objectContaining({ tool: "commit_files", outcome: "started" }),
      );
      expect(appendAuditRecordMock).toHaveBeenNthCalledWith(
        2,
        "audit.jsonl",
        expect.objectContaining({ tool: "commit_files", outcome: "failed" }),
      );
    } finally {
      await connection.close();
    }
  });
});
