export interface PullRequestCommentAuthor {
  login: string;
  type: string;
}

export interface PullRequestComment {
  id: number;
  nodeId: string;
  body: string;
  author: PullRequestCommentAuthor | null;
  authorAssociation: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  issueUrl: string;
}

export const PULL_REQUEST_COMMENTS_JQ = "if type == \"array\" then map({id: .id, nodeId: .node_id, body: (.body // \"\"), author: (if .user == null then null else {login: .user.login, type: .user.type} end), authorAssociation: (.author_association // null), createdAt: .created_at, updatedAt: .updated_at, url: .html_url, issueUrl: .issue_url}) else null end";

export const PULL_REQUEST_COMMENT_JQ = "{id: .id, nodeId: .node_id, body: (.body // \"\"), author: (if .user == null then null else {login: .user.login, type: .user.type} end), authorAssociation: (.author_association // null), createdAt: .created_at, updatedAt: .updated_at, url: .html_url, issueUrl: .issue_url}";

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

function commentAuthor(value: unknown, label: string): PullRequestCommentAuthor | null {
  if (value === null) return null;
  const item = objectResponse(value, label);
  return {
    login: stringField(item, "login", label, false),
    type: stringField(item, "type", label, false),
  };
}

function pullRequestCommentItem(value: unknown, label: string): PullRequestComment {
  const item = objectResponse(value, label);
  return {
    id: positiveIntegerField(item, "id", label),
    nodeId: stringField(item, "nodeId", label, false),
    body: stringField(item, "body", label),
    author: commentAuthor(item.author, `${label} author`),
    authorAssociation: nullableStringField(item, "authorAssociation", label),
    createdAt: stringField(item, "createdAt", label, false),
    updatedAt: stringField(item, "updatedAt", label, false),
    url: stringField(item, "url", label, false),
    issueUrl: stringField(item, "issueUrl", label, false),
  };
}

export function pullRequestComments(value: unknown, maximum?: number): PullRequestComment[] {
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
    throw new Error("The expected pull request comment count must be a non-negative safe integer.");
  }
  if (!Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected pull request comments response: expected an array.");
  }
  if (maximum !== undefined && value.length > maximum) {
    throw new Error(
      `GitHub API returned ${value.length} pull request comments, exceeding the requested maximum of ${maximum}.`,
    );
  }
  return value.map((entry, index) => pullRequestCommentItem(
    entry,
    `pull request comment at index ${index}`,
  ));
}

export function pullRequestComment(value: unknown): PullRequestComment {
  return pullRequestCommentItem(value, "pull request comment");
}

export function assertCommentPullRequest(
  comment: PullRequestComment,
  repository: string,
  pullRequestNumber: number,
  githubHostname: string,
): void {
  let issueUrl: URL;
  try {
    issueUrl = new URL(comment.issueUrl);
  } catch {
    throw new Error("GitHub API returned a pull request comment with an invalid issue URL.");
  }
  const normalizedHostname = githubHostname.toLowerCase();
  const expectedApiHostname = normalizedHostname === "github.com"
    ? "api.github.com"
    : normalizedHostname;
  const expectedPathname = normalizedHostname === "github.com"
    ? `/repos/${repository}/issues/${pullRequestNumber}`
    : `/api/v3/repos/${repository}/issues/${pullRequestNumber}`;
  if (
    issueUrl.protocol !== "https:"
    || issueUrl.hostname.toLowerCase() !== expectedApiHostname
    || issueUrl.port !== ""
    || issueUrl.username !== ""
    || issueUrl.password !== ""
    || issueUrl.search !== ""
    || issueUrl.hash !== ""
    || issueUrl.pathname.toLowerCase() !== expectedPathname.toLowerCase()
  ) {
    throw new Error(
      `Pull request comment ${comment.id} does not belong to ${repository} pull request #${pullRequestNumber}.`,
    );
  }
}
