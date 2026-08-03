export interface PullRequestReviewAuthor {
  login: string;
  type: string;
}

export interface PullRequestReview {
  id: number;
  nodeId: string;
  state: string;
  body: string;
  author: PullRequestReviewAuthor | null;
  authorAssociation: string | null;
  submittedAt: string | null;
  commitId: string | null;
  url: string;
}

export interface PullRequestReviewComment {
  id: number;
  nodeId: string;
  pullRequestReviewId: number | null;
  body: string;
  author: PullRequestReviewAuthor | null;
  authorAssociation: string | null;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  side: string | null;
  startSide: string | null;
  subjectType: string | null;
  commitId: string;
  originalCommitId: string;
  replyToId: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  pullRequestUrl: string;
}

export interface PullRequestReviewThreadComment {
  nodeId: string;
  databaseId: string | null;
  body: string;
  author: PullRequestReviewAuthor | null;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  outdated: boolean;
  state: string;
  subjectType: string;
  replyTo: Readonly<{ nodeId: string; databaseId: string | null }> | null;
  viewerCanDelete: boolean;
  viewerCanUpdate: boolean;
}

export interface PullRequestReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: string;
  startDiffSide: string | null;
  subjectType: string;
  resolvedBy: string | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: PullRequestReviewThreadComment[];
  commentsPagination: ConnectionPagination;
}

export interface ConnectionPagination {
  total: number;
  returnedCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PullRequestReviewThreadPage {
  pullRequestNodeId: string;
  threads: PullRequestReviewThread[];
  pagination: ConnectionPagination;
}

export interface InlineReviewTarget {
  subjectType: "line" | "file";
  path: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export const PULL_REQUEST_REVIEWS_JQ = "map({id: .id, nodeId: .node_id, state: .state, body: (.body // \"\"), author: (if .user == null then null else {login: .user.login, type: .user.type} end), authorAssociation: (.author_association // null), submittedAt: (.submitted_at // null), commitId: (.commit_id // null), url: .html_url})";

export const PULL_REQUEST_REVIEW_COMMENTS_JQ = "map({id: .id, nodeId: .node_id, pullRequestReviewId: (.pull_request_review_id // null), body: (.body // \"\"), author: (if .user == null then null else {login: .user.login, type: .user.type} end), authorAssociation: (.author_association // null), path: .path, line: (.line // null), originalLine: (.original_line // null), startLine: (.start_line // null), originalStartLine: (.original_start_line // null), side: (.side // null), startSide: (.start_side // null), subjectType: (.subject_type // null), commitId: .commit_id, originalCommitId: .original_commit_id, replyToId: (.in_reply_to_id // null), createdAt: .created_at, updatedAt: .updated_at, url: .html_url, pullRequestUrl: .pull_request_url})";

export const PULL_REQUEST_REVIEW_COMMENT_JQ = "{id: .id, nodeId: .node_id, pullRequestReviewId: (.pull_request_review_id // null), body: (.body // \"\"), author: (if .user == null then null else {login: .user.login, type: .user.type} end), authorAssociation: (.author_association // null), path: .path, line: (.line // null), originalLine: (.original_line // null), startLine: (.start_line // null), originalStartLine: (.original_start_line // null), side: (.side // null), startSide: (.start_side // null), subjectType: (.subject_type // null), commitId: .commit_id, originalCommitId: .original_commit_id, replyToId: (.in_reply_to_id // null), createdAt: .created_at, updatedAt: .updated_at, url: .html_url, pullRequestUrl: .pull_request_url}";

const REVIEW_THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  isCollapsed
  path
  line
  originalLine
  startLine
  originalStartLine
  diffSide
  startDiffSide
  subjectType
  resolvedBy { login }
  viewerCanReply
  viewerCanResolve
  viewerCanUnresolve
`;

const REVIEW_THREAD_COMMENT_FIELDS = `
  id
  fullDatabaseId
  body
  author { login __typename }
  authorAssociation
  createdAt
  updatedAt
  url
  path
  line
  originalLine
  startLine
  originalStartLine
  outdated
  state
  subjectType
  replyTo { id fullDatabaseId }
  viewerCanDelete
  viewerCanUpdate
`;

export const LIST_PULL_REQUEST_REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String, $commentsFirst: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      id
      number
      reviewThreads(first: $first, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          ${REVIEW_THREAD_FIELDS}
          comments(first: $commentsFirst) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { ${REVIEW_THREAD_COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

export const GET_PULL_REQUEST_REVIEW_THREAD_QUERY = `
query($threadId: ID!, $commentsFirst: Int!, $commentsAfter: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      ${REVIEW_THREAD_FIELDS}
      repository { nameWithOwner }
      pullRequest { id number }
      comments(first: $commentsFirst, after: $commentsAfter) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_THREAD_COMMENT_FIELDS} }
      }
    }
  }
}`;

export const RESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!, $clientMutationId: String!) {
  resolveReviewThread(input: {threadId: $threadId, clientMutationId: $clientMutationId}) {
    thread { id isResolved viewerCanResolve viewerCanUnresolve }
  }
}`;

