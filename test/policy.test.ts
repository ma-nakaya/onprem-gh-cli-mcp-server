import { describe, expect, it } from "vitest";
import type { AccountProfile, RequestContext } from "../src/config.js";
import {
  assertHostAllowed,
  assertOwnerAllowed,
  assertRepositoryAllowed,
  assertRepositoryListOwnerAllowed,
  assertRunGhAllowedByResourceScope,
  assertSafeGhArguments,
} from "../src/policy.js";

function contextFor(
  id: string,
  overrides: Partial<AccountProfile> = {},
): RequestContext {
  const profile = Object.freeze({
    id,
    expectedLogin: id,
    hostname: "github.com",
    configDir: `C:/secure/gh-${id}`,
    allowedOwners: new Set([id]),
    allowedRepositories: new Set<string>(),
    ...overrides,
  });
  return Object.freeze({ accountId: id, profile });
}

const context = contextFor("ma-nakaya");

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
    expect(() => assertSafeGhArguments(["auth", "switch"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token=true"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-t"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-at"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "-ta"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--template", "{{.Token}}"])).toThrow(/Blocked/);
    expect(() => assertSafeGhArguments(["auth", "status", "--active", "--hostname", "github.com"])).not.toThrow();
  });

  it("limits generic reads using the selected account profile", () => {
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status"], context)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "--hostname", "github.com"], context)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "--hostname=elsewhere.example"], context)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "-helsewhere.example"], context)).toThrow(/short hostname/i);
    expect(() => assertRunGhAllowedByResourceScope(["auth", "status", "-h=elsewhere.example"], context)).toThrow(/short hostname/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "ma-nakaya/example"], context)).toThrow(/typed repository tool/);

    const unrestricted = contextFor("ma-nakaya", {
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set<string>(),
    });
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "ma-nakaya/example"], unrestricted)).not.toThrow();
    expect(() => assertRunGhAllowedByResourceScope(["api", "user", "--hostname", "elsewhere.example"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "https://elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["api", "https://elsewhere.example/user"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["issue", "view", "https://elsewhere.example/ma-nakaya/example/issues/1"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "checks", "https://elsewhere.example/ma-nakaya/example/pull/1"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["issue", "list", "--repo", "elsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "list", "-Relsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/host does not match account profile/i);
    expect(() => assertRunGhAllowedByResourceScope(["pr", "list", "-wRelsewhere.example/ma-nakaya/example"], unrestricted)).toThrow(/bundled -R/i);
    expect(() => assertRunGhAllowedByResourceScope(["repo", "view", "github.com/ma-nakaya/example"], unrestricted)).not.toThrow();
  });

  it("pins host assertions to the selected profile", () => {
    const gheContext = contextFor("enterprise", {
      expectedLogin: "ma-nakaya",
      hostname: "ghe.example.com",
    });
    expect(() => assertHostAllowed("ghe.example.com", gheContext)).not.toThrow();
    expect(() => assertHostAllowed("github.com", gheContext)).toThrow(/account profile 'enterprise'/i);
  });

  it("enforces repository scopes independently for each account", () => {
    const ma = contextFor("ma-nakaya");
    const masa = contextFor("masa-nakaya");
    expect(() => assertRepositoryAllowed("ma-nakaya/example", ma)).not.toThrow();
    expect(() => assertRepositoryAllowed("masa-nakaya/example", ma)).toThrow(/account 'ma-nakaya'/i);
    expect(() => assertRepositoryAllowed("masa-nakaya/example", masa)).not.toThrow();
    expect(() => assertRepositoryAllowed("ma-nakaya/example", masa)).toThrow(/account 'masa-nakaya'/i);
  });

  it("enforces owner-wide scopes independently for each account", () => {
    expect(() => assertOwnerAllowed("ma-nakaya", context)).not.toThrow();
    expect(() => assertOwnerAllowed("someone-else", context)).toThrow(/not allowed/);
    const repositoryScoped = contextFor("ma-nakaya", {
      allowedOwners: new Set<string>(),
      allowedRepositories: new Set(["ma-nakaya/example"]),
    });
    expect(() => assertOwnerAllowed("ma-nakaya", repositoryScoped)).toThrow(/explicit allowedOwners/);
    expect(() => assertOwnerAllowed("someone-else", repositoryScoped)).toThrow(/explicit allowedOwners/);
    expect(() => assertRepositoryListOwnerAllowed("ma-nakaya", repositoryScoped)).not.toThrow();
    expect(() => assertRepositoryListOwnerAllowed("someone-else", repositoryScoped)).toThrow(/repository allowlist/);
  });
});
