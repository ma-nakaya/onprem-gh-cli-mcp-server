import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { assertRepositoryAllowed } from "../policy.js";
import {
  milestoneIdentifier,
  milestoneSummary,
} from "../repository-metadata.js";
import {
  auditedJsonGh,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  response,
} from "../server-support.js";

export function registerMilestoneTools(server: McpServer, config: Config): void {
  const { writeContextSchema } = buildContextSchemas(config);
  const { dueOnSchema } = buildSharedSchemas();

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

}
