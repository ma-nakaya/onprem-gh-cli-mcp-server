export interface RepositorySecretSummary {
  name: string;
  createdAt: string;
  updatedAt: string;
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected secrets response.");
  }
  return value as Record<string, unknown>;
}

export function repositorySecretsPage(
  value: unknown,
): { totalCount: number; secrets: RepositorySecretSummary[] } {
  const item = objectResponse(value);
  if (typeof item.total_count !== "number" || !Array.isArray(item.secrets)) {
    throw new Error("GitHub API returned an unexpected secrets response.");
  }
  const secrets = item.secrets.map((entry) => {
    const record = objectResponse(entry);
    if (
      typeof record.name !== "string"
      || typeof record.created_at !== "string"
      || typeof record.updated_at !== "string"
    ) {
      throw new Error("GitHub API returned an unexpected secret entry.");
    }
    return { name: record.name, createdAt: record.created_at, updatedAt: record.updated_at };
  });
  return { totalCount: item.total_count, secrets };
}

export interface OrganizationSecretSummary extends RepositorySecretSummary {
  visibility: string;
}

export function organizationSecretsPage(
  value: unknown,
): { totalCount: number; secrets: OrganizationSecretSummary[] } {
  const page = repositorySecretsPage(value);
  const item = objectResponse(value);
  const rawSecrets = item.secrets as Record<string, unknown>[];
  return {
    totalCount: page.totalCount,
    secrets: page.secrets.map((secret, index) => {
      const visibility = rawSecrets[index]?.visibility;
      if (typeof visibility !== "string") {
        throw new Error("GitHub API returned an unexpected secret entry.");
      }
      return { ...secret, visibility };
    }),
  };
}
