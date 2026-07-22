import { describe, expect, it } from "vitest";
import { isLabelColor, isUtcTimestamp, labelSummary, milestoneIdentifier, milestoneSummary } from "../src/repository-metadata.js";

describe("repository metadata validation", () => {
  it("validates six-digit label colors", () => {
    expect(isLabelColor("A1b2C3")).toBe(true);
    expect(isLabelColor("#a1b2c3")).toBe(false);
    expect(isLabelColor("abc")).toBe(false);
  });

  it("validates UTC ISO 8601 milestone timestamps", () => {
    expect(isUtcTimestamp("2026-08-01T00:00:00Z")).toBe(true);
    expect(isUtcTimestamp("2026-08-01T00:00:00.123Z")).toBe(true);
    expect(isUtcTimestamp("2026-08-01T09:00:00+09:00")).toBe(false);
    expect(isUtcTimestamp("2026-02-31T00:00:00Z")).toBe(false);
    expect(isUtcTimestamp("not-a-date")).toBe(false);
  });

  it("excludes descriptions from label and milestone summaries", () => {
    expect(labelSummary({ id: 1, name: "bug", color: "ff0000", default: true, url: "api-url", description: "secret" })).toEqual({
      id: 1, name: "bug", color: "ff0000", isDefault: true, url: "api-url",
    });
    expect(milestoneSummary({
      number: 7, title: "Sprint", state: "open", due_on: null, html_url: "html-url",
      open_issues: 3, closed_issues: 2, created_at: "created", updated_at: "updated", description: "secret",
    })).toEqual({
      number: 7, title: "Sprint", state: "open", dueOn: null, url: "html-url",
      openIssues: 3, closedIssues: 2, createdAt: "created", updatedAt: "updated",
    });
  });

  it("requires a positive milestone number", () => {
    expect(milestoneIdentifier({ number: 7 })).toBe(7);
    expect(() => milestoneIdentifier({ number: 0 })).toThrow(/valid number/);
    expect(() => milestoneIdentifier({ number: "7" })).toThrow(/valid number/);
  });
});
