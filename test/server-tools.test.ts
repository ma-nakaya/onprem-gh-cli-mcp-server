import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: Config = {
  ghPath: "gh",
  allowedHosts: new Set(["github.com"]),
  allowedOwners: new Set(["ma-nakaya"]),
  allowedRepositories: new Set(),
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  auditLogPath: "audit.jsonl",
};

describe("MCP tool registration", () => {
  it("exposes typed pull request writes without a merge tool", async () => {
    const server = createServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.listTools();
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
      for (const name of ["create_pull_request", "update_pull_request", "comment_pull_request", "review_pull_request"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      for (const name of ["create_release", "update_release"]) {
        expect(tools.has(name)).toBe(true);
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      expect(tools.has("merge_pull_request")).toBe(false);
      expect(tools.has("publish_release")).toBe(false);
      expect(tools.has("delete_release")).toBe(false);
      expect(tools.get("run_gh")?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
