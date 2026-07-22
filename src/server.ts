import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendAuditRecord } from "./audit-log.js";
import type { Config } from "./config.js";
import { runGh } from "./gh-runner.js";
import type { RunGhOptions } from "./gh-runner.js";
import { assertHostAllowed, assertOwnerAllowed, assertRepositoryAllowed, assertSafeGhArguments } from "./policy.js";
import { assertReviewBody, pullRequestReviewSummary, pullRequestSummary } from "./pull-request.js";
import { assertDraftRelease, releaseIdentifier, releaseSummary } from "./release.js";
import { assertActiveWorkflow, isWorkflowIdentifier, normalizeWorkflowInputs, workflowSummary } from "./workflow.js";
import { isLabelColor, isUtcTimestamp, labelSummary, milestoneIdentifier, milestoneSummary } from "./repository-metadata.js";
import { assertProjectOwner, buildUpdateProjectMutation, graphqlProject, graphqlProjectItem, ownerNodeId, projectFieldValue, projectFieldsSummary, projectIdentifier, projectItemsSummary, projectItemSummary, projectSummary } from "./project.js";

function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function jsonGh(args: string[], config: Config, options: RunGhOptions = {}): Promise<unknown> {
  const result = await runGh(args, config, options);
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error("GitHub CLI returned invalid JSON."); }
}

async function assertStandaloneIssue(repository: string, issueNumber: number, hostname: string, config: Config): Promise<void> {
  const value = await jsonGh(["api", `repos/${repository}/issues/${issueNumber}`, "--hostname", hostname], config);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned an unexpected issue response.");
  const item = value as Record<string, unknown>;
  if (item.pull_request !== undefined) throw new Error(`Issue #${issueNumber} is a pull request. Use a Pull Request-specific tool instead.`);
}

async function assertPullRequest(repository: string, pullRequestNumber: number, hostname: string, config: Config): Promise<void> {
  await jsonGh(["api", `repos/${repository}/pulls/${pullRequestNumber}`, "--hostname", hostname], config);
}

async function assertProjectAccess(projectId: string, owner: string, hostname: string, config: Config): Promise<void> {
  const query = `query($projectId: ID!) { node(id: $projectId) { __typename ... on ProjectV2 { id owner { ... on User { login } ... on Organization { login } } } } }`;
  const value = await jsonGh(["api", "graphql", "--hostname", hostname, "--method", "POST", "--input", "-"], config, {
    stdin: JSON.stringify({ query, variables: { projectId } }),
  });
  assertProjectOwner(value, owner);
}

interface AuditTarget {
  tool: string;
  hostname: string;
  repository?: string;
  owner?: string;
  projectId?: string;
  projectItemId?: string;
  projectFieldId?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  releaseId?: number;
  workflow?: string;
  label?: string;
  milestoneNumber?: number;
}

