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

export function assertProjectOwner(value: unknown, expectedOwner: string): Record<string, unknown> {
  const project = graphqlProject(value, "node");
  const owner = objectResponse(project.owner, "project owner");
  if (typeof owner.login !== "string" || owner.login.toLowerCase() !== expectedOwner.trim().toLowerCase()) {
    throw new Error("The supplied project does not belong to the allowed owner.");
  }
  return project;
}

export function graphqlProjectConnection(value: unknown, connection: "items" | "fields"): Record<string, unknown> {
  const project = graphqlProject(value, "node");
  return objectResponse(project[connection], `project ${connection}`);
}

export function projectItemsSummary(value: unknown): Record<string, unknown> {
  const connection = graphqlProjectConnection(value, "items");
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  return {
    totalCount: connection.totalCount,
    items: nodes.map((value) => {
      const item = objectResponse(value, "project item");
      const content = item.content && typeof item.content === "object" && !Array.isArray(item.content)
        ? item.content as Record<string, unknown>
        : undefined;
      return {
        id: item.id,
        type: content?.__typename ?? "REDACTED",
        archived: item.isArchived,
        ...(content === undefined ? {} : {
          content: {
            title: content.title,
            number: content.number,
            url: content.url,
            state: content.state,
            repository: content.repository && typeof content.repository === "object" && !Array.isArray(content.repository)
              ? (content.repository as Record<string, unknown>).nameWithOwner
              : undefined,
          },
        }),
      };
    }),
  };
}

export function projectFieldsSummary(value: unknown): Record<string, unknown> {
  const connection = graphqlProjectConnection(value, "fields");
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  return {
    totalCount: connection.totalCount,
    fields: nodes.map((value) => {
      const field = objectResponse(value, "project field");
      const configuration = field.configuration && typeof field.configuration === "object" && !Array.isArray(field.configuration)
        ? field.configuration as Record<string, unknown>
        : undefined;
      const iterations = configuration && Array.isArray(configuration.iterations)
        ? configuration.iterations
        : [];
      return {
        id: field.id,
        name: field.name,
        dataType: field.dataType,
        type: field.__typename,
        ...(Array.isArray(field.options) ? { options: field.options } : {}),
        ...(iterations.length > 0 ? { iterations } : {}),
      };
    }),
  };
}

export function graphqlProjectItem(value: unknown, operation: "addProjectV2ItemById" | "archiveProjectV2Item" | "unarchiveProjectV2Item" | "updateProjectV2ItemFieldValue" | "clearProjectV2ItemFieldValue"): Record<string, unknown> {
  const root = objectResponse(value, "GraphQL");
  assertNoGraphqlErrors(root);
  const data = objectResponse(root.data, "GraphQL data");
  const payload = objectResponse(data[operation], `${operation} payload`);
  return objectResponse(payload.item ?? payload.projectV2Item, "project item");
}

export function projectItemSummary(value: unknown): Record<string, unknown> {
  const item = objectResponse(value, "project item");
  return { id: item.id, archived: item.isArchived };
}

export type ProjectFieldValueType = "text" | "number" | "date" | "singleSelect" | "iteration";

export function projectFieldValue(valueType: ProjectFieldValueType, value: string | number): Record<string, unknown> {
  if (valueType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("A finite numeric value is required.");
    return { number: value };
  }
  if (typeof value !== "string" || value.length === 0) throw new Error(`A non-empty ${valueType} value is required.`);
  if (valueType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date values must use YYYY-MM-DD.");
  const key = valueType === "singleSelect" ? "singleSelectOptionId" : valueType === "iteration" ? "iterationId" : valueType;
  return { [key]: value };
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
