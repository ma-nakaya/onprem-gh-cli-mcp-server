import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { assertRepositoryAllowed } from "../policy.js";
import {
  assertDraftRelease,
  releaseIdentifier,
  releaseSummary,
} from "../release.js";
import {
  auditedJsonGh,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  response,
} from "../server-support.js";

export function registerReleaseTools(server: McpServer, config: Config): void {
  const { writeContextSchema } = buildContextSchemas(config);
  const { gitRefSchema } = buildSharedSchemas();

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
}
