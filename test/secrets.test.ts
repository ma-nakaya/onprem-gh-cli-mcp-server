import { describe, expect, it } from "vitest";
import { repositorySecretsPage } from "../src/secrets.js";

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
