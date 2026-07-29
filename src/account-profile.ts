import type { Config, RequestContext } from "./config.js";
import { runGh } from "./gh-runner.js";

const ACCOUNT_PATTERN = /^[a-z0-9_.-]+$/i;
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/i;

export function loginFromUserApi(stdout: string): string {
  const login = stdout.trim().toLowerCase();
  if (!ACCOUNT_PATTERN.test(login)) {
    throw new Error("GitHub CLI returned an invalid authenticated user login.");
  }
  return login;
}

export function resolveAccountContext(
  config: Config,
  account?: string,
  hostname?: string,
): RequestContext {
  const requestedAccount = account?.trim().toLowerCase();
  if (account !== undefined && requestedAccount?.length === 0) {
    throw new Error("account must not be empty.");
  }
  if (requestedAccount !== undefined && !ACCOUNT_PATTERN.test(requestedAccount)) {
    throw new Error("account must be a configured GitHub account id.");
  }

  let accountId = requestedAccount;
  if (accountId === undefined) {
    if (config.accountProfiles.size === 0) {
      throw new Error(
        "No GitHub account profiles are configured. Set GH_MCP_ACCOUNTS_FILE or the legacy single-account settings.",
      );
    }
    if (config.accountProfiles.size !== 1 || config.defaultAccountId === undefined) {
      throw new Error("account is required when multiple GitHub account profiles are configured.");
    }
    accountId = config.defaultAccountId;
  }

  const profile = config.accountProfiles.get(accountId);
  if (profile === undefined) {
    throw new Error(`GitHub account profile is not configured: ${accountId}`);
  }

  if (hostname !== undefined) {
    const normalizedHostname = hostname.trim().toLowerCase();
    if (normalizedHostname.length === 0 || !HOSTNAME_PATTERN.test(normalizedHostname)) {
      throw new Error("hostname must be a valid GitHub hostname.");
    }
    if (normalizedHostname !== profile.hostname) {
      throw new Error(
        `GitHub host does not match account profile '${profile.id}': expected ${profile.hostname}, requested ${normalizedHostname}.`,
      );
    }
  }

  return Object.freeze({ accountId: profile.id, profile });
}

export async function verifyAccountProfile(
  config: Config,
  context: RequestContext,
): Promise<string> {
  const result = await runGh([
    "api",
    "user",
    "--hostname",
    context.profile.hostname,
    "--jq",
    ".login",
  ], config, context);
  const actualLogin = loginFromUserApi(result.stdout);
  if (actualLogin !== context.profile.expectedLogin) {
    throw new Error(
      `GitHub CLI account mismatch for ${context.profile.hostname}: expected ${context.profile.expectedLogin}, active ${actualLogin}.`,
    );
  }
  return actualLogin;
}
