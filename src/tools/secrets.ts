import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runGh } from "../gh-runner.js";
import { assertOwnerAllowed, assertRepositoryAllowed } from "../policy.js";
import { organizationSecretsPage, repositorySecretsPage } from "../secrets.js";
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
  verifiedRequestContext,
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
  const { repositorySchema, requestContextSchema, writeContextSchema } = buildContextSchemas(config);
  const { apiPageSchema, apiPerPageSchema, ownerLoginSchema } = buildSharedSchemas();

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
  const environmentSchema = z.string().trim().min(1).max(255);

  server.registerTool("list_organization_secrets", {
    description: "List the names, timestamps, and visibility of GitHub Actions secrets on an allowed organization. Secret values are never returned by the GitHub API and are never exposed by this tool.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema,
      page: apiPageSchema,
      perPage: apiPerPageSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, owner, page, perPage }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertOwnerAllowed(owner, context);
    const value = await jsonGh([
      "api",
      `orgs/${owner.trim()}/actions/secrets?per_page=${perPage}&page=${page}`,
      "--hostname",
      context.profile.hostname,
    ], config, context);
    const secretsPage = organizationSecretsPage(value);
    return responseWithinOutputLimit({
      secrets: secretsPage.secrets,
      pagination: {
        page,
        perPage,
        returnedCount: secretsPage.secrets.length,
        totalCount: secretsPage.totalCount,
      },
      source: { owner: owner.trim(), hostname: context.profile.hostname },
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("set_organization_secret", {
    description: "Create or update a GitHub Actions secret on an allowed organization. The value is passed to gh through stdin only: it is never written to the audit log, never included in the response, and never placed in process arguments. Only the secret name is audited. visibility=selected requires a non-empty repositories list of repository names inside the organization.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema,
      secretName: secretNameSchema,
      secretValue: z.string().min(1).max(65_536),
      visibility: z.enum(["all", "private", "selected"]),
      repositories: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, owner, secretName, secretValue, visibility, repositories }) => {
    const normalizedOwner = owner.trim();
    const request = await prepareWriteRequest({
      tool: "set_organization_secret",
      owner: normalizedOwner,
      secretName,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    if (visibility === "selected" && (repositories === undefined || repositories.length === 0)) {
      throw new Error("visibility=selected requires at least one repository name.");
    }
    if (visibility !== "selected" && repositories !== undefined) {
      throw new Error("repositories can only be provided when visibility is selected.");
    }
    const args = [
      "secret", "set", secretName,
      "--org", normalizedOwner,
      "--visibility", visibility,
    ];
    if (visibility === "selected" && repositories !== undefined) {
      args.push("--repos", repositories.join(","));
    }
    const operation = await auditedOperation(
      request,
      config,
      () => runGh(args, config, context, { stdin: secretValue }),
    );
    return response({
      secret: { name: secretName, owner: normalizedOwner, visibility },
      audit: operation.audit,
    });
  });

  server.registerTool("delete_organization_secret", {
    description: "Delete a GitHub Actions secret from an allowed organization. Only the secret name is audited.",
    inputSchema: {
      ...requestContextSchema,
      owner: ownerLoginSchema,
      secretName: secretNameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, hostname, owner, secretName }) => {
    const normalizedOwner = owner.trim();
    const request = await prepareWriteRequest({
      tool: "delete_organization_secret",
      owner: normalizedOwner,
      secretName,
    }, config, account, hostname);
    const { context } = request;
    assertOwnerAllowed(owner, context);
    const operation = await auditedOperation(
      request,
      config,
      () => runGh([
        "api",
        `orgs/${normalizedOwner}/actions/secrets/${secretName}`,
        "--hostname",
        context.profile.hostname,
        "--method",
        "DELETE",
      ], config, context),
    );
    return response({
      deleted: { secretName, owner: normalizedOwner },
      audit: operation.audit,
    });
  });

  server.registerTool("list_environment_secrets", {
    description: "List the names and timestamps of GitHub Actions environment secrets on an allowed repository. Secret values are never returned by the GitHub API and are never exposed by this tool.",
    inputSchema: {
      ...repositorySchema,
      environment: environmentSchema,
      page: apiPageSchema,
      perPage: apiPerPageSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, environment, page, perPage }) => {
    const readRequest = await verifiedRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const value = await jsonGh([
      "api",
      `repos/${readRequest.repository}/environments/${encodeURIComponent(environment)}/secrets?per_page=${perPage}&page=${page}`,
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

  server.registerTool("set_environment_secret", {
    description: "Create or update a GitHub Actions environment secret on an allowed repository. The value is passed to gh through stdin only: it is never written to the audit log, never included in the response, and never placed in process arguments. Only the secret name is audited.",
    inputSchema: {
      ...writeContextSchema,
      environment: environmentSchema,
      secretName: secretNameSchema,
      secretValue: z.string().min(1).max(65_536),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, environment, secretName, secretValue }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "set_environment_secret",
      repository: normalizedRepository,
      secretName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(normalizedRepository, context);
    const operation = await auditedOperation(
      request,
      config,
      () => runGh(
        ["secret", "set", secretName, "--repo", normalizedRepository, "--env", environment],
        config,
        context,
        { stdin: secretValue },
      ),
    );
    return response({
      secret: { name: secretName, repository: normalizedRepository, environment },
      audit: operation.audit,
    });
  });

  server.registerTool("delete_environment_secret", {
    description: "Delete a GitHub Actions environment secret from an allowed repository. Only the secret name is audited.",
    inputSchema: {
      ...writeContextSchema,
      environment: environmentSchema,
      secretName: secretNameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, repository, hostname, environment, secretName }) => {
    const normalizedRepository = repository.trim();
    const request = await prepareWriteRequest({
      tool: "delete_environment_secret",
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
        `repos/${normalizedRepository}/environments/${encodeURIComponent(environment)}/secrets/${secretName}`,
        "--hostname",
        context.profile.hostname,
        "--method",
        "DELETE",
      ], config, context),
    );
    return response({
      deleted: { secretName, repository: normalizedRepository, environment },
      audit: operation.audit,
    });
  });
}
