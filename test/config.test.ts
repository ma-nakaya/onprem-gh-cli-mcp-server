import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAccountContext } from "../src/account-profile.js";
import { loadConfig, restrictedEnvironment } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeManifest(
  accounts: unknown[],
  version: number = 1,
): Promise<{ directory: string; manifestPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-config-"));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, "accounts.json");
  await writeFile(manifestPath, JSON.stringify({ version, accounts }), "utf8");
  return { directory, manifestPath };
}

function manifestAccount(
  directory: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "ma-nakaya",
    expectedLogin: "ma-nakaya",
    hostname: "github.com",
    configDir: join(directory, "gh-ma"),
    allowedOwners: ["ma-nakaya"],
    allowedRepositories: [],
    ...overrides,
  };
}

describe("configuration", () => {
  it("loads, normalizes, and isolates multiple account profiles from a version 1 manifest", async () => {
    const { directory, manifestPath } = await writeManifest([
      manifestAccount("placeholder", {
        id: " MA-NAKAYA ",
        expectedLogin: " MA-NAKAYA ",
        configDir: join(tmpdir(), "gh-ma"),
        allowedOwners: [" MA-NAKAYA ", "ma-nakaya"],
        allowedRepositories: [" MA-NAKAYA/Example "],
      }),
      manifestAccount("placeholder", {
        id: "Masa-Nakaya",
        expectedLogin: "Masa-Nakaya",
        configDir: join(tmpdir(), "gh-masa"),
        allowedOwners: ["Masa-Nakaya"],
      }),
    ]);

    const config = loadConfig({ GH_MCP_ACCOUNTS_FILE: manifestPath });

    expect([...config.accountProfiles.keys()]).toEqual(["ma-nakaya", "masa-nakaya"]);
    expect(config.defaultAccountId).toBeUndefined();
    expect(config.accountProfiles.get("ma-nakaya")).toMatchObject({
      id: "ma-nakaya",
      expectedLogin: "ma-nakaya",
      hostname: "github.com",
      configDir: join(tmpdir(), "gh-ma"),
    });
    expect([...config.accountProfiles.get("ma-nakaya")!.allowedOwners]).toEqual(["ma-nakaya"]);
    expect([...config.accountProfiles.get("ma-nakaya")!.allowedRepositories]).toEqual([
      "ma-nakaya/example",
    ]);
    expect(directory).toBeTruthy();
  });

  it("rejects malformed profile scopes and empty scopes", async () => {
    const malformed = await writeManifest([
      manifestAccount(tmpdir(), { allowedOwners: ["ma-nakaya;other"] }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: malformed.manifestPath })).toThrow(
      /allowedOwners contains an invalid value/i,
    );

    const empty = await writeManifest([
      manifestAccount(tmpdir(), { allowedOwners: [], allowedRepositories: [] }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: empty.manifestPath })).toThrow(
      /at least one owner or repository/i,
    );

    const unselectableId = await writeManifest([
      manifestAccount(tmpdir(), { id: "a".repeat(101) }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: unselectableId.manifestPath })).toThrow(
      /account identifier/i,
    );
  });

  it("rejects unsupported manifest and account properties", async () => {
    const accountExtra = await writeManifest([
      manifestAccount(tmpdir(), { token: "must-not-be-stored-here" }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: accountExtra.manifestPath })).toThrow(
      /accounts\[0\] contains unsupported properties: token/i,
    );

    const rootExtra = await writeManifest([manifestAccount(tmpdir())]);
    await writeFile(
      rootExtra.manifestPath,
      JSON.stringify({
        version: 1,
        accounts: [manifestAccount(tmpdir())],
        credentials: {},
      }),
      "utf8",
    );
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: rootExtra.manifestPath })).toThrow(
      /GH_MCP_ACCOUNTS_FILE contains unsupported properties: credentials/i,
    );
  });

  it("requires an absolute version 1 accounts manifest path", async () => {
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: "accounts.json" })).toThrow(/absolute path/i);

    const { manifestPath } = await writeManifest([], 2);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: manifestPath })).toThrow(/version 1/i);
  });

  it("rejects duplicate account ids, identities, and configuration directories", async () => {
    const duplicateId = await writeManifest([
      manifestAccount(tmpdir()),
      manifestAccount(tmpdir(), {
        id: "MA-NAKAYA",
        expectedLogin: "other",
        configDir: join(tmpdir(), "gh-other"),
      }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: duplicateId.manifestPath })).toThrow(
      /duplicate account id/i,
    );

    const duplicateIdentity = await writeManifest([
      manifestAccount(tmpdir()),
      manifestAccount(tmpdir(), {
        id: "ma-secondary",
        configDir: join(tmpdir(), "gh-secondary"),
      }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: duplicateIdentity.manifestPath })).toThrow(
      /duplicate account identity/i,
    );

    const duplicateDirectory = await writeManifest([
      manifestAccount(tmpdir()),
      manifestAccount(tmpdir(), {
        id: "masa-nakaya",
        expectedLogin: "masa-nakaya",
        configDir: join(tmpdir(), "gh-ma"),
      }),
    ]);
    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: duplicateDirectory.manifestPath })).toThrow(
      /reuses a configDir/i,
    );
  });

  it("rejects configuration-directory aliases that resolve to the same credential store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "onprem-gh-cli-mcp-alias-"));
    temporaryDirectories.push(directory);
    const credentialDirectory = join(directory, "credentials");
    const aliasDirectory = join(directory, "credentials-alias");
    await mkdir(credentialDirectory);
    await symlink(
      credentialDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const { manifestPath } = await writeManifest([
      manifestAccount(directory, { configDir: credentialDirectory }),
      manifestAccount(directory, {
        id: "masa-nakaya",
        expectedLogin: "masa-nakaya",
        configDir: aliasDirectory,
      }),
    ]);

    expect(() => loadConfig({ GH_MCP_ACCOUNTS_FILE: manifestPath })).toThrow(
      /reuses a configDir/i,
    );
  });

  it("rejects a profile host outside the global host allowlist", async () => {
    const { manifestPath } = await writeManifest([
      manifestAccount(tmpdir(), { hostname: "ghe.example.com" }),
    ]);
    expect(() => loadConfig({
      GH_MCP_ACCOUNTS_FILE: manifestPath,
      GH_MCP_ALLOWED_HOSTS: "github.com",
    })).toThrow(/hostname is not allowed/i);
  });

  it("rejects mixed manifest and legacy account configuration", async () => {
    const { manifestPath } = await writeManifest([manifestAccount(tmpdir())]);
    expect(() => loadConfig({
      GH_MCP_ACCOUNTS_FILE: manifestPath,
      GH_MCP_EXPECTED_LOGIN: "ma-nakaya",
    })).toThrow(/cannot be combined.*GH_MCP_EXPECTED_LOGIN/i);
    expect(() => loadConfig({
      GH_MCP_ACCOUNTS_FILE: manifestPath,
      GH_MCP_ALLOWED_OWNERS: "ma-nakaya",
    })).toThrow(/cannot be combined.*GH_MCP_ALLOWED_OWNERS/i);
  });

  it("synthesizes one normalized profile from legacy single-account settings", () => {
    const config = loadConfig({
      GH_MCP_ALLOWED_HOSTS: "github.com, ghe.example.com",
      GH_MCP_ALLOWED_OWNERS: "masa-nakaya, MA-NAKAYA",
      GH_MCP_ALLOWED_REPOSITORIES: " Masa-Nakaya/Example ",
      GH_MCP_EXPECTED_LOGIN: " Masa-Nakaya ",
      GH_MCP_ACCOUNT_HOST: " GHE.Example.com ",
      GH_CONFIG_DIR: join(tmpdir(), "gh-masa"),
    });

    expect(config.defaultAccountId).toBe("masa-nakaya");
    const profile = config.accountProfiles.get("masa-nakaya");
    expect(profile).toMatchObject({
      id: "masa-nakaya",
      expectedLogin: "masa-nakaya",
      hostname: "ghe.example.com",
      configDir: join(tmpdir(), "gh-masa"),
    });
    expect([...profile!.allowedOwners]).toEqual(["masa-nakaya", "ma-nakaya"]);
    expect([...profile!.allowedRepositories]).toEqual(["masa-nakaya/example"]);
  });

  it("never uses ambient GH_HOST to route a legacy account profile", () => {
    const config = loadConfig({
      GH_MCP_ALLOWED_HOSTS: "github.com,ghe.example.com",
      GH_MCP_EXPECTED_LOGIN: "ma-nakaya",
      GH_CONFIG_DIR: join(tmpdir(), "gh-ma"),
      GH_MCP_ALLOWED_OWNERS: "ma-nakaya",
      GH_HOST: "ghe.example.com",
    });

    expect(config.accountProfiles.get("ma-nakaya")?.hostname).toBe("github.com");
  });

  it("validates required legacy account settings", () => {
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
    })).toThrow(/GH_CONFIG_DIR/);
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "   ",
    })).toThrow(/must not be empty/i);
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
      GH_CONFIG_DIR: "relative/gh-masa",
      GH_MCP_ALLOWED_OWNERS: "masa-nakaya",
    })).toThrow(/absolute path/i);
    expect(() => loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
      GH_CONFIG_DIR: join(tmpdir(), "gh-masa"),
    })).toThrow(/GH_MCP_ALLOWED_OWNERS|GH_MCP_ALLOWED_REPOSITORIES/);
  });

  it("pins a selected account environment without inheriting ambient GitHub state", () => {
    const config = loadConfig({
      GH_MCP_EXPECTED_LOGIN: "masa-nakaya",
      GH_CONFIG_DIR: join(tmpdir(), "gh-masa"),
      GH_MCP_ALLOWED_OWNERS: "masa-nakaya",
    });
    const context = resolveAccountContext(config);
    const env = {
      PATH: "C:/tools",
      GH_CONFIG_DIR: "C:/ambient/gh",
      GH_HOST: "ambient.example.com",
      GH_TOKEN: `ghp_${"a".repeat(36)}`,
      GITHUB_TOKEN: `github_pat_${"b".repeat(82)}`,
      GH_ENTERPRISE_TOKEN: `ghp_${"c".repeat(36)}`,
      GITHUB_ENTERPRISE_TOKEN: `github_pat_${"d".repeat(82)}`,
    };

    const restricted = restrictedEnvironment(context, env);

    expect(restricted).toMatchObject({
      PATH: "C:/tools",
      GH_CONFIG_DIR: join(tmpdir(), "gh-masa"),
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    });
    expect(restricted).not.toHaveProperty("GH_TOKEN");
    expect(restricted).not.toHaveProperty("GITHUB_TOKEN");
    expect(restricted).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
    expect(restricted).not.toHaveProperty("GITHUB_ENTERPRISE_TOKEN");
  });

  it("uses configured and platform-specific audit log paths without requiring an account", () => {
    const configured = loadConfig({ GH_MCP_AUDIT_LOG_PATH: "C:/secure/gh-mcp-audit.jsonl" });
    expect(configured.auditLogPath).toBe("C:/secure/gh-mcp-audit.jsonl");
    expect(configured.accountProfiles.size).toBe(0);

    const defaults = loadConfig({ LOCALAPPDATA: "C:/Users/test/AppData/Local", HOME: "/home/test" });
    expect(defaults.auditLogPath).toMatch(/onprem-gh-cli-mcp[\\/]audit\.jsonl$/);
  });

  it("rejects an empty or malformed global host allowlist", () => {
    expect(() => loadConfig({ GH_MCP_ALLOWED_HOSTS: "   " })).toThrow(/at least one hostname/i);
    expect(() => loadConfig({ GH_MCP_ALLOWED_HOSTS: "https://github.com" })).toThrow(
      /invalid hostname/i,
    );
  });
});
