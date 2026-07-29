import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

export interface AccountProfile {
  readonly id: string;
  readonly expectedLogin: string;
  readonly hostname: string;
  readonly configDir: string;
  readonly allowedOwners: ReadonlySet<string>;
  readonly allowedRepositories: ReadonlySet<string>;
}

export interface RequestContext {
  readonly accountId: string;
  readonly profile: AccountProfile;
}

export interface Config {
  ghPath: string;
  allowedHosts: ReadonlySet<string>;
  accountProfiles: ReadonlyMap<string, AccountProfile>;
  defaultAccountId?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  auditLogPath: string;
}

interface ManifestAccount {
  id: unknown;
  expectedLogin: unknown;
  hostname: unknown;
  configDir: unknown;
  allowedOwners: unknown;
  allowedRepositories: unknown;
}

const ACCOUNT_PATTERN = /^[a-z0-9_.-]+$/i;
const ACCOUNT_MAX_LENGTH = 100;
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/i;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const LEGACY_ACCOUNT_KEYS = [
  "GH_MCP_EXPECTED_LOGIN",
  "GH_MCP_ACCOUNT_HOST",
  "GH_CONFIG_DIR",
  "GH_MCP_ALLOWED_OWNERS",
  "GH_MCP_ALLOWED_REPOSITORIES",
] as const;

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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizedIdentifier(value: unknown, label: string): string {
  const normalized = requireString(value, label).toLowerCase();
  if (normalized.length > ACCOUNT_MAX_LENGTH || !ACCOUNT_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a GitHub account identifier.`);
  }
  return normalized;
}

function normalizedHostname(value: unknown, label: string): string {
  const normalized = requireString(value, label).toLowerCase();
  if (!HOSTNAME_PATTERN.test(normalized)) {
    throw new Error(`${label} contains an invalid hostname: ${normalized}`);
  }
  return normalized;
}

function normalizedStringSet(
  value: unknown,
  label: string,
  pattern: RegExp,
): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const result = new Set<string>();
  for (const item of value) {
    const normalized = requireString(item, `${label} entry`).toLowerCase();
    if (!pattern.test(normalized)) {
      throw new Error(`${label} contains an invalid value: ${normalized}`);
    }
    result.add(normalized);
  }
  return result;
}

function assertExactObjectKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !(key in record));
  const unexpected = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required properties: ${missing.join(", ")}.`);
  }
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported properties: ${unexpected.join(", ")}.`);
  }
}

function configDirectoryKey(configDir: string): string {
  let normalizedPath: string;
  try {
    normalizedPath = realpathSync.native(configDir);
  } catch {
    // Do not make one missing or temporarily unavailable profile prevent the
    // MCP server from starting. Lexical normalization still catches ordinary
    // duplicates; request-time identity verification fails the profile closed.
    normalizedPath = resolve(normalize(configDir));
  }
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function createAccountProfile(
  input: ManifestAccount,
  allowedHosts: ReadonlySet<string>,
  label: string,
): AccountProfile {
  const id = normalizedIdentifier(input.id, `${label}.id`);
  const expectedLogin = normalizedIdentifier(input.expectedLogin, `${label}.expectedLogin`);
  const hostname = normalizedHostname(input.hostname, `${label}.hostname`);
  const configDir = requireString(input.configDir, `${label}.configDir`);
  const allowedOwners = normalizedStringSet(
    input.allowedOwners,
    `${label}.allowedOwners`,
    ACCOUNT_PATTERN,
  );
  const allowedRepositories = normalizedStringSet(
    input.allowedRepositories,
    `${label}.allowedRepositories`,
    REPOSITORY_PATTERN,
  );

  if (!isAbsolute(configDir)) {
    throw new Error(`${label}.configDir must be an absolute path.`);
  }
  if (!allowedHosts.has(hostname)) {
    throw new Error(`${label}.hostname is not allowed: ${hostname}`);
  }
  if (allowedOwners.size === 0 && allowedRepositories.size === 0) {
    throw new Error(`${label} must allow at least one owner or repository.`);
  }

  return Object.freeze({
    id,
    expectedLogin,
    hostname,
    configDir,
    allowedOwners,
    allowedRepositories,
  });
}

function parseAccountsManifest(
  manifestPath: string,
  allowedHosts: ReadonlySet<string>,
): ReadonlyMap<string, AccountProfile> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read GH_MCP_ACCOUNTS_FILE '${manifestPath}': ${message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GH_MCP_ACCOUNTS_FILE must contain a JSON object.");
  }
  const record = value as Record<string, unknown>;
  assertExactObjectKeys(record, ["version", "accounts"], "GH_MCP_ACCOUNTS_FILE");
  if (record.version !== 1) {
    throw new Error("GH_MCP_ACCOUNTS_FILE must use manifest version 1.");
  }
  if (!Array.isArray(record.accounts) || record.accounts.length === 0) {
    throw new Error("GH_MCP_ACCOUNTS_FILE must contain at least one account.");
  }

  const profiles = new Map<string, AccountProfile>();
  const configDirectories = new Set<string>();
  const identities = new Set<string>();
  for (let index = 0; index < record.accounts.length; index += 1) {
    const account = record.accounts[index];
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new Error(`accounts[${index}] must be an object.`);
    }
    const accountRecord = account as Record<string, unknown>;
    assertExactObjectKeys(
      accountRecord,
      [
        "id",
        "expectedLogin",
        "hostname",
        "configDir",
        "allowedOwners",
        "allowedRepositories",
      ],
      `accounts[${index}]`,
    );
    const profile = createAccountProfile(
      accountRecord as unknown as ManifestAccount,
      allowedHosts,
      `accounts[${index}]`,
    );
    if (profiles.has(profile.id)) {
      throw new Error(`GH_MCP_ACCOUNTS_FILE contains a duplicate account id: ${profile.id}`);
    }
    const configDirKey = configDirectoryKey(profile.configDir);
    if (configDirectories.has(configDirKey)) {
      throw new Error(`GH_MCP_ACCOUNTS_FILE reuses a configDir: ${profile.configDir}`);
    }
    const identityKey = `${profile.hostname}\0${profile.expectedLogin}`;
    if (identities.has(identityKey)) {
      throw new Error(
        `GH_MCP_ACCOUNTS_FILE contains a duplicate account identity: ${profile.expectedLogin}@${profile.hostname}`,
      );
    }
    profiles.set(profile.id, profile);
    configDirectories.add(configDirKey);
    identities.add(identityKey);
  }
  return profiles;
}

function legacyAccountProfiles(
  env: NodeJS.ProcessEnv,
  allowedHosts: ReadonlySet<string>,
): ReadonlyMap<string, AccountProfile> {
  const rawExpectedLogin = env.GH_MCP_EXPECTED_LOGIN;
  if (rawExpectedLogin === undefined) return new Map();
  if (rawExpectedLogin.trim().length === 0) {
    throw new Error("GH_MCP_EXPECTED_LOGIN must not be empty when it is set.");
  }

  const expectedLogin = normalizedIdentifier(rawExpectedLogin, "GH_MCP_EXPECTED_LOGIN");
  const hostname = normalizedHostname(
    env.GH_MCP_ACCOUNT_HOST?.trim() || "github.com",
    "GH_MCP_ACCOUNT_HOST",
  );
  const configDir = env.GH_CONFIG_DIR?.trim();
  const allowedOwners = csv(env.GH_MCP_ALLOWED_OWNERS);
  const allowedRepositories = csv(env.GH_MCP_ALLOWED_REPOSITORIES);

  if (!configDir) {
    throw new Error("GH_CONFIG_DIR is required when GH_MCP_EXPECTED_LOGIN is set.");
  }
  if (!isAbsolute(configDir)) {
    throw new Error("GH_CONFIG_DIR must be an absolute path.");
  }
  if (!allowedHosts.has(hostname)) {
    throw new Error(`GH_MCP_ACCOUNT_HOST is not allowed: ${hostname}`);
  }
  for (const owner of allowedOwners) {
    if (!ACCOUNT_PATTERN.test(owner)) {
      throw new Error(`GH_MCP_ALLOWED_OWNERS contains an invalid owner: ${owner}`);
    }
  }
  for (const repository of allowedRepositories) {
    if (!REPOSITORY_PATTERN.test(repository)) {
      throw new Error(`GH_MCP_ALLOWED_REPOSITORIES contains an invalid repository: ${repository}`);
    }
  }
  if (allowedOwners.size === 0 && allowedRepositories.size === 0) {
    throw new Error(
      "GH_MCP_ALLOWED_OWNERS or GH_MCP_ALLOWED_REPOSITORIES is required when GH_MCP_EXPECTED_LOGIN is set.",
    );
  }

  const profile = Object.freeze({
    id: expectedLogin,
    expectedLogin,
    hostname,
    configDir,
    allowedOwners,
    allowedRepositories,
  });
  return new Map([[profile.id, profile]]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedHosts = csv(env.GH_MCP_ALLOWED_HOSTS || "github.com");
  if (allowedHosts.size === 0) {
    throw new Error("GH_MCP_ALLOWED_HOSTS must contain at least one hostname.");
  }
  for (const hostname of allowedHosts) {
    if (!HOSTNAME_PATTERN.test(hostname)) {
      throw new Error(`GH_MCP_ALLOWED_HOSTS contains an invalid hostname: ${hostname}`);
    }
  }

  const rawManifestPath = env.GH_MCP_ACCOUNTS_FILE;
  let accountProfiles: ReadonlyMap<string, AccountProfile>;
  if (rawManifestPath !== undefined) {
    const manifestPath = rawManifestPath.trim();
    if (manifestPath.length === 0) {
      throw new Error("GH_MCP_ACCOUNTS_FILE must not be empty when it is set.");
    }
    if (!isAbsolute(manifestPath)) {
      throw new Error("GH_MCP_ACCOUNTS_FILE must be an absolute path.");
    }
    const mixedKey = LEGACY_ACCOUNT_KEYS.find((key) => env[key] !== undefined);
    if (mixedKey !== undefined) {
      throw new Error(`GH_MCP_ACCOUNTS_FILE cannot be combined with legacy setting ${mixedKey}.`);
    }
    accountProfiles = parseAccountsManifest(manifestPath, allowedHosts);
  } else {
    accountProfiles = legacyAccountProfiles(env, allowedHosts);
  }

  const defaultAccountId = accountProfiles.size === 1
    ? accountProfiles.keys().next().value
    : undefined;
  return {
    ghPath: env.GH_MCP_GH_PATH?.trim() || (process.platform === "win32" ? "gh.exe" : "gh"),
    allowedHosts,
    accountProfiles,
    ...(defaultAccountId === undefined ? {} : { defaultAccountId }),
    timeoutMs: positiveInteger(env.GH_MCP_TIMEOUT_MS, 30_000),
    maxOutputBytes: positiveInteger(env.GH_MCP_MAX_OUTPUT_BYTES, 1_000_000),
    auditLogPath: env.GH_MCP_AUDIT_LOG_PATH?.trim() || defaultAuditLogPath(env),
  };
}

export function restrictedEnvironment(
  context: RequestContext,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  result.GH_CONFIG_DIR = context.profile.configDir;
  result.GH_HOST = context.profile.hostname;
  result.GH_PROMPT_DISABLED = "1";
  result.NO_COLOR = "1";
  return result;
}