export const UNRESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!, $clientMutationId: String!) {
  unresolveReviewThread(input: {threadId: $threadId, clientMutationId: $clientMutationId}) {
    thread { id isResolved viewerCanResolve viewerCanUnresolve }
  }
}`;

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

function integerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
  minimum = 0,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fieldError(label, field, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function nullableIntegerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): number | null {
  const value = item[field];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    fieldError(label, field, "must be a non-negative safe integer or null");
  }
  return value;
}

function author(value: unknown, label: string): PullRequestReviewAuthor | null {
  if (value === null) return null;
  const item = objectResponse(value, label);
  return {
    login: stringField(item, "login", label, false),
    type: stringField(item, "type", label, false),
  };
}

function graphqlAuthor(value: unknown, label: string): PullRequestReviewAuthor | null {
  if (value === null) return null;
  const item = objectResponse(value, label);
  return {
    login: stringField(item, "login", label, false),
    type: stringField(item, "__typename", label, false),
  };
}

function assertMaximum(value: unknown[], maximum: number | undefined, label: string): void {
  if (maximum !== undefined && value.length > maximum) {
    throw new Error(`GitHub API returned ${value.length} ${label}, exceeding the requested maximum of ${maximum}.`);
  }
}

export function pullRequestReviews(value: unknown, maximum?: number): PullRequestReview[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected pull request reviews response: expected an array.");
  }
  assertMaximum(value, maximum, "pull request reviews");
  return value.map((entry, index) => {
    const label = `pull request review at index ${index}`;
    const item = objectResponse(entry, label);
    return {
      id: integerField(item, "id", label, 1),
      nodeId: stringField(item, "nodeId", label, false),
      state: stringField(item, "state", label, false),
      body: stringField(item, "body", label),
      author: author(item.author, `${label} author`),
      authorAssociation: nullableStringField(item, "authorAssociation", label),
      submittedAt: nullableStringField(item, "submittedAt", label),
      commitId: nullableStringField(item, "commitId", label),
      url: stringField(item, "url", label, false),
    };
  });
}

function pullRequestReviewCommentItem(
  value: unknown,
  label: string,
): PullRequestReviewComment {
  const item = objectResponse(value, label);
  return {
    id: integerField(item, "id", label, 1),
    nodeId: stringField(item, "nodeId", label, false),
    pullRequestReviewId: nullableIntegerField(item, "pullRequestReviewId", label),
    body: stringField(item, "body", label),
    author: author(item.author, `${label} author`),
    authorAssociation: nullableStringField(item, "authorAssociation", label),
    path: stringField(item, "path", label, false),
    line: nullableIntegerField(item, "line", label),
    originalLine: nullableIntegerField(item, "originalLine", label),
    startLine: nullableIntegerField(item, "startLine", label),
    originalStartLine: nullableIntegerField(item, "originalStartLine", label),
    side: nullableStringField(item, "side", label),
    startSide: nullableStringField(item, "startSide", label),
    subjectType: nullableStringField(item, "subjectType", label),
    commitId: stringField(item, "commitId", label, false),
    originalCommitId: stringField(item, "originalCommitId", label, false),
    replyToId: nullableIntegerField(item, "replyToId", label),
    createdAt: stringField(item, "createdAt", label, false),
    updatedAt: stringField(item, "updatedAt", label, false),
    url: stringField(item, "url", label, false),
    pullRequestUrl: stringField(item, "pullRequestUrl", label, false),
  };
}

export function pullRequestReviewComments(
  value: unknown,
  maximum?: number,
): PullRequestReviewComment[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected pull request review comments response: expected an array.");
  }
  assertMaximum(value, maximum, "pull request review comments");
  return value.map((entry, index) => pullRequestReviewCommentItem(
    entry,
    `pull request review comment at index ${index}`,
  ));
}

export function pullRequestReviewComment(value: unknown): PullRequestReviewComment {
  return pullRequestReviewCommentItem(value, "pull request review comment");
}

export function assertReviewCommentPullRequest(
  comment: PullRequestReviewComment,
  repository: string,
  pullRequestNumber: number,
): void {
  let pathname: string;
  try {
    pathname = new URL(comment.pullRequestUrl).pathname;
  } catch {
    throw new Error("GitHub API returned a review comment with an invalid pull request URL.");
  }
  const expectedSuffix = `/repos/${repository}/pulls/${pullRequestNumber}`.toLowerCase();
  if (!pathname.toLowerCase().endsWith(expectedSuffix)) {
    throw new Error(
      `Review comment ${comment.id} does not belong to ${repository} pull request #${pullRequestNumber}.`,
    );
  }
}

