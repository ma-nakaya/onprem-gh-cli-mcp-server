import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedTools = [
  "list_accounts",
  "get_auth_status",
  "get_branch",
  "create_branch",
  "commit_files",
  "list_organizations",
  "list_repositories",
  "list_issues",
  "get_issue",
  "list_issue_comments",
  "list_issue_events",
  "create_issue",
  "update_issue",
  "comment_issue",
  "list_pull_requests",
  "get_pull_request",
  "list_pull_request_files",
  "get_pull_request_diff",
  "list_pull_request_checks",
  "create_pull_request",
  "update_pull_request",
  "comment_pull_request",
  "review_pull_request",
  "list_workflow_runs",
  "list_workflow_run_jobs",
  "get_workflow_job_log",
  "dispatch_workflow",
  "create_release",
  "update_release",
  "create_label",
  "update_label",
  "create_milestone",
  "update_milestone",
  "create_project",
  "update_project",
  "list_project_items",
  "list_project_fields",
  "add_project_item",
  "set_project_item_field",
  "clear_project_item_field",
  "set_project_item_archived",
  "run_gh",
];

const forbiddenTools = [
  "merge_pull_request",
  "delete_repository",
  "delete_release",
  "delete_project",
  "delete_project_item",
  "create_project_field",
  "force_push_branch",
  "show_token",
];

const smokeDirectory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-smoke-"));
const maConfigDirectory = join(smokeDirectory, "gh-ma-nakaya");
const masaConfigDirectory = join(smokeDirectory, "gh-masa-nakaya");
const accountsFile = join(smokeDirectory, "accounts.json");
await mkdir(maConfigDirectory);
await mkdir(masaConfigDirectory);
await writeFile(accountsFile, JSON.stringify({
  version: 1,
  accounts: [
    {
      id: "ma-nakaya",
      expectedLogin: "ma-nakaya",
      hostname: "github.com",
      configDir: maConfigDirectory,
      allowedOwners: ["ma-nakaya"],
      allowedRepositories: [],
    },
    {
      id: "masa-nakaya",
      expectedLogin: "masa-nakaya",
      hostname: "github.com",
      configDir: masaConfigDirectory,
      allowedOwners: ["masa-nakaya"],
      allowedRepositories: [],
    },
  ],
}), { encoding: "utf8", mode: 0o600 });

const childEnvironment = {
  ...process.env,
  GH_MCP_ACCOUNTS_FILE: accountsFile,
  GH_MCP_ALLOWED_HOSTS: "github.com",
  GH_MCP_AUDIT_LOG_PATH: join(smokeDirectory, "audit.jsonl"),
};
for (const name of [
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_MCP_EXPECTED_LOGIN",
  "GH_MCP_ACCOUNT_HOST",
  "GH_MCP_ALLOWED_OWNERS",
  "GH_MCP_ALLOWED_REPOSITORIES",
]) {
  delete childEnvironment[name];
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js"],
  env: childEnvironment,
  stderr: "pipe",
});
const client = new Client({ name: "onprem-gh-cli-mcp-smoke", version: "0.1.0" });

const timeout = setTimeout(() => {
  process.stderr.write("stdio smoke test timed out.\n");
  void client.close();
}, 10_000);

try {
  await client.connect(transport);
  const result = await client.listTools();
  const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

  for (const name of expectedTools) {
    if (!tools.has(name)) throw new Error(`Expected MCP tool is missing: ${name}`);
  }
  const expectedToolSet = new Set(expectedTools);
  const unexpectedTools = [...tools.keys()].filter((name) => !expectedToolSet.has(name));
  if (unexpectedTools.length > 0) {
    throw new Error(`Unexpected MCP tools were exposed: ${unexpectedTools.join(", ")}`);
  }
  for (const name of forbiddenTools) {
    if (tools.has(name)) throw new Error(`Forbidden MCP tool was exposed: ${name}`);
  }
  if (tools.get("run_gh")?.annotations?.readOnlyHint !== true) {
    throw new Error("run_gh must remain read-only.");
  }
  for (const name of [
    "get_issue",
    "list_issue_comments",
    "list_issue_events",
    "get_pull_request",
    "list_pull_request_files",
    "get_pull_request_diff",
    "list_pull_request_checks",
    "list_workflow_run_jobs",
    "get_workflow_job_log",
  ]) {
    const annotations = tools.get(name)?.annotations;
    if (annotations?.readOnlyHint !== true || annotations?.destructiveHint !== false) {
      throw new Error(`${name} must be read-only and non-destructive.`);
    }
  }
  if (tools.get("dispatch_workflow")?.annotations?.destructiveHint !== true) {
    throw new Error("dispatch_workflow must retain its high-impact hint.");
  }
  for (const name of expectedTools) {
    const inputSchema = tools.get(name)?.inputSchema;
    const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
    const properties = inputSchema?.properties ?? {};
    if (name === "list_accounts") {
      if (required.includes("account") || Object.hasOwn(properties, "account")) {
        throw new Error("list_accounts must not require or expose an account selector.");
      }
      continue;
    }
    if (!required.includes("account")) {
      throw new Error(`account must be required for ${name} when multiple profiles are configured.`);
    }
    if (!Object.hasOwn(properties, "account")) {
      throw new Error(`Account selector schema is missing for ${name}.`);
    }
  }

  process.stdout.write(`stdio MCP smoke test passed: ${tools.size} tools discovered.\n`);
} finally {
  clearTimeout(timeout);
  await client.close();
  await rm(smokeDirectory, { recursive: true, force: true });
}
