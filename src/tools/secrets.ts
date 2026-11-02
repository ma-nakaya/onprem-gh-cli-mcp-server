import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runGh } from "../gh-runner.js";
import { assertRepositoryAllowed } from "../policy.js";
import { repositorySecretsPage } from "../secrets.js";
import {
  REPOSITORY_CONTENT_TRUST,
  auditedOperation,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  repositorySource,
  response,
  responseWithinOutputLimit,
  verifiedRepositoryReadContext,
} from "../server-support.js";

const secretNameSchema = z.string().trim().min(1).max(100)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "Secret names must start with a letter or underscore and contain only letters, digits, and underscores.",
  )
  .refine(
    (name) => !/^github_/i.test(name),
    "Secret names must not start with the reserved GITHUB_ prefix.",
  );

export function registerSecretTools(server: McpServer, config: Config): void {
  const { repositorySchema, writeContextSchema } = buildContextSchemas(config);
  const { apiPageSchema, apiPerPageSchema } = buildSharedSchemas();

  server.registerTool("list_repository_secrets", {
    description: "List the names and timestamps of GitHub Actions secrets on an allowed repository. The GitHub API never returns secret values, and this tool never exposes them.",
    inputSchema: {
      ...repositorySchema,
      page: apiPageSchema,
      perPage: apiPerPageSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, page, perPage }) => {
    const readRequest = await verifiedRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const value = await jsonGh([
      "api",
      `repos/${readRequest.repository}/actions/secrets?per_page=${perPage}&page=${page}`,
      "--hostname",
      readRequest.context.profile.hostname,
    ], config, readRequest.context);
    const secretsPage = repositorySecretsPage(value);
    return responseWithinOutputLimit({
      secrets: secretsPage.secrets,
      pagination: {
        page,
        perPage,
        returnedCount: secretsPage.secrets.length,
        totalCount: secretsPage.totalCount,
      },
      source: repositorySource(readRequest.context, readRequest.repository),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("set_repository_secret", {
    description: "Create or update a GitHub Actions secret on an allowed repository. The value is passed to gh through stdin only: it is never written to the audit log, never included in the response, and never placed in process arguments. Only the secret name is audited.",
    inputSchema: {
      ...writeContextSchema,
      secretName: secretNameSchema,
      secretValue: z.string().min(1).max(65_536),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, secretName, secretValue }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "set_repository_secret",
      repository: normalizedRepository,
      secretName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(normalizedRepository, context);
    const operation = await auditedOperation(
      request,
      config,
      () => runGh(
        ["secret", "set", secretName, "--repo", normalizedRepository],
        config,
        context,
        { stdin: secretValue },
      ),
    );
    return response({
      secret: { name: secretName, repository: normalizedRepository },
      audit: operation.audit,
    });
  });

  server.registerTool("delete_repository_secret", {
    description: "Delete a GitHub Actions secret from an allowed repository. The secret value is not needed and is never requested. Only the secret name is audited.",
    inputSchema: {
      ...writeContextSchema,
      secretName: secretNameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, repository, hostname, secretName }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "delete_repository_secret",
      repository: normalizedRepository,
      secretName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(normalizedRepository, context);
    const operation = await auditedOperation(
      request,
      config,
      () => runGh([
        "api",
        `repos/${normalizedRepository}/actions/secrets/${secretName}`,
        "--hostname",
        context.profile.hostname,
        "--method",
        "DELETE",
      ], config, context),
    );
    return response({
      deleted: { secretName, repository: normalizedRepository },
      audit: operation.audit,
    });
  });
}
