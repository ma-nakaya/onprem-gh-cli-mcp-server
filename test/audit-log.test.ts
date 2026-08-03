import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditRecord } from "../src/audit-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("audit log", () => {
  it("records the selected account without retaining token-shaped extra fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");
    const token = `ghp_${"a".repeat(36)}`;
    const operation = {
      timestamp: "2026-07-27T12:00:00.000Z",
      operationId: "operation-secret-redaction",
      tool: "create_issue",
      hostname: "github.com",
      account: "masa-nakaya",
      repository: "masa-nakaya/example",
      outcome: "succeeded" as const,
      durationMs: 10,
      token,
    } as Parameters<typeof appendAuditRecord>[1] & { token: string };

    await appendAuditRecord(auditLogPath, operation);

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      timestamp: "2026-07-27T12:00:00.000Z",
      operationId: "operation-secret-redaction",
      tool: "create_issue",
      hostname: "github.com",
      account: "masa-nakaya",
      repository: "masa-nakaya/example",
      outcome: "succeeded",
      durationMs: 10,
    });
    expect(text).not.toContain(token);
    expect(text).not.toContain('"token"');
  });

  it("writes metadata without operation content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "nested", "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-17T10:00:00.000Z",
      operationId: "operation-issue-comment",
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
      operationId: "operation-issue-comment",
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
      operationId: "operation-pr-review",
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
      operationId: "operation-pr-review",
      tool: "review_pull_request",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      pullRequestNumber: 42,
      outcome: "succeeded",
      durationMs: 84,
    });
    expect(text).not.toContain("review content");
  });

  it("records stable repository and review identifiers without authored content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-08-03T01:00:00.000Z",
      operationId: "operation-review-thread",
      tool: "resolve_pull_request_review_thread",
      hostname: "github.com",
      account: "ma-nakaya",
      repository: "ma-nakaya/example",
      repositoryId: 123,
      pullRequestNumber: 7,
      reviewCommentId: 101,
      reviewThreadId: "PRRT_thread101",
      outcome: "succeeded",
      durationMs: 12,
    });

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toMatchObject({
      repositoryId: 123,
      reviewCommentId: 101,
      reviewThreadId: "PRRT_thread101",
    });
    expect(text).not.toContain("Inline body");
  });

  it("records a release target without release content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T04:00:00.000Z",
      operationId: "operation-release-update",
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
      operationId: "operation-release-update",
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
      operationId: "operation-workflow-dispatch",
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
      operationId: "operation-workflow-dispatch",
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
      operationId: "operation-label-update",
      tool: "update_label",
      hostname: "github.com",
      repository: "ma-nakaya/example",
      label: "priority-high",
      outcome: "succeeded",
      durationMs: 8,
    });
    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T05:01:00.000Z",
      operationId: "operation-milestone-update",
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

  it("records an owner and project ID without project content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");

    await appendAuditRecord(auditLogPath, {
      timestamp: "2026-07-22T05:10:00.000Z",
      operationId: "operation-project-update",
      tool: "update_project",
      hostname: "github.com",
      owner: "ma-nakaya",
      projectId: "PVT_example123",
      outcome: "succeeded",
      durationMs: 15,
    });

    const text = await readFile(auditLogPath, "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      timestamp: "2026-07-22T05:10:00.000Z",
      operationId: "operation-project-update",
      tool: "update_project",
      hostname: "github.com",
      owner: "ma-nakaya",
      projectId: "PVT_example123",
      outcome: "succeeded",
      durationMs: 15,
    });
    expect(text).not.toContain("project readme");
  });

  it("serializes concurrent writes in invocation order as complete JSONL records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const auditLogPath = join(directory, "audit.jsonl");
    const operationIds = Array.from({ length: 100 }, (_, index) => `operation-${index}`);

    await Promise.all(
      operationIds.map((operationId, index) =>
        appendAuditRecord(auditLogPath, {
          timestamp: "2026-07-22T06:00:00.000Z",
          operationId,
          tool: "concurrent_operation",
          hostname: "github.com",
          outcome: "succeeded",
          durationMs: index,
        }),
      ),
    );

    const records = (await readFile(auditLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { operationId: string });
    expect(records).toHaveLength(operationIds.length);
    expect(records.map((record) => record.operationId)).toEqual(operationIds);
  });

  it("continues processing queued writes after an earlier write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-"));
    temporaryDirectories.push(directory);
    const invalidAuditLogPath = join(directory, "not-a-file");
    const validAuditLogPath = join(directory, "audit.jsonl");
    await mkdir(invalidAuditLogPath);

    const failedWrite = appendAuditRecord(invalidAuditLogPath, {
      operationId: "operation-failed-write",
      tool: "failed_operation",
      hostname: "github.com",
      outcome: "failed",
      durationMs: 1,
    });
    const succeedingWrite = appendAuditRecord(validAuditLogPath, {
      operationId: "operation-after-failure",
      tool: "later_operation",
      hostname: "github.com",
      outcome: "succeeded",
      durationMs: 2,
    });

    await expect(failedWrite).rejects.toThrow();
    await expect(succeedingWrite).resolves.toBeUndefined();
    expect(JSON.parse((await readFile(validAuditLogPath, "utf8")).trim())).toMatchObject({
      operationId: "operation-after-failure",
      tool: "later_operation",
    });
  });
});
