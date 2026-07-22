function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected release response.");
  }
  return value as Record<string, unknown>;
}

export function releaseSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value);
  return {
    id: item.id,
    tagName: item.tag_name,
    name: item.name,
    isDraft: item.draft,
    isPrerelease: item.prerelease,
    targetCommitish: item.target_commitish,
    url: item.html_url,
    createdAt: item.created_at,
    publishedAt: item.published_at,
  };
}

export function releaseIdentifier(value: unknown): number {
  const item = objectResponse(value);
  if (typeof item.id !== "number" || !Number.isInteger(item.id) || item.id <= 0) {
    throw new Error("GitHub API returned a release without a valid ID.");
  }
  return item.id;
}

export function assertDraftRelease(value: unknown, releaseId: number): void {
  const item = objectResponse(value);
  if (item.draft !== true) {
    throw new Error(`Release ${releaseId} is not a draft. Published releases cannot be changed by this tool.`);
  }
}
