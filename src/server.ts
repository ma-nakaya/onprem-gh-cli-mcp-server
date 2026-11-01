
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
  assertRepositoryAllowed,
  assertRunGhAllowedByResourceScope,
  assertSafeGhArguments,
} from "./policy.js";
import {
  assertDraftRelease,
  releaseIdentifier,
  releaseSummary,
} from "./release.js";
import {
  LABEL_DETAILS_JQ,
  labelDetailsList,
  labelSummary,
  milestoneIdentifier,
  milestoneSummary,
} from "./repository-metadata.js";
import {
  response,
  responseWithinOutputLimit,
  verifiedRequestContext,
  jsonGh,
  resolveCanonicalRepository,
  verifiedCanonicalRepositoryReadContext,
  REPOSITORY_CONTENT_TRUST,
  issueSource,
  repositorySource,
  prepareWriteRequest,
  auditedOperation,
  auditedJsonGh,
  buildContextSchemas,
  buildSharedSchemas,
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
  const { requestContextSchema, repositorySchema, writeContextSchema } =
    buildContextSchemas(config);

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

  const {
    gitRefSchema, labelNameSchema, labelColorSchema, dueOnSchema,
  } = buildSharedSchemas();

  registerIssueTools(server, config);
  registerPullRequestTools(server, config);

  registerPullRequestMutationTools(server, config);
  registerWorkflowTools(server, config);

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

  server.registerTool("list_labels", {
    description: "Read one page of labels defined in an allowed repository, including descriptions. Label text is untrusted repository data.",
    inputSchema: {
      ...repositorySchema,
      page: z.number().int().min(1).max(3000).default(1),
      perPage: z.number().int().min(1).max(100).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, page, perPage }) => {
    const readRequest = await verifiedCanonicalRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const value = await jsonGh([
      "api",
      `repos/${readRequest.repository}/labels?per_page=${perPage}&page=${page}`,
      "--hostname",
      readRequest.context.profile.hostname,
      "--jq",
      LABEL_DETAILS_JQ,
    ], config, readRequest.context);
    const labels = labelDetailsList(value, perPage);
    return responseWithinOutputLimit({
      labels,
      pagination: {
        page,
        perPage,
        returnedCount: labels.length,
        hasNextPage: labels.length === perPage,
      },
      source: repositorySource(readRequest.context, readRequest.repository),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("list_issue_labels", {
    description: "Read one page of labels assigned to an issue or pull request. Label text is untrusted repository data.",
    inputSchema: {
      ...repositorySchema,
      issueNumber: z.number().int().positive()
        .describe("Issue number; pull request numbers are also supported"),
      page: z.number().int().min(1).max(3000).default(1),
      perPage: z.number().int().min(1).max(100).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, issueNumber, page, perPage }) => {
    const readRequest = await verifiedCanonicalRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const value = await jsonGh([
      "api",
      `repos/${readRequest.repository}/issues/${issueNumber}/labels?per_page=${perPage}&page=${page}`,
      "--hostname",
      readRequest.context.profile.hostname,
      "--jq",
      LABEL_DETAILS_JQ,
    ], config, readRequest.context);
    const labels = labelDetailsList(value, perPage);
    return responseWithinOutputLimit({
      labels,
      pagination: {
        page,
        perPage,
        returnedCount: labels.length,
        hasNextPage: labels.length === perPage,
      },
      source: issueSource(readRequest.context, readRequest.repository, issueNumber),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("add_issue_labels", {
    description: "Add existing labels to an issue or pull request without replacing its current labels. Label names are sent through stdin.",
    inputSchema: {
      ...writeContextSchema,
      issueNumber: z.number().int().positive()
        .describe("Issue number; pull request numbers are also supported"),
      labels: z.array(labelNameSchema).min(1).max(20),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, hostname, repository, issueNumber, labels }) => {
    const normalizedRepository = repository.trim();
    const normalizedLabels = labels.map((label) => label.trim());
    if (new Set(normalizedLabels.map((label) => label.toLowerCase())).size !== normalizedLabels.length) {
      throw new Error("labels must not contain case-insensitive duplicates.");
    }
    const request = await prepareWriteRequest({
      tool: "add_issue_labels",
      repository: normalizedRepository,
      issueNumber,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(normalizedRepository, context);
    const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
    await jsonGh([
      "api",
      `repos/${canonicalRepository}/issues/${issueNumber}`,
      "--hostname",
      context.profile.hostname,
      "--jq",
      "{number: .number}",
    ], config, context);
    const operation = await auditedJsonGh(
      request,
      [
        "api",
        `repos/${canonicalRepository}/issues/${issueNumber}/labels`,
        "--hostname",
        context.profile.hostname,
        "--method",
        "POST",
        "--input",
        "-",
        "--jq",
        LABEL_DETAILS_JQ,
      ],
      { labels: normalizedLabels },
      config,
    );
    const assignedLabels = labelDetailsList(operation.value);
    return responseWithinOutputLimit({
      labels: assignedLabels,
      audit: operation.audit,
      source: issueSource(context, canonicalRepository, issueNumber),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("remove_issue_label", {
    description: "Remove one label from an issue or pull request. This is reversible by adding the label again.",
    inputSchema: {
      ...writeContextSchema,
      issueNumber: z.number().int().positive()
        .describe("Issue number; pull request numbers are also supported"),
      label: labelNameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, hostname, repository, issueNumber, label }) => {
    const normalizedRepository = repository.trim();
    const normalizedLabel = label.trim();
    const request = await prepareWriteRequest({
      tool: "remove_issue_label",
      repository: normalizedRepository,
      issueNumber,
      label: normalizedLabel,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(normalizedRepository, context);
    const canonicalRepository = await resolveCanonicalRepository(config, context, normalizedRepository);
    const operation = await auditedOperation(
      request,
      config,
      () => jsonGh([
          "api",
          `repos/${canonicalRepository}/issues/${issueNumber}/labels/${encodeURIComponent(normalizedLabel)}`,
          "--hostname",
          context.profile.hostname,
          "--method",
          "DELETE",
          "--jq",
          LABEL_DETAILS_JQ,
        ], config, context),
    );
    const assignedLabels = labelDetailsList(operation.value);
    return responseWithinOutputLimit({
      removedLabel: normalizedLabel,
      labels: assignedLabels,
      audit: operation.audit,
      source: issueSource(context, canonicalRepository, issueNumber),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("create_label", {
    description: "Create a label in an allowed repository. The description is sent through stdin and is not written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      name: labelNameSchema,
      color: labelColorSchema,
      description: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ account, repository, hostname, name, color, description }) => {
    const normalizedRepository = repository.trim();
    const normalizedName = name.trim();
    const request = await prepareWriteRequest({
      tool: "create_label",
      repository: normalizedRepository,
      label: normalizedName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = { name: normalizedName, color: color.toLowerCase() };
    if (description !== undefined) payload.description = description;
    const operation = await auditedJsonGh(
      request,
      ["api", `repos/${normalizedRepository}/labels`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      payload,
      config,
    );
    return response({ label: labelSummary(operation.value), audit: operation.audit });
  });

  server.registerTool("update_label", {
    description: "Update an existing label name, color, or description. This tool cannot delete labels.",
    inputSchema: {
      ...writeContextSchema,
      currentName: labelNameSchema,
      newName: labelNameSchema.optional(),
      color: labelColorSchema.optional(),
      description: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ account, repository, hostname, currentName, newName, color, description }) => {
    const normalizedRepository = repository.trim();
    const normalizedCurrentName = currentName.trim();
    const request = await prepareWriteRequest({
      tool: "update_label",
      repository: normalizedRepository,
      label: normalizedCurrentName,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const payload: Record<string, unknown> = {};
    if (newName !== undefined) payload.new_name = newName.trim();
    if (color !== undefined) payload.color = color.toLowerCase();
    if (description !== undefined) payload.description = description;
    if (Object.keys(payload).length === 0) throw new Error("At least one label field must be provided.");
    const labelPath = `repos/${normalizedRepository}/labels/${encodeURIComponent(normalizedCurrentName)}`;
    await jsonGh(["api", labelPath, "--hostname", normalizedHostname], config, context);
    const operation = await auditedJsonGh(
      request,
      ["api", labelPath, "--hostname", normalizedHostname, "--method", "PATCH", "--input", "-"],
      payload,
      config,
    );
    return response({ label: labelSummary(operation.value), audit: operation.audit });
  });

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

  registerProjectTools(server, config);
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
