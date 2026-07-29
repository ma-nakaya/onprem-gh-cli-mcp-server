export interface IssueAuthor {
  login: string;
  isBot: boolean;
  name: string | null;
}

export interface IssueAssignee {
  login: string;
  name: string | null;
}

export interface IssueLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueMilestone {
  number: number;
  title: string;
  dueOn: string | null;
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string;
  author: IssueAuthor | null;
  assignees: IssueAssignee[];
  labels: IssueLabel[];
  milestone: IssueMilestone | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
}

export interface IssueActor {
  login: string;
  type: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: IssueActor | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface IssueEventLabel {
  name: string | null;
  color: string | null;
}

export interface IssueEventMilestone {
  title: string;
}

export interface IssueEventRename {
  from: string;
  to: string;
}

export interface IssueEvent {
  id: number;
  event: string;
  actor: IssueActor | null;
  createdAt: string;
  commitId: string | null;
  label: IssueEventLabel | null;
  assignee: IssueActor | null;
  assigner: IssueActor | null;
  milestone: IssueEventMilestone | null;
  rename: IssueEventRename | null;
  lockReason: string | null;
}

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub CLI returned an unexpected ${label} response: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function fieldError(label: string, field: string, expectation: string): never {
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
    fieldError(label, field, allowEmpty ? "must be a string" : "must be a non-empty string");
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
    fieldError(label, field, "must be a string or null");
  }
  return value;
}

function optionalNullableStringField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): string | null {
  const value = item[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fieldError(label, field, "must be a string, null, or omitted");
  return value;
}

function booleanField(item: Record<string, unknown>, field: string, label: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") fieldError(label, field, "must be a boolean");
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
    fieldError(label, field, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function arrayField(item: Record<string, unknown>, field: string, label: string): unknown[] {
  const value = item[field];
  if (!Array.isArray(value)) fieldError(label, field, "must be an array");
  return value;
}

function issueAuthor(value: unknown): IssueAuthor | null {
  if (value === null) return null;
  const author = objectResponse(value, "issue author");
  return {
    login: stringField(author, "login", "issue author", false),
    isBot: booleanField(author, "is_bot", "issue author"),
    name: optionalNullableStringField(author, "name", "issue author"),
  };
}

function issueAssignee(value: unknown, index: number): IssueAssignee {
  const label = `issue assignee at index ${index}`;
  const assignee = objectResponse(value, label);
  return {
    login: stringField(assignee, "login", label, false),
    name: optionalNullableStringField(assignee, "name", label),
  };
}

function issueLabel(value: unknown, index: number): IssueLabel {
  const label = `issue label at index ${index}`;
  const item = objectResponse(value, label);
  return {
    name: stringField(item, "name", label, false),
    color: stringField(item, "color", label),
    description: nullableStringField(item, "description", label),
  };
}

function issueMilestone(value: unknown): IssueMilestone | null {
  if (value === null) return null;
  const milestone = objectResponse(value, "issue milestone");
  return {
    number: integerField(milestone, "number", "issue milestone", 1),
    title: stringField(milestone, "title", "issue milestone", false),
    dueOn: nullableStringField(milestone, "dueOn", "issue milestone"),
  };
}

export function issueDetails(value: unknown): IssueDetails {
  const item = objectResponse(value, "issue details");
  return {
    number: integerField(item, "number", "issue details", 1),
    title: stringField(item, "title", "issue details"),
    body: stringField(item, "body", "issue details"),
    state: stringField(item, "state", "issue details", false),
    stateReason: stringField(item, "stateReason", "issue details"),
    author: issueAuthor(item.author),
    assignees: arrayField(item, "assignees", "issue details").map(issueAssignee),
    labels: arrayField(item, "labels", "issue details").map(issueLabel),
    milestone: issueMilestone(item.milestone),
    createdAt: stringField(item, "createdAt", "issue details", false),
    updatedAt: stringField(item, "updatedAt", "issue details", false),
    closedAt: nullableStringField(item, "closedAt", "issue details"),
    url: stringField(item, "url", "issue details", false),
  };
}

function expectedPageMaximum(expectedMax: number | undefined, label: string): void {
  if (
    expectedMax !== undefined
    && (!Number.isSafeInteger(expectedMax) || expectedMax < 0)
  ) {
    throw new Error(`The expected ${label} count must be a non-negative safe integer.`);
  }
}

function pageArray(value: unknown, expectedMax: number | undefined, label: string): unknown[] {
  expectedPageMaximum(expectedMax, label);
  if (!Array.isArray(value)) {
    throw new Error(`GitHub CLI returned an unexpected ${label} response: expected an array.`);
  }
  if (expectedMax !== undefined && value.length > expectedMax) {
    throw new Error(
      `GitHub CLI returned ${value.length} ${label}, exceeding the requested maximum of ${expectedMax}.`,
    );
  }
  return value;
}

function optionalActor(value: unknown, label: string): IssueActor | null {
  if (value === undefined || value === null) return null;
  const actor = objectResponse(value, label);
  return {
    login: stringField(actor, "login", label, false),
    type: stringField(actor, "type", label, false),
  };
}

export function issueComments(value: unknown, expectedMax?: number): IssueComment[] {
  return pageArray(value, expectedMax, "issue comments").map((entry, index) => {
    const label = `issue comment at index ${index}`;
    const item = objectResponse(entry, label);
    return {
      id: integerField(item, "id", label, 1),
      body: stringField(item, "body", label),
      author: optionalActor(item.author, `${label} author`),
      createdAt: stringField(item, "createdAt", label, false),
      updatedAt: stringField(item, "updatedAt", label, false),
      url: stringField(item, "url", label, false),
    };
  });
}

function optionalEventLabel(value: unknown, label: string): IssueEventLabel | null {
  if (value === undefined || value === null) return null;
  const item = objectResponse(value, label);
  return {
    name: optionalNullableStringField(item, "name", label),
    color: optionalNullableStringField(item, "color", label),
  };
}

function optionalEventMilestone(value: unknown, label: string): IssueEventMilestone | null {
  if (value === undefined || value === null) return null;
  const item = objectResponse(value, label);
  return { title: stringField(item, "title", label, false) };
}

function optionalEventRename(value: unknown, label: string): IssueEventRename | null {
  if (value === undefined || value === null) return null;
  const item = objectResponse(value, label);
  return {
    from: stringField(item, "from", label),
    to: stringField(item, "to", label),
  };
}

export function issueEvents(value: unknown, expectedMax?: number): IssueEvent[] {
  return pageArray(value, expectedMax, "issue events").map((entry, index) => {
    const label = `issue event at index ${index}`;
    const item = objectResponse(entry, label);
    return {
      id: integerField(item, "id", label, 1),
      event: stringField(item, "event", label, false),
      actor: optionalActor(item.actor, `${label} actor`),
      createdAt: stringField(item, "createdAt", label, false),
      commitId: optionalNullableStringField(item, "commitId", label),
      label: optionalEventLabel(item.label, `${label} label`),
      assignee: optionalActor(item.assignee, `${label} assignee`),
      assigner: optionalActor(item.assigner, `${label} assigner`),
      milestone: optionalEventMilestone(item.milestone, `${label} milestone`),
      rename: optionalEventRename(item.rename, `${label} rename`),
      lockReason: optionalNullableStringField(item, "lockReason", label),
    };
  });
}
