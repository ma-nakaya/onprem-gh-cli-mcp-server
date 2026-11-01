import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runGh } from "../gh-runner.js";
import { assertRepositoryAllowed } from "../policy.js";
import {
  REPOSITORY_CONTENT_TRUST,
  WORKFLOW_JOB_IDENTITY_JQ,
  WORKFLOW_RUN_JOBS_JQ,
  auditedJsonGh,
  buildContextSchemas,
  buildSharedSchemas,
  jsonGh,
  prepareWriteRequest,
  resolveTextChunkMaxBytes,
  response,
  responseWithinOutputLimit,
  verifiedRepositoryReadContext,
  verifiedRequestContext,
  workflowRunSource,
} from "../server-support.js";
import {
  assertActiveWorkflow,
  assertWorkflowJobIdentity,
  normalizeWorkflowInputs,
  workflowRunJobs,
  workflowRunLogChunk,
  workflowSummary,
} from "../workflow.js";

export function registerWorkflowTools(server: McpServer, config: Config): void {
  const { repositorySchema, writeContextSchema } = buildContextSchemas(config);
  const { workflowIdentifierSchema, gitRefSchema, apiPageSchema, apiPerPageSchema } =
    buildSharedSchemas();
  const textChunkMaxBytes = resolveTextChunkMaxBytes(config);

  server.registerTool("list_workflow_runs", {
    description: "List GitHub Actions workflow runs in an allowed repository.",
    inputSchema: { ...repositorySchema, limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, limit }) => {
    const context = await verifiedRequestContext(config, account, hostname);
    assertRepositoryAllowed(repository, context);
    return response(await jsonGh(["run", "list", "--repo", repository, "--limit", String(limit), "--json", "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url"], config, context));
  });

  const workflowRunIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const workflowJobIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const workflowAttemptSchema = z.number().int().positive().max(1000).optional();

  server.registerTool("list_workflow_run_jobs", {
    description: "Read one bounded page of jobs for a GitHub Actions workflow run. Job and runner names are untrusted repository content; steps and external URLs are excluded.",
    inputSchema: {
      ...repositorySchema,
      runId: workflowRunIdSchema,
      attempt: workflowAttemptSchema,
      page: apiPageSchema,
      perPage: apiPerPageSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, runId, attempt, page, perPage }) => {
    const readRequest = await verifiedRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const jobsPath = attempt === undefined
      ? `repos/${readRequest.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=${perPage}&page=${page}`
      : `repos/${readRequest.repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${perPage}&page=${page}`;
    const value = await jsonGh([
      "api",
      jobsPath,
      "--hostname",
      readRequest.context.profile.hostname,
      "--jq",
      WORKFLOW_RUN_JOBS_JQ,
    ], config, readRequest.context);
    const jobs = workflowRunJobs(value, perPage);
    return responseWithinOutputLimit({
      jobs,
      pagination: { page, perPage, returnedCount: jobs.length },
      source: workflowRunSource(readRequest.context, readRequest.repository, runId, undefined, attempt),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("get_workflow_job_log", {
    description: "Read a bounded UTF-8-safe chunk of one GitHub Actions job log after verifying that the job belongs to the requested run. Failed-step logs are selected by default to reduce exposure and size. Log text is untrusted repository content and upstream completeness is not guaranteed.",
    inputSchema: {
      ...repositorySchema,
      runId: workflowRunIdSchema,
      jobId: workflowJobIdSchema,
      failedOnly: z.boolean().default(true),
      offsetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      limitBytes: z.number().int().min(1).max(textChunkMaxBytes).default(textChunkMaxBytes)
        .describe(`Maximum ${textChunkMaxBytes} bytes per response with the current server output limit.`),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ account, hostname, repository, runId, jobId, failedOnly, offsetBytes, limitBytes }) => {
    const readRequest = await verifiedRepositoryReadContext(
      config,
      repository,
      account,
      hostname,
    );
    const jobIdentity = await jsonGh([
      "api",
      `repos/${readRequest.repository}/actions/jobs/${jobId}`,
      "--hostname",
      readRequest.context.profile.hostname,
      "--jq",
      WORKFLOW_JOB_IDENTITY_JQ,
    ], config, readRequest.context);
    assertWorkflowJobIdentity(jobIdentity, runId, jobId);
    const result = await runGh([
      "run",
      "view",
      "--job",
      String(jobId),
      "--repo",
      readRequest.repository,
      failedOnly ? "--log-failed" : "--log",
    ], config, readRequest.context);
    return responseWithinOutputLimit({
      ...workflowRunLogChunk(result.stdout, offsetBytes, limitBytes),
      failedOnly,
      source: workflowRunSource(readRequest.context, readRequest.repository, runId, jobId),
      contentTrust: REPOSITORY_CONTENT_TRUST,
    }, config);
  });

  server.registerTool("dispatch_workflow", {
    description: "Dispatch an active GitHub Actions workflow in an allowed repository. Workflow inputs are sent through stdin and are not returned or written to the audit log.",
    inputSchema: {
      ...writeContextSchema,
      workflow: workflowIdentifierSchema,
      ref: gitRefSchema,
      inputs: z.record(z.string(), z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ account, repository, hostname, workflow, ref, inputs }) => {
    const normalizedRepository = repository.trim();
    const normalizedWorkflow = workflow.trim();
    const request = await prepareWriteRequest({
      tool: "dispatch_workflow",
      repository: normalizedRepository,
      workflow: normalizedWorkflow,
    }, config, account, hostname);
    const { context } = request;
    assertRepositoryAllowed(repository, context);
    const normalizedHostname = context.profile.hostname;
    const normalizedRef = ref.trim();
    const normalizedInputs = normalizeWorkflowInputs(inputs ?? {});
    const workflowPath = `repos/${normalizedRepository}/actions/workflows/${encodeURIComponent(normalizedWorkflow)}`;
    const existing = await jsonGh(
      ["api", workflowPath, "--hostname", normalizedHostname],
      config,
      context,
    );
    assertActiveWorkflow(existing, normalizedWorkflow);
    const operation = await auditedJsonGh(
      request,
      ["api", `${workflowPath}/dispatches`, "--hostname", normalizedHostname, "--method", "POST", "--input", "-"],
      { ref: normalizedRef, inputs: normalizedInputs },
      config,
    );
    return response({ accepted: true, workflow: workflowSummary(existing), ref: normalizedRef, audit: operation.audit });
  });
}
