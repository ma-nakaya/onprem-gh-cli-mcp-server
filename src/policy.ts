import type { Config } from "./config.js";

const SAFE_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  auth: new Set(["status"]),
  repo: new Set(["list", "view"]),
  issue: new Set(["list", "view", "status"]),
  pr: new Set(["list", "view", "status", "checks", "diff"]),
  run: new Set(["list", "view", "watch"]),
  workflow: new Set(["list", "view"]),
  release: new Set(["list", "view"]),
  api: new Set(),
};

const BLOCKED_ARGUMENTS = new Set(["auth-token", "--show-token", "--with-token", "alias", "extension", "copilot"]);

export function assertSafeGhArguments(args: readonly string[]): void {
  if (args.length === 0) throw new Error("At least one gh argument is required.");
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    if (BLOCKED_ARGUMENTS.has(normalized)) throw new Error(`Blocked gh argument: ${arg}`);
    if (/\r|\n|\0/.test(arg)) throw new Error("Control characters are not allowed in gh arguments.");
  }
  const command = args[0].toLowerCase();
  if (!(command in SAFE_COMMANDS)) throw new Error(`Command is not allowed in read-only mode: ${command}`);
  if (command === "api") {
    if (args.some((arg) => ["-x", "--method", "-f", "--raw-field", "-F", "--field", "--input"].includes(arg))) {
      throw new Error("Mutating gh api options are blocked.");
    }
    return;
  }
  const subcommand = args[1]?.toLowerCase();
  if (!subcommand || !SAFE_COMMANDS[command].has(subcommand)) {
    throw new Error(`Subcommand is not allowed in read-only mode: ${command} ${subcommand ?? ""}`.trim());
  }
}

export function assertRepositoryAllowed(repository: string, config: Config): void {
  const normalized = repository.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(normalized)) throw new Error("Repository must use owner/name format.");
  const owner = normalized.split("/", 1)[0];
  if (config.allowedRepositories.size > 0 && !config.allowedRepositories.has(normalized)) throw new Error(`Repository is not allowed: ${repository}`);
  if (config.allowedOwners.size > 0 && !config.allowedOwners.has(owner)) throw new Error(`Repository owner is not allowed: ${owner}`);
}

export function assertOwnerAllowed(owner: string, config: Config): void {
  const normalized = owner.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/i.test(normalized)) throw new Error("Owner must be a GitHub user or organization login.");
  if (config.allowedOwners.size > 0) {
    if (!config.allowedOwners.has(normalized)) throw new Error(`Owner is not allowed: ${owner}`);
    return;
  }
  if (config.allowedRepositories.size > 0) {
    const ownerIsRepresented = [...config.allowedRepositories].some((repository) => repository.split("/", 1)[0] === normalized);
    if (!ownerIsRepresented) throw new Error(`Owner is not allowed by the repository allowlist: ${owner}`);
  }
}

export function assertHostAllowed(host: string, config: Config): void {
  if (!config.allowedHosts.has(host.trim().toLowerCase())) throw new Error(`GitHub host is not allowed: ${host}`);
}
