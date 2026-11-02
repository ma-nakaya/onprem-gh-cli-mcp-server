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

export function assertPublishableRelease(value: unknown, releaseId: number): void {
  const item = objectResponse(value);
  if (item.draft !== true) {
    throw new Error(`Release ${releaseId} is not a draft. Only draft releases can be published.`);
  }
}

export interface ReleaseAssetSummary {
  id: number;
  name: string;
  size: number;
  contentType: string;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export function releaseAssetsPage(value: unknown): ReleaseAssetSummary[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected release assets response.");
  }
  return value.map((entry) => {
    const item = objectResponse(entry);
    if (
      typeof item.id !== "number"
      || typeof item.name !== "string"
      || typeof item.size !== "number"
      || typeof item.content_type !== "string"
      || typeof item.download_count !== "number"
      || typeof item.created_at !== "string"
      || typeof item.updated_at !== "string"
    ) {
      throw new Error("GitHub API returned an unexpected release asset entry.");
    }
    return {
      id: item.id,
      name: item.name,
      size: item.size,
      contentType: item.content_type,
      downloadCount: item.download_count,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  });
}

export function releaseTagName(value: unknown): string {
  const item = objectResponse(value);
  if (typeof item.tag_name !== "string" || item.tag_name.length === 0) {
    throw new Error("GitHub API returned a release without a tag name.");
  }
  return item.tag_name;
}
