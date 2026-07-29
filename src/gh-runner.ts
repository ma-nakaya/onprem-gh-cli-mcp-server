import { spawn } from "node:child_process";
import type { Config, RequestContext } from "./config.js";
import { restrictedEnvironment } from "./config.js";
import { redactSecrets } from "./redaction.js";

export interface GhResult { exitCode: number; stdout: string; stderr: string }
export interface RunGhOptions { allowFailure?: boolean; stdin?: string }

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
