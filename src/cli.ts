#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { verifyAccountProfile } from "./account-profile.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await verifyAccountProfile(config);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`onprem-gh-cli-mcp failed: ${message}\n`);
  process.exitCode = 1;
});
