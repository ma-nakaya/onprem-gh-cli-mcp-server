import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAccountContext } from "../src/account-profile.js";
import type { AccountProfile, Config } from "../src/config.js";
import { runGh } from "../src/gh-runner.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function profile(id: string, configDir: string): AccountProfile {
  return Object.freeze({
    id,
    expectedLogin: id,
    hostname: "github.com",
    configDir,
    allowedOwners: new Set([id]),
    allowedRepositories: new Set<string>(),
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

function successfulChild(stdoutText: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => {
    child.stdout.end(stdoutText);
    child.stderr.end();
    child.emit("close", 0);
  });
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
  vi.unstubAllEnvs();
});

describe("GitHub CLI request-scoped execution", () => {
  it("keeps concurrent account child environments isolated from each other and ambient auth", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const masa = profile("masa-nakaya", "C:/secure/gh-masa");
    const config = configFor([ma, masa]);
    const maContext = resolveAccountContext(config, "ma-nakaya");
    const masaContext = resolveAccountContext(config, "masa-nakaya");
    vi.stubEnv("GH_CONFIG_DIR", "C:/ambient/gh");
    vi.stubEnv("GH_HOST", "ambient.example.com");
    vi.stubEnv("GH_TOKEN", `ghp_${"a".repeat(36)}`);
    vi.stubEnv("GITHUB_TOKEN", `github_pat_${"b".repeat(82)}`);
    spawnMock
      .mockImplementationOnce(() => successfulChild("ma\n"))
      .mockImplementationOnce(() => successfulChild("masa\n"));

    const [maResult, masaResult] = await Promise.all([
      runGh(["api", "user"], config, maContext),
      runGh(["api", "user"], config, masaContext),
    ]);

    expect(maResult.stdout).toBe("ma\n");
    expect(masaResult.stdout).toBe("masa\n");
    const maEnvironment = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const masaEnvironment = spawnMock.mock.calls[1]?.[2]?.env as NodeJS.ProcessEnv;
    expect(maEnvironment).toMatchObject({
      GH_CONFIG_DIR: "C:/secure/gh-ma",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    });
    expect(masaEnvironment).toMatchObject({
      GH_CONFIG_DIR: "C:/secure/gh-masa",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    });
    for (const environment of [maEnvironment, masaEnvironment]) {
      expect(environment).not.toHaveProperty("GH_TOKEN");
      expect(environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(environment.GH_CONFIG_DIR).not.toBe("C:/ambient/gh");
      expect(environment.GH_HOST).not.toBe("ambient.example.com");
    }
    expect(process.env.GH_CONFIG_DIR).toBe("C:/ambient/gh");
    expect(process.env.GH_HOST).toBe("ambient.example.com");
  });

  it("rejects a forged or stale request context before spawning gh", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const forgedContext = {
      ...context,
      profile: { ...context.profile },
    };

    await expect(runGh(["api", "user"], config, forgedContext)).rejects.toThrow(
      /request context is not configured/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
