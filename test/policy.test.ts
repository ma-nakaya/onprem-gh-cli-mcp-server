import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  assertHostAllowed,
  assertOwnerAllowed,
  assertRepositoryAllowed,
  assertRepositoryListOwnerAllowed,
  assertRunGhAllowedByResourceScope,
  assertSafeGhArguments,
} from "../src/policy.js";

const config: Config = {
  ghPath: "gh", allowedHosts: new Set(["github.com"]), allowedOwners: new Set(["masa-nakaya", "ma-nakaya"]),
  allowedRepositories: new Set(), timeoutMs: 1000, maxOutputBytes: 1000, auditLogPath: "audit.jsonl",
};

describe("read-only policy", () => {
  it("allows safe repository reads", () => expect(() => assertSafeGhArguments(["repo", "view", "ma-nakaya/example"])).not.toThrow());
  it("allows read-only API requests", () => expect(() => assertSafeGhArguments(["api", "user/orgs", "--paginate", "--slurp"])).not.toThrow());
  it("blocks destructive and write commands from run_gh", () => {
    expect(() => assertSafeGhArguments(["repo", "delete", "ma-nakaya/example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "merge", "1"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["issue", "create", "--title", "example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["issue", "comment", "1", "--body", "example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "create", "--title", "example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "edit", "1"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "review", "1", "--approve"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "comment", "1", "--body", "example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["release", "create", "v1.0.0"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["release", "edit", "v1.0.0"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["release", "upload", "v1.0.0", "asset.zip"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["release", "delete", "v1.0.0"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["workflow", "run", "ci.yml"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["run", "rerun", "123"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["run", "cancel", "123"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["label", "create", "priority-high"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["api", "repos/example/repo/milestones", "--method", "POST"])).toThrow(/blocked/i);
    for (const args of [
      ["api", "repos/example/repo", "--method=POST"],
      ["api", "repos/example/repo", "-XPOST"],
      ["api", "repos/example/repo", "-iXPOST"],
      ["api", "repos/example/repo", "--field=name=value"],
      ["api", "repos/example/repo", "-Fname=value"],
      ["api", "repos/example/repo", "-iFname=value"],
      ["api", "repos/example/repo", "--raw-field=name=value"],
      ["api", "repos/example/repo", "-fname=value"],
      ["api", "repos/example/repo", "-iname=value"],
      ["api", "repos/example/repo", "--input=payload.json"],
    ]) {
      expect(() => assertSafeGhArguments(args)).toThrow(/blocked|requires/i);
    }
  });
  it("blocks token disclosure", () => {
    expect(() => assertSafeGhArguments(["auth", "token"])).toThrow();
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token=true"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-t"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-at"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-ta"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--template", "{{.Token}}"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--active", "--hostname", "github.com"])).not.toThrow();
  });
  it("limits generic reads when a resource allowlist is configured", () => {
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status"], config)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "--hostname", "github.com"], config)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "--hostname=elsewhere.example"], config)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "-helsewhere.example"], config)).toThrow(/short hostname/i);
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "-h=elsewhere.example"], config)).toThrow(/short hostname/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "ma-nakaya/example"], config)).toThrow(/typed repository tool/);
    const unrestricted = { ...config, allowedOwners: new Set<string>(), allowedRepositories: new Set<string>() };
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "ma-nakaya/example"], unrestricted)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["api", "user", "--hostname", "elsewhere.example"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "https://elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["api", "https://elsewhere.example/user"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["issue", "view", "https://elsewhere.example/ma-nakaya/example/issues/1"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "checks", "https://elsewhere.example/ma-nakaya/example/pull/1"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["issue", "list", "--repo", "elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "list", "-Relsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host is not allowed/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "list", "-wRelsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/bundled -R/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "github.com/ma-nakaya/example"], unrestricted)).not.toThrow();
  });
  it("pins allowed hosts to the fixed account profile", () => {
    const profiled: Config = {
      ...config,
      allowedHosts: new Set(["github.com", "ghe.example.com"]),
      accountProfile: {
        expectedLogin: "ma-nakaya",
        hostname: "github.com",
        configDir: "C:/secure/gh-ma",
      },
    };
    expect(() => assertHostAllowed("github.com", profiled)).not.toThrow();
    expect(() => assertHostAllowed("ghe.example.com", profiled)).toThrow(/fixed account profile/i);
  });
  it("enforces owner allowlists", () => {
    expect(() => assertRepositoryAllowed("masa-nakaya/example", config)).not.toThrow();
    expect(() => assertRepositoryAllowed("ma-nakaya/example", config)).not.toThrow();
    expect(() => assertRepositoryAllowed("someone-else/example", config)).toThrow(/owner is not allowed/);
  });
  it("enforces owner-wide operation allowlists", () => {
    expect(() => assertOwnerAllowed("masa-nakaya", config)).not.toThrow();
    expect(() => assertOwnerAllowed("ma-nakaya", config)).not.toThrow();
    expect(() => assertOwnerAllowed("someone-else", config)).toThrow(/not allowed/);
    const repositoryScoped = {
      ...config,
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set(["masa-nakaya/example", "ma-nakaya/example"]),
    };
    expect(() => assertOwnerAllowed("masa-nakaya", repositoryScoped)).toThrow(/explicit GH_MCP_ALLOWED_OWNERS/);
    expect(() => assertOwnerAllowed("ma-nakaya", repositoryScoped)).toThrow(/explicit GH_MCP_ALLOWED_OWNERS/);
    expect(() => assertOwnerAllowed("someone-else", repositoryScoped)).toThrow(/explicit GH_MCP_ALLOWED_OWNERS/);
    expect(() => assertRepositoryListOwnerAllowed("masa-nakaya", repositoryScoped)).not.toThrow();
    expect(() => assertRepositoryListOwnerAllowed("ma-nakaya", repositoryScoped)).not.toThrow();
    expect(() => assertRepositoryListOwnerAllowed("someone-else", repositoryScoped)).toThrow(/repository allowlist/);
  });
});
