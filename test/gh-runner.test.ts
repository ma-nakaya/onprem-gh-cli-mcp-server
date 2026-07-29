import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAccountContext } from "../src/account-profile.js";
import type { AccountProfile, Config } from "../src/config.js";
import {
  GhExecutionError,
  runGh,
  runGhRawBlobChunk,
} from "../src/gh-runner.js";
import type { RunGhRawBlobChunkOptions } from "../src/gh-runner.js";

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

type MockChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function mockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function scriptedChild(options: {
  stdout?: readonly Buffer[];
  stderr?: readonly Buffer[];
  exitCode?: number | null;
} = {}): MockChild {
  const child = mockChild();
  setImmediate(() => {
    for (const chunk of options.stdout ?? []) child.stdout.write(chunk);
    child.stdout.end();
    for (const chunk of options.stderr ?? []) child.stderr.write(chunk);
    child.stderr.end();
    child.emit("close", options.exitCode ?? 0);
  });
  return child;
}

function rawBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function rawBlobOptions(
  bytes: Buffer,
  overrides: Partial<RunGhRawBlobChunkOptions> = {},
): RunGhRawBlobChunkOptions {
  return {
    expectedBlobSha: rawBlobSha(bytes),
    expectedTotalBytes: bytes.length,
    offsetBytes: 0,
    limitBytes: Math.max(1, bytes.length),
    ...overrides,
  };
}

