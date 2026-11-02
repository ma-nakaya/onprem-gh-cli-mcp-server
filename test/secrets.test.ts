import { describe, expect, it } from "vitest";
import { organizationSecretsPage, repositorySecretsPage } from "../src/secrets.js";

describe("repositorySecretsPage", () => {
  it("projects secret metadata without any value field", () => {
    expect(repositorySecretsPage({
      total_count: 1,
      secrets: [{
        name: "MY_TOKEN",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      }],
    })).toEqual({
      totalCount: 1,
      secrets: [{
        name: "MY_TOKEN",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }],
    });
  });

  it("rejects unexpected response shapes", () => {
    expect(() => repositorySecretsPage(null)).toThrow(/unexpected secrets response/);
    expect(() => repositorySecretsPage({ secrets: [] })).toThrow(/unexpected secrets response/);
    expect(() => repositorySecretsPage({ total_count: 1, secrets: [{ name: "X" }] }))
      .toThrow(/unexpected secret entry/);
  });
});

describe("organizationSecretsPage", () => {
  it("includes the visibility of each organization secret", () => {
    expect(organizationSecretsPage({
      total_count: 1,
      secrets: [{
        name: "ORG_TOKEN",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        visibility: "selected",
      }],
    })).toEqual({
      totalCount: 1,
      secrets: [{
        name: "ORG_TOKEN",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        visibility: "selected",
      }],
    });
  });

  it("rejects entries without a visibility", () => {
    expect(() => organizationSecretsPage({
      total_count: 1,
      secrets: [{ name: "X", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }],
    })).toThrow(/unexpected secret entry/);
  });
});
