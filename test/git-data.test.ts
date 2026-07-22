import { describe, expect, it } from "vitest";
import { assertRepositoryPath, assertWritableBranch, branchHeadSha, branchSummary, commitTreeSha, encodeGitRef } from "../src/git-data.js";

describe("Git data validation and response handling", () => {
  const sha = "a".repeat(40);
  it("summarizes a branch and encodes nested names", () => {
    const ref = { ref: "refs/heads/agent/change", object: { type: "commit", sha } };
    expect(branchHeadSha(ref)).toBe(sha);
    expect(branchSummary(ref)).toEqual({ ref: "refs/heads/agent/change", sha });
    expect(encodeGitRef("agent/change one")).toBe("agent/change%20one");
  });

  it("extracts a commit tree SHA", () => {
    expect(commitTreeSha({ sha, tree: { sha } })).toBe(sha);
  });

  it("blocks default branches and unsafe paths", () => {
    expect(() => assertWritableBranch("main")).toThrow(/feature branch/);
    expect(() => assertWritableBranch("agent/change")).not.toThrow();
    for (const path of ["/root.txt", "../secret", "a//b", "a\\b", "a/./b"]) expect(() => assertRepositoryPath(path)).toThrow(/normalized/);
    expect(() => assertRepositoryPath("src/file.ts")).not.toThrow();
  });
});
