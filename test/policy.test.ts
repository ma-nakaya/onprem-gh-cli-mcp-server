import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { assertRepositoryAllowed, assertSafeGhArguments } from "../src/policy.js";

const config: Config = {
  ghPath: "gh", allowedHosts: new Set(["github.com"]), allowedOwners: new Set(["ma-nakaya"]),
  allowedRepositories: new Set(), timeoutMs: 1000, maxOutputBytes: 1000,
};

describe("read-only policy", () => {
  it("allows safe repository reads", () => expect(() => assertSafeGhArguments(["repo", "view", "ma-nakaya/example"])).not.toThrow());
  it("blocks destructive commands", () => {
    expect(() => assertSafeGhArguments(["repo", "delete", "ma-nakaya/example"])).toThrow(/not allowed/);
    expect(() => assertSafeGhArguments(["pr", "merge", "1"])).toThrow(/not allowed/);
  });
  it("blocks token disclosure", () => {
    expect(() => assertSafeGhArguments(["auth", "token"])).toThrow();
    expect(() => assertSafeGhArguments(["auth", "status", "--show-token"])).toThrow(/Blocked/);
  });
  it("enforces owner allowlists", () => {
    expect(() => assertRepositoryAllowed("ma-nakaya/example", config)).not.toThrow();
    expect(() => assertRepositoryAllowed("someone-else/example", config)).toThrow(/owner is not allowed/);
  });
});
