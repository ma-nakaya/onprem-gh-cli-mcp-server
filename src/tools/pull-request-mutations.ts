import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runGh } from "../gh-runner.js";
import { assertRepositoryAllowed } from "../policy.js";
import {
  assertOpenPullRequestAtHead,
  assertReviewBody,
  pullRequestMergeResult,
  pullRequestReviewSummary,
  pullRequestSummary,
} from "../pull-request.js";
import {
  GET_PULL_REQUEST_REVIEW_THREAD_QUERY,
  PULL_REQUEST_REVIEW_COMMENT_JQ,
  RESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION,
  UNRESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION,
  assertInlineReviewTarget,
  assertReviewCommentPullRequest,
  pullRequestReviewComment,
  pullRequestReviewThreadDetails,
  reviewThreadMutationSummary,
} from "../pull-request-review.js";
import {
  REPOSITORY_CONTENT_TRUST,
  assertPullRequest,
  auditedGraphqlGh,
  auditedJsonGh,
  auditedOperation,
  buildContextSchemas,
  buildSharedSchemas,
  commentSummary,
  jsonGh,
  prepareWriteRequest,
  pullRequestSource,
  readGraphqlGh,
  resolveCanonicalRepository,
  resolvePullRequestMutationIdentity,
  response,
  responseWithinOutputLimit,
} from "../server-support.js";

export function registerPullRequestMutationTools(server: McpServer, config: Config): void {
  const { writeContextSchema } = buildContextSchemas(config);
  const {
    commitShaSchema, gitRefSchema, repositoryPathSchema,
    reviewCommentIdSchema, reviewThreadIdSchema,
  } = buildSharedSchemas();
  const pullRequestNumberSchema = z.number().int().positive();

server.registerTool("create_pull_request_review_comment", {
  description: "Create an inline line- or file-level review comment on the exact expected pull request head SHA. The body is sent through stdin and is not audited.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    expectedHeadSha: commitShaSchema,
    body: z.string().min(1).max(65_536),
    path: repositoryPathSchema,
    subjectType: z.enum(["line", "file"]).default("line"),
    line: z.number().int().positive().optional(),
    side: z.enum(["LEFT", "RIGHT"]).optional(),
    startLine: z.number().int().positive().optional(),
    startSide: z.enum(["LEFT", "RIGHT"]).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, hostname, repository, pullRequestNumber, expectedHeadSha, body, path, subjectType, line, side, startLine, startSide }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "create_pull_request_review_comment",
    repository: normalizedRepository,
    pullRequestNumber,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const identity = await resolvePullRequestMutationIdentity(
    config,
    context,
    canonicalRepository,
    pullRequestNumber,
  );
  assertOpenPullRequestAtHead(identity, expectedHeadSha);
  assertInlineReviewTarget({ subjectType, path, line, side, startLine, startSide });
  const payload: Record<string, unknown> = {
    body,
    commit_id: expectedHeadSha,
    path,
    subject_type: subjectType,
  };
  if (line !== undefined) payload.line = line;
  if (side !== undefined) payload.side = side;
  if (startLine !== undefined) payload.start_line = startLine;
  if (startSide !== undefined) payload.start_side = startSide;
  const operation = await auditedJsonGh(
    request,
    [
      "api",
      `repos/${canonicalRepository}/pulls/${pullRequestNumber}/comments`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "POST",
      "--input",
      "-",
      "--jq",
      PULL_REQUEST_REVIEW_COMMENT_JQ,
    ],
    payload,
    config,
    (value) => ({ reviewCommentId: pullRequestReviewComment(value).id }),
  );
  const comment = pullRequestReviewComment(operation.value);
  assertReviewCommentPullRequest(comment, canonicalRepository, pullRequestNumber);
  return responseWithinOutputLimit({
    comment,
    audit: operation.audit,
    source: pullRequestSource(context, canonicalRepository, pullRequestNumber),
    contentTrust: REPOSITORY_CONTENT_TRUST,
  }, config);
});

