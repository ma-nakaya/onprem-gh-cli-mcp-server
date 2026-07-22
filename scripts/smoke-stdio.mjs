import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedTools = [
  "get_auth_status",
  "list_organizations",
  "list_repositories",
  "list_issues",
  "create_issue",
  "update_issue",
  "comment_issue",
  "list_pull_requests",
  "create_pull_request",
  "update_pull_request",
  "comment_pull_request",
  "review_pull_request",
  "list_workflow_runs",
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
  "show_token",
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js"],
  env: {
    ...process.env,
    GH_MCP_ALLOWED_OWNERS: "ma-nakaya",
    GH_MCP_AUDIT_LOG_PATH: join(tmpdir(), "onprem-gh-cli-mcp-smoke-audit.jsonl"),
  },
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
  for (const name of forbiddenTools) {
    if (tools.has(name)) throw new Error(`Forbidden MCP tool was exposed: ${name}`);
  }
  if (tools.get("run_gh")?.annotations?.readOnlyHint !== true) {
    throw new Error("run_gh must remain read-only.");
  }
  if (tools.get("dispatch_workflow")?.annotations?.destructiveHint !== true) {
    throw new Error("dispatch_workflow must retain its high-impact hint.");
  }

  process.stdout.write(`stdio MCP smoke test passed: ${tools.size} tools discovered.\n`);
} finally {
  clearTimeout(timeout);
  await client.close();
}
