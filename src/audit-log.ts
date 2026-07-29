import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditOutcome = "started" | "succeeded" | "failed";

export interface AuditRecord {
  timestamp?: string;
  operationId: string;
  tool: string;
  hostname: string;
  account?: string;
  repository?: string;
  owner?: string;
  projectId?: string;
  projectItemId?: string;
  projectFieldId?: string;
  branch?: string;
  commitSha?: string;
  fileCount?: number;
  issueNumber?: number;
  pullRequestNumber?: number;
  releaseId?: number;
  workflow?: string;
  label?: string;
  milestoneNumber?: number;
  outcome: AuditOutcome;
  durationMs: number;
}

let auditWriteQueue: Promise<void> = Promise.resolve();

export function appendAuditRecord(auditLogPath: string, record: AuditRecord): Promise<void> {
  const line = JSON.stringify({
    timestamp: record.timestamp ?? new Date().toISOString(),
    operationId: record.operationId,
    tool: record.tool,
    hostname: record.hostname,
    ...(record.account === undefined ? {} : { account: record.account }),
    ...(record.repository === undefined ? {} : { repository: record.repository }),
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.projectItemId === undefined ? {} : { projectItemId: record.projectItemId }),
    ...(record.projectFieldId === undefined ? {} : { projectFieldId: record.projectFieldId }),
    ...(record.branch === undefined ? {} : { branch: record.branch }),
    ...(record.commitSha === undefined ? {} : { commitSha: record.commitSha }),
    ...(record.fileCount === undefined ? {} : { fileCount: record.fileCount }),
    ...(record.issueNumber === undefined ? {} : { issueNumber: record.issueNumber }),
    ...(record.pullRequestNumber === undefined ? {} : { pullRequestNumber: record.pullRequestNumber }),
    ...(record.releaseId === undefined ? {} : { releaseId: record.releaseId }),
    ...(record.workflow === undefined ? {} : { workflow: record.workflow }),
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.milestoneNumber === undefined ? {} : { milestoneNumber: record.milestoneNumber }),
    outcome: record.outcome,
    durationMs: record.durationMs,
  });

  const pendingWrite = auditWriteQueue.then(async () => {
    await mkdir(dirname(auditLogPath), { recursive: true });
    await appendFile(auditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  });

  auditWriteQueue = pendingWrite.catch(() => undefined);
  return pendingWrite;
}
