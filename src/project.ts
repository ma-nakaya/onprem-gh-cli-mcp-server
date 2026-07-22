function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API returned an unexpected ${label} response.`);
  }
  return value as Record<string, unknown>;
}

function assertNoGraphqlErrors(value: Record<string, unknown>): void {
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error("GitHub GraphQL returned one or more errors.");
  }
}

export function ownerNodeId(value: unknown): string {
  const item = objectResponse(value, "owner");
  if (typeof item.node_id !== "string" || item.node_id.length === 0) {
    throw new Error("GitHub API returned an owner without a node ID.");
  }
  return item.node_id;
}

export function graphqlProject(value: unknown, operation: "createProjectV2" | "updateProjectV2" | "node"): Record<string, unknown> {
  const root = objectResponse(value, "GraphQL");
  assertNoGraphqlErrors(root);
  const data = objectResponse(root.data, "GraphQL data");
  const project = operation === "node"
    ? data.node
    : objectResponse(data[operation], `${operation} payload`).projectV2;
  const item = objectResponse(project, "project");
  if (operation === "node" && item.__typename !== "ProjectV2") {
    throw new Error("The supplied project ID does not identify a GitHub ProjectV2.");
  }
  return item;
}

export function projectIdentifier(value: unknown): string {
  const item = objectResponse(value, "project");
  if (typeof item.id !== "string" || !/^PVT_[A-Za-z0-9_-]+$/.test(item.id)) {
    throw new Error("GitHub GraphQL returned a project without a valid ProjectV2 ID.");
  }
  return item.id;
}

export function projectSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "project");
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    url: item.url,
    isClosed: item.closed,
    isPublic: item.public,
  };
}

export interface ProjectUpdates {
  title?: string;
  shortDescription?: string;
  readme?: string;
  closed?: boolean;
}

export function buildUpdateProjectMutation(projectId: string, updates: ProjectUpdates): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { projectId };
  const variableDefinitions = ["$projectId: ID!"];
  const inputFields = ["projectId: $projectId"];
  for (const [name, type] of [["title", "String"], ["shortDescription", "String"], ["readme", "String"], ["closed", "Boolean"]] as const) {
    const value = updates[name];
    if (value !== undefined) {
      variables[name] = value;
      variableDefinitions.push(`$${name}: ${type}`);
      inputFields.push(`${name}: $${name}`);
    }
  }
  if (Object.keys(variables).length === 1) throw new Error("At least one project field must be provided.");
  return {
    query: `mutation(${variableDefinitions.join(", ")}) {
      updateProjectV2(input: { ${inputFields.join(", ")} }) {
        projectV2 { id number title url closed public }
      }
    }`,
    variables,
  };
}