function connectionPagination(
  value: unknown,
  returnedCount: number,
  label: string,
): ConnectionPagination {
  const item = objectResponse(value, label);
  const pageInfo = objectResponse(item.pageInfo, `${label} page info`);
  return {
    total: integerField(item, "totalCount", label),
    returnedCount,
    hasNextPage: booleanField(pageInfo, "hasNextPage", `${label} page info`),
    endCursor: nullableStringField(pageInfo, "endCursor", `${label} page info`),
  };
}

function databaseId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error(`GitHub API returned an unexpected ${label}: database ID must be a positive integer string or null.`);
}

function reviewThreadComment(value: unknown, index: number): PullRequestReviewThreadComment {
  const label = `review thread comment at index ${index}`;
  const item = objectResponse(value, label);
  const replyValue = item.replyTo;
  let replyTo: PullRequestReviewThreadComment["replyTo"] = null;
  if (replyValue !== null) {
    const reply = objectResponse(replyValue, `${label} reply target`);
    replyTo = {
      nodeId: stringField(reply, "id", `${label} reply target`, false),
      databaseId: databaseId(reply.fullDatabaseId, `${label} reply target`),
    };
  }
  return {
    nodeId: stringField(item, "id", label, false),
    databaseId: databaseId(item.fullDatabaseId, label),
    body: stringField(item, "body", label),
    author: graphqlAuthor(item.author, `${label} author`),
    authorAssociation: stringField(item, "authorAssociation", label, false),
    createdAt: stringField(item, "createdAt", label, false),
    updatedAt: stringField(item, "updatedAt", label, false),
    url: stringField(item, "url", label, false),
    path: stringField(item, "path", label, false),
    line: nullableIntegerField(item, "line", label),
    originalLine: nullableIntegerField(item, "originalLine", label),
    startLine: nullableIntegerField(item, "startLine", label),
    originalStartLine: nullableIntegerField(item, "originalStartLine", label),
    outdated: booleanField(item, "outdated", label),
    state: stringField(item, "state", label, false),
    subjectType: stringField(item, "subjectType", label, false),
    replyTo,
    viewerCanDelete: booleanField(item, "viewerCanDelete", label),
    viewerCanUpdate: booleanField(item, "viewerCanUpdate", label),
  };
}

