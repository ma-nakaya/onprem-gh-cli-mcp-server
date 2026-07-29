import type { RequestContext } from "./config.js";

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

function assertSafeAuthStatusArguments(args: readonly string[]): void {
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument.toLowerCase();
    if (normalized === "--active") continue;
    if (normalized === "--hostname") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error("--hostname requires a hostname value.");
      }
      index += 1;
      continue;
    }
    if (normalized.startsWith("--hostname=") && argument.slice(argument.indexOf("=") + 1).length > 0) {
      continue;
    }
    throw new Error(`Blocked gh auth status argument: ${argument}`);
  }
}

function assertSafeApiArguments(args: readonly string[]): void {
  const endpoint = args[1];
  if (endpoint === undefined || endpoint.startsWith("-")) {
    throw new Error("gh api requires an explicit endpoint before its options.");
  }

  const valuelessOptions = new Set(["--paginate", "--slurp", "--include", "--silent"]);
  const valuedOptions = new Set(["--hostname", "--cache", "--jq", "--template", "--preview"]);
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument.toLowerCase();
    if (valuelessOptions.has(normalized)) continue;

    const equalsIndex = normalized.indexOf("=");
    const optionName = equalsIndex === -1 ? normalized : normalized.slice(0, equalsIndex);
    if (!valuedOptions.has(optionName)) {
      throw new Error(`Blocked gh api argument: ${argument}`);
    }
    if (equalsIndex !== -1) {
      if (argument.slice(equalsIndex + 1).length === 0) {
        throw new Error(`${optionName} requires a value.`);
      }
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new Error(`${optionName} requires a value.`);
    }
    index += 1;
  }
}

export function assertSafeGhArguments(args: readonly string[]): void {
  if (args.length === 0) throw new Error("At least one gh argument is required.");
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    const optionName = normalized.split("=", 1)[0];
    if (BLOCKED_ARGUMENTS.has(normalized) || BLOCKED_ARGUMENTS.has(optionName)) {
      throw new Error(`Blocked gh argument: ${arg}`);
    }
    if (/\r|\n|\0/.test(arg)) throw new Error("Control characters are not allowed in gh arguments.");
  }
  const command = args[0].toLowerCase();
  if (!(command in SAFE_COMMANDS)) throw new Error(`Command is not allowed in read-only mode: ${command}`);
  if (command === "api") {
    assertSafeApiArguments(args);
    return;
  }
  const subcommand = args[1]?.toLowerCase();
  if (!subcommand || !SAFE_COMMANDS[command].has(subcommand)) {
    throw new Error(`Subcommand is not allowed in read-only mode: ${command} ${subcommand ?? ""}`.trim());
  }
  if (command === "auth") assertSafeAuthStatusArguments(args);
}

export function hasResourceAllowlist(context: RequestContext): boolean {
  return context.profile.allowedOwners.size > 0 || context.profile.allowedRepositories.size > 0;
}

function assertRepositorySpecifierHostAllowed(repository: string, context: RequestContext): void {
  const value = repository.trim();
  let hostname: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      hostname = new URL(value).hostname;
    } catch {
      throw new Error(`Invalid repository URL: ${repository}`);
    }
  } else {
    const parts = value.split("/");
    if (parts.length >= 3) [hostname] = parts;
  }
  if (hostname !== undefined && hostname.length > 0) assertHostAllowed(hostname, context);
}

function assertRepositoryArgumentHosts(args: readonly string[], context: RequestContext): void {
  for (const argument of args.slice(1)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument)) {
      assertRepositorySpecifierHostAllowed(argument, context);
    }
  }
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument.toLowerCase();
    if (normalized === "--repo" || argument === "-R") {
      const repository = args[index + 1];
      if (repository === undefined || repository.length === 0) throw new Error(`${argument} requires a repository value.`);
      assertRepositorySpecifierHostAllowed(repository, context);
      index += 1;
      continue;
    }
    if (normalized.startsWith("--repo=")) {
      assertRepositorySpecifierHostAllowed(argument.slice(argument.indexOf("=") + 1), context);
      continue;
    }
    if (/^-[^-].*R/.test(argument) && !argument.startsWith("-R")) {
      throw new Error("Bundled -R repository options are not allowed. Use --repo.");
    }
    if (argument.startsWith("-R") && argument.length > 2) {
      assertRepositorySpecifierHostAllowed(argument.slice(2), context);
    }
  }

  if (args[0]?.toLowerCase() !== "repo" || args[1]?.toLowerCase() !== "view") return;
  const valuedOptions = new Set(["--branch", "-b", "--hostname", "--jq", "-q", "--json", "--template", "-t"]);
  let optionsEnded = false;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument.toLowerCase();
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (normalized === "--repo" || argument === "-R")) {
      index += 1;
      continue;
    }
    if (!optionsEnded && valuedOptions.has(normalized)) {
      index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith("-")) continue;
    assertRepositorySpecifierHostAllowed(argument, context);
    return;
  }
}

