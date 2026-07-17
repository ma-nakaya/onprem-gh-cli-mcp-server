import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("audit log", () => {
  it("writes metadata without operation content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "nested", "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-17T10:00:00.000Z",
      tool: "comment_issue",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      issueNumber: 12,
      outcome: "succeeded",
      durationMs: 42,
    });

    const text = await readFile(auditLogPath, "utf8");
    const record = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(record).toEqual({
      timestamp: "2026-07-17T10:00:00.000Z",
      tool: "comment_issue",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      issueNumber: 12,
      outcome: "succeeded",
      durationMs: 42,
    });
    expect(text).not.toContain("body");
    expect(text).not.toContain("comment text");
  });
});