async function auditedJsonGh(
  target: AuditTarget,
  args: string[],
  payload: Record<string, unknown>,
  config: Config,
  completedTarget?: (value: unknown) => Partial<AuditTarget>,
): Promise<{ value: unknown; audit: { started: true; completed: boolean } }> {
  const startedAt = Date.now();
  await appendAuditRecord(config.auditLogPath, {
    ...target,
    outcome: "started",
    durationMs: 0,
  });
  try {
    const value = await jsonGh(args, config, { stdin: JSON.stringify(payload) });
    const finalTarget = completedTarget === undefined ? target : { ...target, ...completedTarget(value) };
    let completed = true;
    try {
      await appendAuditRecord(config.auditLogPath, {
        ...finalTarget,
        outcome: "succeeded",
        durationMs: Date.now() - startedAt,
      });
    } catch {
      completed = false;
    }
    return { value, audit: { started: true, completed } };
  } catch (error) {
    try {
      await appendAuditRecord(config.auditLogPath, {
        ...target,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Preserve the original GitHub operation error. The initial audit record was already written.
    }
    throw error;
  }
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

  server.registerTool("get_auth_status", {
    description: "Check local GitHub CLI authentication without exposing any token.",
    inputSchema: { hostname: z.string().default("github.com") },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ hostname }) => {
    assertHostAllowed(hostname, config);
    const result = await runGh(["auth", "status", "--hostname", hostname], config, { allowFailure: true });
    return response({ authenticated: result.exitCode === 0, hostname, details: result.stderr || result.stdout });
  });

  server.registerTool("list_repositories", {
    description: "List repositories visible to the authenticated GitHub CLI account.",
    inputSchema: { owner: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ owner, limit }) => {
    if (owner && config.allowedOwners.size > 0 && !config.allowedOwners.has(owner.toLowerCase())) throw new Error(`Repository owner is not allowed: ${owner}`);
    const args = ["repo", "list", ...(owner ? [owner] : []), "--limit", String(limit), "--json", "nameWithOwner,url,visibility,isPrivate,updatedAt"];
    return response(await jsonGh(args, config));
  });

  server.registerTool("list_organizations", {
    description: "List organizations visible to the authenticated GitHub CLI account, including private memberships allowed by its scopes.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    const pages = await jsonGh(["api", "user/orgs", "--paginate", "--slurp"], config);
    if (!Array.isArray(pages)) throw new Error("GitHub CLI returned an unexpected organizations response.");
    const organizations = pages.flatMap((page) => Array.isArray(page) ? page : []).map((organization) => {
      const item = organization as Record<string, unknown>;
      return { login: item.login, id: item.id, url: item.html_url, description: item.description };
    });
    return response(organizations);
  });

  const repositorySchema = { repository: z.string().describe("Repository in owner/name format") };
  const writeContextSchema = {
    ...repositorySchema,
    hostname: z.string().min(1).default("github.com"),
  };
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

  server.registerTool("list_issues", {
    description: "List issues in an allowed repository.",
    inputSchema: { ...repositorySchema, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ repository, state, limit }) => {
    assertRepositoryAllowed(repository, config);
    return response(await jsonGh(["issue", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,state,author,assignees,labels,createdAt,updatedAt,url"], config));
  });

  server.registerTool("create_issue", {
    description: "Create an issue in an allowed repository. The title and body are sent to gh through stdin and are not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      title: z.string().min(1).max(256),
      body: z.string().max(65_536).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ repository, hostname, title, body }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload = body === undefined ? { title } : { title, body };
    const operation = await auditedJsonGh(
      { tool: "create_issue", hostname: normalizedHostname, repository: normalizedRepository },
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
  }, async ({ repository, hostname, issueNumber, title, body, state }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (Object.keys(payload).length === 0) throw new Error("At least one of title, body, or state must be provided.");
    await assertStandaloneIssue(normalizedRepository, issueNumber, normalizedHostname, config);
    const operation = await auditedJsonGh(
      { tool: "update_issue", hostname: normalizedHostname, repository: normalizedRepository, issueNumber },
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
  }, async ({ repository, hostname, issueNumber, body }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertStandaloneIssue(normalizedRepository, issueNumber, normalizedHostname, config);
    const operation = await auditedJsonGh(
      { tool: "comment_issue", hostname: normalizedHostname, repository: normalizedRepository, issueNumber },
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
  }, async ({ repository, state, limit }) => {
    assertRepositoryAllowed(repository, config);
    return response(await jsonGh(["pr", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,url"], config));
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
  }, async ({ repository, hostname, title, body, head, base, draft, maintainerCanModify }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload: Record<string, unknown> = {
      title,
      head: head.trim(),
      base: base.trim(),
      draft,
      maintainer_can_modify: maintainerCanModify,
    };
    if (body !== undefined) payload.body = body;
    const operation = await auditedJsonGh(
      { tool: "create_pull_request", hostname: normalizedHostname, repository: normalizedRepository },
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
  }, async ({ repository, hostname, pullRequestNumber, title, body, state }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (Object.keys(payload).length === 0) throw new Error("At least one of title, body, or state must be provided.");
    await assertPullRequest(normalizedRepository, pullRequestNumber, normalizedHostname, config);
    const operation = await auditedJsonGh(
      { tool: "update_pull_request", hostname: normalizedHostname, repository: normalizedRepository, pullRequestNumber },
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
  }, async ({ repository, hostname, pullRequestNumber, body }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertPullRequest(normalizedRepository, pullRequestNumber, normalizedHostname, config);
    const operation = await auditedJsonGh(
      { tool: "comment_pull_request", hostname: normalizedHostname, repository: normalizedRepository, pullRequestNumber },
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
  }, async ({ repository, hostname, pullRequestNumber, event, body }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    assertReviewBody(event, body);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertPullRequest(normalizedRepository, pullRequestNumber, normalizedHostname, config);
    const payload: Record<string, unknown> = { event };
    if (body !== undefined) payload.body = body;
    const operation = await auditedJsonGh(
      { tool: "review_pull_request", hostname: normalizedHostname, repository: normalizedRepository, pullRequestNumber },
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
  }, async ({ repository, limit }) => {
    assertRepositoryAllowed(repository, config);
    return response(await jsonGh(["run", "list", "--repo", repository, "--limit", String(limit), "--json", "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url"], config));
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
  }, async ({ repository, hostname, workflow, ref, inputs }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const normalizedWorkflow = workflow.trim();
    const normalizedRef = ref.trim();
    const normalizedInputs = normalizeWorkflowInputs(inputs ?? {});
    const workflowPath = `repos/${normalizedRepository}/actions/workflows/${encodeURIComponent(normalizedWorkflow)}`;
    const existing = await jsonGh(["api", workflowPath, "--hostname", normalizedHostname], config);
    assertActiveWorkflow(existing, normalizedWorkflow);
    const operation = await auditedJsonGh(
      { tool: "dispatch_workflow", hostname: normalizedHostname, repository: normalizedRepository, workflow: normalizedWorkflow },
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
  }, async ({ repository, hostname, tagName, targetCommitish, name, body, prerelease, generateReleaseNotes }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
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
      { tool: "create_release", hostname: normalizedHostname, repository: normalizedRepository },
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
  }, async ({ repository, hostname, name, color, description }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const normalizedName = name.trim();
    const payload: Record<string, unknown> = { name: normalizedName, color: color.toLowerCase() };
    if (description !== undefined) payload.description = description;
    const operation = await auditedJsonGh(
      { tool: "create_label", hostname: normalizedHostname, repository: normalizedRepository, label: normalizedName },
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
  }, async ({ repository, hostname, currentName, newName, color, description }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const normalizedCurrentName = currentName.trim();
    const payload: Record<string, unknown> = {};
    if (newName !== undefined) payload.new_name = newName.trim();
    if (color !== undefined) payload.color = color.toLowerCase();
    if (description !== undefined) payload.description = description;
    if (Object.keys(payload).length === 0) throw new Error("At least one label field must be provided.");
    const labelPath = `repos/${normalizedRepository}/labels/${encodeURIComponent(normalizedCurrentName)}`;
    await jsonGh(["api", labelPath, "--hostname", normalizedHostname], config);
    const operation = await auditedJsonGh(
      { tool: "update_label", hostname: normalizedHostname, repository: normalizedRepository, label: normalizedCurrentName },
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
  }, async ({ repository, hostname, title, description, dueOn }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload: Record<string, unknown> = { title: title.trim(), state: "open" };
    if (description !== undefined) payload.description = description;
    if (dueOn !== undefined) payload.due_on = dueOn;
    const operation = await auditedJsonGh(
      { tool: "create_milestone", hostname: normalizedHostname, repository: normalizedRepository },
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
  }, async ({ repository, hostname, milestoneNumber, title, description, state, dueOn }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title.trim();
    if (description !== undefined) payload.description = description;
    if (state !== undefined) payload.state = state;
    if (dueOn !== undefined) payload.due_on = dueOn;
    if (Object.keys(payload).length === 0) throw new Error("At least one milestone field must be provided.");
    const milestonePath = `repos/${normalizedRepository}/milestones/${milestoneNumber}`;
    await jsonGh(["api", milestonePath, "--hostname", normalizedHostname], config);
    const operation = await auditedJsonGh(
      { tool: "update_milestone", hostname: normalizedHostname, repository: normalizedRepository, milestoneNumber },
      ["api", milestonePath, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ milestone: milestoneSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("create_project", {
    description: "Create a private GitHub Projects v2 project for an allowed user or organization. This tool cannot make the project public or delete it.",
    inputSchema: {
      hostname: z.string().min(1).default("github.com"),
      ownerType: z.enum(["user", "organization"]),
      owner: ownerLoginSchema,
      title: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ hostname, ownerType, owner, title }) => {
    assertHostAllowed(hostname, config);
    assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
    const normalizedOwner = owner.trim().toLowerCase();
    const ownerEndpoint = ownerType === "organization" ? `orgs/${normalizedOwner}` : `users/${normalizedOwner}`;
    const ownerResponse = await jsonGh(["api", ownerEndpoint, "--hostname", normalizedHostname], config);
    const ownerId = ownerNodeId(ownerResponse);
    const query = `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id number title url closed public }
      }
    }`;
    const operation = await auditedJsonGh(
      { tool: "create_project", hostname: normalizedHostname, owner: normalizedOwner },
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
      hostname: z.string().min(1).default("github.com"),
      owner: ownerLoginSchema.describe("Allowed owner used as the authorization scope"),
      projectId: projectIdSchema,
      title: z.string().trim().min(1).max(256).optional(),
      shortDescription: z.string().max(256).optional(),
      readme: z.string().max(65_536).optional(),
      closed: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ hostname, owner, projectId, title, shortDescription, readme, closed }) => {
    assertHostAllowed(hostname, config);
    assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
    const normalizedOwner = owner.trim().toLowerCase();
    const normalizedProjectId = projectId.trim();
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
      { stdin: JSON.stringify({ query: readQuery, variables: { projectId: normalizedProjectId } }) },
    );
    assertProjectOwner(existing, normalizedOwner);

    const operation = await auditedJsonGh(
      { tool: "update_project", hostname: normalizedHostname, owner: normalizedOwner, projectId: normalizedProjectId },
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
      hostname: z.string().min(1).default("github.com"),
      owner: ownerLoginSchema,
      projectId: projectIdSchema,
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ hostname, owner, projectId, limit }) => {
    assertHostAllowed(hostname, config);
    assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
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
      { stdin: JSON.stringify({ query, variables: { projectId: projectId.trim(), limit } }) },
    );
    assertProjectOwner(value, owner);
    return response(projectItemsSummary(value));
  });

  server.registerTool("list_project_fields", {
    description: "List field metadata and selectable option IDs for a GitHub Projects v2 project. Item field values are not returned.",
    inputSchema: {
      hostname: z.string().min(1).default("github.com"),
      owner: ownerLoginSchema,
      projectId: projectIdSchema,
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ hostname, owner, projectId, limit }) => {
    assertHostAllowed(hostname, config);
    assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
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
  }, async ({ repository, hostname, owner, projectId, contentType, number }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    assertOwnerAllowed(owner, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertProjectAccess(projectId.trim(), owner, normalizedHostname, config);
    const path = contentType === "issue" ? `repos/${normalizedRepository}/issues/${number}` : `repos/${normalizedRepository}/pulls/${number}`;
    const content = await jsonGh(["api", path, "--hostname", normalizedHostname], config);
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("GitHub API returned an unexpected content response.");
    const contentRecord = content as Record<string, unknown>;
    if (contentType === "issue" && contentRecord.pull_request !== undefined) throw new Error(`Issue #${number} is a pull request.`);
    if (typeof contentRecord.node_id !== "string") throw new Error("GitHub API returned content without a node ID.");
    const query = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id isArchived } }
    }`;
    const operation = await auditedJsonGh(
      { tool: "add_project_item", hostname: normalizedHostname, repository: normalizedRepository, owner: owner.trim().toLowerCase(), projectId: projectId.trim(), ...(contentType === "issue" ? { issueNumber: number } : { pullRequestNumber: number }) },
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
      hostname: z.string().min(1).default("github.com"), owner: ownerLoginSchema,
      projectId: projectIdSchema, itemId: projectItemIdSchema, fieldId: projectFieldIdSchema,
      valueType: z.enum(["text", "number", "date", "singleSelect", "iteration"]),
      value: z.union([z.string().max(65_536), z.number().finite()]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ hostname, owner, projectId, itemId, fieldId, valueType, value }) => {
    assertHostAllowed(hostname, config); assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertProjectAccess(projectId.trim(), owner, normalizedHostname, config);
    const query = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id isArchived } }
    }`;
    const operation = await auditedJsonGh(
      { tool: "set_project_item_field", hostname: normalizedHostname, owner: owner.trim().toLowerCase(), projectId: projectId.trim(), projectItemId: itemId.trim(), projectFieldId: fieldId.trim() },
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { projectId: projectId.trim(), itemId: itemId.trim(), fieldId: fieldId.trim(), value: projectFieldValue(valueType, value) } }, config,
    );
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, "updateProjectV2ItemFieldValue")), audit: operation.audit });
  });

  server.registerTool("clear_project_item_field", {
    description: "Clear one supported field value on a GitHub Projects v2 item.",
    inputSchema: { hostname: z.string().min(1).default("github.com"), owner: ownerLoginSchema, projectId: projectIdSchema, itemId: projectItemIdSchema, fieldId: projectFieldIdSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ hostname, owner, projectId, itemId, fieldId }) => {
    assertHostAllowed(hostname, config); assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertProjectAccess(projectId.trim(), owner, normalizedHostname, config);
    const query = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id isArchived } }
    }`;
    const target = { hostname: normalizedHostname, owner: owner.trim().toLowerCase(), projectId: projectId.trim(), projectItemId: itemId.trim(), projectFieldId: fieldId.trim() };
    const operation = await auditedJsonGh({ tool: "clear_project_item_field", ...target }, ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"], { query, variables: { projectId: projectId.trim(), itemId: itemId.trim(), fieldId: fieldId.trim() } }, config);
    return response({ item: projectItemSummary(graphqlProjectItem(operation.value, "clearProjectV2ItemFieldValue")), audit: operation.audit });
  });

  server.registerTool("set_project_item_archived", {
    description: "Archive or restore a GitHub Projects v2 item. This is reversible and does not delete its Issue or Pull Request.",
    inputSchema: { hostname: z.string().min(1).default("github.com"), owner: ownerLoginSchema, projectId: projectIdSchema, itemId: projectItemIdSchema, archived: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ hostname, owner, projectId, itemId, archived }) => {
    assertHostAllowed(hostname, config); assertOwnerAllowed(owner, config);
    const normalizedHostname = hostname.trim().toLowerCase();
    await assertProjectAccess(projectId.trim(), owner, normalizedHostname, config);
    const operationName = archived ? "archiveProjectV2Item" : "unarchiveProjectV2Item";
    const query = `mutation($projectId: ID!, $itemId: ID!) { ${operationName}(input: { projectId: $projectId, itemId: $itemId }) { item { id isArchived } } }`;
    const operation = await auditedJsonGh(
      { tool: "set_project_item_archived", hostname: normalizedHostname, owner: owner.trim().toLowerCase(), projectId: projectId.trim(), projectItemId: itemId.trim() },
      ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { query, variables: { projectId: projectId.trim(), itemId: itemId.trim() } }, config,
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
  }, async ({ repository, hostname, releaseId, tagName, targetCommitish, name, body, prerelease }) => {
    assertHostAllowed(hostname, config);
    assertRepositoryAllowed(repository, config);
    const normalizedRepository = repository.trim();
    const normalizedHostname = hostname.trim().toLowerCase();
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
    );
    assertDraftRelease(existing, releaseId);
    const operation = await auditedJsonGh(
      { tool: "update_release", hostname: normalizedHostname, repository: normalizedRepository, releaseId },
      ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ release: releaseSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("run_gh", {
    description: "Run an allowlisted, read-only GitHub CLI command. Arguments are passed directly without a shell.",
    inputSchema: { args: z.array(z.string().min(1)).min(1).max(40) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ args }) => {
    assertSafeGhArguments(args);
    const result = await runGh(args, config);
    return response(result);
  });
  return server;
}
