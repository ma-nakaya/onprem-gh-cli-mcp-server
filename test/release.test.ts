import { describe, expect, it } from "vitest";
import { assertDraftRelease, releaseIdentifier, releaseSummary } from "../src/release.js";

describe("release response handling", () => {
  it("returns stable metadata without release body content", () => {
    expect(releaseSummary({
      id: 99,
      tag_name: "v1.2.3",
      name: "Version 1.2.3",
      body: "sensitive release notes",
      draft: true,
      prerelease: false,
      target_commitish: "main",
      html_url: "https://github.com/example/repo/releases/tag/untagged-abc",
      created_at: "2026-07-22T04:00:00Z",
      published_at: null,
    })).toEqual({
      id: 99,
      tagName: "v1.2.3",
      name: "Version 1.2.3",
      isDraft: true,
      isPrerelease: false,
      targetCommitish: "main",
      url: "https://github.com/example/repo/releases/tag/untagged-abc",
      createdAt: "2026-07-22T04:00:00Z",
      publishedAt: null,
    });
  });

  it("allows only draft releases to be updated", () => {
    expect(() => assertDraftRelease({ draft: true }, 99)).not.toThrow();
    expect(() => assertDraftRelease({ draft: false }, 99)).toThrow(/not a draft/);
    expect(() => assertDraftRelease(null, 99)).toThrow(/unexpected release response/);
  });

  it("requires a positive integer release ID", () => {
    expect(releaseIdentifier({ id: 99 })).toBe(99);
    expect(() => releaseIdentifier({ id: "99" })).toThrow(/valid ID/);
    expect(() => releaseIdentifier({ id: 0 })).toThrow(/valid ID/);
  });
});
