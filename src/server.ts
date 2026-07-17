import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { runGh } from "./gh-runner.js";
import { assertHostAllowed, assertRepositoryAllowed, assertSafeGhArguments } from "./policy.js";

function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function jsonGh(args: string[], config: Config): Promise<unknown> {
  const result = await runGh(args, config);
  try { return JSON.parse(result.stdout || "null"); }
  catch { throw new Error("GitHub CLI returned invalid JSON."); }
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
  server.registerTool("list_issues", {
    description: "List issues in an allowed repository.",
    inputSchema: { ...repositorySchema, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ repository, state, limit }) => {
    assertRepositoryAllowed(repository, config);
    return response(await jsonGh(["issue", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,state,author,assignees,labels,createdAt,updatedAt,url"], config));
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
