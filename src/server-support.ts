import {
  randomUUID,
} from "node:crypto";

import {
  resolveAccountContext,
  verifyAccountProfile,
} from "./account-profile.js";
import {
  appendAuditRecord,
} from "./audit-log.js";
import type {
  Config,
  RequestContext,
} from "./config.js";
import {
  runGh,
} from "./gh-runner.js";
import type {
  RunGhOptions,
} from "./gh-runner.js";
import { z } from "zod";
import { assertRepositoryPath } from "./git-data.js";
import {
  isLabelColor,
  isUtcTimestamp,
} from "./repository-metadata.js";
import { isWorkflowIdentifier } from "./workflow.js";
import {
  assertRepositoryAllowed,
} from "./policy.js";
import {
  pullRequestMutationIdentity,
} from "./pull-request.js";
import {
  REPOSITORY_DETAILS_JQ,
  assertRepositoryIdentity,
  repositoryDetails,
} from "./repository-admin.js";
import {
  assertNoGraphqlErrors,
  assertProjectOwner,
} from "./project.js";
import {
  assertGitReadRef,
  assertRepositoryReadPath,
  canonicalRepositoryIdentity,
  encodeGitReadRef,
  repositorySnapshot,
  repositoryTreeLookup,
  repositoryTreeLookupJq,
} from "./repository-content.js";
import type {
  RepositorySnapshot,
  RepositoryTreeEntry,
} from "./repository-content.js";

export function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function responseWithinOutputLimit(value: unknown, config: Config) {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") > config.maxOutputBytes) {
    throw new Error(`MCP response exceeded the configured ${config.maxOutputBytes}-byte output limit.`);
  }
  return { content: [{ type: "text" as const, text }] };
}

export async function verifiedRequestContext(
  config: Config,
  account?: string,
  hostname?: string,
): Promise<RequestContext> {
  const context = resolveAccountContext(config, account, hostname);
  await verifyAccountProfile(config, context);
  return context;
}

export async function verifiedRepositoryReadContext(
  config: Config,
  repository: string,
  account?: string,
  hostname?: string,
): Promise<Readonly<{ context: RequestContext; repository: string }>> {
  const context = resolveAccountContext(config, account, hostname);
  const normalizedRepository = repository.trim();
  assertRepositoryAllowed(normalizedRepository, context);
  const [owner, name] = normalizedRepository.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error("Repository must use a canonical owner/name path.");
  }
  await verifyAccountProfile(config, context);
  return Object.freeze({ context, repository: normalizedRepository });
}

export async function jsonGh(
  args: string[],
  config: Config,
  context: RequestContext,
  options: RunGhOptions = {},
): Promise<unknown> {
  const result = await runGh(args, config, context, options);
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error("GitHub CLI returned invalid JSON."); }
}

export async function resolveCanonicalRepository(
  config: Config,
  context: RequestContext,
  requestedRepository: string,
): Promise<string> {
  const value = await jsonGh([
    "api",
    `repos/${requestedRepository}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    REPOSITORY_IDENTITY_JQ,
  ], config, context);
  return canonicalRepositoryIdentity(value, requestedRepository);
}

export async function verifiedCanonicalRepositoryReadContext(
  config: Config,
  repository: string,
  account?: string,
  hostname?: string,
): Promise<Readonly<{ context: RequestContext; repository: string }>> {
  const readRequest = await verifiedRepositoryReadContext(
    config,
    repository,
    account,
    hostname,
  );
  const canonicalRepository = await resolveCanonicalRepository(
    config,
    readRequest.context,
    readRequest.repository,
  );
  return Object.freeze({
    context: readRequest.context,
    repository: canonicalRepository,
  });
}

export async function resolveRepositoryDetails(
  config: Config,
  context: RequestContext,
  repository: string,
) {
  const value = await jsonGh([
    "api",
    `repos/${repository}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    REPOSITORY_DETAILS_JQ,
  ], config, context);
  const details = repositoryDetails(value);
  assertRepositoryIdentity(details, repository);
  return details;
}

