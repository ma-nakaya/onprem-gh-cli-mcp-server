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

  it("publishes a draft release with a draft=false PATCH and audits the mutation", async () => {
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/99" && !args.includes("--method")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: 99, draft: true, tag_name: "v1.0.0", prerelease: false }),
          stderr: "",
        };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/99" && args.includes("PATCH")) {
        expect(JSON.parse(options?.stdin ?? "{}")).toEqual({ draft: false });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 99,
            draft: false,
            tag_name: "v1.0.0",
            name: null,
            prerelease: false,
            target_commitish: "main",
            html_url: "https://github.com/masa-nakaya/example/releases/tag/v1.0.0",
            created_at: "2026-07-22T04:00:00Z",
            published_at: "2026-07-22T05:00:00Z",
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "publish_release",
        arguments: { repository: "masa-nakaya/example", releaseId: 99 },
      });

      expect(result.isError).not.toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(JSON.parse(text).release.isDraft).toBe(false);
      const started = appendAuditRecordMock.mock.calls[0]?.[1];
      const succeeded = appendAuditRecordMock.mock.calls.at(-1)?.[1];
      expect(started).toMatchObject({ tool: "publish_release", outcome: "started", releaseId: 99 });
      expect(succeeded).toMatchObject({ tool: "publish_release", outcome: "succeeded", releaseId: 99 });
    } finally {
      await connection.close();
    }
  });

  it("refuses to publish a release that is not a draft and sends no PATCH", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/99" && !args.includes("--method")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: 99, draft: false, tag_name: "v1.0.0" }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "publish_release",
        arguments: { repository: "masa-nakaya/example", releaseId: 99 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/not a draft/i);
      expect(runGhMock.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("deletes a release after reading its tag and audits the mutation", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/99" && !args.includes("--method")) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 99, tag_name: "v1.0.0" }), stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/99" && args.includes("DELETE")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "delete_release",
        arguments: { repository: "masa-nakaya/example", releaseId: 99 },
      });

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.deleted).toEqual({ releaseId: 99, tagName: "v1.0.0", repository: "masa-nakaya/example" });
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "delete_release",
        outcome: "succeeded",
        releaseId: 99,
      });
    } finally {
      await connection.close();
    }
  });

  it("uploads a release asset through gh release upload for the resolved tag", async () => {
    let uploadArgs: unknown;
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "repos/masa-nakaya/example/releases/99") {
        return { exitCode: 0, stdout: JSON.stringify({ id: 99, tag_name: "v1.0.0" }), stderr: "" };
      }
      if (args[0] === "release" && args[1] === "upload") {
        uploadArgs = args;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "upload_release_asset",
        arguments: {
          repository: "masa-nakaya/example",
          releaseId: 99,
          filePath: "C:/build/app.zip",
          clobber: true,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(uploadArgs).toEqual([
        "release",
        "upload",
        "v1.0.0",
        "C:/build/app.zip",
        "--repo",
        "masa-nakaya/example",
        "--clobber",
      ]);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.uploaded.name).toBe("app.zip");
    } finally {
      await connection.close();
    }
  });

  it("deletes a release asset by ID with an audited DELETE", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/releases/assets/7" && args.includes("DELETE")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "delete_release_asset",
        arguments: { repository: "masa-nakaya/example", releaseAssetId: 7 },
      });

      expect(result.isError).not.toBe(true);
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "delete_release_asset",
        outcome: "succeeded",
        releaseAssetId: 7,
      });
    } finally {
      await connection.close();
    }
  });

  it("cancels a workflow run that has not completed", async () => {
    const calls: string[][] = [];
    runGhMock.mockImplementation(async (args) => {
      calls.push(args);
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42" && !args.includes("--method")) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 42, status: "in_progress", conclusion: null, name: "CI" }), stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42/cancel" && args.includes("POST")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "cancel_workflow_run",
        arguments: { repository: "masa-nakaya/example", runId: 42 },
      });

      expect(result.isError).not.toBe(true);
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "cancel_workflow_run",
        outcome: "succeeded",
        workflowRunId: 42,
      });
    } finally {
      await connection.close();
    }
  });

  it("refuses to cancel a completed workflow run", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42" && !args.includes("--method")) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 42, status: "completed", conclusion: "success", name: "CI" }), stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "cancel_workflow_run",
        arguments: { repository: "masa-nakaya/example", runId: 42 },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/already completed/);
      expect(runGhMock.mock.calls.some(([args]) => (args[1] ?? "").endsWith("/cancel"))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("re-runs only failed jobs when failedJobsOnly is set", async () => {
    let rerunEndpoint = "";
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42" && !args.includes("--method")) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 42, status: "completed", conclusion: "failure", name: "CI" }), stderr: "" };
      }
      if ((args[1] ?? "").includes("/rerun")) {
        rerunEndpoint = args[1];
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "rerun_workflow_run",
        arguments: { repository: "masa-nakaya/example", runId: 42, failedJobsOnly: true },
      });

      expect(result.isError).not.toBe(true);
      expect(rerunEndpoint).toBe("repos/masa-nakaya/example/actions/runs/42/rerun-failed-jobs");
    } finally {
      await connection.close();
    }
  });

  it("deletes a completed workflow run", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42" && !args.includes("--method")) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 42, status: "completed", conclusion: "success", name: "CI" }), stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/actions/runs/42" && args.includes("DELETE")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "delete_workflow_run",
        arguments: { repository: "masa-nakaya/example", runId: 42 },
      });

      expect(result.isError).not.toBe(true);
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "delete_workflow_run",
        outcome: "succeeded",
        workflowRunId: 42,
      });
    } finally {
      await connection.close();
    }
  });

  it("deletes a label after reading it and audits the mutation", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/labels/bug" && !args.includes("--method")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: 5, name: "bug", color: "d73a4a", default: true, url: "https://api.github.com/repos/masa-nakaya/example/labels/bug" }),
          stderr: "",
        };
      }
      if (args[1] === "repos/masa-nakaya/example/labels/bug" && args.includes("DELETE")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "delete_label",
        arguments: { repository: "masa-nakaya/example", name: "bug" },
      });

      expect(result.isError).not.toBe(true);
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "delete_label",
        outcome: "succeeded",
        label: "bug",
      });
    } finally {
      await connection.close();
    }
  });

  it("deletes a milestone after reading it and audits the mutation", async () => {
    runGhMock.mockImplementation(async (args) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "repos/masa-nakaya/example/milestones/3" && !args.includes("--method")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ number: 3, title: "v1.0", state: "open", due_on: null, html_url: "https://github.com/masa-nakaya/example/milestone/3", open_issues: 2, closed_issues: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }),
          stderr: "",
        };
      }
      if (args[1] === "repos/masa-nakaya/example/milestones/3" && args.includes("DELETE")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh endpoint in test: ${args[1] ?? ""}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "delete_milestone",
        arguments: { repository: "masa-nakaya/example", milestoneNumber: 3 },
      });

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.deleted.milestone.title).toBe("v1.0");
      expect(appendAuditRecordMock.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "delete_milestone",
        outcome: "succeeded",
        milestoneNumber: 3,
      });
    } finally {
      await connection.close();
    }
  });

  it("changes project visibility through update_project", async () => {
    let updateVariables: Record<string, unknown> = {};
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "graphql") {
        const payload = JSON.parse(options?.stdin ?? "{}") as { query: string; variables: Record<string, unknown> };
        if (payload.query.includes("node(id")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { node: { __typename: "ProjectV2", id: "PVT_project123", number: 3, title: "Roadmap", url: "https://github.com/users/masa-nakaya/projects/3", closed: false, public: false, owner: { login: "masa-nakaya" } } } }), stderr: "" };
        }
        if (payload.query.includes("updateProjectV2(")) {
          updateVariables = payload.variables;
          return { exitCode: 0, stdout: JSON.stringify({ data: { updateProjectV2: { projectV2: { id: "PVT_project123", number: 3, title: "Roadmap", url: "https://github.com/users/masa-nakaya/projects/3", closed: false, public: true } } } }), stderr: "" };
        }
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "update_project",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", public: true },
      });

      expect(result.isError).not.toBe(true);
      expect(updateVariables).toEqual({ projectId: "PVT_project123", public: true });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.project.isPublic).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("deletes a project only when the confirmation title matches exactly", async () => {
    let deleteCalled = false;
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "graphql") {
        const payload = JSON.parse(options?.stdin ?? "{}") as { query: string };
        if (payload.query.includes("node(id")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { node: { __typename: "ProjectV2", id: "PVT_project123", number: 3, title: "Roadmap", url: "https://github.com/users/masa-nakaya/projects/3", closed: false, public: false, owner: { login: "masa-nakaya" } } } }), stderr: "" };
        }
        if (payload.query.includes("deleteProjectV2(")) {
          deleteCalled = true;
          return { exitCode: 0, stdout: JSON.stringify({ data: { deleteProjectV2: { projectV2: { id: "PVT_project123", number: 3, title: "Roadmap", url: "https://github.com/users/masa-nakaya/projects/3", closed: false, public: false } } } }), stderr: "" };
        }
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const refused = await connection.client.callTool({
        name: "delete_project",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", confirmTitle: "Wrong title" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/confirmTitle must exactly match/);
      expect(deleteCalled).toBe(false);

      const result = await connection.client.callTool({
        name: "delete_project",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", confirmTitle: "Roadmap" },
      });
      expect(result.isError).not.toBe(true);
      expect(deleteCalled).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("creates a draft item and deletes a project item", async () => {
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "graphql") {
        const payload = JSON.parse(options?.stdin ?? "{}") as { query: string };
        if (payload.query.includes("node(id")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { node: { __typename: "ProjectV2", id: "PVT_project123", owner: { login: "masa-nakaya" } } } }), stderr: "" };
        }
        if (payload.query.includes("addProjectV2DraftIssue(")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { addProjectV2DraftIssue: { projectV2Item: { id: "PVTI_item123", isArchived: false } } } }), stderr: "" };
        }
        if (payload.query.includes("deleteProjectV2Item(")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { deleteProjectV2Item: { deletedItemId: "PVTI_item123" } } }), stderr: "" };
        }
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const created = await connection.client.callTool({
        name: "create_project_draft_item",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", title: "Draft task" },
      });
      expect(created.isError).not.toBe(true);
      expect(JSON.parse((created.content[0] as { text: string }).text).item.id).toBe("PVTI_item123");

      const deleted = await connection.client.callTool({
        name: "delete_project_item",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", itemId: "PVTI_item123" },
      });
      expect(deleted.isError).not.toBe(true);
      expect(JSON.parse((deleted.content[0] as { text: string }).text).deleted.itemId).toBe("PVTI_item123");
    } finally {
      await connection.close();
    }
  });

  it("creates and deletes a single-select project field", async () => {
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "graphql") {
        const payload = JSON.parse(options?.stdin ?? "{}") as { query: string };
        if (payload.query.includes("node(id")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { node: { __typename: "ProjectV2", id: "PVT_project123", owner: { login: "masa-nakaya" } } } }), stderr: "" };
        }
        const field = { id: "PVTF_field123", name: "Status", dataType: "SINGLE_SELECT", __typename: "ProjectV2SingleSelectField", options: [{ id: "o1", name: "Todo" }] };
        if (payload.query.includes("createProjectV2Field(")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: field } } }), stderr: "" };
        }
        if (payload.query.includes("deleteProjectV2Field(")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { deleteProjectV2Field: { projectV2Field: field } } }), stderr: "" };
        }
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const created = await connection.client.callTool({
        name: "create_project_field",
        arguments: {
          owner: "masa-nakaya",
          projectId: "PVT_project123",
          name: "Status",
          dataType: "SINGLE_SELECT",
          singleSelectOptions: [{ name: "Todo", color: "GRAY" }],
        },
      });
      expect(created.isError).not.toBe(true);
      expect(JSON.parse((created.content[0] as { text: string }).text).field.id).toBe("PVTF_field123");

      const refused = await connection.client.callTool({
        name: "create_project_field",
        arguments: {
          owner: "masa-nakaya",
          projectId: "PVT_project123",
          name: "Note",
          dataType: "TEXT",
          singleSelectOptions: [{ name: "Todo" }],
        },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/only be provided for SINGLE_SELECT/);

      const deleted = await connection.client.callTool({
        name: "delete_project_field",
        arguments: { owner: "masa-nakaya", projectId: "PVT_project123", fieldId: "PVTF_field123" },
      });
      expect(deleted.isError).not.toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("creates an iteration project field with its configuration", async () => {
    let createVariables: Record<string, unknown> = {};
    runGhMock.mockImplementation(async (args, _config, _context, options) => {
      if (args[1] === "user") {
        return { exitCode: 0, stdout: "masa-nakaya\n", stderr: "" };
      }
      if (args[1] === "graphql") {
        const payload = JSON.parse(options?.stdin ?? "{}") as { query: string; variables: Record<string, unknown> };
        if (payload.query.includes("node(id")) {
          return { exitCode: 0, stdout: JSON.stringify({ data: { node: { __typename: "ProjectV2", id: "PVT_project123", owner: { login: "masa-nakaya" } } } }), stderr: "" };
        }
        if (payload.query.includes("createProjectV2Field(")) {
          createVariables = payload.variables;
          return { exitCode: 0, stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: "PVTF_iter123", name: "Sprint", dataType: "ITERATION", __typename: "ProjectV2IterationField" } } } }), stderr: "" };
        }
      }
      throw new Error(`Unexpected gh call in test: ${args.join(" ")}`);
    });
    const connection = await connectedClient(accountConfig());

    try {
      const result = await connection.client.callTool({
        name: "create_project_field",
        arguments: {
          owner: "masa-nakaya",
          projectId: "PVT_project123",
          name: "Sprint",
          dataType: "ITERATION",
          iterationConfiguration: {
            startDate: "2026-11-03",
            durationDays: 14,
            iterations: [{ title: "Sprint 1", startDate: "2026-11-03" }],
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(createVariables.iterationConfiguration).toEqual({
        startDate: "2026-11-03",
        duration: 14,
        iterations: [{ title: "Sprint 1", startDate: "2026-11-03" }],
      });
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
