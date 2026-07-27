import type { Config } from "./config.js";
import { runGh } from "./gh-runner.js";

export function loginFromUserApi(stdout: string): string {
  const login = stdout.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/i.test(login)) {
    throw new Error("GitHub CLI returned an invalid authenticated user login.");
  }
  return login;
}

export async function verifyAccountProfile(config: Config): Promise<void> {
  const profile = config.accountProfile;
  if (profile === undefined) return;

  const result = await runGh([
    "api",
    "user",
    "--hostname",
    profile.hostname,
    "--jq",
    ".login",
  ], config);
  const actualLogin = loginFromUserApi(result.stdout);
  if (actualLogin !== profile.expectedLogin) {
    throw new Error(
      `GitHub CLI account mismatch for ${profile.hostname}: expected ${profile.expectedLogin}, active ${actualLogin}.`,
    );
  }
}
