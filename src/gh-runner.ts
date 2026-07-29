import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Config, RequestContext } from "./config.js";
import { restrictedEnvironment } from "./config.js";
import { redactSecrets } from "./redaction.js";

export interface GhResult { exitCode: number; stdout: string; stderr: string }
export interface RunGhOptions { allowFailure?: boolean; stdin?: string }
export interface GhRawBlobChunkResult {
  bytes: Buffer;
  totalBytes: number;
  verifiedBlobSha: string;
}
export interface RunGhRawBlobChunkOptions {
  expectedBlobSha: string;
  expectedTotalBytes: number;
  offsetBytes: number;
  limitBytes: number;
}

export class GhExecutionError extends Error {
  constructor(public readonly result: GhResult) {
    super(result.stderr || `gh exited with code ${result.exitCode}`);
    this.name = "GhExecutionError";
  }
}

function assertConfiguredContext(config: Config, context: RequestContext): void {
  const configuredProfile = config.accountProfiles.get(context.accountId);
  if (configuredProfile === undefined || configuredProfile !== context.profile) {
    throw new Error(`GitHub request context is not configured: ${context.accountId}`);
  }
}

export async function runGh(
  args: readonly string[],
  config: Config,
  context: RequestContext,
  options: RunGhOptions = {},
): Promise<GhResult> {
  assertConfiguredContext(config, context);
  return new Promise((resolve, reject) => {
    const child = spawn(config.ghPath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: restrictedEnvironment(context, process.env),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > config.maxOutputBytes) {
        exceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => { append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { append(stderr, chunk); });
    child.stdin.end(options.stdin ?? "", "utf8");
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`gh command timed out after ${config.timeoutMs} ms.`));
    }, config.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to start GitHub CLI at '${config.ghPath}': ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) {
        reject(new Error(`gh output exceeded ${config.maxOutputBytes} bytes.`));
        return;
      }
      const result = {
        exitCode: code ?? 1,
        stdout: redactSecrets(Buffer.concat(stdout).toString("utf8")),
        stderr: redactSecrets(Buffer.concat(stderr).toString("utf8")),
      };
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(new GhExecutionError(result));
      } else {
        resolve(result);
      }
    });
  });
}

const MAX_GITHUB_BLOB_BYTES = 100 * 1024 * 1024;

function safeByteCount(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export async function runGhRawBlobChunk(
  args: readonly string[],
  config: Config,
  context: RequestContext,
  options: RunGhRawBlobChunkOptions,
): Promise<GhRawBlobChunkResult> {
  assertConfiguredContext(config, context);
  if (!/^[0-9a-f]{40}$/.test(options.expectedBlobSha)) {
    throw new Error("expectedBlobSha must be a lowercase 40-character Git SHA.");
  }
  const expectedTotalBytes = safeByteCount(
    options.expectedTotalBytes,
    "expectedTotalBytes",
    0,
  );
  const offsetBytes = safeByteCount(options.offsetBytes, "offsetBytes", 0);
  const limitBytes = safeByteCount(options.limitBytes, "limitBytes", 1);
  if (expectedTotalBytes > MAX_GITHUB_BLOB_BYTES) {
    throw new Error(
      `expectedTotalBytes ${expectedTotalBytes} exceeds the supported ${MAX_GITHUB_BLOB_BYTES}-byte GitHub blob limit.`,
    );
  }
  if (offsetBytes > expectedTotalBytes) {
    throw new Error(
      `offsetBytes ${offsetBytes} exceeds the expected raw blob size of ${expectedTotalBytes} bytes.`,
    );
  }
  if (limitBytes > config.maxOutputBytes) {
    throw new Error(
      `limitBytes ${limitBytes} exceeds the configured ${config.maxOutputBytes}-byte output limit.`,
    );
  }

  const targetEndBytes = Math.min(expectedTotalBytes, offsetBytes + limitBytes);
  const targetLength = targetEndBytes - offsetBytes;

  return new Promise((resolve, reject) => {
    const child = spawn(config.ghPath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: restrictedEnvironment(context, process.env),
    });
    const output: Buffer[] = [];
    const stderr: Buffer[] = [];
    const hash = createHash("sha1");
    hash.update(Buffer.from(`blob ${expectedTotalBytes}\0`, "utf8"));
    let outputLength = 0;
    let stderrBytes = 0;
    let totalBytes = 0;
    let exceededExpectedSize = false;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const chunkStart = totalBytes;
      const chunkEnd = chunkStart + chunk.length;
      hash.update(chunk);
      const copyStart = Math.max(offsetBytes, chunkStart);
      const copyEnd = Math.min(targetEndBytes, chunkEnd);
      if (copyEnd > copyStart) {
        const selected = chunk.subarray(
          copyStart - chunkStart,
          copyEnd - chunkStart,
        );
        output.push(selected);
        outputLength += selected.length;
      }
      totalBytes = chunkEnd;
      if (!exceededExpectedSize && totalBytes > expectedTotalBytes) {
        exceededExpectedSize = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > config.maxOutputBytes) {
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.end("", "utf8");

    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`gh command timed out after ${config.timeoutMs} ms.`));
    }, config.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(new Error(`Unable to start GitHub CLI at '${config.ghPath}': ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (stderrBytes > config.maxOutputBytes) {
        fail(new Error(`gh error output exceeded ${config.maxOutputBytes} bytes.`));
        return;
      }
      const stderrText = redactSecrets(Buffer.concat(stderr).toString("utf8"));
      if (code !== 0) {
        fail(new GhExecutionError({
          exitCode: code ?? 1,
          stdout: "",
          stderr: stderrText,
        }));
        return;
      }
      if (exceededExpectedSize || totalBytes !== expectedTotalBytes) {
        fail(new Error(
          `gh raw blob size ${totalBytes} did not match the expected ${expectedTotalBytes} bytes.`,
        ));
        return;
      }
      if (outputLength !== targetLength) {
        fail(new Error(
          `gh raw blob did not contain the requested byte chunk: expected ${targetLength} bytes, received ${outputLength}.`,
        ));
        return;
      }
      const verifiedBlobSha = hash.digest("hex");
      if (verifiedBlobSha !== options.expectedBlobSha) {
        fail(new Error(
          `gh raw blob SHA ${verifiedBlobSha} did not match the expected ${options.expectedBlobSha}.`,
        ));
        return;
      }
      settled = true;
      resolve({
        bytes: Buffer.concat(output, outputLength),
        totalBytes,
        verifiedBlobSha,
      });
    });
  });
}
