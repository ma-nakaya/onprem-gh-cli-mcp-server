const WORKFLOW_IDENTIFIER = /^(?:[1-9]\d*|[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml)$/;
const INPUT_NAME = /^[A-Za-z0-9_-]{1,100}$/;

function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub API returned an unexpected workflow response.");
  }
  return value as Record<string, unknown>;
}

export function isWorkflowIdentifier(value: string): boolean {
  return WORKFLOW_IDENTIFIER.test(value);
}

export function assertActiveWorkflow(value: unknown, workflow: string): void {
  const item = objectResponse(value);
  if (item.state !== "active") {
    throw new Error(`Workflow ${workflow} is not active and cannot be dispatched.`);
  }
}

export function workflowSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value);
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    state: item.state,
    url: item.html_url,
  };
}

export function normalizeWorkflowInputs(inputs: Record<string, string>): Record<string, string> {
  const entries = Object.entries(inputs);
  if (entries.length > 25) throw new Error("Workflow inputs cannot contain more than 25 entries.");
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!INPUT_NAME.test(name)) throw new Error(`Invalid workflow input name: ${name}`);
    if (value.length > 1024) throw new Error(`Workflow input ${name} exceeds 1024 characters.`);
    normalized[name] = value;
  }
  return normalized;
}
