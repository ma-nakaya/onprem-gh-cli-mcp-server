import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  assertOwnerAllowed,
  assertRepositoryAllowed,
} from "../policy.js";
import {
  assertProjectOwner,
  buildUpdateProjectMutation,
  graphqlDeletedItemId,
  graphqlProject,
  graphqlProjectField,
  graphqlProjectItem,
  ownerNodeId,
  projectFieldSummary,
  projectFieldValue,
  projectFieldsSummary,
  projectIdentifier,
  projectItemsSummary,
  projectItemSummary,
  projectSummary,
} from "../project.js";
import {
  assertProjectAccess,
  auditedGraphqlGh,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  response,
  verifiedRequestContext,
} from "../server-support.js";

export function registerProjectTools(server: McpServer, config: Config): void {
  const { requestContextSchema, writeContextSchema } = buildContextSchemas(config);
  const {
    ownerLoginSchema, projectFieldIdSchema, projectIdSchema, projectItemIdSchema,
  } = buildSharedSchemas();

server.registerTool("create_project", {
  description: "Create a GitHub Projects v2 project for an allowed user or organization. New projects are always private; use update_project to change visibility.",
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
  description: "Update a GitHub Projects v2 title, descriptions, visibility (public), or reversible open/closed state.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema.describe("Allowed owner used as the authorization scope"),
    projectId: projectIdSchema,
    title: z.string().trim().min(1).max(256).optional(),
    shortDescription: z.string().max(256).optional(),
    readme: z.string().max(65_536).optional(),
    closed: z.boolean().optional(),
    public: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, owner, projectId, title, shortDescription, readme, closed, public: isPublic }) => {
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
    ...(isPublic === undefined ? {} : { public: isPublic }),
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
  description: "Add an existing Issue or Pull Request to a GitHub Projects v2 project.",
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
server.registerTool("delete_project", {
  description: "Delete a GitHub Projects v2 project. The exact current project title must be repeated as confirmation. This operation cannot be undone by this MCP server; the contained Issues and Pull Requests are not deleted.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema.describe("Allowed owner used as the authorization scope"),
    projectId: projectIdSchema,
    confirmTitle: z.string().trim().min(1).max(256)
      .describe("Repeat the exact current title of the project"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, hostname, owner, projectId, confirmTitle }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const request = await prepareWriteRequest({
    tool: "delete_project",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  const readQuery = `query($projectId: ID!) {
    node(id: $projectId) { __typename ... on ProjectV2 { id number title url closed public owner { ... on User { login } ... on Organization { login } } } }
  }`;
  const existing = await jsonGh(
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    config,
    context,
    { stdin: JSON.stringify({ query: readQuery, variables: { projectId: normalizedProjectId } }) },
  );
  const project = assertProjectOwner(existing, normalizedOwner);
  if (confirmTitle !== project.title) {
    throw new Error("confirmTitle must exactly match the current project title; refusing project deletion.");
  }
  const query = `mutation($projectId: ID!) {
    deleteProjectV2(input: { projectId: $projectId }) {
      projectV2 { id number title url closed public }
    }
  }`;
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables: { projectId: normalizedProjectId } },
    config,
  );
  return response({
    deleted: { project: projectSummary(graphqlProject(operation.value, "deleteProjectV2")) },
    audit: operation.audit,
  });
});

server.registerTool("create_project_draft_item", {
  description: "Create a draft item in a GitHub Projects v2 project. The title and body are sent through stdin and are not written to the audit log.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema,
    projectId: projectIdSchema,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(65_536).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, hostname, owner, projectId, title, body }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const request = await prepareWriteRequest({
    tool: "create_project_draft_item",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  await assertProjectAccess(normalizedProjectId, owner, config, context);
  const query = `mutation($projectId: ID!, $title: String!, $body: String) {
    addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
      projectV2Item { id isArchived }
    }
  }`;
  const variables: Record<string, unknown> = { projectId: normalizedProjectId, title: title.trim() };
  if (body !== undefined) variables.body = body;
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables },
    config,
    (value) => ({ projectItemId: String(graphqlProjectItem(value, "addProjectV2DraftIssue").id) }),
  );
  return response({
    item: projectItemSummary(graphqlProjectItem(operation.value, "addProjectV2DraftIssue")),
    audit: operation.audit,
  });
});

server.registerTool("delete_project_item", {
  description: "Delete an item from a GitHub Projects v2 project. The underlying Issue or Pull Request is not deleted. This operation cannot be undone by this MCP server.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema,
    projectId: projectIdSchema,
    itemId: projectItemIdSchema,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, hostname, owner, projectId, itemId }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const normalizedItemId = itemId.trim();
  const request = await prepareWriteRequest({
    tool: "delete_project_item",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
    projectItemId: normalizedItemId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  await assertProjectAccess(normalizedProjectId, owner, config, context);
  const query = `mutation($projectId: ID!, $itemId: ID!) {
    deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
  }`;
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables: { projectId: normalizedProjectId, itemId: normalizedItemId } },
    config,
  );
  return response({
    deleted: { itemId: graphqlDeletedItemId(operation.value), projectId: normalizedProjectId },
    audit: operation.audit,
  });
});

const singleSelectOptionSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(128),
  color: z.enum(["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"]).default("GRAY"),
  description: z.string().max(256).optional(),
});

const iterationConfigurationSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Iteration start dates must use YYYY-MM-DD."),
  durationDays: z.number().int().min(1).max(365),
  iterations: z.array(z.object({
    title: z.string().trim().min(1).max(256),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Iteration start dates must use YYYY-MM-DD."),
    durationDays: z.number().int().min(1).max(365).optional(),
  })).max(50).optional(),
});

server.registerTool("create_project_field", {
  description: "Create a TEXT, NUMBER, DATE, SINGLE_SELECT, or ITERATION field on a GitHub Projects v2 project. SINGLE_SELECT requires at least one option; ITERATION requires an iteration configuration.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema,
    projectId: projectIdSchema,
    name: z.string().trim().min(1).max(256),
    dataType: z.enum(["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"]),
    singleSelectOptions: z.array(singleSelectOptionSchema).min(1).max(50).optional(),
    iterationConfiguration: iterationConfigurationSchema.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ account, hostname, owner, projectId, name, dataType, singleSelectOptions, iterationConfiguration }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const request = await prepareWriteRequest({
    tool: "create_project_field",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  if (dataType === "SINGLE_SELECT" && (singleSelectOptions === undefined || singleSelectOptions.length === 0)) {
    throw new Error("SINGLE_SELECT fields require at least one option.");
  }
  if (dataType !== "SINGLE_SELECT" && singleSelectOptions !== undefined) {
    throw new Error("singleSelectOptions can only be provided for SINGLE_SELECT fields.");
  }
  if (dataType === "ITERATION" && iterationConfiguration === undefined) {
    throw new Error("ITERATION fields require an iteration configuration.");
  }
  if (dataType !== "ITERATION" && iterationConfiguration !== undefined) {
    throw new Error("iterationConfiguration can only be provided for ITERATION fields.");
  }
  await assertProjectAccess(normalizedProjectId, owner, config, context);
  const query = `mutation($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!], $iterationConfiguration: ProjectV2IterationFieldConfigurationInput) {
    createProjectV2Field(input: { projectId: $projectId, dataType: $dataType, name: $name, singleSelectOptions: $options, iterationConfiguration: $iterationConfiguration }) {
      projectV2Field { id name dataType __typename ... on ProjectV2SingleSelectField { options { id name } } }
    }
  }`;
  const variables: Record<string, unknown> = {
    projectId: normalizedProjectId,
    dataType,
    name: name.trim(),
  };
  if (singleSelectOptions !== undefined) {
    variables.options = singleSelectOptions.map((option) => ({
      name: option.name,
      color: option.color,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
  }
  if (iterationConfiguration !== undefined) {
    variables.iterationConfiguration = {
      startDate: iterationConfiguration.startDate,
      duration: iterationConfiguration.durationDays,
      ...(iterationConfiguration.iterations === undefined ? {} : {
        iterations: iterationConfiguration.iterations.map((iteration) => ({
          title: iteration.title,
          startDate: iteration.startDate,
          ...(iteration.durationDays === undefined ? {} : { duration: iteration.durationDays }),
        })),
      }),
    };
  }
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables },
    config,
    (value) => ({ projectFieldId: String(graphqlProjectField(value, "createProjectV2Field").id) }),
  );
  return response({
    field: projectFieldSummary(graphqlProjectField(operation.value, "createProjectV2Field")),
    audit: operation.audit,
  });
});

server.registerTool("update_project_field", {
  description: "Rename a GitHub Projects v2 field, or replace the options of a single-select field. Options with an id keep that option; options without an id are created.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema,
    projectId: projectIdSchema,
    fieldId: projectFieldIdSchema,
    name: z.string().trim().min(1).max(256).optional(),
    singleSelectOptions: z.array(singleSelectOptionSchema).min(1).max(50).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, owner, projectId, fieldId, name, singleSelectOptions }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const normalizedFieldId = fieldId.trim();
  const request = await prepareWriteRequest({
    tool: "update_project_field",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
    projectFieldId: normalizedFieldId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  if (name === undefined && singleSelectOptions === undefined) {
    throw new Error("At least one field update must be provided.");
  }
  await assertProjectAccess(normalizedProjectId, owner, config, context);
  const query = `mutation($fieldId: ID!, $name: String, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    updateProjectV2Field(input: { fieldId: $fieldId, name: $name, singleSelectOptions: $options }) {
      projectV2Field { id name dataType __typename ... on ProjectV2SingleSelectField { options { id name } } }
    }
  }`;
  const variables: Record<string, unknown> = { fieldId: normalizedFieldId };
  if (name !== undefined) variables.name = name.trim();
  if (singleSelectOptions !== undefined) {
    variables.options = singleSelectOptions.map((option) => ({
      ...(option.id === undefined ? {} : { id: option.id }),
      name: option.name,
      color: option.color,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
  }
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables },
    config,
    (value) => ({ projectFieldId: String(graphqlProjectField(value, "updateProjectV2Field").id) }),
  );
  return response({
    field: projectFieldSummary(graphqlProjectField(operation.value, "updateProjectV2Field")),
    audit: operation.audit,
  });
});

server.registerTool("delete_project_field", {
  description: "Delete a field definition from a GitHub Projects v2 project. Values stored in this field are lost. This operation cannot be undone by this MCP server.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema,
    projectId: projectIdSchema,
    fieldId: projectFieldIdSchema,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ account, hostname, owner, projectId, fieldId }) => {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedProjectId = projectId.trim();
  const normalizedFieldId = fieldId.trim();
  const request = await prepareWriteRequest({
    tool: "delete_project_field",
    owner: normalizedOwner,
    projectId: normalizedProjectId,
    projectFieldId: normalizedFieldId,
  }, config, account, hostname);
  const { context } = request;
  assertOwnerAllowed(owner, context);
  const normalizedHostname = context.profile.hostname;
  await assertProjectAccess(normalizedProjectId, owner, config, context);
  const query = `mutation($fieldId: ID!) {
    deleteProjectV2Field(input: { fieldId: $fieldId }) {
      projectV2Field { id name dataType __typename }
    }
  }`;
  const operation = await auditedGraphqlGh(
    request,
    ["api", "graphql", "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
    { query, variables: { fieldId: normalizedFieldId } },
    config,
  );
  return response({
    deleted: { field: projectFieldSummary(graphqlProjectField(operation.value, "deleteProjectV2Field")) },
    audit: operation.audit,
  });
});
}
