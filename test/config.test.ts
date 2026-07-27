import { describe, expect, it } from "vitest";
import { loadConfig, restrictedEnvironment } from "../src/config.js";

describe("configuration", () => {
  it("normalizes and deduplicates comma-separated owner and repository allowlists", () => {
    const config = loadConfig({
      GH_MCP_ALLOWED_OWNERS: " masa-nakaya, MA-NAKAYA,masa-nakaya ",
      GH_MCP_ALLOWED_REPOSITORIES: " masa-nakaya/Example, MA-NAKAYA/Other,masa-nakaya/example ",
    });

    expect([...config.allowedOwners]).toEqual(["masa-nakaya", "ma-nakaya"]);
    expect([...config.allowedRepositories]).toEqual(["masa-nakaya/example", "ma-nakaya/other"]);
  });

  it("rejects malformed resource allowlist entries", () => {
    expect(() => loadConfig({ GH_MCP_ALLOWED_OWNERS: "ma-nakaya;other" })).toThrow(/invalid owner/i);
    expect(() => loadConfig({ GH_MCP_ALLOWED_REPOSITORIES: "ma-nakaya" })).toThrow(/invalid repository/i);
  });

  it("rejects an empty or malformed host allowlist", () => {
    expect(() => loadConfig({ GH_MCP_ALLOWED_HOSTS: "   " })).toThrow(/at least one hostname/i);
    expect(() => loadConfig({ GH_MCP_ALLOWED_HOSTS: "https://github.com" })).toThrow(/invalid hostname/i);
  });

  it("builds a normalized account profile from explicit configuration", () => {
    const config = loadConfig({
      GH_MCP_ALLOWED_HOSTS: "github.com, ghe.example.com",
      GH_MCP_ALLOWED_OWNERS: "masa-nakaya,ma-nakaya",
      GH_MCP_EXPECTED_LOGIN: " Masa-Nakaya ",
      GH_MCP_ACCOUNT_HOST: " GHE.Example.com ",
      GH_CONFIG_DIR: " C:/secure/gh-masa ",
    });

    expect(config.accountProfile).toEqual({
      expectedLogin: "masa-nakaya",
      hostname: "ghe.example.com",
      configDir: "C:/secure/gh-masa",
    });
  });

  it("requires an isolated GitHub CLI config directory for an expected login", () => {
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
    })).toThrow(/GH_CONFIG_DIR/);
  });

  it("rejects an explicitly empty expected login", () => {
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "   ",
    })).toThrow(/must not be empty/i);
  });

  it("rejects an account host outside the host allowlist", () => {
    expect(() => loadConfig({
      GH_MCP_ALLOWED_HOSTS: "github.com",
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
      GH_MCP_ACCOUNT_HOST: "ghe.example.com",
      GH_CONFIG_DIR: "C:/secure/gh-masa",
      GH_MCP_ALLOWED_OWNERS: "masa-nakaya",
    })).toThrow(/not allowed/i);
  });

  it("requires a resource allowlist for an account-isolated process", () => {
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
      GH_CONFIG_DIR: "C:/secure/gh-masa",
    })).toThrow(/GH_MCP_ALLOWED_OWNERS|GH_MCP_ALLOWED_REPOSITORIES/);
  });

  it("pins the account environment without inheriting ambient GitHub tokens", () => {
    const env = {
      PATH: "C:/tools",
      GH_CONFIG_DIR: "C:/ambient/gh",
      GH_HOST: "ambient.example.com",
      GH_TOKEN: `ghp_${"a".repeat(36)}`,
      GITHUB_TOKEN: `github_pat_${"b".repeat(82)}`,
    };

    const restricted = restrictedEnvironment(env, {
      expectedLogin: "masa-nakaya",
      hostname: "github.com",
      configDir: "C:/isolated/gh-masa",
    });

    expect(restricted).toMatchObject({
      PATH: "C:/tools",
      GH_CONFIG_DIR: "C:/isolated/gh-masa",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    });
    expect(restricted).not.toHaveProperty("GH_TOKEN");
    expect(restricted).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("never inherits an ambient host outside the configured host allowlist", () => {
    const restricted = restrictedEnvironment(
      { PATH: "C:/tools", GH_HOST: "outside.example.com" },
      undefined,
      new Set(["github.com"]),
    );

    expect(restricted.GH_HOST).toBe("github.com");
  });

  it("uses the configured audit log path", () => {
    const config = loadConfig({ GH_MCP_AUDIT_LOG_PATH: "C:/secure/gh-mcp-audit.jsonl" });
    expect(config.auditLogPath).toBe("C:/secure/gh-mcp-audit.jsonl");
  });

  it("creates a platform-specific default audit log path", () => {
    const config = loadConfig({ LOCALAPPDATA: "C:/Users/test/AppData/Local", HOME: "/home/test" });
    expect(config.auditLogPath).toMatch(/onprem-gh-cli-mcp[\\/]audit\.jsonl$/);
  });
});
