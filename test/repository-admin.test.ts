import { describe, expect, it } from "vitest";
import {
  assertCreatedRepository,
  assertRepositoryIdentity,
  repositoryDetails,
  repositoryOwnerIdentity,
} from "../src/repository-admin.js";

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    nodeId: "R_node123",
    fullName: "ma-nakaya/example",
    name: "example",
    owner: { login: "ma-nakaya", type: "User" },
    description: "Repository description",
    visibility: "private",
    isPrivate: true,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    defaultBranch: "main",
    hasIssues: true,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
    pushedAt: "2026-08-03T00:00:00Z",
    url: "https://github.com/ma-nakaya/example",
    permissions: { admin: true },
    ...overrides,
  };
}

describe("repository administration response handling", () => {
  it("returns selected metadata and removes permission details", () => {
    const details = repositoryDetails(repository());
    expect(details).toMatchObject({
      id: 123,
      fullName: "ma-nakaya/example",
      description: "Repository description",
      visibility: "private",
      isPrivate: true,
    });
    expect(details).not.toHaveProperty("permissions");
  });

  it("requires both canonical name and stable ID when supplied", () => {
    const details = repositoryDetails(repository());
    expect(() => assertRepositoryIdentity(details, "MA-NAKAYA/EXAMPLE", 123)).not.toThrow();
    expect(() => assertRepositoryIdentity(details, "ma-nakaya/renamed", 123)).toThrow(/redirects/);
    expect(() => assertRepositoryIdentity(details, "ma-nakaya/example", 456)).toThrow(/expectedRepositoryId/);
  });

  it("verifies created visibility and privacy", () => {
    expect(() => assertCreatedRepository(
      repositoryDetails(repository()),
      "ma-nakaya",
      "example",
      "private",
    )).not.toThrow();
    expect(() => assertCreatedRepository(
      repositoryDetails(repository({ visibility: "public", isPrivate: false })),
      "ma-nakaya",
      "example",
      "public",
    )).not.toThrow();
    expect(() => assertCreatedRepository(
      repositoryDetails(repository({ visibility: "public", isPrivate: false })),
      "ma-nakaya",
      "example",
      "private",
    )).toThrow(/visibility/);
  });

  it("accepts only user and organization owner identities", () => {
    expect(repositoryOwnerIdentity({ login: "ma-nakaya", type: "User" }))
      .toEqual({ login: "ma-nakaya", type: "User" });
    expect(repositoryOwnerIdentity({ login: "YMSL-J", type: "Organization" }))
      .toEqual({ login: "YMSL-J", type: "Organization" });
    expect(() => repositoryOwnerIdentity({ login: "x", type: "Bot" })).toThrow(/unsupported/);
  });

  it("rejects malformed repository identities", () => {
    expect(() => repositoryDetails(repository({ id: 0 }))).toThrow(/positive/);
    expect(() => repositoryDetails(repository({ owner: null }))).toThrow(/repository owner/);
    expect(() => repositoryDetails(repository({ isPrivate: "yes" }))).toThrow(/boolean/);
  });
});