server.registerTool("reply_pull_request_review_comment", {
  description: "Reply to a top-level inline review comment after verifying that it belongs to the requested pull request. The body is sent through stdin and is not audited.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    reviewCommentId: reviewCommentIdSchema,
    body: z.string().min(1).max(65_536),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, hostname, repository, pullRequestNumber, reviewCommentId, body }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "reply_pull_request_review_comment",
    repository: normalizedRepository,
    pullRequestNumber,
    reviewCommentId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  await resolvePullRequestMutationIdentity(config, context, canonicalRepository, pullRequestNumber);
  const parentValue = await jsonGh([
    "api",
    `repos/${canonicalRepository}/pulls/comments/${reviewCommentId}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    PULL_REQUEST_REVIEW_COMMENT_JQ,
  ], config, context);
  const parent = pullRequestReviewComment(parentValue);
  if (parent.id !== reviewCommentId) {
    throw new Error(`GitHub returned review comment ${parent.id} instead of ${reviewCommentId}.`);
  }
  assertReviewCommentPullRequest(parent, canonicalRepository, pullRequestNumber);
  if (parent.replyToId !== null) {
    throw new Error("GitHub only supports replies to a top-level review comment, not replies to replies.");
  }
  const operation = await auditedJsonGh(
    request,
    [
      "api",
      `repos/${canonicalRepository}/pulls/${pullRequestNumber}/comments/${reviewCommentId}/replies`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "POST",
      "--input",
      "-",
      "--jq",
      PULL_REQUEST_REVIEW_COMMENT_JQ,
    ],
    { body },
    config,
    (value) => ({ reviewCommentId: pullRequestReviewComment(value).id }),
  );
  const comment = pullRequestReviewComment(operation.value);
  assertReviewCommentPullRequest(comment, canonicalRepository, pullRequestNumber);
  return responseWithinOutputLimit({
    comment,
    audit: operation.audit,
    source: pullRequestSource(context, canonicalRepository, pullRequestNumber),
    contentTrust: REPOSITORY_CONTENT_TRUST,
  }, config);
});

server.registerTool("update_pull_request_review_comment", {
  description: "Edit an inline review comment body with an expected updatedAt concurrency check. The body is sent through stdin and is not audited.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    reviewCommentId: reviewCommentIdSchema,
    expectedUpdatedAt: z.string().min(1).max(64),
    body: z.string().min(1).max(65_536),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, repository, pullRequestNumber, reviewCommentId, expectedUpdatedAt, body }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "update_pull_request_review_comment",
    repository: normalizedRepository,
    pullRequestNumber,
    reviewCommentId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const beforeValue = await jsonGh([
    "api",
    `repos/${canonicalRepository}/pulls/comments/${reviewCommentId}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    PULL_REQUEST_REVIEW_COMMENT_JQ,
  ], config, context);
  const before = pullRequestReviewComment(beforeValue);
  if (before.id !== reviewCommentId) {
    throw new Error(`GitHub returned review comment ${before.id} instead of ${reviewCommentId}.`);
  }
  assertReviewCommentPullRequest(before, canonicalRepository, pullRequestNumber);
  if (before.updatedAt !== expectedUpdatedAt) {
    throw new Error(
      `Review comment ${reviewCommentId} updatedAt ${before.updatedAt} does not match expectedUpdatedAt ${expectedUpdatedAt}.`,
    );
  }
  const operation = await auditedJsonGh(
    request,
    [
      "api",
      `repos/${canonicalRepository}/pulls/comments/${reviewCommentId}`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "PATCH",
      "--input",
      "-",
      "--jq",
      PULL_REQUEST_REVIEW_COMMENT_JQ,
    ],
    { body },
    config,
  );
  const comment = pullRequestReviewComment(operation.value);
  assertReviewCommentPullRequest(comment, canonicalRepository, pullRequestNumber);
  return responseWithinOutputLimit({
    comment,
    audit: operation.audit,
    source: pullRequestSource(context, canonicalRepository, pullRequestNumber),
    contentTrust: REPOSITORY_CONTENT_TRUST,
  }, config);
});

server.registerTool("delete_pull_request_review_comment", {
  description: "Permanently delete an inline review comment after its PR ownership, node ID, and updatedAt value all match. Deleted comment content cannot be restored by this MCP server.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    reviewCommentId: reviewCommentIdSchema,
    expectedNodeId: z.string().trim().min(8).max(256)
      .refine((value) => !/[\0\r\n]/.test(value), "Review comment node ID must not contain control characters."),
    expectedUpdatedAt: z.string().min(1).max(64),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, hostname, repository, pullRequestNumber, reviewCommentId, expectedNodeId, expectedUpdatedAt }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "delete_pull_request_review_comment",
    repository: normalizedRepository,
    pullRequestNumber,
    reviewCommentId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const beforeValue = await jsonGh([
    "api",
    `repos/${canonicalRepository}/pulls/comments/${reviewCommentId}`,
    "--hostname",
    context.profile.hostname,
    "--jq",
    PULL_REQUEST_REVIEW_COMMENT_JQ,
  ], config, context);
  const before = pullRequestReviewComment(beforeValue);
  if (before.id !== reviewCommentId) {
    throw new Error(`GitHub returned review comment ${before.id} instead of ${reviewCommentId}.`);
  }
  assertReviewCommentPullRequest(before, canonicalRepository, pullRequestNumber);
  if (before.nodeId !== expectedNodeId) {
    throw new Error(
      `Review comment ${reviewCommentId} node ID does not match expectedNodeId; refusing deletion.`,
    );
  }
  if (before.updatedAt !== expectedUpdatedAt) {
    throw new Error(
      `Review comment ${reviewCommentId} updatedAt ${before.updatedAt} does not match expectedUpdatedAt ${expectedUpdatedAt}.`,
    );
  }
  const operation = await auditedOperation(
    request,
    config,
    () => runGh([
      "api",
      `repos/${canonicalRepository}/pulls/comments/${reviewCommentId}`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "DELETE",
    ], config, context),
  );
  return response({
    deleted: {
      reviewCommentId: before.id,
      nodeId: before.nodeId,
      repository: canonicalRepository,
      pullRequestNumber,
    },
    audit: operation.audit,
  });
});

