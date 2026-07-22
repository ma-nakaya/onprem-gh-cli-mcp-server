export type PullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API returned an unexpected ${label} response.`);
  }
  return value as Record<string, unknown>;
}

function nestedRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = (value as Record<string, unknown>).ref;
  return typeof ref === "string" ? ref : undefined;
}

export function pullRequestSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "pull request");
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    isDraft: item.draft,
    url: item.html_url,
    headRefName: nestedRef(item.head),
    baseRefName: nestedRef(item.base),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function pullRequestReviewSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "pull request review");
  return {
    id: item.id,
    state: item.state,
    url: item.html_url,
    submittedAt: item.submitted_at,
  };
}

export function assertReviewBody(event: PullRequestReviewEvent, body: string | undefined): void {
  if ((event === "COMMENT" || event === "REQUEST_CHANGES") && !body?.trim()) {
    throw new Error(`A review body is required for ${event}.`);
  }
}