export async function resolvePullRequestMutationIdentity(
  config: Config,
  context: RequestContext,
  repository: string,
  pullRequestNumber: number,
) {
  const value = await jsonGh([
    "api",
    `repos/${repository}/pulls/${pullRequestNumber}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    PULL_REQUEST_MUTATION_IDENTITY_JQ,
  ], config, context);
  return pullRequestMutationIdentity(value, pullRequestNumber);
}

export async function readGraphqlGh(
  config: Config,
  context: RequestContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const value = await jsonGh([
    "api",
    "graphql",
    "--hostname",
    context.profile.hostname,
    "--method",
    "POST",
    "--input",
    "-",
  ], config, context, { stdin: JSON.stringify({ query, variables }) });
  assertNoGraphqlErrors(value);
  return value;
}

export async function resolveRepositorySnapshot(
  config: Config,
  context: RequestContext,
  repository: string,
  ref: string,
): Promise<RepositorySnapshot> {
  const value = await jsonGh([
    "api",
    `repos/${repository}/commits/${encodeGitReadRef(ref)}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    REPOSITORY_COMMIT_JQ,
  ], config, context);
  return repositorySnapshot(value, ref);
}

export async function resolveRepositoryPathEntry(
  config: Config,
  context: RequestContext,
  repository: string,
  rootTreeSha: string,
  path: string,
): Promise<Readonly<{ entry: RepositoryTreeEntry; parentTreeSha: string }>> {
  assertRepositoryReadPath(path);
  const components = path.split("/");
  let currentTreeSha = rootTreeSha;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    const value = await jsonGh([
      "api",
      `repos/${repository}/git/trees/${currentTreeSha}`,
      "--hostname",
      context.profile.hostname,
      "--jq",
      repositoryTreeLookupJq(component),
    ], config, context);
    const entry = repositoryTreeLookup(value, currentTreeSha, component);
    const isFinal = index === components.length - 1;
    if (isFinal) {
      return Object.freeze({ entry, parentTreeSha: currentTreeSha });
    }
    if (entry.kind !== "directory") {
      throw new Error(
        `Repository path component ${JSON.stringify(component)} is ${entry.kind}, not a directory.`,
      );
    }
    currentTreeSha = entry.sha;
  }
  throw new Error("Repository path did not contain a resolvable entry.");
}

