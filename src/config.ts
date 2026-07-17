import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  ghPath: string;
  allowedHosts: ReadonlySet<string>;
  allowedOwners: ReadonlySet<string>;
  allowedRepositories: ReadonlySet<string>;
  timeoutMs: number;
  maxOutputBytes: number;
  auditLogPath: string;
}

function csv(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultAuditLogPath(env: NodeJS.ProcessEnv): string {
  const baseDirectory = process.platform === "win32"
    ? env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local")
    : env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(baseDirectory, "onprem-gh-cli-mcp", "audit.jsonl");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    ghPath: env.GH_MCP_GH_PATH?.trim() || (process.platform === "win32" ? "gh.exe" : "gh"),
    allowedHosts: csv(env.GH_MCP_ALLOWED_HOSTS || "github.com"),
    allowedOwners: csv(env.GH_MCP_ALLOWED_OWNERS),
    allowedRepositories: csv(env.GH_MCP_ALLOWED_REPOSITORIES),
    timeoutMs: positiveInteger(env.GH_MCP_TIMEOUT_MS, 30_000),
    maxOutputBytes: positiveInteger(env.GH_MCP_MAX_OUTPUT_BYTES, 1_000_000),
    auditLogPath: env.GH_MCP_AUDIT_LOG_PATH?.trim() || defaultAuditLogPath(env),
  };
}

export function restrictedEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowedKeys = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "GH_CONFIG_DIR", "GH_HOST", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) if (env[key] !== undefined) result[key] = env[key];
  result.GH_PROMPT_DISABLED = "1";
  result.NO_COLOR = "1";
  return result;
}
