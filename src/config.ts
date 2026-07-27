import { homedir } from "node:os";
import { join } from "node:path";

export interface AccountProfile {
  expectedLogin: string;
  hostname: string;
  configDir: string;
}

export interface Config {
  ghPath: string;
  allowedHosts: ReadonlySet<string>;
  allowedOwners: ReadonlySet<string>;
  allowedRepositories: ReadonlySet<string>;
  timeoutMs: number;
  maxOutputBytes: number;
  auditLogPath: string;
  accountProfile?: AccountProfile;
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
  const allowedHosts = csv(env.GH_MCP_ALLOWED_HOSTS || "github.com");
  const allowedOwners = csv(env.GH_MCP_ALLOWED_OWNERS);
  const allowedRepositories = csv(env.GH_MCP_ALLOWED_REPOSITORIES);
  const rawExpectedLogin = env.GH_MCP_EXPECTED_LOGIN;
  if (rawExpectedLogin !== undefined && rawExpectedLogin.trim().length === 0) {
    throw new Error("GH_MCP_EXPECTED_LOGIN must not be empty when it is set.");
  }
  const expectedLogin = rawExpectedLogin?.trim().toLowerCase();
  const accountHostname = (env.GH_MCP_ACCOUNT_HOST?.trim() || env.GH_HOST?.trim() || "github.com").toLowerCase();
  const ghConfigDir = env.GH_CONFIG_DIR?.trim();
  let accountProfile: AccountProfile | undefined;

  if (allowedHosts.size === 0) {
    throw new Error("GH_MCP_ALLOWED_HOSTS must contain at least one hostname.");
  }
  for (const hostname of allowedHosts) {
    if (!/^[a-z0-9.-]+$/i.test(hostname)) {
      throw new Error(`GH_MCP_ALLOWED_HOSTS contains an invalid hostname: ${hostname}`);
    }
  }
  for (const owner of allowedOwners) {
    if (!/^[a-z0-9_.-]+$/i.test(owner)) {
      throw new Error(`GH_MCP_ALLOWED_OWNERS contains an invalid owner: ${owner}`);
    }
  }
  for (const repository of allowedRepositories) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
      throw new Error(`GH_MCP_ALLOWED_REPOSITORIES contains an invalid repository: ${repository}`);
    }
  }

  if (expectedLogin) {
    if (!/^[a-z0-9_.-]+$/i.test(expectedLogin)) {
      throw new Error("GH_MCP_EXPECTED_LOGIN must be a GitHub login.");
    }
    if (!ghConfigDir) {
      throw new Error("GH_CONFIG_DIR is required when GH_MCP_EXPECTED_LOGIN is set.");
    }
    if (!allowedHosts.has(accountHostname)) {
      throw new Error(`GH_MCP_ACCOUNT_HOST is not allowed: ${accountHostname}`);
    }
    if (allowedOwners.size === 0 && allowedRepositories.size === 0) {
      throw new Error(
        "GH_MCP_ALLOWED_OWNERS or GH_MCP_ALLOWED_REPOSITORIES is required when GH_MCP_EXPECTED_LOGIN is set.",
      );
    }
    accountProfile = { expectedLogin, hostname: accountHostname, configDir: ghConfigDir };
  }

  return {
    ghPath: env.GH_MCP_GH_PATH?.trim() || (process.platform === "win32" ? "gh.exe" : "gh"),
    allowedHosts,
    allowedOwners,
    allowedRepositories,
    timeoutMs: positiveInteger(env.GH_MCP_TIMEOUT_MS, 30_000),
    maxOutputBytes: positiveInteger(env.GH_MCP_MAX_OUTPUT_BYTES, 1_000_000),
    auditLogPath: env.GH_MCP_AUDIT_LOG_PATH?.trim() || defaultAuditLogPath(env),
    ...(accountProfile === undefined ? {} : { accountProfile }),
  };
}

export function restrictedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  accountProfile?: AccountProfile,
  allowedHosts: ReadonlySet<string> = new Set(["github.com"]),
): NodeJS.ProcessEnv {
  const allowedKeys = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "GH_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) if (env[key] !== undefined) result[key] = env[key];
  if (accountProfile !== undefined) {
    result.GH_CONFIG_DIR = accountProfile.configDir;
    result.GH_HOST = accountProfile.hostname;
  } else {
    const ambientHost = env.GH_HOST?.trim().toLowerCase();
    const selectedHost = ambientHost !== undefined && allowedHosts.has(ambientHost)
      ? ambientHost
      : allowedHosts.values().next().value;
    if (selectedHost !== undefined) result.GH_HOST = selectedHost;
  }
  result.GH_PROMPT_DISABLED = "1";
  result.NO_COLOR = "1";
  return result;
}
