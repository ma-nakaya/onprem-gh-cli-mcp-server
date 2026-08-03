import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AccountProfile, Config } from "../src/config.js";
import { createServer } from "../src/server.js";

function profile(id: string): AccountProfile {
  return Object.freeze({
    id,
    expectedLogin: id,
    hostname: "github.com",
    configDir: `C:/secure/gh-${id}`,
    allowedOwners: new Set([id]),
    allowedRepositories: new Set<string>(),
  });
}

function configFor(profiles: AccountProfile[]): Config {
  return {
    ghPath: "gh",
    allowedHosts: new Set(["github.com"]),
    accountProfiles: new Map(profiles.map((item) => [item.id, item])),
    ...(profiles.length === 1 ? { defaultAccountId: profiles[0].id } : {}),
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    auditLogPath: "audit.jsonl",
  };
}

const config = configFor([profile("ma-nakaya")]);

describe("MCP tool registration", () => {
  it("exposes prioritized review, repository administration, merge, and label tools", async () => {
    const server = createServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.listTools();
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
      expect(tools.get("list_accounts")?.annotations?.readOnlyHint).toBe(true);
      for (const name of ["create_pull_request", "update_pull_request", "comment_pull_request", "review_pull_request"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      for (const name of ["create_release", "update_release"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      for (const name of [
        "list_pull_request_reviews",
        "list_pull_request_review_comments",
        "get_pull_request_review_comment",
        "list_pull_request_review_threads",
        "get_pull_request_review_thread",
      ]) {
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get(name)?.annotations?.destructiveHint).toBe(false);
      }
      for (const name of [
        "create_pull_request_review_comment",
        "reply_pull_request_review_comment",
        "update_pull_request_review_comment",
        "resolve_pull_request_review_thread",
        "unresolve_pull_request_review_thread",
      ]) {
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
        expect(tools.get(name)?.annotations?.destructiveHint).toBe(false);
      }
      expect(tools.get("delete_pull_request_review_comment")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("delete_pull_request_review_comment")?.annotations?.destructiveHint).toBe(true);
      expect(tools.get("merge_pull_request")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("merge_pull_request")?.annotations?.destructiveHint).toBe(true);
      expect(tools.get("get_repository")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.get("create_repository")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("create_repository")?.annotations?.destructiveHint).toBe(true);
      expect(tools.get("update_repository_description")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("delete_repository")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("delete_repository")?.annotations?.destructiveHint).toBe(true);
      expect(tools.has("publish_release")).toBe(false);
      expect(tools.has("delete_release")).toBe(false);
      expect(tools.has("dispatch_workflow")).toBe(true);
      expect(tools.get("dispatch_workflow")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.get("dispatch_workflow")?.annotations?.destructiveHint).toBe(true);
      for (const name of ["create_label", "update_label", "create_milestone", "update_milestone"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      for (const name of ["list_labels", "list_issue_labels"]) {
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get(name)?.annotations?.destructiveHint).toBe(false);
      }
      for (const name of ["add_issue_labels", "remove_issue_label"]) {
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
        expect(tools.get(name)?.annotations?.destructiveHint).toBe(false);
      }
      expect(tools.has("delete_label")).toBe(false);
      expect(tools.has("delete_milestone")).toBe(false);
      for (const name of ["create_project", "update_project"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      expect(tools.has("delete_project")).toBe(false);
      expect(tools.has("publish_project")).toBe(false);
      for (const name of ["list_project_items", "list_project_fields"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
      }
      for (const name of ["add_project_item", "set_project_item_field", "clear_project_item_field", "set_project_item_archived"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      expect(tools.has("delete_project_item")).toBe(false);
      expect(tools.has("create_project_field")).toBe(false);
      expect(tools.get("get_branch")?.annotations?.readOnlyHint).toBe(true);
      for (const name of ["list_repository_tree", "get_repository_file"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get(name)?.annotations?.destructiveHint).toBe(false);
      }
      for (const name of ["create_branch", "commit_files"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      expect(tools.get("commit_files")?.annotations?.destructiveHint).toBe(true);
      expect(tools.has("force_push_branch")).toBe(false);
      expect(tools.get("run_gh")?.annotations?.readOnlyHint).toBe(true);
      for (const [name, tool] of tools) {
        if (name === "list_accounts") continue;
        const required = (tool.inputSchema as { required?: string[] }).required ?? [];
        expect(required, `${name} should allow the singleton default account`).not.toContain("account");
        expect(required, `${name} should keep hostname as an optional assertion`).not.toContain("hostname");
        expect((tool.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("account");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires an exact account selector on every gh-backed tool with multiple profiles", async () => {
    const server = createServer(configFor([
      profile("ma-nakaya"),
      profile("masa-nakaya"),
    ]));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.listTools();
      for (const tool of result.tools) {
        const required = (tool.inputSchema as { required?: string[] }).required ?? [];
        if (tool.name === "list_accounts") {
          expect(required).not.toContain("account");
          continue;
        }
        expect(required, `${tool.name} must select an account`).toContain("account");
        expect(required, `${tool.name} hostname remains only an assertion`).not.toContain("hostname");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