server.registerTool("resolve_pull_request_review_thread", {
  description: "Resolve a review thread after verifying its repository, pull request, current state, and viewer permission. Repeating an already-resolved request is a no-op.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    reviewThreadId: reviewThreadIdSchema,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, repository, pullRequestNumber, reviewThreadId }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "resolve_pull_request_review_thread",
    repository: normalizedRepository,
    pullRequestNumber,
    reviewThreadId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const beforeValue = await readGraphqlGh(
    config,
    context,
    GET_PULL_REQUEST_REVIEW_THREAD_QUERY,
    { threadId: reviewThreadId, commentsFirst: 1, commentsAfter: null },
  );
  const before = pullRequestReviewThreadDetails(
    beforeValue,
    canonicalRepository,
    pullRequestNumber,
    reviewThreadId,
    1,
  );
  if (before.isResolved) {
    return response({
      thread: {
        id: before.id,
        isResolved: before.isResolved,
        viewerCanResolve: before.viewerCanResolve,
        viewerCanUnresolve: before.viewerCanUnresolve,
      },
      changed: false,
      audit: { started: false, completed: false, skipped: "already_resolved" },
    });
  }
  if (!before.viewerCanResolve) {
    throw new Error("The selected account is not allowed to resolve this review thread.");
  }
  const operation = await auditedGraphqlGh(
    request,
    [
      "api",
      "graphql",
      "--hostname",
      context.profile.hostname,
      "--method",
      "POST",
      "--input",
      "-",
    ],
    {
      query: RESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION,
      variables: { threadId: reviewThreadId, clientMutationId: request.operationId },
    },
    config,
  );
  const thread = reviewThreadMutationSummary(
    operation.value,
    "resolveReviewThread",
    reviewThreadId,
    true,
  );
  return response({ thread, changed: true, audit: operation.audit });
});

server.registerTool("unresolve_pull_request_review_thread", {
  description: "Reopen a resolved review thread after verifying its repository, pull request, current state, and viewer permission. Repeating an unresolved request is a no-op.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    reviewThreadId: reviewThreadIdSchema,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, repository, pullRequestNumber, reviewThreadId }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "unresolve_pull_request_review_thread",
    repository: normalizedRepository,
    pullRequestNumber,
    reviewThreadId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const beforeValue = await readGraphqlGh(
    config,
    context,
    GET_PULL_REQUEST_REVIEW_THREAD_QUERY,
    { threadId: reviewThreadId, commentsFirst: 1, commentsAfter: null },
  );
  const before = pullRequestReviewThreadDetails(
    beforeValue,
    canonicalRepository,
    pullRequestNumber,
    reviewThreadId,
    1,
  );
  if (!before.isResolved) {
    return response({
      thread: {
        id: before.id,
        isResolved: before.isResolved,
        viewerCanResolve: before.viewerCanResolve,
        viewerCanUnresolve: before.viewerCanUnresolve,
      },
      changed: false,
      audit: { started: false, completed: false, skipped: "already_unresolved" },
    });
  }
  if (!before.viewerCanUnresolve) {
    throw new Error("The selected account is not allowed to unresolve this review thread.");
  }
  const operation = await auditedGraphqlGh(
    request,
    [
      "api",
      "graphql",
      "--hostname",
      context.profile.hostname,
      "--method",
      "POST",
      "--input",
      "-",
    ],
    {
      query: UNRESOLVE_PULL_REQUEST_REVIEW_THREAD_MUTATION,
      variables: { threadId: reviewThreadId, clientMutationId: request.operationId },
    },
    config,
  );
  const thread = reviewThreadMutationSummary(
    operation.value,
    "unresolveReviewThread",
    reviewThreadId,
    false,
  );
  return response({ thread, changed: true, audit: operation.audit });
});

