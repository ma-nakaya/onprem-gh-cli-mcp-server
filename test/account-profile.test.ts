import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginFromUserApi,
  resolveAccountContext,
  verifyAccountProfile,
} from "../src/account-profile.js";
import type { AccountProfile, Config } from "../src/config.js";
import { runGh } from "../src/gh-runner.js";

vi.mock("../src/gh-runner.js", () => ({
  runGh: vi.fn(),
}));

const runGhMock = vi.mocked(runGh);

function profile(
  id: string,
  overrides: Partial<AccountProfile> = {},
): AccountProfile {
  return Object.freeze({
    id,
    expectedLogin: id,
    hostname: "github.com",
    configDir: `C:/secure/gh-${id}`,
    allowedOwners: new Set([id]),
    allowedRepositories: new Set<string>(),
    ...overrides,
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

describe("GitHub CLI account profile routing and validation", () => {
  beforeEach(() => {
    runGhMock.mockReset();
  });

  it("normalizes the authenticated login returned by the user API", () => {
    expect(loginFromUserApi(" Masa-Nakaya \r\n")).toBe("masa-nakaya");
  });

  it("rejects empty, structured, or multi-line user API output", () => {
    expect(() => loginFromUserApi("")).toThrow();
    expect(() => loginFromUserApi('{"login":"masa-nakaya"}')).toThrow();
    expect(() => loginFromUserApi("masa-nakaya\nma-nakaya")).toThrow();
  });

  it("resolves an explicit account without mutating the immutable context", () => {
    const ma = profile("ma-nakaya");
    const masa = profile("masa-nakaya");
    const config = configFor([ma, masa]);

    const context = resolveAccountContext(config, " MA-NAKAYA ", " GITHUB.COM ");

    expect(context).toEqual({ accountId: "ma-nakaya", profile: ma });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("defaults an omitted account only for a singleton profile", () => {
    const ma = profile("ma-nakaya");
    expect(resolveAccountContext(configFor([ma]))).toEqual({
      accountId: "ma-nakaya",
      profile: ma,
    });

    expect(() => resolveAccountContext(configFor([
      ma,
      profile("masa-nakaya"),
    ]))).toThrow(/account is required.*multiple/i);
    expect(() => resolveAccountContext(configFor([]))).toThrow(/no GitHub account profiles/i);
  });

  it("rejects empty, malformed, unknown, or host-mismatched selections", () => {
    const config = configFor([profile("ma-nakaya")]);

    expect(() => resolveAccountContext(config, " ")).toThrow(/account must not be empty/i);
    expect(() => resolveAccountContext(config, "ma/nakaya")).toThrow(/configured GitHub account id/i);
    expect(() => resolveAccountContext(config, "masa-nakaya")).toThrow(/not configured/i);
    expect(() => resolveAccountContext(config, "ma-nakaya", "ghe.example.com")).toThrow(
      /host does not match account profile/i,
    );
    expect(() => resolveAccountContext(config, "ma-nakaya", "https://github.com")).toThrow(
      /valid GitHub hostname/i,
    );
  });

  it("accepts and returns the expected account from the isolated CLI profile", async () => {
    const config = configFor([profile("masa-nakaya")]);
    const context = resolveAccountContext(config);
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "masa-nakaya\n", stderr: "" });

    await expect(verifyAccountProfile(config, context)).resolves.toBe("masa-nakaya");
    expect(runGhMock).toHaveBeenCalledWith(
      ["api", "user", "--hostname", "github.com", "--jq", ".login"],
      config,
      context,
    );
  });

  it("fails closed when the isolated profile authenticates as a different account", async () => {
    const config = configFor([profile("masa-nakaya")]);
    const context = resolveAccountContext(config);
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "ma-nakaya\n", stderr: "" });

    await expect(verifyAccountProfile(config, context)).rejects.toThrow(
      /expected masa-nakaya, active ma-nakaya/i,
    );
  });

  it("propagates GitHub CLI authentication failures", async () => {
    const config = configFor([profile("masa-nakaya")]);
    const context = resolveAccountContext(config);
    runGhMock.mockRejectedValue(new Error("authentication failed"));

    await expect(verifyAccountProfile(config, context)).rejects.toThrow(/authentication failed/i);
  });
});
