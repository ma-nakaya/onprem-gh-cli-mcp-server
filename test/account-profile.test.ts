import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { runGh } from "../src/gh-runner.js";
import { loginFromUserApi, verifyAccountProfile } from "../src/account-profile.js";

vi.mock("../src/gh-runner.js", () => ({
  runGh: vi.fn(),
}));

const runGhMock = vi.mocked(runGh);
const config: Config = {
  ghPath: "gh",
  allowedHosts: new Set(["github.com"]),
  allowedOwners: new Set(["masa-nakaya"]),
  allowedRepositories: new Set(),
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  auditLogPath: "audit.jsonl",
  accountProfile: {
    expectedLogin: "masa-nakaya",
    hostname: "github.com",
    configDir: "C:/secure/gh-masa",
  },
};

describe("GitHub CLI account profile validation", () => {
  beforeEach(() => {
    runGhMock.mockReset();
  });

  it("normalizes the authenticated login returned by the user API", () => {
    expect(loginFromUserApi(" Masa-Nakaya \r\n")).toBe("masa-nakaya");
  });

  it("rejects empty, structured, or multi-line output", () => {
    expect(() => loginFromUserApi("")).toThrow();
    expect(() => loginFromUserApi('{"login":"masa-nakaya"}')).toThrow();
    expect(() => loginFromUserApi("masa-nakaya\nma-nakaya")).toThrow();
  });

  it("accepts the expected account returned through the isolated CLI profile", async () => {
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "masa-nakaya\n", stderr: "" });

    await expect(verifyAccountProfile(config)).resolves.toBeUndefined();
    expect(runGhMock).toHaveBeenCalledWith(
      ["api", "user", "--hostname", "github.com", "--jq", ".login"],
      config,
    );
  });

  it("fails closed when the active account differs from the expected account", async () => {
    runGhMock.mockResolvedValue({ exitCode: 0, stdout: "ma-nakaya\n", stderr: "" });

    await expect(verifyAccountProfile(config)).rejects.toThrow(
      /expected masa-nakaya, active ma-nakaya/i,
    );
  });

  it("propagates GitHub CLI authentication failures", async () => {
    runGhMock.mockRejectedValue(new Error("authentication failed"));

    await expect(verifyAccountProfile(config)).rejects.toThrow(/authentication failed/i);
  });
});