export const REPOSITORY_CONTENT_TRUST = "untrusted_repository_content";
export const ISSUE_DETAILS_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "stateReason",
  "author",
  "assignees",
  "labels",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedAt",
  "url",
].join(",");
export const ISSUE_COMMENTS_JQ = "map({id: .id, body: .body, author: (if .user == null then null else {login: .user.login, type: .user.type} end), createdAt: .created_at, updatedAt: .updated_at, url: .html_url})";
export const ISSUE_EVENTS_JQ = "map({id: .id, event: .event, actor: (if .actor == null then null else {login: .actor.login, type: .actor.type} end), createdAt: .created_at, commitId: (.commit_id // null), label: (if .label == null then null else {name: .label.name, color: .label.color} end), assignee: (if .assignee == null then null else {login: .assignee.login, type: .assignee.type} end), assigner: (if .assigner == null then null else {login: .assigner.login, type: .assigner.type} end), milestone: (if .milestone == null then null else {title: .milestone.title} end), rename: (if .rename == null then null else {from: .rename.from, to: .rename.to} end), lockReason: (.lock_reason // null)})";
export const PULL_REQUEST_DETAILS_FIELDS = [
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
export const PULL_REQUEST_FILES_JQ = "map({path: .filename, status: .status, previousPath: (.previous_filename // null), additions: .additions, deletions: .deletions, changes: .changes})";
export const PULL_REQUEST_CHECK_FIELDS = "bucket,completedAt,event,name,startedAt,state,workflow";
export const WORKFLOW_RUN_JOBS_JQ = ".jobs | map({id: .id, name: .name, status: .status, conclusion: (.conclusion // null), startedAt: (.started_at // null), completedAt: (.completed_at // null), runnerName: (.runner_name // null), runnerGroupName: (.runner_group_name // null), labels: (.labels // [])})";
export const WORKFLOW_JOB_IDENTITY_JQ = "{id: .id, runId: .run_id, status: .status}";
export const REPOSITORY_IDENTITY_JQ = "{fullName:.full_name}";
export const REPOSITORY_COMMIT_JQ = "{commitSha:.sha,treeSha:.commit.tree.sha}";
export const PULL_REQUEST_IDENTITY_JQ = "{number:.number,repository:(.base.repo.full_name // null)}";
export const PULL_REQUEST_MUTATION_IDENTITY_JQ = "{number: .number, nodeId: .node_id, state: .state, merged: .merged, headSha: .head.sha, url: .html_url}";

export function pullRequestChecksJq(offset: number, limit: number): string {
  const end = offset + limit;
  return `{total: length, buckets: {pass: (map(select(.bucket == "pass")) | length), fail: (map(select(.bucket == "fail")) | length), pending: (map(select(.bucket == "pending")) | length), skipping: (map(select(.bucket == "skipping")) | length), cancel: (map(select(.bucket == "cancel")) | length)}, checks: (.[${offset}:${end}] | map({bucket: .bucket, completedAt: .completedAt, event: .event, name: .name, startedAt: .startedAt, state: .state, workflow: .workflow}))}`;
}

export function pullRequestSource(
  context: RequestContext,
  repository: string,
  pullRequestNumber: number,
): Record<string, unknown> {
  return {
    provider: "github",
    hostname: context.profile.hostname,
    account: context.accountId,
    repository,
    pullRequestNumber,
  };
}

export function issueSource(
  context: RequestContext,
  repository: string,
  issueNumber: number,
): Record<string, unknown> {
  return {
    provider: "github",
    hostname: context.profile.hostname,
    account: context.accountId,
    repository,
    issueNumber,
  };
}

export function repositorySource(
  context: RequestContext,
  repository: string,
): Record<string, unknown> {
  return {
    provider: "github",
    hostname: context.profile.hostname,
    account: context.accountId,
    repository,
  };
}

export function workflowRunSource(
  context: RequestContext,
  repository: string,
  runId: number,
  jobId?: number,
  attempt?: number,
): Record<string, unknown> {
  return {
    provider: "github",
    hostname: context.profile.hostname,
    account: context.accountId,
    repository,
    runId,
    ...(jobId === undefined ? {} : { jobId }),
    ...(attempt === undefined ? {} : { attempt }),
  };
}

export function repositoryContentSource(
  context: RequestContext,
  repository: string,
  requestedRef: string,
  snapshot: RepositorySnapshot,
  path: string,
  selectedTreeSha: string,
  entry?: RepositoryTreeEntry,
): Record<string, unknown> {
  return {
    provider: "github",
    hostname: context.profile.hostname,
    account: context.accountId,
    repository,
    requestedRef,
    commitSha: snapshot.commitSha,
    rootTreeSha: snapshot.treeSha,
    selectedTreeSha,
    path,
    ...(entry === undefined
      ? {}
      : {
          blobSha: entry.sha,
          kind: entry.kind,
          mode: entry.mode,
          size: entry.size,
        }),
  };
}

export async function assertStandaloneIssue(
  repository: string,
  issueNumber: number,
  config: Config,
  context: RequestContext,
): Promise<void> {
  const value = await jsonGh([
    "api",
    `repos/${repository}/issues/${issueNumber}`,
    "--hostname",
    context.profile.hostname,
  ], config, context);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned an unexpected issue response.");
  const item = value as Record<string, unknown>;
  if (item.pull_request !== undefined) throw new Error(`Issue #${issueNumber} is a pull request. Use a Pull Request-specific tool instead.`);
}

export async function assertPullRequest(
  repository: string,
  pullRequestNumber: number,
  config: Config,
  context: RequestContext,
): Promise<void> {
  const value = await jsonGh([
    "api",
    `repos/${repository}/pulls/${pullRequestNumber}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    PULL_REQUEST_IDENTITY_JQ,
  ], config, context);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected pull request identity response.");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.number !== "number"
    || !Number.isSafeInteger(item.number)
    || item.number <= 0
    || typeof item.repository !== "string"
    || item.repository.length === 0
  ) {
    throw new Error("GitHub API returned an invalid pull request identity.");
  }
  if (item.number !== pullRequestNumber) {
    throw new Error(`GitHub returned pull request #${item.number} instead of #${pullRequestNumber}.`);
  }
  if (item.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`GitHub returned pull request repository ${item.repository} instead of ${repository}.`);
  }
}

export async function assertProjectAccess(
  projectId: string,
  owner: string,
  config: Config,
  context: RequestContext,
): Promise<void> {
  const query = `query($projectId: ID!) { node(id: $projectId) { __typename ... on ProjectV2 { id owner { ... on User { login } ... on Organization { login } } } } }`;
  const value = await jsonGh([
    "api",
    "graphql",
    "--hostname",
    context.profile.hostname,
    "--method",
    "POST",
    "--input",
    "-",
  ], config, context, { stdin: JSON.stringify({ query, variables: { projectId } }) });
  assertProjectOwner(value, owner);
}

export interface AuditTarget {
  tool: string;
  hostname: string;
  account: string;
  repository?: string;
  repositoryId?: number;
  owner?: string;
  projectId?: string;
  projectItemId?: string;
  projectFieldId?: string;
  branch?: string;
  commitSha?: string;
  fileCount?: number;
  issueNumber?: number;
  pullRequestNumber?: number;
  reviewCommentId?: number;
  reviewThreadId?: string;
  releaseId?: number;
  releaseAssetId?: number;
  secretName?: string;
  workflow?: string;
  label?: string;
  milestoneNumber?: number;
}

export type AuditTargetInput = Omit<AuditTarget, "hostname" | "account">;

export interface WriteRequest {
  readonly context: RequestContext;
  readonly operationId: string;
  readonly target: AuditTarget;
}

export function accountScopedTarget(
  target: AuditTargetInput,
  context: RequestContext,
): AuditTarget {
  return {
    ...target,
    hostname: context.profile.hostname,
    account: context.accountId,
  };
}

export async function verifyWriteAccount(request: WriteRequest, config: Config): Promise<void> {
  const startedAt = Date.now();
  try {
    await verifyAccountProfile(config, request.context);
  } catch (error) {
    try {
      await appendAuditRecord(config.auditLogPath, {
        ...request.target,
        operationId: request.operationId,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Preserve the account verification error even if the audit destination is unavailable.
    }
    throw error;
  }
}

export async function prepareWriteRequest(
  target: AuditTargetInput,
  config: Config,
  account?: string,
  hostname?: string,
): Promise<WriteRequest> {
  const context = resolveAccountContext(config, account, hostname);
  const request = Object.freeze({
    context,
    operationId: randomUUID(),
    target: accountScopedTarget(target, context),
  });
  await verifyWriteAccount(request, config);
  return request;
}

export async function auditedOperation<T>(
  request: WriteRequest,
  config: Config,
  operation: () => Promise<T>,
  completedTarget?: (value: T) => Partial<AuditTargetInput>,
): Promise<{ value: T; audit: { started: true; completed: boolean } }> {
  const startedAt = Date.now();
  await appendAuditRecord(config.auditLogPath, {
    ...request.target,
    operationId: request.operationId,
    outcome: "started",
    durationMs: 0,
  });
  let value: T;
  try {
    await verifyAccountProfile(config, request.context);
    value = await operation();
  } catch (error) {
    try {
      await appendAuditRecord(config.auditLogPath, {
        ...request.target,
        operationId: request.operationId,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Preserve the original GitHub operation error. The initial audit record was already written.
    }
    throw error;
  }

  let completionMetadataError: unknown;
  let finalTarget = request.target;
  if (completedTarget !== undefined) {
    try {
      finalTarget = { ...request.target, ...completedTarget(value) };
    } catch (error) {
      // The remote mutation already succeeded. Preserve that audit outcome even
      // if an unexpected response shape prevents optional target enrichment.
      completionMetadataError = error;
    }
  }

  let completed = true;
  try {
    await appendAuditRecord(config.auditLogPath, {
      ...finalTarget,
      operationId: request.operationId,
      outcome: "succeeded",
      durationMs: Date.now() - startedAt,
    });
  } catch {
    completed = false;
  }
  if (completionMetadataError !== undefined) throw completionMetadataError;
  return { value, audit: { started: true, completed } };
}

export async function auditedJsonGh(
  request: WriteRequest,
  args: string[],
  payload: Record<string, unknown>,
  config: Config,
  completedTarget?: (value: unknown) => Partial<AuditTargetInput>,
): Promise<{ value: unknown; audit: { started: true; completed: boolean } }> {
  return auditedOperation(
    request,
    config,
    () => jsonGh(args, config, request.context, { stdin: JSON.stringify(payload) }),
    completedTarget,
  );
}

export async function auditedGraphqlGh(
  request: WriteRequest,
  args: string[],
  payload: Record<string, unknown>,
  config: Config,
  completedTarget?: (value: unknown) => Partial<AuditTargetInput>,
): Promise<{ value: unknown; audit: { started: true; completed: boolean } }> {
  return auditedOperation(
    request,
    config,
    async () => {
      const value = await jsonGh(
        args,
        config,
        request.context,
        { stdin: JSON.stringify(payload) },
      );
      // GitHub GraphQL can reject a mutation through a top-level errors array
      // while gh still exits zero. Validate that before recording success.
      assertNoGraphqlErrors(value);
      return value;
    },
    completedTarget,
  );
}

export function issueSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned an unexpected issue response.");
  const item = value as Record<string, unknown>;
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function commentSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned an unexpected issue comment response.");
  const item = value as Record<string, unknown>;
  return {
    id: item.id,
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function buildContextSchemas(config: Config) {
  const accountSelectorSchema = z.string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/, "Account must be a configured GitHub account id.");
  const accountInputSchema = config.accountProfiles.size === 1
    ? accountSelectorSchema.optional()
    : accountSelectorSchema;
  const requestContextSchema = {
    account: accountInputSchema,
    hostname: z.string().trim().min(1).optional(),
  };
  const repositorySchema = {
    ...requestContextSchema,
    repository: z.string().describe("Repository in owner/name format"),
  };
  const writeContextSchema = repositorySchema;
  return { requestContextSchema, repositorySchema, writeContextSchema };
}

export function resolveTextChunkMaxBytes(config: Config): number {
  return Math.max(
    1,
    Math.min(128 * 1024, Math.floor(Math.max(1, config.maxOutputBytes - 4096) / 6)),
  );
}

export function buildSharedSchemas() {
  const gitRefSchema = z.string().trim().min(1).max(255).refine(
    (value) => !/[\0\r\n]/.test(value),
    "Git reference must not contain control characters.",
  );
  const repositoryReadRefSchema = z.string().min(1).max(255).refine((value) => {
    try { assertGitReadRef(value); return true; } catch { return false; }
  }, "Ref must be a canonical branch, tag, or full commit SHA.");
  const repositoryTreePathSchema = z.string().max(4096).refine((value) => {
    try { assertRepositoryReadPath(value, true); return true; } catch { return false; }
  }, "Repository directory path must be a normalized relative Git path.").default("");
  const repositoryReadFilePathSchema = z.string().min(1).max(4096).refine((value) => {
    try { assertRepositoryReadPath(value); return true; } catch { return false; }
  }, "Repository file path must be a normalized relative Git path.");
  const workflowIdentifierSchema = z.string().trim().min(1).max(255).refine(
    isWorkflowIdentifier,
    "Workflow must be a positive numeric ID or a .yml/.yaml file name.",
  );
  const labelNameSchema = z.string().trim().min(1).max(50);
  const labelColorSchema = z.string().refine(isLabelColor, "Label color must be exactly six hexadecimal characters.");
  const dueOnSchema = z.string().refine(isUtcTimestamp, "Milestone dueOn must be a valid UTC ISO 8601 timestamp.");
  const ownerLoginSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);
  const projectIdSchema = z.string().trim().min(8).max(128).regex(/^PVT_[A-Za-z0-9_-]+$/);
  const projectItemIdSchema = z.string().trim().min(8).max(128).regex(/^PVTI_[A-Za-z0-9_-]+$/);
  const projectFieldIdSchema = z.string().trim().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/);
  const branchNameSchema = z.string().trim().min(1).max(255).regex(/^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|\s))[A-Za-z0-9._\/-]+(?<![\/.])$/);
  const commitShaSchema = z.string().trim().regex(/^[0-9a-f]{40}$/);
  const repositoryPathSchema = z.string().trim().min(1).max(1024).refine((value) => {
    try { assertRepositoryPath(value); return true; } catch { return false; }
  }, "Repository file path must be a normalized relative path.");
  const repositoryNameSchema = z.string().trim().min(1).max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .refine((value) => value !== "." && value !== "..", "Repository name must be canonical.");
  const repositoryIdSchema = z.number().int().positive();
  const repositoryDescriptionSchema = z.string().max(160).nullable();
  const reviewCommentIdSchema = z.number().int().positive();
  const reviewThreadIdSchema = z.string().trim().min(8).max(256)
    .refine((value) => !/[\0\r\n]/.test(value), "Review thread ID must not contain control characters.");
  const graphqlCursorSchema = z.string().min(1).max(512)
    .refine((value) => !/[\0\r\n]/.test(value), "GraphQL cursor must not contain control characters.");
  const apiPageSchema = z.number().int().min(1).max(10_000).default(1);
  const apiPerPageSchema = z.number().int().min(1).max(100).default(100);
  return {
    gitRefSchema, repositoryReadRefSchema, repositoryTreePathSchema,
    repositoryReadFilePathSchema, workflowIdentifierSchema, labelNameSchema,
    labelColorSchema, dueOnSchema, ownerLoginSchema, projectIdSchema,
    projectItemIdSchema, projectFieldIdSchema, branchNameSchema,
    commitShaSchema, repositoryPathSchema, repositoryNameSchema,
    repositoryIdSchema, repositoryDescriptionSchema, reviewCommentIdSchema,
    reviewThreadIdSchema, graphqlCursorSchema, apiPageSchema, apiPerPageSchema,
  };
}
