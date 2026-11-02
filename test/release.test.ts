import { describe, expect, it } from "vitest";
import { assertDraftRelease, assertPublishableRelease, releaseAssetsPage, releaseIdentifier, releaseSummary, releaseTagName } from "../src/release.js";

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

describe("assertPublishableRelease", () => {
  it("allows only draft releases to be published", () => {
    expect(() => assertPublishableRelease({ draft: true }, 99)).not.toThrow();
    expect(() => assertPublishableRelease({ draft: false }, 99)).toThrow(/not a draft/);
    expect(() => assertPublishableRelease(null, 99)).toThrow(/unexpected release response/);
  });
});

describe("release asset handling", () => {
  it("projects asset metadata into stable fields", () => {
    expect(releaseAssetsPage([{
      id: 7,
      name: "app.zip",
      size: 1234,
      content_type: "application/zip",
      download_count: 3,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      browser_download_url: "https://example.invalid/app.zip",
    }])).toEqual([{
      id: 7,
      name: "app.zip",
      size: 1234,
      contentType: "application/zip",
      downloadCount: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }]);
  });

  it("rejects unexpected asset shapes", () => {
    expect(() => releaseAssetsPage({})).toThrow(/unexpected release assets response/);
    expect(() => releaseAssetsPage([{ id: "7" }])).toThrow(/unexpected release asset entry/);
  });

  it("requires a non-empty tag name", () => {
    expect(releaseTagName({ tag_name: "v1.0.0" })).toBe("v1.0.0");
    expect(() => releaseTagName({ tag_name: "" })).toThrow(/without a tag name/);
  });
});
