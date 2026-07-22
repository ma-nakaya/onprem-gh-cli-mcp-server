import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditOutcome = "started" | "succeeded" | "failed";

export interface AuditRecord {
  timestamp?: string;
  tool: string;
  hostname: string;
  repository: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  releaseId?: number;
  workflow?: string;
  outcome: AuditOutcome;
  durationMs: number;
}

export async function appendAuditRecord(auditLogPath: string, record: AuditRecord): Promise<void> {
  await mkdir(dirname(auditLogPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: record.timestamp ?? new Date().toISOString(),
    tool: record.tool,
    hostname: record.hostname,
    repository: record.repository,
    ...(record.issueNumber === undefined ? {} : { issueNumber: record.issueNumber }),
    ...(record.pullRequestNumber === undefined ? {} : { pullRequestNumber: record.pullRequestNumber }),
    ...(record.releaseId === undefined ? {} : { releaseId: record.releaseId }),
    ...(record.workflow === undefined ? {} : { workflow: record.workflow }),
    outcome: record.outcome,
    durationMs: record.durationMs,
  });
  await appendFile(auditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}
