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

  it("records a pull request target without review content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T01:00:00.000Z",
      tool: "review_pull_request",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      pullRequestNumber: 42,
      outcome: "succeeded",
      durationMs: 84,
    });

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      timestamp: "2026-07-22T01:00:00.000Z",
      tool: "review_pull_request",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      pullRequestNumber: 42,
      outcome: "succeeded",
      durationMs: 84,
    });
    expect(text).not.toContain("review content");
  });

  it("records a release target without release content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T04:00:00.000Z",
      tool: "update_release",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      releaseId: 99,
      outcome: "succeeded",
      durationMs: 21,
    });

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      timestamp: "2026-07-22T04:00:00.000Z",
      tool: "update_release",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      releaseId: 99,
      outcome: "succeeded",
      durationMs: 21,
    });
    expect(text).not.toContain("release notes");
  });

  it("records a workflow target without workflow inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T04:30:00.000Z",
      tool: "dispatch_workflow",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      workflow: "ci.yml",
      outcome: "succeeded",
      durationMs: 12,
    });

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      timestamp: "2026-07-22T04:30:00.000Z",
      tool: "dispatch_workflow",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      workflow: "ci.yml",
      outcome: "succeeded",
      durationMs: 12,
    });
    expect(text).not.toContain("environment");
    expect(text).not.toContain("production");
  });

  it("records label and milestone targets without descriptions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T05:00:00.000Z",
      tool: "update_label",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      label: "priority-high",
      outcome: "succeeded",
      durationMs: 8,
    });
    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T05:01:00.000Z",
      tool: "update_milestone",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      milestoneNumber: 7,
      outcome: "succeeded",
      durationMs: 9,
    });

    const records = (await readFile(auditLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0].label).toBe("priority-high");
    expect(records[1].milestoneNumber).toBe(7);
    expect(JSON.stringify(records)).not.toContain("description content");
  });
});
