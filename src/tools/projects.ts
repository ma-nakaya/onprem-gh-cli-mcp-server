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
  graphqlProject,
  graphqlProjectItem,
  ownerNodeId,
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
  description: "Create a private GitHub Projects v2 project for an allowed user or organization. This tool cannot make the project public or delete it.",
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
  description: "Update a GitHub Projects v2 title, descriptions, or reversible open/closed state. This tool cannot change visibility or delete a project.",
  inputSchema: {
    ...requestContextSchema,
    owner: ownerLoginSchema.describe("Allowed owner used as the authorization scope"),
    projectId: projectIdSchema,
    title: z.string().trim().min(1).max(256).optional(),
    shortDescription: z.string().max(256).optional(),
    readme: z.string().max(65_536).optional(),
    closed: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ account, hostname, owner, projectId, title, shortDescription, readme, closed }) => {
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
  description: "Add an existing Issue or Pull Request to a GitHub Projects v2 project. Draft items cannot be created.",
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
}
