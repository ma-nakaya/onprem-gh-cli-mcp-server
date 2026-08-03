export type PullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: {
    login: string;
    isBot: boolean;
    name: string;
  } | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  url: string;
}

export interface PullRequestFile {
  path: string;
  status: string;
  previousPath: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

export type PullRequestCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface PullRequestCheck {
  bucket: PullRequestCheckBucket;
  completedAt: string | null;
  event: string;
  name: string;
  startedAt: string | null;
  state: string;
  workflow: string;
}

export interface PullRequestChecksEnvelope {
  total: number;
  buckets: Record<PullRequestCheckBucket, number>;
  checks: PullRequestCheck[];
}

export interface PullRequestDiffChunk {
  diff: string;
  offsetBytes: number;
  limitBytes: number;
  totalBytes: number;
  returnedBytes: number;
  nextOffsetBytes: number | null;
  truncated: boolean;
  endedAtLineBoundary: boolean;
  completeness: "not_guaranteed";
  githubMayLimitLargeDiffs: true;
}

export interface PullRequestMutationIdentity {
  number: number;
  nodeId: string;
  state: string;
  merged: boolean;
  headSha: string;
  url: string;
}

export interface PullRequestMergeResult {
  merged: true;
  sha: string;
  message: string;
}

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API returned an unexpected ${label} response.`);
  }
  return value as Record<string, unknown>;
}

function cliObjectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub CLI returned an unexpected ${label} response: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function responseFieldError(label: string, field: string, expectation: string): never {
  throw new Error(`GitHub CLI returned an unexpected ${label} response: "${field}" ${expectation}.`);
}

function stringField(
  item: Record<string, unknown>,
  field: string,
  label: string,
  allowEmpty = true,
): string {
  const value = item[field];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    responseFieldError(label, field, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function nullableStringField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): string | null {
  const value = item[field];
  if (value !== null && typeof value !== "string") {
    responseFieldError(label, field, "must be a string or null");
  }
  return value;
}

function booleanField(item: Record<string, unknown>, field: string, label: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") responseFieldError(label, field, "must be a boolean");
  return value;
}

function integerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
  minimum = 0,
): number {
  const value = item[field];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    responseFieldError(label, field, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function nestedRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = (value as Record<string, unknown>).ref;
  return typeof ref === "string" ? ref : undefined;
}

function pullRequestAuthor(value: unknown): PullRequestDetails["author"] {
  if (value === null) return null;
  const author = cliObjectResponse(value, "pull request author");
  return {
    login: stringField(author, "login", "pull request author", false),
    isBot: booleanField(author, "is_bot", "pull request author"),
    name: stringField(author, "name", "pull request author"),
  };
}

export function pullRequestDetails(value: unknown): PullRequestDetails {
  const item = cliObjectResponse(value, "pull request details");
  return {
    number: integerField(item, "number", "pull request details", 1),
    title: stringField(item, "title", "pull request details"),
    body: stringField(item, "body", "pull request details"),
    state: stringField(item, "state", "pull request details", false),
    isDraft: booleanField(item, "isDraft", "pull request details"),
    author: pullRequestAuthor(item.author),
    headRefName: stringField(item, "headRefName", "pull request details", false),
    headRefOid: stringField(item, "headRefOid", "pull request details", false),
    baseRefName: stringField(item, "baseRefName", "pull request details", false),
    baseRefOid: stringField(item, "baseRefOid", "pull request details", false),
    additions: integerField(item, "additions", "pull request details"),
    deletions: integerField(item, "deletions", "pull request details"),
    changedFiles: integerField(item, "changedFiles", "pull request details"),
    mergeable: stringField(item, "mergeable", "pull request details", false),
    mergeStateStatus: stringField(item, "mergeStateStatus", "pull request details", false),
    reviewDecision: stringField(item, "reviewDecision", "pull request details"),
    createdAt: stringField(item, "createdAt", "pull request details", false),
    updatedAt: stringField(item, "updatedAt", "pull request details", false),
    closedAt: nullableStringField(item, "closedAt", "pull request details"),
    mergedAt: nullableStringField(item, "mergedAt", "pull request details"),
    url: stringField(item, "url", "pull request details", false),
  };
}

export function pullRequestFiles(value: unknown, expectedMax?: number): PullRequestFile[] {
  if (
    expectedMax !== undefined
    && (!Number.isSafeInteger(expectedMax) || expectedMax < 0)
  ) {
    throw new Error("The expected pull request file count must be a non-negative safe integer.");
  }
  if (!Array.isArray(value)) {
    throw new Error("GitHub CLI returned an unexpected pull request files response: expected an array.");
  }
  if (expectedMax !== undefined && value.length > expectedMax) {
    throw new Error(
      `GitHub CLI returned ${value.length} pull request files, exceeding the requested maximum of ${expectedMax}.`,
    );
  }
  return value.map((entry, index) => {
    const label = `pull request file at index ${index}`;
    const item = cliObjectResponse(entry, label);
    return {
      path: stringField(item, "path", label, false),
      status: stringField(item, "status", label, false),
      previousPath: nullableStringField(item, "previousPath", label),
      additions: integerField(item, "additions", label),
      deletions: integerField(item, "deletions", label),
      changes: integerField(item, "changes", label),
    };
  });
}

const PULL_REQUEST_CHECK_BUCKETS = [
  "pass",
  "fail",
  "pending",
  "skipping",
  "cancel",
] as const satisfies readonly PullRequestCheckBucket[];

function checkBucket(value: unknown, label: string): PullRequestCheckBucket {
  if (
    typeof value !== "string"
    || !PULL_REQUEST_CHECK_BUCKETS.includes(value as PullRequestCheckBucket)
  ) {
    throw new Error(
      `GitHub CLI returned an unexpected ${label} response: "bucket" must be one of ${PULL_REQUEST_CHECK_BUCKETS.join(", ")}.`,
    );
  }
  return value as PullRequestCheckBucket;
}

export function pullRequestChecksEnvelope(value: unknown, limit: number): PullRequestChecksEnvelope {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("The pull request checks limit must be a positive safe integer.");
  }
  const envelope = cliObjectResponse(value, "pull request checks");
  const total = integerField(envelope, "total", "pull request checks");
  const sourceBuckets = cliObjectResponse(envelope.buckets, "pull request check buckets");
  const buckets = Object.fromEntries(
    PULL_REQUEST_CHECK_BUCKETS.map((bucket) => [
      bucket,
      integerField(sourceBuckets, bucket, "pull request check buckets"),
    ]),
  ) as unknown as Record<PullRequestCheckBucket, number>;
  const bucketTotal = PULL_REQUEST_CHECK_BUCKETS.reduce(
    (sum, bucket) => sum + buckets[bucket],
    0,
  );
  if (!Number.isSafeInteger(bucketTotal) || bucketTotal !== total) {
    throw new Error(
      "GitHub CLI returned an unexpected pull request checks response: bucket counts do not equal total.",
    );
  }
  if (!Array.isArray(envelope.checks)) {
    throw new Error('GitHub CLI returned an unexpected pull request checks response: "checks" must be an array.');
  }
  if (envelope.checks.length > limit) {
    throw new Error(
      `GitHub CLI returned ${envelope.checks.length} pull request checks, exceeding the requested limit of ${limit}.`,
    );
  }
  if (envelope.checks.length > total) {
    throw new Error(
      "GitHub CLI returned an unexpected pull request checks response: more checks were returned than total.",
    );
  }
  const checks = envelope.checks.map((entry, index) => {
    const label = `pull request check at index ${index}`;
    const item = cliObjectResponse(entry, label);
    return {
      bucket: checkBucket(item.bucket, label),
      completedAt: nullableStringField(item, "completedAt", label),
      event: stringField(item, "event", label),
      name: stringField(item, "name", label, false),
      startedAt: nullableStringField(item, "startedAt", label),
      state: stringField(item, "state", label, false),
      workflow: stringField(item, "workflow", label),
    };
  });
  return { total, buckets, checks };
}

function safeByteOffset(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0
    || offset === bytes.length
    || (bytes[offset]! & 0xc0) !== 0x80;
}

export function pullRequestDiffChunk(
  diff: string,
  offsetBytes: number,
  limitBytes: number,
): PullRequestDiffChunk {
  if (typeof diff !== "string") {
    throw new Error("The pull request diff must be a string.");
  }
  safeByteOffset(offsetBytes, "offsetBytes", 0);
  safeByteOffset(limitBytes, "limitBytes", 1);

  const bytes = Buffer.from(diff, "utf8");
  const totalBytes = bytes.length;
  if (offsetBytes > totalBytes) {
    throw new Error(`offsetBytes ${offsetBytes} exceeds the pull request diff size of ${totalBytes} bytes.`);
  }
  if (!isUtf8Boundary(bytes, offsetBytes)) {
    throw new Error(`offsetBytes ${offsetBytes} is not on a UTF-8 character boundary.`);
  }

  let endOffsetBytes = Math.min(totalBytes, offsetBytes + limitBytes);
  while (endOffsetBytes > offsetBytes && !isUtf8Boundary(bytes, endOffsetBytes)) {
    endOffsetBytes -= 1;
  }
  if (endOffsetBytes === offsetBytes && offsetBytes < totalBytes) {
    throw new Error(
      `limitBytes ${limitBytes} is too small to include the next complete UTF-8 character.`,
    );
  }

  if (endOffsetBytes < totalBytes) {
    for (let index = endOffsetBytes - 1; index >= offsetBytes; index -= 1) {
      if (bytes[index] === 0x0a) {
        endOffsetBytes = index + 1;
        break;
      }
    }
  }

  const returnedBytes = endOffsetBytes - offsetBytes;
  const nextOffsetBytes = endOffsetBytes < totalBytes ? endOffsetBytes : null;
  return {
    diff: bytes.subarray(offsetBytes, endOffsetBytes).toString("utf8"),
    offsetBytes,
    limitBytes,
    totalBytes,
    returnedBytes,
    nextOffsetBytes,
    truncated: offsetBytes > 0 || nextOffsetBytes !== null,
    endedAtLineBoundary: endOffsetBytes === totalBytes || bytes[endOffsetBytes - 1] === 0x0a,
    completeness: "not_guaranteed",
    githubMayLimitLargeDiffs: true,
  };
}

export function pullRequestSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "pull request");
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    isDraft: item.draft,
    url: item.html_url,
    headRefName: nestedRef(item.head),
    baseRefName: nestedRef(item.base),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function pullRequestReviewSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "pull request review");
  return {
    id: item.id,
    state: item.state,
    url: item.html_url,
    submittedAt: item.submitted_at,
  };
}

export function pullRequestMutationIdentity(
  value: unknown,
  expectedNumber: number,
): PullRequestMutationIdentity {
  const label = "pull request mutation identity";
  const item = cliObjectResponse(value, label);
  const number = integerField(item, "number", label, 1);
  if (number !== expectedNumber) {
    throw new Error(`GitHub returned pull request #${number} instead of #${expectedNumber}.`);
  }
  const headSha = stringField(item, "headSha", label, false);
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    responseFieldError(label, "headSha", "must be a full lowercase commit SHA");
  }
  return {
    number,
    nodeId: stringField(item, "nodeId", label, false),
    state: stringField(item, "state", label, false),
    merged: booleanField(item, "merged", label),
    headSha,
    url: stringField(item, "url", label, false),
  };
}

export function assertOpenPullRequestAtHead(
  identity: PullRequestMutationIdentity,
  expectedHeadSha: string,
): void {
  if (identity.merged || identity.state.toLowerCase() !== "open") {
    throw new Error(`Pull request #${identity.number} is not an open, unmerged pull request.`);
  }
  if (identity.headSha !== expectedHeadSha) {
    throw new Error(
      `Pull request #${identity.number} head ${identity.headSha} does not match expectedHeadSha ${expectedHeadSha}.`,
    );
  }
}

export function pullRequestMergeResult(value: unknown): PullRequestMergeResult {
  const label = "pull request merge";
  const item = cliObjectResponse(value, label);
  if (item.merged !== true) {
    throw new Error("GitHub did not confirm that the pull request was merged.");
  }
  const sha = stringField(item, "sha", label, false);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    responseFieldError(label, "sha", "must be a full lowercase commit SHA");
  }
  return {
    merged: true,
    sha,
    message: stringField(item, "message", label),
  };
}

export function assertReviewBody(event: PullRequestReviewEvent, body: string | undefined): void {
  if ((event === "COMMENT" || event === "REQUEST_CHANGES") && !body?.trim()) {
    throw new Error(`A review body is required for ${event}.`);
  }
}
