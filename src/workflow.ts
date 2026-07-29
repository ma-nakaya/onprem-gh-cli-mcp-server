const WORKFLOW_IDENTIFIER = /^(?:[1-9]\d*|[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml)$/;
const INPUT_NAME = /^[A-Za-z0-9_-]{1,100}$/;

export interface WorkflowRunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerName: string | null;
  runnerGroupName: string | null;
  labels: string[];
}

export interface WorkflowRunLogChunk {
  log: string;
  offsetBytes: number;
  limitBytes: number;
  totalBytes: number;
  returnedBytes: number;
  nextOffsetBytes: number | null;
  truncated: boolean;
  endedAtLineBoundary: boolean;
  completeness: "not_guaranteed";
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected workflow response.");
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

function positiveIntegerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    responseFieldError(label, field, "must be a positive safe integer");
  }
  return value;
}

function stringArrayField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): string[] {
  const value = item[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    responseFieldError(label, field, "must be an array of strings");
  }
  return [...value] as string[];
}

export function isWorkflowIdentifier(value: string): boolean {
  return WORKFLOW_IDENTIFIER.test(value);
}

export function assertActiveWorkflow(value: unknown, workflow: string): void {
  const item = objectResponse(value);
  if (item.state !== "active") {
    throw new Error(`Workflow ${workflow} is not active and cannot be dispatched.`);
  }
}

export function workflowSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value);
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    state: item.state,
    url: item.html_url,
  };
}

export function assertWorkflowJobIdentity(
  value: unknown,
  expectedRunId: number,
  expectedJobId: number,
): void {
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new Error("expectedRunId must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(expectedJobId) || expectedJobId < 1) {
    throw new Error("expectedJobId must be a positive safe integer.");
  }

  const label = "workflow job identity";
  const item = cliObjectResponse(value, label);
  const id = positiveIntegerField(item, "id", label);
  const runId = positiveIntegerField(item, "runId", label);
  stringField(item, "status", label, false);
  if (id !== expectedJobId) {
    throw new Error(`GitHub CLI returned workflow job ${id} when job ${expectedJobId} was requested.`);
  }
  if (runId !== expectedRunId) {
    throw new Error(
      `GitHub CLI returned workflow run ${runId} for job ${id} when run ${expectedRunId} was requested.`,
    );
  }
}

export function workflowRunJobs(value: unknown, expectedMax?: number): WorkflowRunJob[] {
  if (
    expectedMax !== undefined
    && (!Number.isSafeInteger(expectedMax) || expectedMax < 0)
  ) {
    throw new Error("The expected workflow run job count must be a non-negative safe integer.");
  }
  if (!Array.isArray(value)) {
    throw new Error("GitHub CLI returned an unexpected workflow run jobs response: expected an array.");
  }
  if (expectedMax !== undefined && value.length > expectedMax) {
    throw new Error(
      `GitHub CLI returned ${value.length} workflow run jobs, exceeding the requested maximum of ${expectedMax}.`,
    );
  }

  return value.map((entry, index) => {
    const label = `workflow run job at index ${index}`;
    const item = cliObjectResponse(entry, label);
    return {
      id: positiveIntegerField(item, "id", label),
      name: stringField(item, "name", label, false),
      status: stringField(item, "status", label, false),
      conclusion: nullableStringField(item, "conclusion", label),
      startedAt: nullableStringField(item, "startedAt", label),
      completedAt: nullableStringField(item, "completedAt", label),
      runnerName: nullableStringField(item, "runnerName", label),
      runnerGroupName: nullableStringField(item, "runnerGroupName", label),
      labels: stringArrayField(item, "labels", label),
    };
  });
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

export function workflowRunLogChunk(
  log: string,
  offsetBytes: number,
  limitBytes: number,
): WorkflowRunLogChunk {
  if (typeof log !== "string") {
    throw new Error("The workflow run log must be a string.");
  }
  safeByteOffset(offsetBytes, "offsetBytes", 0);
  safeByteOffset(limitBytes, "limitBytes", 1);

  const bytes = Buffer.from(log, "utf8");
  const totalBytes = bytes.length;
  if (offsetBytes > totalBytes) {
    throw new Error(`offsetBytes ${offsetBytes} exceeds the workflow run log size of ${totalBytes} bytes.`);
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
    log: bytes.subarray(offsetBytes, endOffsetBytes).toString("utf8"),
    offsetBytes,
    limitBytes,
    totalBytes,
    returnedBytes,
    nextOffsetBytes,
    truncated: offsetBytes > 0 || nextOffsetBytes !== null,
    endedAtLineBoundary: endOffsetBytes === totalBytes || bytes[endOffsetBytes - 1] === 0x0a,
    completeness: "not_guaranteed",
  };
}

export function normalizeWorkflowInputs(inputs: Record<string, string>): Record<string, string> {
  const entries = Object.entries(inputs);
  if (entries.length > 25) throw new Error("Workflow inputs cannot contain more than 25 entries.");
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!INPUT_NAME.test(name)) throw new Error(`Invalid workflow input name: ${name}`);
    if (value.length > 1024) throw new Error(`Workflow input ${name} exceeds 1024 characters.`);
    normalized[name] = value;
  }
  return normalized;
}
