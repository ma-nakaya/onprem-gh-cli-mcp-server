import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { assertRepositoryAllowed } from "../policy.js";
import {
  assertDraftRelease,
  assertPublishableRelease,
  releaseAssetsPage,
  releaseIdentifier,
  releaseSummary,
  releaseTagName,
} from "../release.js";
import { runGh } from "../gh-runner.js";
import {
  REPOSITORY_CONTENT_TRUST,
  auditedOperation,
  auditedJsonGh,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  repositorySource,
  response,
  responseWithinOutputLimit,
  verifiedRepositoryReadContext,
} from "../server-support.js";

export function registerReleaseTools(server: McpServer, config: Config): void {
  const { repositorySchema, writeContextSchema } = buildContextSchemas(config);
  const { gitRefSchema, apiPageSchema, apiPerPageSchema } = buildSharedSchemas();

server.registerTool("create_release", {
  description: "Create a draft release in an allowed repository. Use publish_release to publish the draft. The release body is sent through stdin and is not written to the audit log.",
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

server.registerTool("update_release", {
  description: "Update metadata for an existing draft release. Published releases cannot be changed by this tool; use publish_release to publish a draft.",
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
server.registerTool("publish_release", {
  description: "Publish an existing draft release in an allowed repository. Only draft releases can be published. This server cannot unpublish a release afterwards.",
  inputSchema: {
    ...writeContextSchema,
    releaseId: z.number().int().positive(),
    prerelease: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, repository, hostname, releaseId, prerelease }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "publish_release",
    repository: normalizedRepository,
    releaseId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  const existing = await jsonGh(
    ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname],
    config,
    context,
  );
  assertPublishableRelease(existing, releaseId);
  const payload: Record<string, unknown> = { draft: false };
  if (prerelease !== undefined) payload.prerelease = prerelease;
  const operation = await auditedJsonGh(
    request,
    ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
    payload,
    config,
  );
  return response({ release: releaseSummary(operation.value), audit: operation.audit });
});
server.registerTool("delete_release", {
  description: "Delete a release (draft or published) from an allowed repository. The tag itself is not deleted. This operation cannot be undone by this MCP server.",
  inputSchema: {
    ...writeContextSchema,
    releaseId: z.number().int().positive(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, repository, hostname, releaseId }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "delete_release",
    repository: normalizedRepository,
    releaseId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  const existing = await jsonGh(
    ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname],
    config,
    context,
  );
  const tagName = releaseTagName(existing);
  const operation = await auditedOperation(
    request,
    config,
    () => runGh([
      "api",
      `repos/${normalizedRepository}/releases/${releaseId}`,
      "--hostname",
      normalizedHostname,
      "--method",
      "DELETE",
    ], config, context),
  );
  return response({
    deleted: { releaseId, tagName, repository: normalizedRepository },
    audit: operation.audit,
  });
});

server.registerTool("list_release_assets", {
  description: "List the assets attached to a release in an allowed repository, with their IDs, names, sizes, and download counts.",
  inputSchema: {
    ...repositorySchema,
    releaseId: z.number().int().positive(),
    page: apiPageSchema,
    perPage: apiPerPageSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ account, hostname, repository, releaseId, page, perPage }) => {
  const readRequest = await verifiedRepositoryReadContext(
    config,
    repository,
    account,
    hostname,
  );
  const value = await jsonGh([
    "api",
    `repos/${readRequest.repository}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    "--hostname",
    readRequest.context.profile.hostname,
  ], config, readRequest.context);
  const assets = releaseAssetsPage(value);
  return responseWithinOutputLimit({
    assets,
    pagination: { page, perPage, returnedCount: assets.length },
    source: repositorySource(readRequest.context, readRequest.repository),
    contentTrust: REPOSITORY_CONTENT_TRUST,
  }, config);
});

server.registerTool("upload_release_asset", {
  description: "Upload a local file as an asset of an existing release in an allowed repository. The asset name is the file base name. The file is read by the local gh CLI; its contents are not included in the response or the audit log.",
  inputSchema: {
    ...writeContextSchema,
    releaseId: z.number().int().positive(),
    filePath: z.string().trim().min(1).max(1024),
    clobber: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, repository, hostname, releaseId, filePath, clobber }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "upload_release_asset",
    repository: normalizedRepository,
    releaseId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const normalizedHostname = context.profile.hostname;
  const existing = await jsonGh(
    ["api", `repos/${normalizedRepository}/releases/${releaseId}`, "--hostname", normalizedHostname],
    config,
    context,
  );
  const tagName = releaseTagName(existing);
  const args = ["release", "upload", tagName, filePath, "--repo", normalizedRepository];
  if (clobber) args.push("--clobber");
  const operation = await auditedOperation(
    request,
    config,
    () => runGh(args, config, context),
  );
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  return response({
    uploaded: { releaseId, tagName, name, repository: normalizedRepository },
    audit: operation.audit,
  });
});

server.registerTool("delete_release_asset", {
  description: "Delete one asset from a release in an allowed repository by its asset ID (see list_release_assets). This operation cannot be undone by this MCP server.",
  inputSchema: {
    ...writeContextSchema,
    releaseAssetId: z.number().int().positive(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, repository, hostname, releaseAssetId }) => {
  const normalizedRepository = repository.trim();
  const request = await prepareWriteRequest({
    tool: "delete_release_asset",
    repository: normalizedRepository,
    releaseAssetId,
  }, config, account, hostname);
  const { context } = request;
  assertRepositoryAllowed(repository, context);
  const operation = await auditedOperation(
    request,
    config,
    () => runGh([
      "api",
      `repos/${normalizedRepository}/releases/assets/${releaseAssetId}`,
      "--hostname",
      context.profile.hostname,
      "--method",
      "DELETE",
    ], config, context),
  );
  return response({
    deleted: { releaseAssetId, repository: normalizedRepository },
    audit: operation.audit,
  });
});
}
