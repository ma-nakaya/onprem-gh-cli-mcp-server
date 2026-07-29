import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveAccountContext,
  verifyAccountProfile,
} from "./account-profile.js";
import { appendAuditRecord } from "./audit-log.js";
import type { Config, RequestContext } from "./config.js";
import { runGh } from "./gh-runner.js";
import type { RunGhOptions } from "./gh-runner.js";
import {
  assertOwnerAllowed,
  assertRepositoryAllowed,
  assertRepositoryListOwnerAllowed,
  assertRunGhAllowedByResourceScope,
  assertSafeGhArguments,
  hasResourceAllowlist,
} from "./policy.js";
import { assertReviewBody, pullRequestReviewSummary, pullRequestSummary } from "./pull-request.js";
import { assertDraftRelease, releaseIdentifier, releaseSummary } from "./release.js";
import { assertActiveWorkflow, isWorkflowIdentifier, normalizeWorkflowInputs, workflowSummary } from "./workflow.js";
import { isLabelColor, isUtcTimestamp, labelSummary, milestoneIdentifier, milestoneSummary } from "./repository-metadata.js";
import { assertNoGraphqlErrors, assertProjectOwner, buildUpdateProjectMutation, graphqlProject, graphqlProjectItem, ownerNodeId, projectFieldValue, projectFieldsSummary, projectIdentifier, projectItemsSummary, projectItemSummary, projectSummary } from "./project.js";
import { assertRepositoryPath, assertWritableBranch, branchHeadSha, branchSummary, commitTreeSha, encodeGitRef, gitObjectSha } from "./git-data.js";

function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function verifiedRequestContext(
  config: Config,
  account?: string,
  hostname?: string,
): Promise<RequestContext> {
  const context = resolveAccountContext(config, account, hostname);
  await verifyAccountProfile(config, context);
  return context;
}

async function jsonGh(
  args: string[],
  config: Config,
  context: RequestContext,
  options: RunGhOptions = {},
): Promise<unknown> {
  const result = await runGh(args, config, context, options);
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error("GitHub CLI returned invalid JSON."); }
}

