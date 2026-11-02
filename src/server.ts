
import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  z,
} from "zod";

import type {
  Config,
} from "./config.js";
import {
  runGh,
} from "./gh-runner.js";
import {
  assertRunGhAllowedByResourceScope,
  assertSafeGhArguments,
} from "./policy.js";
import {
  response,
  verifiedRequestContext,
  buildContextSchemas,
} from "./server-support.js";
import {
  registerWorkflowTools,
} from "./tools/workflows.js";
import {
  registerRepositoryTools,
} from "./tools/repositories.js";
import {
  registerProjectTools,
} from "./tools/projects.js";
import {
  registerReleaseTools,
} from "./tools/releases.js";
import {
  registerLabelTools,
} from "./tools/labels.js";
import {
  registerMilestoneTools,
} from "./tools/milestones.js";
import {
  registerSecretTools,
} from "./tools/secrets.js";
import {
  registerPullRequestMutationTools,
} from "./tools/pull-request-mutations.js";
import {
  registerPullRequestTools,
} from "./tools/pull-requests.js";
import {
  registerIssueTools,
} from "./tools/issues.js";

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "onprem-gh-cli-mcp", version: "0.1.0" });
  const { requestContextSchema } = buildContextSchemas(config);

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

  registerRepositoryTools(server, config);


  registerIssueTools(server, config);
  registerPullRequestTools(server, config);

  registerPullRequestMutationTools(server, config);
  registerWorkflowTools(server, config);

  registerReleaseTools(server, config);
  registerLabelTools(server, config);
  registerMilestoneTools(server, config);
  registerProjectTools(server, config);
  registerSecretTools(server, config);
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