server.registerTool("merge_pull_request", {
  description: "Merge an open pull request only when its current head exactly matches expectedHeadSha. A merge method is required; optional commit text is sent through stdin and is not audited.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: pullRequestNumberSchema,
    expectedHeadSha: commitShaSchema,
    mergeMethod: z.enum(["merge", "squash", "rebase"]),
    commitTitle: z.string().min(1).max(256).optional(),
    commitMessage: z.string().max(65_536).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, hostname, repository, pullRequestNumber, expectedHeadSha, mergeMethod, commitTitle, commitMessage }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "merge_pull_request",
    repository: normalizedRepository,
    pullRequestNumber,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(normalizedRepository, context);
  const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
  const identity = await resolvePullRequestMutationIdentity(
    config,
    context,
    canonicalRepository,
    pullRequestNumber,
  );
  assertOpenPullRequestAtHead(identity, expectedHeadSha);
  const payload: Record<string, unknown> = {
    sha: expectedHeadSha,
    merge_method: mergeMethod,
  };
  if (commitTitle !== undefined) payload.commit_title = commitTitle;
  if (commitMessage !== undefined) payload.commit_message = commitMessage;
  const operation = await auditedJsonGh(
    request,
    [
      "api",
      `repos/${canonicalRepository}/pulls/${pullRequestNumber}/merge`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "PUT",
      "--input",
      "-",
    ],
    payload,
    config,
    (value) => ({ commitSha: pullRequestMergeResult(value).sha }),
  );
  const merge = pullRequestMergeResult(operation.value);
  return response({ merge, audit: operation.audit });
});

server.registerTool("create_pull_request", {
  description: "Create a pull request in an allowed repository. This never merges it. The title and body are sent through stdin and are not written to the audit log.",
  inputSchema: {
    ...writeContextSchema,
    title: z.string().min(1).max(256),
    body: z.string().max(65_536).optional(),
    head: gitRefSchema.describe("Head branch, or owner:branch for a fork"),
    base: gitRefSchema.describe("Base branch"),
    draft: z.boolean().default(true),
    maintainerCanModify: z.boolean().default(true),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, repository, hostname, title, body, head, base, draft, maintainerCanModify }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "create_pull_request",
    repository: normalizedRepository,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  const payload: Record<string, unknown> = {
    title,
    head: head.trim(),
    base: base.trim(),
    draft,
    maintainer_can_modify: maintainerCanModify,
  };
  if (body !== undefined) payload.body = body;
  const operation = await auditedJsonGh(
    request,
    ["api", `repos/${normalizedRepository}/pulls`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    payload,
    config,
  );
  return response({ pullRequest: pullRequestSummary(operation.value), audit: operation.audit });
});

server.registerTool("update_pull_request", {
  description: "Update a pull request title, body, or reversible open/closed state. This cannot merge a pull request.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: z.number().int().positive(),
    title: z.string().min(1).max(256).optional(),
    body: z.string().max(65_536).optional(),
    state: z.enum(["open", "closed"]).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, repository, hostname, pullRequestNumber, title, body, state }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "update_pull_request",
    repository: normalizedRepository,
    pullRequestNumber,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  const payload: Record<string, unknown> = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (state !== undefined) payload.state = state;
  if (Object.keys(payload).length === 0) throw new Error("At least one of title, body, or state must be provided.");
  await assertPullRequest(normalizedRepository, pullRequestNumber, config, context);
  const operation = await auditedJsonGh(
    request,
    ["api", `repos/${normalizedRepository}/pulls/${pullRequestNumber}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
    payload,
    config,
  );
  return response({ pullRequest: pullRequestSummary(operation.value), audit: operation.audit });
});

server.registerTool("comment_pull_request", {
  description: "Add a top-level conversation comment to a pull request. The comment body is sent through stdin and is not written to the audit log.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, repository, hostname, pullRequestNumber, body }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "comment_pull_request",
    repository: normalizedRepository,
    pullRequestNumber,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  await assertPullRequest(normalizedRepository, pullRequestNumber, config, context);
  const operation = await auditedJsonGh(
    request,
    ["api", `repos/${normalizedRepository}/issues/${pullRequestNumber}/comments`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { body },
    config,
  );
  return response({ comment: commentSummary(operation.value), audit: operation.audit });
});

server.registerTool("review_pull_request", {
  description: "Submit an APPROVE, REQUEST_CHANGES, or COMMENT review to an existing pull request. This never merges it. COMMENT and REQUEST_CHANGES require a body.",
  inputSchema: {
    ...writeContextSchema,
    pullRequestNumber: z.number().int().positive(),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: z.string().max(65_536).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, repository, hostname, pullRequestNumber, event, body }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "review_pull_request",
    repository: normalizedRepository,
    pullRequestNumber,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  assertReviewBody(event, body);
  const normalizedHostname = context.profile.hostname;
  await assertPullRequest(normalizedRepository, pullRequestNumber, config, context);
  const payload: Record<string, unknown> = { event };
  if (body !== undefined) payload.body = body;
  const operation = await auditedJsonGh(
    request,
    ["api", `repos/${normalizedRepository}/pulls/${pullRequestNumber}/reviews`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    payload,
    config,
  );
  return response({ review: pullRequestReviewSummary(operation.value), audit: operation.audit });
});
}
