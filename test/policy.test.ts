import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { assertOwnerAllowed, assertRepositoryAllowed, assertSafeGhArguments } from "../src/policy.js";

const config: Config = {
  ghPath: "gh", allowedHosts: new Set(["github.com"]), allowedOwners: new Set(["ma-nakaya"]),
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
  });
  it("blocks token disclosure", () => {
    expect(() => assertSafeGhArguments(["auth", "token"])).toThrow();
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token"])).toThrow(/Blocked/);
  });
  it("enforces owner allowlists", () => {
    expect(() => assertRepositoryAllowed("ma-nakaya/example", config)).not.toThrow();
    expect(() => assertRepositoryAllowed("someone-else/example", config)).toThrow(/owner is not allowed/);
  });
  it("enforces owner-wide operation allowlists", () => {
    expect(() => assertOwnerAllowed("ma-nakaya", config)).not.toThrow();
    expect(() => assertOwnerAllowed("someone-else", config)).toThrow(/not allowed/);
    const repositoryScoped = { ...config, allowedOwners: new Set<string>(), allowedRepositories: new Set(["ma-nakaya/example"]) };
    expect(() => assertOwnerAllowed("ma-nakaya", repositoryScoped)).not.toThrow();
    expect(() => assertOwnerAllowed("someone-else", repositoryScoped)).toThrow(/repository allowlist/);
  });
});
