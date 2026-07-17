import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendAuditRecord } from "./audit-log.js";
import type { Config } from "./config.js";
import { runGh } from "./gh-runner.js";
import type { RunGhOptions } from "./gh-runner.js";
import { assertHostAllowed, assertRepositoryAllowed, assertSafeGhArguments } from "./policy.js";

function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function jsonGh(args: string[], config: Config, options: RunGhOptions = {}): Promise<unknown> {
  const result = await runGh(args, config, options);
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error("GitHub CLI returned invalid JSON."); }
}

interface AuditTarget {
  tool: string;
  hostname: string;
  repository: string;
  issueNumber?: number;
}

async function auditedJsonGh(
  target: AuditTarget,
  args: string[],
  payload: Record<string, unknown>,
  config: Config,
): Promise<{ value: unknown; audit: { started: true; completed: boolean } }> {
  const startedAt = Date.now();
  await appendAuditRecord(config.auditLogPath, {
    ...target,
    outcome: "started",
    durationMs: 0,
  });
  try {
    const value = await jsonGh(args, config, { stdin: JSON.stringify(payload) });
    let completed = true;
    try {
      await appendAuditRecord(config.auditLogPath, {
        ...target,
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
    const payload = body === undefined ? { title } : { title, body };
    const operation = await auditedJsonGh(
      { tool: "create_issue", hostname, repository },
      ["api", `repos/${repository}/issues`, "--hostname", hostname, "--method", "POST", "--input", "-"],
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
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (Object.keys(payload).length === 0) throw new Error("At least one of title, body, or state must be provided.");
    const operation = await auditedJsonGh(
      { tool: "update_issue", hostname, repository, issueNumber },
      ["api", `repos/${repository}/issues/${issueNumber}`, "--hostname", hostname, "--method", "PATCH", "--input", "-"],
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
    const operation = await auditedJsonGh(
      { tool: "comment_issue", hostname, repository, issueNumber },
      ["api", `repos/${repository}/issues/${issueNumber}/comments`, "--hostname", hostname, "--method", "POST", "--input", "-"],
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

  server.registerTool("list_workflow_runs", {
    description: "List GitHub Actions workflow runs in an allowed repository.",
    inputSchema: { ...repositorySchema, limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ repository, limit }) => {
    assertRepositoryAllowed(repository, config);
    return response(await jsonGh(["run", "list", "--repo", repository, "--limit", String(limit), "--json", "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url"], config));
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
