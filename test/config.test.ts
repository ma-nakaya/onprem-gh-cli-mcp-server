import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("uses the configured audit log path", () => {
    const config = loadConfig({ GH_MCP_AUDIT_LOG_PATH: "C:/secure/gh-mcp-audit.jsonl" });
    expect(config.auditLogPath).toBe("C:/secure/gh-mcp-audit.jsonl");
  });

  it("creates a platform-specific default audit log path", () => {
    const config = loadConfig({ LOCALAPPDATA: "C:/Users/test/AppData/Local", HOME: "/home/test" });
    expect(config.auditLogPath).toMatch(/onprem-gh-cli-mcp[\\/]audit\.jsonl$/);
  });
});