function reviewThread(value: unknown, index: number, maximumComments?: number): PullRequestReviewThread {
  const label = `pull request review thread at index ${index}`;
  const item = objectResponse(value, label);
  const commentsConnection = objectResponse(item.comments, `${label} comments`);
  if (!Array.isArray(commentsConnection.nodes)) {
    fieldError(`${label} comments`, "nodes", "must be an array");
  }
  assertMaximum(commentsConnection.nodes, maximumComments, "review thread comments");
  const comments = commentsConnection.nodes.map(reviewThreadComment);
  const resolvedByValue = item.resolvedBy;
  const resolvedBy = resolvedByValue === null
    ? null
    : stringField(objectResponse(resolvedByValue, `${label} resolver`), "login", `${label} resolver`, false);
  return {
    id: stringField(item, "id", label, false),
    isResolved: booleanField(item, "isResolved", label),
    isOutdated: booleanField(item, "isOutdated", label),
    isCollapsed: booleanField(item, "isCollapsed", label),
    path: stringField(item, "path", label, false),
    line: nullableIntegerField(item, "line", label),
    originalLine: nullableIntegerField(item, "originalLine", label),
    startLine: nullableIntegerField(item, "startLine", label),
    originalStartLine: nullableIntegerField(item, "originalStartLine", label),
    diffSide: stringField(item, "diffSide", label, false),
    startDiffSide: nullableStringField(item, "startDiffSide", label),
    subjectType: stringField(item, "subjectType", label, false),
    resolvedBy,
    viewerCanReply: booleanField(item, "viewerCanReply", label),
    viewerCanResolve: booleanField(item, "viewerCanResolve", label),
    viewerCanUnresolve: booleanField(item, "viewerCanUnresolve", label),
    comments,
    commentsPagination: connectionPagination(
      commentsConnection,
      comments.length,
      `${label} comments`,
    ),
  };
}

function assertRepositoryAndPullRequest(
  repositoryValue: unknown,
  pullRequestValue: unknown,
  expectedRepository: string,
  expectedPullRequestNumber: number,
): Readonly<{ repository: Record<string, unknown>; pullRequest: Record<string, unknown> }> {
  const repository = objectResponse(repositoryValue, "review thread repository");
  const returnedRepository = stringField(repository, "nameWithOwner", "review thread repository", false);
  if (returnedRepository.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error(`GitHub returned review threads for ${returnedRepository} instead of ${expectedRepository}.`);
  }
  const pullRequest = objectResponse(pullRequestValue, "review thread pull request");
  const returnedNumber = integerField(pullRequest, "number", "review thread pull request", 1);
  if (returnedNumber !== expectedPullRequestNumber) {
    throw new Error(`GitHub returned review threads for pull request #${returnedNumber} instead of #${expectedPullRequestNumber}.`);
  }
  return { repository, pullRequest };
}

export function pullRequestReviewThreadsPage(
  value: unknown,
  expectedRepository: string,
  expectedPullRequestNumber: number,
  maximumThreads: number,
  maximumComments: number,
): PullRequestReviewThreadPage {
  const root = objectResponse(value, "GraphQL response");
  const data = objectResponse(root.data, "GraphQL data");
  const checked = assertRepositoryAndPullRequest(
    data.repository,
    objectResponse(data.repository, "review thread repository").pullRequest,
    expectedRepository,
    expectedPullRequestNumber,
  );
  const connection = objectResponse(checked.pullRequest.reviewThreads, "review thread connection");
  if (!Array.isArray(connection.nodes)) fieldError("review thread connection", "nodes", "must be an array");
  assertMaximum(connection.nodes, maximumThreads, "pull request review threads");
  const threads = connection.nodes.map((entry, index) => reviewThread(entry, index, maximumComments));
  return {
    pullRequestNodeId: stringField(checked.pullRequest, "id", "review thread pull request", false),
    threads,
    pagination: connectionPagination(connection, threads.length, "review thread connection"),
  };
}

