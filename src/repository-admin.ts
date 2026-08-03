export interface RepositoryDetails {
  id: number;
  nodeId: string;
  fullName: string;
  name: string;
  owner: Readonly<{ login: string; type: string }>;
  description: string | null;
  visibility: string;
  isPrivate: boolean;
  isArchived: boolean;
  isDisabled: boolean;
  isFork: boolean;
  defaultBranch: string | null;
  hasIssues: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  url: string;
}

export interface RepositoryOwnerIdentity {
  login: string;
  type: "User" | "Organization";
}

export const REPOSITORY_DETAILS_JQ = "{id: .id, nodeId: .node_id, fullName: .full_name, name: .name, owner: {login: .owner.login, type: .owner.type}, description: (.description // null), visibility: (.visibility // (if .private then \"private\" else \"public\" end)), isPrivate: .private, isArchived: .archived, isDisabled: .disabled, isFork: .fork, defaultBranch: (.default_branch // null), hasIssues: .has_issues, createdAt: .created_at, updatedAt: .updated_at, pushedAt: (.pushed_at // null), url: .html_url}";

export const REPOSITORY_OWNER_IDENTITY_JQ = "{login: .login, type: .type}";

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API returned an unexpected ${label} response.`);
  }
  return value as Record<string, unknown>;
}

function fieldError(label: string, field: string, expectation: string): never {
  throw new Error(`GitHub API returned an unexpected ${label} response: "${field}" ${expectation}.`);
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

function booleanField(item: Record<string, unknown>, field: string, label: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") fieldError(label, field, "must be a boolean");
  return value;
}

function positiveIntegerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fieldError(label, field, "must be a positive safe integer");
  }
  return value;
}

export function repositoryDetails(value: unknown): RepositoryDetails {
  const label = "repository";
  const item = objectResponse(value, label);
  const owner = objectResponse(item.owner, "repository owner");
  return {
    id: positiveIntegerField(item, "id", label),
    nodeId: stringField(item, "nodeId", label, false),
    fullName: stringField(item, "fullName", label, false),
    name: stringField(item, "name", label, false),
    owner: {
      login: stringField(owner, "login", "repository owner", false),
      type: stringField(owner, "type", "repository owner", false),
    },
    description: nullableStringField(item, "description", label),
    visibility: stringField(item, "visibility", label, false),
    isPrivate: booleanField(item, "isPrivate", label),
    isArchived: booleanField(item, "isArchived", label),
    isDisabled: booleanField(item, "isDisabled", label),
    isFork: booleanField(item, "isFork", label),
    defaultBranch: nullableStringField(item, "defaultBranch", label),
    hasIssues: booleanField(item, "hasIssues", label),
    createdAt: stringField(item, "createdAt", label, false),
    updatedAt: stringField(item, "updatedAt", label, false),
    pushedAt: nullableStringField(item, "pushedAt", label),
    url: stringField(item, "url", label, false),
  };
}

export function assertRepositoryIdentity(
  details: RepositoryDetails,
  expectedFullName: string,
  expectedId?: number,
): void {
  if (details.fullName.toLowerCase() !== expectedFullName.toLowerCase()) {
    throw new Error(
      `GitHub returned repository ${details.fullName} instead of ${expectedFullName}; repository redirects are not allowed.`,
    );
  }
  if (expectedId !== undefined && details.id !== expectedId) {
    throw new Error(
      `Repository ID ${details.id} does not match expectedRepositoryId ${expectedId}; refusing the operation.`,
    );
  }
}

export function repositoryOwnerIdentity(value: unknown): RepositoryOwnerIdentity {
  const label = "repository owner";
  const item = objectResponse(value, label);
  const type = stringField(item, "type", label, false);
  if (type !== "User" && type !== "Organization") {
    throw new Error(`GitHub returned unsupported repository owner type: ${type}.`);
  }
  return {
    login: stringField(item, "login", label, false),
    type,
  };
}

export function assertCreatedRepository(
  details: RepositoryDetails,
  expectedOwner: string,
  expectedName: string,
  expectedVisibility: "private" | "public" | "internal",
): void {
  const expectedFullName = `${expectedOwner}/${expectedName}`;
  assertRepositoryIdentity(details, expectedFullName);
  if (details.visibility.toLowerCase() !== expectedVisibility) {
    throw new Error(
      `GitHub created ${details.fullName} with visibility ${details.visibility} instead of ${expectedVisibility}.`,
    );
  }
  if ((expectedVisibility !== "public") !== details.isPrivate) {
    throw new Error(`GitHub returned inconsistent privacy metadata for ${details.fullName}.`);
  }
}