export function assertRunGhAllowedByResourceScope(
  args: readonly string[],
  context: RequestContext,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument.toLowerCase();
    if (normalized === "-h" || /^-h(?:=)?.+/i.test(argument)) {
      throw new Error("Short hostname options are not allowed. Use --hostname.");
    }
    if (normalized === "--hostname") {
      const hostname = args[index + 1];
      if (hostname === undefined || hostname.length === 0) {
        throw new Error("--hostname requires a hostname value.");
      }
      assertHostAllowed(hostname, context);
      index += 1;
    } else if (normalized.startsWith("--hostname=")) {
      const hostname = argument.slice(argument.indexOf("=") + 1);
      if (hostname.length === 0) throw new Error("--hostname requires a hostname value.");
      assertHostAllowed(hostname, context);
    }
  }
  assertRepositoryArgumentHosts(args, context);

  if (!hasResourceAllowlist(context)) return;
  if (args[0]?.toLowerCase() === "auth" && args[1]?.toLowerCase() === "status") {
    return;
  }
  throw new Error("run_gh is limited to auth status when a resource allowlist is configured. Use a typed repository tool.");
}

export function assertRepositoryAllowed(repository: string, context: RequestContext): void {
  const normalized = repository.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(normalized)) throw new Error("Repository must use owner/name format.");
  const owner = normalized.split("/", 1)[0];
  if (
    context.profile.allowedRepositories.size > 0
    && !context.profile.allowedRepositories.has(normalized)
  ) {
    throw new Error(`Repository is not allowed for account '${context.accountId}': ${repository}`);
  }
  if (context.profile.allowedOwners.size > 0 && !context.profile.allowedOwners.has(owner)) {
    throw new Error(`Repository owner is not allowed for account '${context.accountId}': ${owner}`);
  }
}

export function assertOwnerAllowed(owner: string, context: RequestContext): void {
  const normalized = owner.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/i.test(normalized)) throw new Error("Owner must be a GitHub user or organization login.");
  if (context.profile.allowedOwners.size > 0) {
    if (!context.profile.allowedOwners.has(normalized)) {
      throw new Error(`Owner is not allowed for account '${context.accountId}': ${owner}`);
    }
    return;
  }
  if (context.profile.allowedRepositories.size > 0) {
    throw new Error(
      `Owner-wide operations require an explicit allowedOwners entry for account '${context.accountId}'.`,
    );
  }
}

export function assertRepositoryListOwnerAllowed(owner: string, context: RequestContext): void {
  const normalized = owner.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/i.test(normalized)) throw new Error("Owner must be a GitHub user or organization login.");
  if (context.profile.allowedOwners.size > 0) {
    if (!context.profile.allowedOwners.has(normalized)) {
      throw new Error(`Owner is not allowed for account '${context.accountId}': ${owner}`);
    }
    return;
  }
  if (context.profile.allowedRepositories.size > 0) {
    const ownerIsRepresented = [...context.profile.allowedRepositories].some(
      (repository) => repository.split("/", 1)[0] === normalized,
    );
    if (!ownerIsRepresented) {
      throw new Error(
        `Owner is not allowed by account '${context.accountId}' repository allowlist: ${owner}`,
      );
    }
  }
}

export function assertHostAllowed(host: string, context: RequestContext): void {
  const normalized = host.trim().toLowerCase();
  if (context.profile.hostname !== normalized) {
    throw new Error(
      `GitHub host does not match account profile '${context.accountId}': ${host}`,
    );
  }
}