async function assertStandaloneIssue(
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

async function assertPullRequest(
  repository: string,
  pullRequestNumber: number,
  config: Config,
  context: RequestContext,
): Promise<void> {
  await jsonGh([
    "api",
    `repos/${repository}/pulls/${pullRequestNumber}`,
    "--hostname",
    context.profile.hostname,
  ], config, context);
}

async function assertProjectAccess(
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

interface AuditTarget {
  tool: string;
  hostname: string;
  account: string;
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
}

type AuditTargetInput = Omit<AuditTarget, "hostname" | "account">;

interface WriteRequest {
  readonly context: RequestContext;
  readonly operationId: string;
  readonly target: AuditTarget;
}

function accountScopedTarget(
  target: AuditTargetInput,
  context: RequestContext,
): AuditTarget {
  return {
    ...target,
    hostname: context.profile.hostname,
    account: context.accountId,
  };
}

async function verifyWriteAccount(request: WriteRequest, config: Config): Promise<void> {
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

async function prepareWriteRequest(
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

async function auditedOperation<T>(
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

async function auditedJsonGh(
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

async function auditedGraphqlGh(
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

function issueSummary(value: unknown): Record<string, unknown> {
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

function commentSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned an unexpected issue comment response.");
  const item = value as Record<string, unknown>;
  return {
    id: item.id,
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "onprem-gh-cli-mcp", version: "0.1.0" });
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

  server.registerTool("list_accounts", {
    description: "List configured GitHub account selectors without exposing credentials or config paths.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => response({
    accounts: [...config.accountProfiles.values()].map((profile) => ({
      account: profile.id,
      expectedLogin: profile.expectedLogin,
      hostname: profile.hostname,
      default: config.defaultAccountId === profile.id,
    })),
  }));

  server.registerTool("get_auth_status", {
    description: "Check the selected isolated GitHub CLI account without exposing any token.",
    inputSchema: requestContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    const activeLogin = context.profile.expectedLogin;
    const result = await runGh([
      "auth",
      "status",
      "--hostname",
      context.profile.hostname,
    ], config, context, { allowFailure: true });
    return response({
      authenticated: result.exitCode === 0,
      account: context.accountId,
      hostname: context.profile.hostname,
      activeLogin,
      expectedLogin: context.profile.expectedLogin,
      matchesExpected: true,
      details: result.stderr || result.stdout,
    });
  });

  server.registerTool("list_repositories", {
    description: "List repositories visible to the authenticated GitHub CLI account.",
    inputSchema: {
      ...requestContextSchema,
      owner: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, owner, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    if (!owner && hasResourceAllowlist(context)) {
      throw new Error("owner is required when a resource allowlist is configured.");
    }
    if (owner) assertRepositoryListOwnerAllowed(owner, context);
    if (context.profile.allowedRepositories.size > 0) {
      const normalizedOwner = owner?.trim().toLowerCase();
      const repositories = [...context.profile.allowedRepositories]
        .filter((repository) => normalizedOwner === undefined || repository.split("/", 1)[0] === normalizedOwner)
        .slice(0, limit);
      return response(await Promise.all(repositories.map(async (repository) =>
        jsonGh([
          "repo",
          "view",
          repository,
          "--json",
          "nameWithOwner,url,visibility,isPrivate,updatedAt",
        ], config, context)
      )));
    }
    const args = ["repo", "list", ...(owner ? [owner] : []), "--limit", String(limit), "--json", "nameWithOwner,url,visibility,isPrivate,updatedAt"];
    return response(await jsonGh(args, config, context));
  });

  server.registerTool("list_organizations", {
    description: "List organizations visible to the authenticated GitHub CLI account, including private memberships allowed by its scopes.",
    inputSchema: requestContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    const pages = await jsonGh([
      "api",
      "user/orgs",
      "--hostname",
      context.profile.hostname,
      "--paginate",
      "--slurp",
    ], config, context);
    if (!Array.isArray(pages)) throw new Error("GitHub CLI returned an unexpected organizations response.");
    const allowedOrganizationOwners = new Set(context.profile.allowedOwners);
    if (allowedOrganizationOwners.size === 0) {
      for (const repository of context.profile.allowedRepositories) {
        allowedOrganizationOwners.add(repository.split("/", 1)[0]);
      }
    }
    const organizations = pages.flatMap((page) => Array.isArray(page) ? page : []).filter((organization) => {
      if (!hasResourceAllowlist(context)) return true;
      if (!organization || typeof organization !== "object" || Array.isArray(organization)) return false;
      const login = (organization as Record<string, unknown>).login;
      return typeof login === "string" && allowedOrganizationOwners.has(login.toLowerCase());
    }).map((organization) => {
      const item = organization as Record<string, unknown>;
      return { login: item.login, id: item.id, url: item.html_url, description: item.description };
    });
    return response(organizations);
  });

  const gitRefSchema = z.string().trim().min(1).max(255).refine(
    (value) => !/[\0\r\n]/.test(value),
    "Git reference must not contain control characters.",
  );
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

  server.registerTool("get_branch", {
    description: "Read the current commit SHA for a branch in an allowed repository.",
    inputSchema: { ...writeContextSchema, branch: branchNameSchema },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, repository, hostname, branch }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertRepositoryAllowed(repository, context);
    const value = await jsonGh([
      "api",
      `repos/${repository.trim()}/git/ref/heads/${encodeGitRef(branch.trim())}`,
      "--hostname",
      context.profile.hostname,
    ], config, context);
    return response({ branch: branchSummary(value) });
  });

  server.registerTool("create_branch", {
    description: "Create a feature branch from an existing branch. Existing branches are never overwritten.",
    inputSchema: { ...writeContextSchema, branch: branchNameSchema, sourceBranch: branchNameSchema.default("main") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, branch, sourceBranch }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "create_branch",
      repository: normalizedRepository,
      branch: branch.trim(),
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    assertWritableBranch(branch);
    const normalizedHostname = context.profile.hostname;
    const source = await jsonGh([
      "api",
      `repos/${normalizedRepository}/git/ref/heads/${encodeGitRef(sourceBranch.trim())}`,
      "--hostname",
      normalizedHostname,
    ], config, context);
    const sourceSha = branchHeadSha(source);
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/git/refs`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { ref: `refs/heads/${branch.trim()}`, sha: sourceSha },
      config,
    );
    return response({ branch: branchSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("commit_files", {
    description: "Create one atomic commit containing multiple file creates, updates, or deletes, then advance a feature branch without force-pushing. File contents are not audited.",
    inputSchema: {
      ...writeContextSchema,
      branch: branchNameSchema,
      expectedHeadSha: commitShaSchema.describe("Current branch head SHA used for optimistic concurrency"),
      message: z.string().trim().min(1).max(2048),
      files: z.array(z.object({
        path: repositoryPathSchema,
        operation: z.enum(["upsert", "delete"]),
        content: z.string().max(1_000_000).optional(),
      }).superRefine((file, context) => {
        if (file.operation === "upsert" && file.content === undefined) context.addIssue({ code: "custom", message: "Upsert operations require content." });
        if (file.operation === "delete" && file.content !== undefined) context.addIssue({ code: "custom", message: "Delete operations must not include content." });
      })).min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, repository, hostname, branch, expectedHeadSha, message, files }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "commit_files",
      repository: normalizedRepository,
      branch: branch.trim(),
      fileCount: files.length,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    assertWritableBranch(branch);
    const paths = files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) throw new Error("Each repository path may appear only once per commit.");
    const normalizedHostname = context.profile.hostname;
    const operation = await auditedOperation(
      request,
      config,
      async () => {
        const refPath = `repos/${normalizedRepository}/git/ref/heads/${encodeGitRef(branch.trim())}`;
        const currentRef = await jsonGh(
          ["api", refPath, "--hostname", normalizedHostname],
          config,
          context,
        );
        const actualHeadSha = branchHeadSha(currentRef);
        if (actualHeadSha !== expectedHeadSha) {
          throw new Error("Branch head changed. Fetch the branch again and rebuild the commit from the new head.");
        }
        const baseCommit = await jsonGh(
          ["api", `repos/${normalizedRepository}/git/commits/${actualHeadSha}`, "--hostname", normalizedHostname],
          config,
          context,
        );
        const baseTree = commitTreeSha(baseCommit);
        const tree: Record<string, unknown>[] = [];
        for (const file of files) {
          assertRepositoryPath(file.path);
          if (file.operation === "delete") {
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: null });
            continue;
          }
          const blob = await jsonGh(
            ["api", `repos/${normalizedRepository}/git/blobs`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
            config,
            context,
            { stdin: JSON.stringify({ content: file.content, encoding: "utf-8" }) },
          );
          tree.push({ path: file.path, mode: "100644", type: "blob", sha: gitObjectSha(blob, "Git blob") });
        }
        const newTree = await jsonGh(
          ["api", `repos/${normalizedRepository}/git/trees`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
          config,
          context,
          { stdin: JSON.stringify({ base_tree: baseTree, tree }) },
        );
        const newTreeSha = gitObjectSha(newTree, "Git tree");
        const commit = await jsonGh(
          ["api", `repos/${normalizedRepository}/git/commits`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
          config,
          context,
          { stdin: JSON.stringify({ message: message.trim(), tree: newTreeSha, parents: [actualHeadSha] }) },
        );
        const commitSha = gitObjectSha(commit, "Git commit");
        await verifyAccountProfile(config, context);
        const branchValue = await jsonGh(
          ["api", `repos/${normalizedRepository}/git/refs/heads/${encodeGitRef(branch.trim())}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
          config,
          context,
          { stdin: JSON.stringify({ sha: commitSha, force: false }) },
        );
        return { branchValue, commitSha };
      },
      (value) => ({ commitSha: value.commitSha }),
    );
    return response({
      branch: branchSummary(operation.value.branchValue),
      commit: { sha: operation.value.commitSha, fileCount: files.length },
      audit: operation.audit,
    });
  });

  server.registerTool("list_issues", {
    description: "List issues in an allowed repository.",
    inputSchema: { ...repositorySchema, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, state, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertRepositoryAllowed(repository, context);
    return response(await jsonGh(["issue", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,state,author,assignees,labels,createdAt,updatedAt,url"], config, context));
  });

  server.registerTool("create_issue", {
    description: "Create an issue in an allowed repository. The title and body are sent to gh through stdin and are not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      title: z.string().min(1).max(256),
      body: z.string().max(65_536).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, title, body }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "create_issue",
      repository: normalizedRepository,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload = body === undefined ? { title } : { title, body };
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/issues`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      payload,
      config,
    );
    return response({ issue: issueSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("update_issue", {
    description: "Update an issue title, body, or reversible open/closed state in an allowed repository.",
    inputSchema: {
      ...writeContextSchema,
      issueNumber: z.number().int().positive(),
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(65_536).optional(),
      state: z.enum(["open", "closed"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, issueNumber, title, body, state }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "update_issue",
      repository: normalizedRepository,
      issueNumber,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (Object.keys(payload).length === 0) throw new Error("At least one of title, body, or state must be provided.");
    await assertStandaloneIssue(normalizedRepository, issueNumber, config, context);
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/issues/${issueNumber}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ issue: issueSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("comment_issue", {
    description: "Add a comment to an issue in an allowed repository. The comment body is sent through stdin and is not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      issueNumber: z.number().int().positive(),
      body: z.string().min(1).max(65_536),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, issueNumber, body }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "comment_issue",
      repository: normalizedRepository,
      issueNumber,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    await assertStandaloneIssue(normalizedRepository, issueNumber, config, context);
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/issues/${issueNumber}/comments`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { body },
      config,
    );
    return response({ comment: commentSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("list_pull_requests", {
    description: "List pull requests in an allowed repository.",
    inputSchema: { ...repositorySchema, state: z.enum(["open", "closed", "merged", "all"]).default("open"), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, state, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertRepositoryAllowed(repository, context);
    return response(await jsonGh(["pr", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,url"], config, context));
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

  server.registerTool("list_workflow_runs", {
    description: "List GitHub Actions workflow runs in an allowed repository.",
    inputSchema: { ...repositorySchema, limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertRepositoryAllowed(repository, context);
    return response(await jsonGh(["run", "list", "--repo", repository, "--limit", String(limit), "--json", "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url"], config, context));
  });

  server.registerTool("dispatch_workflow", {
    description: "Dispatch an active GitHub Actions workflow in an allowed repository. Workflow inputs are sent through stdin and are not returned or written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      workflow: workflowIdentifierSchema,
      ref: gitRefSchema,
      inputs: z.record(z.string(), z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, repository, hostname, workflow, ref, inputs }) => {
    const normalizedRepository = repository.trim();
    const normalizedWorkflow = workflow.trim();
    const request = await prepareWriteRequest({
      tool: "dispatch_workflow",
      repository: normalizedRepository,
      workflow: normalizedWorkflow,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const normalizedRef = ref.trim();
    const normalizedInputs = normalizeWorkflowInputs(inputs ?? {});
    const workflowPath = `repos/${normalizedRepository}/actions/workflows/${encodeURIComponent(normalizedWorkflow)}`;
    const existing = await jsonGh(
      ["api", workflowPath, "--hostname", normalizedHostname],
      config,
      context,
    );
    assertActiveWorkflow(existing, normalizedWorkflow);
    const operation = await auditedJsonGh(
      request,
      ["api", `${workflowPath}/dispatches`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { ref: normalizedRef, inputs: normalizedInputs },
      config,
    );
    return response({ accepted: true, workflow: workflowSummary(existing), ref: normalizedRef, audit: operation.audit });
  });

  server.registerTool("create_release", {
    description: "Create a draft release in an allowed repository. This tool cannot publish a release. The release body is sent through stdin and is not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      tagName: gitRefSchema.describe("Git tag name for the draft release"),
      targetCommitish: gitRefSchema.optional().describe("Branch or commit SHA used when creating a new tag"),
      name: z.string().max(256).optional(),
      body: z.string().max(125_000).optional(),
      prerelease: z.boolean().default(false),
      generateReleaseNotes: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, tagName, targetCommitish, name, body, prerelease, generateReleaseNotes }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "create_release",
      repository: normalizedRepository,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {
      tag_name: tagName.trim(),
      draft: true,
      prerelease,
      generate_release_notes: generateReleaseNotes,
    };
    if (targetCommitish !== undefined) payload.target_commitish = targetCommitish.trim();
    if (name !== undefined) payload.name = name;
    if (body !== undefined) payload.body = body;
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/releases`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      payload,
      config,
      (value) => ({ releaseId: releaseIdentifier(value) }),
    );
    return response({ release: releaseSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("create_label", {
    description: "Create a label in an allowed repository. The description is sent through stdin and is not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      name: labelNameSchema,
      color: labelColorSchema,
      description: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, name, color, description }) => {
    const normalizedRepository = repository.trim();
    const normalizedName = name.trim();
    const request = await prepareWriteRequest({
      tool: "create_label",
      repository: normalizedRepository,
      label: normalizedName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = { name: normalizedName, color: color.toLowerCase() };
    if (description !== undefined) payload.description = description;
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/labels`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      payload,
      config,
    );
    return response({ label: labelSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("update_label", {
    description: "Update an existing label name, color, or description. This tool cannot delete labels.",
    inputSchema: {
      ...writeContextSchema,
      currentName: labelNameSchema,
      newName: labelNameSchema.optional(),
      color: labelColorSchema.optional(),
      description: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, currentName, newName, color, description }) => {
    const normalizedRepository = repository.trim();
    const normalizedCurrentName = currentName.trim();
    const request = await prepareWriteRequest({
      tool: "update_label",
      repository: normalizedRepository,
      label: normalizedCurrentName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {};
    if (newName !== undefined) payload.new_name = newName.trim();
    if (color !== undefined) payload.color = color.toLowerCase();
    if (description !== undefined) payload.description = description;
    if (Object.keys(payload).length === 0) throw new Error("At least one label field must be provided.");
    const labelPath = `repos/${normalizedRepository}/labels/${encodeURIComponent(normalizedCurrentName)}`;
    await jsonGh(["api", labelPath, "--hostname", normalizedHostname], config, context);
    const operation = await auditedJsonGh(
      request,
      ["api", labelPath, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ label: labelSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("create_milestone", {
    description: "Create an open milestone in an allowed repository. The description is sent through stdin and is not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      title: z.string().trim().min(1).max(256),
      description: z.string().max(65_536).optional(),
      dueOn: dueOnSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, title, description, dueOn }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "create_milestone",
      repository: normalizedRepository,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = { title: title.trim(), state: "open" };
    if (description !== undefined) payload.description = description;
    if (dueOn !== undefined) payload.due_on = dueOn;
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/milestones`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      payload,
      config,
      (value) => ({ milestoneNumber: milestoneIdentifier(value) }),
    );
    return response({ milestone: milestoneSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("update_milestone", {
    description: "Update an existing milestone title, description, reversible open/closed state, or UTC due date. This tool cannot delete milestones.",
    inputSchema: {
      ...writeContextSchema,
      milestoneNumber: z.number().int().positive(),
      title: z.string().trim().min(1).max(256).optional(),
      description: z.string().max(65_536).optional(),
      state: z.enum(["open", "closed"]).optional(),
      dueOn: dueOnSchema.nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, milestoneNumber, title, description, state, dueOn }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "update_milestone",
      repository: normalizedRepository,
      milestoneNumber,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title.trim();
    if (description !== undefined) payload.description = description;
    if (state !== undefined) payload.state = state;
    if (dueOn !== undefined) payload.due_on = dueOn;
    if (Object.keys(payload).length === 0) throw new Error("At least one milestone field must be provided.");
    const milestonePath = `repos/${normalizedRepository}/milestones/${milestoneNumber}`;
    await jsonGh(["api", milestonePath, "--hostname", normalizedHostname], config, context);
    const operation = await auditedJsonGh(
      request,
      ["api", milestonePath, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ milestone: milestoneSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("create_project", {
    description: "Create a private GitHub Projects v2 project for an allowed user or organization. This tool cannot make the project public or delete it.",
    inputSchema: {
      ...requestContextSchema,
      ownerType: z.enum(["user", "organization"]),
      owner: ownerLoginSchema,
      title: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, hostname, ownerType, owner, title }) => {
    const normalizedOwner = owner.trim().toLowerCase();
    const request = await prepareWriteRequest({
      tool: "create_project",
      owner: normalizedOwner,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    const ownerEndpoint = ownerType === "organization" ? `orgs/${normalizedOwner}` : `users/${normalizedOwner}`;
    const ownerResponse = await jsonGh(
      ["api", ownerEndpoint, "--hostname", normalizedHostname],
      config,
      context,
    );
    const ownerId = ownerNodeId(ownerResponse);
    const query = `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id number title url closed public }
      }
    }`;
    const operation = await auditedGraphqlGh(
      request,
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { ownerId, title: title.trim() } },
      config,
      (value) => ({ projectId: projectIdentifier(graphqlProject(value, "createProjectV2")) }),
    );
    const project = graphqlProject(operation.value, "createProjectV2");
    return response({ project: projectSummary(project), audit: operation.audit });
  });

  server.registerTool("update_project", {
    description: "Update a GitHub Projects v2 title, descriptions, or reversible open/closed state. This tool cannot change visibility or delete a project.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema.describe("Allowed owner used as the authorization scope"),
      projectId: projectIdSchema,
      title: z.string().trim().min(1).max(256).optional(),
      shortDescription: z.string().max(256).optional(),
      readme: z.string().max(65_536).optional(),
      closed: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, owner, projectId, title, shortDescription, readme, closed }) => {
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
    const request = await prepareWriteRequest({
      tool: "update_project",
      owner: normalizedOwner,
      projectId: normalizedProjectId,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    const update = buildUpdateProjectMutation(normalizedProjectId, {
      ...(title === undefined ? {} : { title: title.trim() }),
      ...(shortDescription === undefined ? {} : { shortDescription }),
      ...(readme === undefined ? {} : { readme }),
      ...(closed === undefined ? {} : { closed }),
    });

    const readQuery = `query($projectId: ID!) {
      node(id: $projectId) { __typename ... on ProjectV2 { id number title url closed public owner { ... on User { login } ... on Organization { login } } } }
    }`;
    const existing = await jsonGh(
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      config,
      context,
      { stdin: JSON.stringify({ query: readQuery, variables: { projectId: normalizedProjectId } }) },
    );
    assertProjectOwner(existing, normalizedOwner);

    const operation = await auditedGraphqlGh(
      request,
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      update,
      config,
    );
    const project = graphqlProject(operation.value, "updateProjectV2");
    return response({ project: projectSummary(project), audit: operation.audit });
  });

  server.registerTool("list_project_items", {
    description: "List Issue and Pull Request metadata in a GitHub Projects v2 project. Item field values and content bodies are not returned.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema,
      projectId: projectIdSchema,
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, owner, projectId, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    const query = `query($projectId: ID!, $limit: Int!) {
      node(id: $projectId) { __typename ... on ProjectV2 {
        id owner { ... on User { login } ... on Organization { login } } items(first: $limit) { totalCount nodes { id isArchived content {
          __typename ... on Issue { title number url state repository { nameWithOwner } }
          ... on PullRequest { title number url state repository { nameWithOwner } }
        } } }
      } }
    }`;
    const value = await jsonGh(
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      config,
      context,
      { stdin: JSON.stringify({ query, variables: { projectId: projectId.trim(), limit } }) },
    );
    assertProjectOwner(value, owner);
    return response(projectItemsSummary(value));
  });

  server.registerTool("list_project_fields", {
    description: "List field metadata and selectable option IDs for a GitHub Projects v2 project. Item field values are not returned.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema,
      projectId: projectIdSchema,
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, owner, projectId, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    const query = `query($projectId: ID!, $limit: Int!) {
      node(id: $projectId) { __typename ... on ProjectV2 {
        id owner { ... on User { login } ... on Organization { login } } fields(first: $limit) { totalCount nodes {
          __typename ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } }
        } }
      } }
    }`;
    const value = await jsonGh(
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      config,
      context,
      { stdin: JSON.stringify({ query, variables: { projectId: projectId.trim(), limit } }) },
    );
    assertProjectOwner(value, owner);
    return response(projectFieldsSummary(value));
  });

  server.registerTool("add_project_item", {
    description: "Add an existing Issue or Pull Request to a GitHub Projects v2 project. Draft items cannot be created.",
    inputSchema: {
      ...writeContextSchema,
      owner: ownerLoginSchema,
      projectId: projectIdSchema,
      contentType: z.enum(["issue", "pull_request"]),
      number: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, owner, projectId, contentType, number }) => {
    const normalizedRepository = repository.trim();
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
    const request = await prepareWriteRequest({
      tool: "add_project_item",
      repository: normalizedRepository,
      owner: normalizedOwner,
      projectId: normalizedProjectId,
      ...(contentType === "issue"
        ? { issueNumber: number }
        : { pullRequestNumber: number }),
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    await assertProjectAccess(normalizedProjectId, owner, config, context);
    const path = contentType === "issue" ? `repos/${normalizedRepository}/issues/${number}` : `repos/${normalizedRepository}/pulls/${number}`;
    const content = await jsonGh(
      ["api", path, "--hostname", normalizedHostname],
      config,
      context,
    );
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("GitHub API returned an unexpected content response.");
    const contentRecord = content as Record<string, unknown>;
    if (contentType === "issue" && contentRecord.pull_request !== undefined) throw new Error(`Issue #${number} is a pull request.`);
    if (typeof contentRecord.node_id !== "string") throw new Error("GitHub API returned content without a node ID.");
    const query = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id isArchived } }
    }`;
    const operation = await auditedGraphqlGh(
      request,
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { projectId: projectId.trim(), contentId: contentRecord.node_id } },
      config,
      (value) => ({ projectItemId: String(graphqlProjectItem(value, "addProjectV2ItemById").id) }),
    );
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, "addProjectV2ItemById")), audit: operation.audit });
  });

  server.registerTool("set_project_item_field", {
    description: "Set one supported text, number, date, single-select, or iteration value on a GitHub Projects v2 item.",
    inputSchema: {
      ...requestContextSchema, owner: ownerLoginSchema,
      projectId: projectIdSchema, itemId: projectItemIdSchema, fieldId: projectFieldIdSchema,
      valueType: z.enum(["text", "number", "date", "singleSelect", "iteration"]),
      value: z.union([z.string().max(65_536), z.number().finite()]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, owner, projectId, itemId, fieldId, valueType, value }) => {
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
    const normalizedItemId = itemId.trim();
    const normalizedFieldId = fieldId.trim();
    const request = await prepareWriteRequest({
      tool: "set_project_item_field",
      owner: normalizedOwner,
      projectId: normalizedProjectId,
      projectItemId: normalizedItemId,
      projectFieldId: normalizedFieldId,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    await assertProjectAccess(normalizedProjectId, owner, config, context);
    const query = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id isArchived } }
    }`;
    const operation = await auditedGraphqlGh(
      request,
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { projectId: normalizedProjectId, itemId: normalizedItemId, fieldId: normalizedFieldId, value: projectFieldValue(valueType, value) } }, config,
    );
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, "updateProjectV2ItemFieldValue")), audit: operation.audit });
  });

  server.registerTool("clear_project_item_field", {
    description: "Clear one supported field value on a GitHub Projects v2 item.",
    inputSchema: { ...requestContextSchema, owner: ownerLoginSchema, projectId: projectIdSchema, itemId: projectItemIdSchema, fieldId: projectFieldIdSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, owner, projectId, itemId, fieldId }) => {
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
    const normalizedItemId = itemId.trim();
    const normalizedFieldId = fieldId.trim();
    const request = await prepareWriteRequest({
      tool: "clear_project_item_field",
      owner: normalizedOwner,
      projectId: normalizedProjectId,
      projectItemId: normalizedItemId,
      projectFieldId: normalizedFieldId,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    await assertProjectAccess(normalizedProjectId, owner, config, context);
    const query = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id isArchived } }
    }`;
    const operation = await auditedGraphqlGh(request, ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"], { query, variables: { projectId: normalizedProjectId, itemId: normalizedItemId, fieldId: normalizedFieldId } }, config);
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, "clearProjectV2ItemFieldValue")), audit: operation.audit });
  });

  server.registerTool("set_project_item_archived", {
    description: "Archive or restore a GitHub Projects v2 item. This is reversible and does not delete its Issue or Pull Request.",
    inputSchema: { ...requestContextSchema, owner: ownerLoginSchema, projectId: projectIdSchema, itemId: projectItemIdSchema, archived: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, owner, projectId, itemId, archived }) => {
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
    const normalizedItemId = itemId.trim();
    const request = await prepareWriteRequest({
      tool: "set_project_item_archived",
      owner: normalizedOwner,
      projectId: normalizedProjectId,
      projectItemId: normalizedItemId,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const normalizedHostname = context.profile.hostname;
    await assertProjectAccess(normalizedProjectId, owner, config, context);
    const operationName = archived ? "archiveProjectV2Item" : "unarchiveProjectV2Item";
    const query = `mutation($projectId: ID!, $itemId: ID!) { ${operationName}(input: { projectId: $projectId, itemId: $itemId }) { item { id isArchived } } }`;
    const operation = await auditedGraphqlGh(
      request,
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { projectId: normalizedProjectId, itemId: normalizedItemId } }, config,
    );
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, operationName)), audit: operation.audit });
  });

  server.registerTool("update_release", {
    description: "Update metadata for an existing draft release. Published releases cannot be changed or published by this tool.",
    inputSchema: {
      ...writeContextSchema,
      releaseId: z.number().int().positive(),
      tagName: gitRefSchema.optional(),
      targetCommitish: gitRefSchema.optional(),
      name: z.string().max(256).optional(),
      body: z.string().max(125_000).optional(),
      prerelease: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, releaseId, tagName, targetCommitish, name, body, prerelease }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "update_release",
      repository: normalizedRepository,
      releaseId,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {};
    if (tagName !== undefined) payload.tag_name = tagName.trim();
    if (targetCommitish !== undefined) payload.target_commitish = targetCommitish.trim();
    if (name !== undefined) payload.name = name;
    if (body !== undefined) payload.body = body;
    if (prerelease !== undefined) payload.prerelease = prerelease;
    if (Object.keys(payload).length === 0) {
      throw new Error("At least one release field must be provided.");
    }
    const existing = await jsonGh(
      ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname],
      config,
      context,
    );
    assertDraftRelease(existing, releaseId);
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ release: releaseSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("run_gh", {
    description: "Run an allowlisted, read-only GitHub CLI command. With a resource allowlist, only auth status is available; use typed repository tools for other reads.",
    inputSchema: {
      ...requestContextSchema,
      args: z.array(z.string().min(1)).min(1).max(40),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, args }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertSafeGhArguments(args);
    assertRunGhAllowedByResourceScope(args, context);
    const result = await runGh(args, config, context);
    return response(result);
  });
  return server;
}
