function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GitHub API returned an unexpected ${label} response.`);
  return value as Record<string, unknown>;
}

export function gitObjectSha(value: unknown, label: string): string {
  const item = objectResponse(value, label);
  if (typeof item.sha !== "string" || !/^[0-9a-f]{40}$/.test(item.sha)) throw new Error(`GitHub API returned ${label} without a valid SHA.`);
  return item.sha;
}

export function branchSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "Git reference");
  const object = objectResponse(item.object, "Git reference object");
  return { ref: item.ref, sha: gitObjectSha(object, "Git reference object") };
}

export function branchHeadSha(value: unknown): string {
  const item = objectResponse(value, "Git reference");
  return gitObjectSha(objectResponse(item.object, "Git reference object"), "Git reference object");
}

export function commitTreeSha(value: unknown): string {
  const item = objectResponse(value, "Git commit");
  return gitObjectSha(objectResponse(item.tree, "Git commit tree"), "Git commit tree");
}

export function encodeGitRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export function assertWritableBranch(branch: string): void {
  const normalized = branch.trim().toLowerCase();
  if (["main", "master", "develop", "development", "trunk"].includes(normalized)) {
    throw new Error("Direct commits to a common default branch are not allowed. Create a feature branch first.");
  }
}

export function assertRepositoryPath(path: string): void {
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Repository file path must be a normalized relative path.");
  }
}
