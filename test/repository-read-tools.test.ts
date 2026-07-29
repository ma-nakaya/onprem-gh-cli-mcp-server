import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";
import type { AccountProfile, Config } from "../src/config.js";
import { runGh, runGhRawBlobChunk } from "../src/gh-runner.js";
import { repositoryTreeLookupJq, repositoryTreePageJq } from "../src/repository-content.js";
import { createServer } from "../src/server.js";

vi.mock("../src/gh-runner.js", () => ({
  runGh: vi.fn(),
  runGhRawBlobChunk: vi.fn(),
}));
vi.mock("../src/audit-log.js", () => ({
  appendAuditRecord: vi.fn(),
}));

const runGhMock = vi.mocked(runGh);
const runGhRawBlobChunkMock = vi.mocked(runGhRawBlobChunk);
const appendAuditRecordMock = vi.mocked(appendAuditRecord);

const repository = "ma-nakaya/example";
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const srcTreeSha = "c".repeat(40);
const blobSha = "d".repeat(40);
const symlinkSha = "e".repeat(40);
const submoduleSha = "f".repeat(40);

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

function config(
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

async function connectedClient(serverConfig = config()): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer(serverConfig);
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

function ghJson(value: unknown) {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function identity(login = "ma-nakaya") {
  return { exitCode: 0, stdout: `${login}\n`, stderr: "" };
}

function repositoryIdentity(fullName = repository) {
  return ghJson({ fullName });
}

function snapshot() {
  return { commitSha, treeSha: rootTreeSha };
}

function treeEntry(
  path: string,
  kind: "file" | "directory" | "symlink" | "submodule" = "file",
  size = 12,
) {
  if (kind === "directory") {
    return { path, mode: "040000", type: "tree", sha: srcTreeSha, size: null };
  }
  if (kind === "symlink") {
    return { path, mode: "120000", type: "blob", sha: symlinkSha, size };
  }
  if (kind === "submodule") {
    return { path, mode: "160000", type: "commit", sha: submoduleSha, size: null };
  }
  return { path, mode: "100644", type: "blob", sha: blobSha, size };
}

function lookup(treeSha: string, entry: ReturnType<typeof treeEntry>) {
  return { sha: treeSha, truncated: false, matches: [entry] };
}

function parseToolJson(result: { content: unknown }): Record<string, unknown> {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  return JSON.parse(blocks[0]?.text ?? "null") as Record<string, unknown>;
}

describe("repository tree and file read tools", () => {
  beforeEach(() => {
    runGhMock.mockReset();
    runGhRawBlobChunkMock.mockReset();
    appendAuditRecordMock.mockReset();
    appendAuditRecordMock.mockResolvedValue();
  });

  it.each(["list_repository_tree", "get_repository_file"])(
    "rejects a disallowed repository before any network request for %s",
    async (name) => {
      const connection = await connectedClient(config(profile({
        allowedOwners: new Set<string>(),
        allowedRepositories: new Set(["ma-nakaya/allowed"]),
      })));
      try {
        const result = await connection.client.callTool({
          name,
          arguments: name === "list_repository_tree"
            ? { repository, ref: "main" }
            : { repository, ref: "main", path: "README.md" },
        });
        expect(result.isError).toBe(true);
        expect(runGhMock).not.toHaveBeenCalled();
        expect(runGhRawBlobChunkMock).not.toHaveBeenCalled();
        expect(appendAuditRecordMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it.each(["list_repository_tree", "get_repository_file"])(
    "stops after one failed account identity check for %s",
    async (name) => {
      runGhMock.mockResolvedValue(identity("masa-nakaya"));
      const connection = await connectedClient();
      try {
        const result = await connection.client.callTool({
          name,
          arguments: name === "list_repository_tree"
            ? { repository, ref: "main" }
            : { repository, ref: "main", path: "README.md" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/expected ma-nakaya, active masa-nakaya/i);
        expect(runGhMock).toHaveBeenCalledTimes(1);
        expect(runGhRawBlobChunkMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it.each(["list_repository_tree", "get_repository_file"])(
    "rejects a repository redirect before resolving a commit or reading content for %s",
    async (name) => {
      runGhMock
        .mockResolvedValueOnce(identity())
        .mockResolvedValueOnce(repositoryIdentity("masa-nakaya/example"));
      const connection = await connectedClient();
      try {
        const result = await connection.client.callTool({
          name,
          arguments: name === "list_repository_tree"
            ? { repository, ref: "main" }
            : { repository, ref: "main", path: "README.md" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(
          /repository redirects are not allowed/i,
        );
        expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
          ["api", "user", "--hostname", "github.com", "--jq", ".login"],
          [
            "api",
            `repos/${repository}`,
            "--hostname",
            "github.com",
            "--jq",
            "{fullName:.full_name}",
          ],
        ]);
        expect(runGhMock.mock.calls.some(([args]) =>
          args[1]?.includes("/commits/")
          || args[1]?.includes("/git/trees/")
          || args[1]?.includes("/git/blobs/")
        )).toBe(false);
        expect(runGhRawBlobChunkMock).not.toHaveBeenCalled();
      } finally {
        await connection.close();
      }
    },
  );

  it("lists a bounded non-recursive root page without a recursive query", async () => {
    const entries = [
      treeEntry("README.md", "file", 20),
      treeEntry("src", "directory"),
    ];
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson({
        sha: rootTreeSha,
        truncated: false,
        visibleTotalEntries: 2,
        entries,
      }));
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "list_repository_tree",
        arguments: { repository, ref: "main", offset: 0, limit: 2 },
      });
      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.map(([args]) => args)).toEqual([
        ["api", "user", "--hostname", "github.com", "--jq", ".login"],
        [
          "api",
          `repos/${repository}`,
          "--hostname",
          "github.com",
          "--jq",
          "{fullName:.full_name}",
        ],
        [
          "api",
          `repos/${repository}/commits/main`,
          "--hostname",
          "github.com",
          "--jq",
          "{commitSha:.sha,treeSha:.commit.tree.sha}",
        ],
        [
          "api",
          `repos/${repository}/git/trees/${rootTreeSha}`,
          "--hostname",
          "github.com",
          "--jq",
          repositoryTreePageJq(0, 2),
        ],
      ]);
      const value = parseToolJson(result);
      expect(value.entries).toEqual([
        { ...entries[0], kind: "file" },
        { ...entries[1], kind: "directory" },
      ]);
      expect(value.pagination).toEqual({
        offset: 0,
        limit: 2,
        returnedCount: 2,
        nextOffset: null,
        visibleTotalEntries: 2,
      });
      expect(value.upstreamTruncated).toBe(false);
      expect(value.completeness).toBe("complete_after_pagination");
      expect(value.contentTrust).toBe("untrusted_repository_content");
      expect(value.source).toEqual({
        provider: "github",
        hostname: "github.com",
        account: "ma-nakaya",
        repository,
        requestedRef: "main",
        commitSha,
        rootTreeSha,
        selectedTreeSha: rootTreeSha,
        path: "",
      });
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("pins a nested subtree to the resolved commit and exposes recursive truncation", async () => {
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry("src", "directory"),
      )))
      .mockResolvedValueOnce(ghJson({
        sha: srcTreeSha,
        truncated: true,
        visibleTotalEntries: 2,
        entries: [treeEntry("server.ts", "file", 99)],
      }));
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "list_repository_tree",
        arguments: {
          repository,
          ref: commitSha,
          path: "src",
          recursive: true,
          offset: 1,
          limit: 1,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls[3]?.[0]).toEqual([
        "api",
        `repos/${repository}/git/trees/${rootTreeSha}`,
        "--hostname",
        "github.com",
        "--jq",
        repositoryTreeLookupJq("src"),
      ]);
      expect(runGhMock.mock.calls[4]?.[0][1]).toBe(
        `repos/${repository}/git/trees/${srcTreeSha}?recursive=1`,
      );
      expect(runGhMock.mock.calls.filter(([args]) =>
        args[1]?.includes("/commits/")
      )).toHaveLength(1);
      const value = parseToolJson(result);
      expect(value.entries).toEqual([{
        ...treeEntry("server.ts", "file", 99),
        kind: "file",
        path: "src/server.ts",
      }]);
      expect(value.upstreamTruncated).toBe(true);
      expect(value.completeness).toBe("not_guaranteed");
      expect(value.recovery).toMatch(/recursive false/i);
    } finally {
      await connection.close();
    }
  });

  it("reads a nested UTF-8 file from one immutable blob and reports provenance", async () => {
    const content = Buffer.from("line one\nline two\n", "utf8");
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry("src", "directory"),
      )))
      .mockResolvedValueOnce(ghJson(lookup(
        srcTreeSha,
        treeEntry("server.ts", "file", content.length),
      )));
    runGhRawBlobChunkMock.mockResolvedValue({
      bytes: content,
      totalBytes: content.length,
      verifiedBlobSha: blobSha,
    });
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "get_repository_file",
        arguments: {
          repository,
          ref: "main",
          path: "src/server.ts",
          format: "utf8",
          offsetBytes: 0,
          limitBytes: content.length,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(runGhMock.mock.calls.filter(([args]) =>
        args[1]?.includes("/commits/")
      )).toHaveLength(1);
      expect(runGhRawBlobChunkMock).toHaveBeenCalledWith(
        [
          "api",
          `repos/${repository}/git/blobs/${blobSha}`,
          "--hostname",
          "github.com",
          "--header",
          "Accept: application/vnd.github.raw+json",
        ],
        expect.anything(),
        expect.objectContaining({ accountId: "ma-nakaya" }),
        {
          expectedBlobSha: blobSha,
          expectedTotalBytes: content.length,
          offsetBytes: 0,
          limitBytes: content.length,
        },
      );
      const value = parseToolJson(result);
      expect(value).toMatchObject({
        format: "utf8",
        content: content.toString("utf8"),
        totalBytes: content.length,
        returnedBytes: content.length,
        nextOffsetBytes: null,
        blobShaVerified: true,
        gitBlobOnly: true,
        gitLfsObjectFollowed: false,
        symlinkTargetFollowed: false,
        contentTrust: "untrusted_repository_content",
      });
      expect(value.source).toEqual({
        provider: "github",
        hostname: "github.com",
        account: "ma-nakaya",
        repository,
        requestedRef: "main",
        commitSha,
        rootTreeSha,
        selectedTreeSha: srcTreeSha,
        path: "src/server.ts",
        blobSha,
        kind: "file",
        mode: "100644",
        size: content.length,
      });
      expect(appendAuditRecordMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("returns exact Base64 bytes for binary content", async () => {
    const content = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry("asset.bin", "file", content.length),
      )));
    runGhRawBlobChunkMock.mockResolvedValue({
      bytes: content.subarray(1, 3),
      totalBytes: content.length,
      verifiedBlobSha: blobSha,
    });
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "get_repository_file",
        arguments: {
          repository,
          ref: commitSha,
          path: "asset.bin",
          format: "base64",
          offsetBytes: 1,
          limitBytes: 2,
        },
      });
      expect(result.isError).not.toBe(true);
      const value = parseToolJson(result);
      expect(value.contentBase64).toBe(content.subarray(1, 3).toString("base64"));
      expect(value).toMatchObject({
        returnedBytes: 2,
        nextOffsetBytes: 3,
        totalBytes: 4,
      });
      expect(value).not.toHaveProperty("content");
    } finally {
      await connection.close();
    }
  });

  it("reads a symlink blob without following its target", async () => {
    const target = Buffer.from("../private/secret.txt", "utf8");
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry("link", "symlink", target.length),
      )));
    runGhRawBlobChunkMock.mockResolvedValue({
      bytes: target,
      totalBytes: target.length,
      verifiedBlobSha: symlinkSha,
    });
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "get_repository_file",
        arguments: {
          repository,
          ref: "main",
          path: "link",
          limitBytes: target.length,
        },
      });
      expect(result.isError).not.toBe(true);
      const value = parseToolJson(result);
      expect(value.content).toBe("../private/secret.txt");
      expect(value.symlinkTargetFollowed).toBe(false);
      expect((value.source as Record<string, unknown>).kind).toBe("symlink");
      expect(runGhMock).toHaveBeenCalledTimes(4);
      expect(runGhRawBlobChunkMock).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });

  it("rejects a submodule without reading another repository", async () => {
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry("vendor", "submodule"),
      )));
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "get_repository_file",
        arguments: { repository, ref: "main", path: "vendor" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/submodule.*not a readable Git blob/i);
      expect(runGhRawBlobChunkMock).not.toHaveBeenCalled();
      expect(runGhMock).toHaveBeenCalledTimes(4);
    } finally {
      await connection.close();
    }
  });

  it("escapes a malicious-looking path component inside one fixed jq argument", async () => {
    const component = 'a")|error("pwn")|("';
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson(lookup(
        rootTreeSha,
        treeEntry(component, "directory"),
      )))
      .mockResolvedValueOnce(ghJson({
        sha: srcTreeSha,
        truncated: false,
        visibleTotalEntries: 0,
        entries: [],
      }));
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "list_repository_tree",
        arguments: { repository, ref: "main", path: component },
      });
      expect(result.isError).not.toBe(true);
      const lookupArgs = runGhMock.mock.calls[3]?.[0] ?? [];
      expect(lookupArgs).toHaveLength(6);
      expect(lookupArgs[5]).toBe(repositoryTreeLookupJq(component));
      expect(lookupArgs[1]).toBe(
        `repos/${repository}/git/trees/${rootTreeSha}`,
      );
    } finally {
      await connection.close();
    }
  });

  it.each([
    { ref: "main?recursive=1", path: "" },
    { ref: "https://github.com/x/y", path: "" },
    { ref: "main", path: "../secret" },
    { ref: "main", path: "a\r\nb" },
    { ref: "main", path: "C:/secret" },
  ])("rejects unsafe ref/path input before network: %j", async (argumentsPart) => {
    const connection = await connectedClient();
    try {
      const result = await connection.client.callTool({
        name: "list_repository_tree",
        arguments: { repository, ...argumentsPart },
      });
      expect(result.isError).toBe(true);
      expect(runGhMock).not.toHaveBeenCalled();
      expect(runGhRawBlobChunkMock).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("fails closed when the final serialized response exceeds the configured cap", async () => {
    const longName = "x".repeat(1500);
    runGhMock
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(repositoryIdentity())
      .mockResolvedValueOnce(ghJson(snapshot()))
      .mockResolvedValueOnce(ghJson({
        sha: rootTreeSha,
        truncated: false,
        visibleTotalEntries: 1,
        entries: [treeEntry(longName, "file", 1)],
      }));
    const connection = await connectedClient(config(profile(), {
      maxOutputBytes: 1000,
    }));
    try {
      const result = await connection.client.callTool({
        name: "list_repository_tree",
        arguments: { repository, ref: "main", limit: 1 },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/response exceeded.*1000-byte/i);
    } finally {
      await connection.close();
    }
  });
});