afterEach(() => {
  spawnMock.mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
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

describe("GitHub CLI raw blob chunk execution", () => {
  it("captures an exact binary byte window across multiple stdout data boundaries", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from([
      0x00, 0xff, 0x61, 0xc3, 0xa9, 0x62, 0x0a, 0x7f, 0x80, 0x63, 0x64,
    ]);
    const child = scriptedChild({
      stdout: [
        blob.subarray(0, 2),
        blob.subarray(2, 5),
        blob.subarray(5, 8),
        blob.subarray(8),
      ],
    });
    spawnMock.mockReturnValueOnce(child);

    const result = await runGhRawBlobChunk(
      ["api", "repos/ma-nakaya/example/git/blobs/deadbeef", "-H", "Accept: application/vnd.github.raw"],
      config,
      context,
      rawBlobOptions(blob, { offsetBytes: 1, limitBytes: 8 }),
    );

    expect(result.bytes).toEqual(blob.subarray(1, 9));
    expect(result.totalBytes).toBe(blob.length);
    expect(result.verifiedBlobSha).toBe(rawBlobSha(blob));
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "repos/ma-nakaya/example/git/blobs/deadbeef",
        "-H",
        "Accept: application/vnd.github.raw",
      ],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("drains and hashes the full blob after the requested window has been captured", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const requested = Buffer.from("ab", "utf8");
    const remainder = Buffer.from("cdefghijklmnopqrstuvwxyz", "utf8");
    const blob = Buffer.concat([requested, remainder]);
    const child = mockChild();
    spawnMock.mockReturnValueOnce(child);

    const resultPromise = runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob, { limitBytes: requested.length }),
    );
    child.stdout.write(requested);
    await new Promise<void>((resolve) => setImmediate(resolve));

    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.stdout.write(remainder.subarray(0, 7));
    child.stdout.write(remainder.subarray(7));
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);

    const result = await resultPromise;
    expect(result.bytes).toEqual(requested);
    expect(result.totalBytes).toBe(blob.length);
    expect(result.verifiedBlobSha).toBe(rawBlobSha(blob));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("accepts an exact lowercase Git blob SHA and returns a tail shorter than the limit", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from("0123456789", "utf8");
    spawnMock.mockReturnValueOnce(scriptedChild({
      stdout: [blob.subarray(0, 4), blob.subarray(4)],
    }));

    const result = await runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob, { offsetBytes: 7, limitBytes: 100 }),
    );

    expect(result).toMatchObject({
      totalBytes: 10,
      verifiedBlobSha: rawBlobSha(blob),
    });
    expect(result.bytes.toString("utf8")).toBe("789");
  });

  it("rejects content whose computed Git blob SHA differs from the expected SHA", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from("authentic repository bytes", "utf8");
    const actualSha = rawBlobSha(blob);
    spawnMock.mockReturnValueOnce(scriptedChild({ stdout: [blob] }));

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob, { expectedBlobSha: "0".repeat(40) }),
    )).rejects.toThrow(
      `gh raw blob SHA ${actualSha} did not match the expected ${"0".repeat(40)}.`,
    );
  });

  it("rejects a blob shorter than its trusted metadata size", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const metadataBlob = Buffer.from("abcdef", "utf8");
    const returnedBlob = Buffer.from("abcde", "utf8");
    spawnMock.mockReturnValueOnce(scriptedChild({ stdout: [returnedBlob] }));

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(metadataBlob),
    )).rejects.toThrow(
      "gh raw blob size 5 did not match the expected 6 bytes.",
    );
  });

  it("kills and rejects a blob longer than its trusted metadata size", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const metadataBlob = Buffer.from("abcdef", "utf8");
    const returnedBlob = Buffer.from("abcdefg", "utf8");
    const child = scriptedChild({
      stdout: [returnedBlob.subarray(0, 6), returnedBlob.subarray(6)],
    });
    spawnMock.mockReturnValueOnce(child);

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(metadataBlob),
    )).rejects.toThrow(
      "gh raw blob size 7 did not match the expected 6 bytes.",
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects a nonzero exit that occurs after the requested window was captured", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from("complete blob output", "utf8");
    spawnMock.mockReturnValueOnce(scriptedChild({
      stdout: [blob.subarray(0, 4), blob.subarray(4)],
      stderr: [Buffer.from("remote returned an error", "utf8")],
      exitCode: 22,
    }));

    let caught: unknown;
    try {
      await runGhRawBlobChunk(
        ["api", "raw-blob"],
        config,
        context,
        rawBlobOptions(blob, { limitBytes: 4 }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GhExecutionError);
    expect((caught as GhExecutionError).result).toEqual({
      exitCode: 22,
      stdout: "",
      stderr: "remote returned an error",
    });
  });

  it("caps cumulative stderr output independently of the requested blob window", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = { ...configFor([ma]), maxOutputBytes: 8 };
    const context = resolveAccountContext(config);
    const blob = Buffer.from("data", "utf8");
    const child = scriptedChild({
      stdout: [blob],
      stderr: [
        Buffer.from("12345", "utf8"),
        Buffer.from("6789", "utf8"),
      ],
    });
    spawnMock.mockReturnValueOnce(child);

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob),
    )).rejects.toThrow("gh error output exceeded 8 bytes.");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("times out a child that never closes and kills it", async () => {
    vi.useFakeTimers();
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = { ...configFor([ma]), timeoutMs: 25 };
    const context = resolveAccountContext(config);
    const blob = Buffer.from("data", "utf8");
    const child = mockChild();
    spawnMock.mockReturnValueOnce(child);

    const resultPromise = runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob),
    );
    const rejection = expect(resultPromise).rejects.toThrow(
      "gh command timed out after 25 ms.",
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("wraps a child-process spawn error without waiting for timeout", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from("data", "utf8");
    const child = mockChild();
    spawnMock.mockReturnValueOnce(child);
    setImmediate(() => {
      child.emit("error", new Error("ENOENT"));
    });

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob),
    )).rejects.toThrow("Unable to start GitHub CLI at 'gh': ENOENT");
  });

  it("verifies and returns an empty blob without capturing bytes", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.alloc(0);
    spawnMock.mockReturnValueOnce(scriptedChild());

    const result = await runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob),
    );

    expect(result.bytes).toEqual(Buffer.alloc(0));
    expect(result.totalBytes).toBe(0);
    expect(result.verifiedBlobSha).toBe(
      createHash("sha1").update(Buffer.from("blob 0\0", "utf8")).digest("hex"),
    );
  });

  it.each([
    {
      label: "an uppercase SHA",
      override: { expectedBlobSha: "A".repeat(40) },
      message: /expectedBlobSha must be a lowercase 40-character Git SHA/,
    },
    {
      label: "a short SHA",
      override: { expectedBlobSha: "a".repeat(39) },
      message: /expectedBlobSha must be a lowercase 40-character Git SHA/,
    },
    {
      label: "a negative total size",
      override: { expectedTotalBytes: -1 },
      message: /expectedTotalBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "a fractional total size",
      override: { expectedTotalBytes: 1.5 },
      message: /expectedTotalBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "an unsafe total size",
      override: { expectedTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
      message: /expectedTotalBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "a total size above GitHub's blob limit",
      override: { expectedTotalBytes: (100 * 1024 * 1024) + 1 },
      message: /exceeds the supported 104857600-byte GitHub blob limit/,
    },
    {
      label: "a negative offset",
      override: { offsetBytes: -1 },
      message: /offsetBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "a fractional offset",
      override: { offsetBytes: 0.5 },
      message: /offsetBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "an unsafe offset",
      override: { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
      message: /offsetBytes must be a safe integer greater than or equal to 0/,
    },
    {
      label: "an offset beyond the blob",
      override: { offsetBytes: 4 },
      message: /offsetBytes 4 exceeds the expected raw blob size of 3 bytes/,
    },
    {
      label: "a zero limit",
      override: { limitBytes: 0 },
      message: /limitBytes must be a safe integer greater than or equal to 1/,
    },
    {
      label: "a negative limit",
      override: { limitBytes: -1 },
      message: /limitBytes must be a safe integer greater than or equal to 1/,
    },
    {
      label: "a fractional limit",
      override: { limitBytes: 1.5 },
      message: /limitBytes must be a safe integer greater than or equal to 1/,
    },
    {
      label: "an unsafe limit",
      override: { limitBytes: Number.MAX_SAFE_INTEGER + 1 },
      message: /limitBytes must be a safe integer greater than or equal to 1/,
    },
    {
      label: "a limit above the configured output cap",
      override: { limitBytes: 1001 },
      message: /limitBytes 1001 exceeds the configured 1000-byte output limit/,
    },
  ])("rejects $label before spawning gh", async ({ override, message }) => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const blob = Buffer.from("abc", "utf8");

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      context,
      rawBlobOptions(blob, override),
    )).rejects.toThrow(message);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects a forged or stale raw-blob request context before spawning gh", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const config = configFor([ma]);
    const context = resolveAccountContext(config);
    const forgedContext = {
      ...context,
      profile: { ...context.profile },
    };
    const blob = Buffer.from("abc", "utf8");

    await expect(runGhRawBlobChunk(
      ["api", "raw-blob"],
      config,
      forgedContext,
      rawBlobOptions(blob),
    )).rejects.toThrow(/request context is not configured/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("isolates concurrent raw-blob child environments from each other and ambient auth", async () => {
    const ma = profile("ma-nakaya", "C:/secure/gh-ma");
    const masa = profile("masa-nakaya", "C:/secure/gh-masa");
    const config = configFor([ma, masa]);
    const maContext = resolveAccountContext(config, "ma-nakaya");
    const masaContext = resolveAccountContext(config, "masa-nakaya");
    const maBlob = Buffer.from("ma bytes", "utf8");
    const masaBlob = Buffer.from("masa bytes", "utf8");
    vi.stubEnv("GH_CONFIG_DIR", "C:/ambient/gh");
    vi.stubEnv("GH_HOST", "ambient.example.com");
    vi.stubEnv("GH_TOKEN", `ghp_${"a".repeat(36)}`);
    vi.stubEnv("GITHUB_TOKEN", `github_pat_${"b".repeat(82)}`);
    spawnMock
      .mockImplementationOnce(() => scriptedChild({ stdout: [maBlob] }))
      .mockImplementationOnce(() => scriptedChild({ stdout: [masaBlob] }));

    const [maResult, masaResult] = await Promise.all([
      runGhRawBlobChunk(
        ["api", "raw-ma"],
        config,
        maContext,
        rawBlobOptions(maBlob),
      ),
      runGhRawBlobChunk(
        ["api", "raw-masa"],
        config,
        masaContext,
        rawBlobOptions(masaBlob),
      ),
    ]);

    expect(maResult.bytes).toEqual(maBlob);
    expect(masaResult.bytes).toEqual(masaBlob);
    const maEnvironment = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const masaEnvironment = spawnMock.mock.calls[1]?.[2]?.env as NodeJS.ProcessEnv;
    expect(maEnvironment).toMatchObject({
      GH_CONFIG_DIR: "C:/secure/gh-ma",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    });
    expect(masaEnvironment).toMatchObject({
      GH_CONFIG_DIR: "C:/secure/gh-masa",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
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
});
