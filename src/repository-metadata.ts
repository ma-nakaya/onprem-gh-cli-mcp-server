const LABEL_COLOR = /^[0-9a-fA-F]{6}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API returned an unexpected ${label} response.`);
  }
  return value as Record<string, unknown>;
}

export function isLabelColor(value: string): boolean {
  return LABEL_COLOR.test(value);
}

export function isUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const expected = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, milliseconds: string) => `.${milliseconds.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === expected;
}

export function labelSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "label");
  return {
    id: item.id,
    name: item.name,
    color: item.color,
    isDefault: item.default,
    url: item.url,
  };
}

export function milestoneSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "milestone");
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    dueOn: item.due_on,
    url: item.html_url,
    openIssues: item.open_issues,
    closedIssues: item.closed_issues,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function milestoneIdentifier(value: unknown): number {
  const item = objectResponse(value, "milestone");
  if (typeof item.number !== "number" || !Number.isInteger(item.number) || item.number <= 0) {
    throw new Error("GitHub API returned a milestone without a valid number.");
  }
  return item.number;
}