export function pullRequestReviewThreadDetails(
  value: unknown,
  expectedRepository: string,
  expectedPullRequestNumber: number,
  expectedThreadId: string,
  maximumComments: number,
): PullRequestReviewThread {
  const root = objectResponse(value, "GraphQL response");
  const data = objectResponse(root.data, "GraphQL data");
  const node = objectResponse(data.node, "review thread node");
  const repository = objectResponse(node.repository, "review thread repository");
  const pullRequest = objectResponse(node.pullRequest, "review thread pull request");
  assertRepositoryAndPullRequest(
    repository,
    pullRequest,
    expectedRepository,
    expectedPullRequestNumber,
  );
  const thread = reviewThread(node, 0, maximumComments);
  if (thread.id !== expectedThreadId) {
    throw new Error(`GitHub returned review thread ${thread.id} instead of ${expectedThreadId}.`);
  }
  return thread;
}

export function reviewThreadMutationSummary(
  value: unknown,
  mutationName: "resolveReviewThread" | "unresolveReviewThread",
  expectedThreadId: string,
  expectedResolved: boolean,
): Readonly<{
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
}> {
  const root = objectResponse(value, "GraphQL response");
  const data = objectResponse(root.data, "GraphQL data");
  const mutation = objectResponse(data[mutationName], mutationName);
  const thread = objectResponse(mutation.thread, `${mutationName} thread`);
  const id = stringField(thread, "id", `${mutationName} thread`, false);
  const isResolved = booleanField(thread, "isResolved", `${mutationName} thread`);
  if (id !== expectedThreadId || isResolved !== expectedResolved) {
    throw new Error(`GitHub returned an unexpected ${mutationName} result.`);
  }
  return {
    id,
    isResolved,
    viewerCanResolve: booleanField(thread, "viewerCanResolve", `${mutationName} thread`),
    viewerCanUnresolve: booleanField(thread, "viewerCanUnresolve", `${mutationName} thread`),
  };
}

export function assertInlineReviewTarget(target: InlineReviewTarget): void {
  if (
    target.path.length === 0
    || target.path.trim() !== target.path
    || target.path.startsWith("/")
    || target.path.endsWith("/")
    || target.path.includes("\\")
    || /[\0\r\n]/.test(target.path)
    || target.path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error("Review comment path must be a normalized relative repository path.");
  }
  if (target.subjectType === "file") {
    if (
      target.line !== undefined
      || target.side !== undefined
      || target.startLine !== undefined
      || target.startSide !== undefined
    ) {
      throw new Error("File-level review comments must not specify line or side fields.");
    }
    return;
  }
  if (target.line === undefined || target.side === undefined) {
    throw new Error("Line-level review comments require line and side.");
  }
  if (!Number.isSafeInteger(target.line) || target.line <= 0) {
    throw new Error("Review comment line must be a positive safe integer.");
  }
  const hasStartLine = target.startLine !== undefined;
  const hasStartSide = target.startSide !== undefined;
  if (hasStartLine !== hasStartSide) {
    throw new Error("Multi-line review comments require both startLine and startSide.");
  }
  if (target.startLine !== undefined) {
    if (!Number.isSafeInteger(target.startLine) || target.startLine <= 0) {
      throw new Error("Review comment startLine must be a positive safe integer.");
    }
    if (target.startSide === target.side && target.startLine > target.line) {
      throw new Error("Review comment startLine must not exceed line on the same diff side.");
    }
  }
}
