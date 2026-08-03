const LABEL_COLOR = /^[0-9a-fA-F]{6}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const LABEL_DETAILS_JQ = "map({id: .id, nodeId: .node_id, name: .name, color: .color, description: (.description // null), isDefault: .default, url: .url})";

export interface LabelDetails {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string | null;
  isDefault: boolean;
  url: string;
}

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

function labelDetailsItem(value: unknown, label: string): LabelDetails {
  const item = objectResponse(value, label);
  if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id <= 0) {
    throw new Error(`GitHub API returned an unexpected ${label} response: "id" must be a positive safe integer.`);
  }
  if (typeof item.nodeId !== "string" || item.nodeId.length === 0) {
    throw new Error(`GitHub API returned an unexpected ${label} response: "nodeId" must be a non-empty string.`);
  }
  if (typeof item.name !== "string" || item.name.length === 0) {
    throw new Error(`GitHub API returned an unexpected ${label} response: "name" must be a non-empty string.`);
  }
  if (typeof item.color !== "string" || !isLabelColor(item.color)) {
    throw new Error(`GitHub API returned an unexpected ${label} response: "color" must be six hexadecimal characters.`);
  }
  if (item.description !== null && typeof item.description !== "string") {
    throw new Error(`GitHub API returned an unexpected ${label} response: "description" must be a string or null.`);
  }
  if (typeof item.isDefault !== "boolean") {
    throw new Error(`GitHub API returned an unexpected ${label} response: "isDefault" must be a boolean.`);
  }
  if (typeof item.url !== "string" || item.url.length === 0) {
    throw new Error(`GitHub API returned an unexpected ${label} response: "url" must be a non-empty string.`);
  }
  return {
    id: item.id,
    nodeId: item.nodeId,
    name: item.name,
    color: item.color.toLowerCase(),
    description: item.description,
    isDefault: item.isDefault,
    url: item.url,
  };
}

export function labelDetailsList(value: unknown, maximum?: number): LabelDetails[] {
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
    throw new Error("The expected label count must be a non-negative safe integer.");
  }
  if (!Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected labels response: expected an array.");
  }
  if (maximum !== undefined && value.length > maximum) {
    throw new Error(`GitHub API returned ${value.length} labels, exceeding the requested maximum of ${maximum}.`);
  }
  return value.map((entry, index) => labelDetailsItem(entry, `label at index ${index}`));
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
