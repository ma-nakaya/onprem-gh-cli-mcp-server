import { describe, expect, it } from "vitest";
import { buildUpdateProjectMutation, graphqlProject, ownerNodeId, projectFieldValue, projectFieldsSummary, projectIdentifier, projectItemsSummary, projectSummary } from "../src/project.js";

describe("GitHub Projects v2 response handling", () => {
  const project = {
    id: "PVT_example123",
    number: 4,
    title: "Roadmap",
    url: "https://github.com/users/example/projects/4",
    closed: false,
    public: false,
    shortDescription: "sensitive description",
    readme: "sensitive readme",
  };

  it("extracts an owner node ID", () => {
    expect(ownerNodeId({ node_id: "O_example" })).toBe("O_example");
    expect(() => ownerNodeId({})).toThrow(/without a node ID/);
  });

  it("extracts projects from create, update, and node responses", () => {
    expect(graphqlProject({ data: { createProjectV2: { projectV2: project } } }, "createProjectV2")).toEqual(project);
    expect(graphqlProject({ data: { updateProjectV2: { projectV2: project } } }, "updateProjectV2")).toEqual(project);
    expect(graphqlProject({ data: { node: { __typename: "ProjectV2", ...project } } }, "node")).toMatchObject(project);
    expect(() => graphqlProject({ data: { node: { __typename: "Issue", id: "I_1" } } }, "node")).toThrow(/does not identify/);
    expect(() => graphqlProject({ errors: [{ message: "denied" }] }, "node")).toThrow(/GraphQL returned/);
  });

  it("returns stable project metadata without descriptions or readme", () => {
    expect(projectSummary(project)).toEqual({
      id: "PVT_example123",
      number: 4,
      title: "Roadmap",
      url: "https://github.com/users/example/projects/4",
      isClosed: false,
      isPublic: false,
    });
  });

  it("requires a ProjectV2 node ID", () => {
    expect(projectIdentifier(project)).toBe("PVT_example123");
    expect(() => projectIdentifier({ id: "I_example" })).toThrow(/valid ProjectV2 ID/);
  });

  it("includes only explicitly supplied update fields", () => {
    const update = buildUpdateProjectMutation("PVT_example123", { title: "New title", closed: false });
    expect(update.variables).toEqual({ projectId: "PVT_example123", title: "New title", closed: false });
    expect(update.query).toContain("title: $title");
    expect(update.query).toContain("closed: $closed");
    expect(update.query).not.toContain("shortDescription:");
    expect(update.query).not.toContain("readme:");
    expect(() => buildUpdateProjectMutation("PVT_example123", {})).toThrow(/At least one/);
  });

  it("summarizes project items without bodies or field values", () => {
    const result = projectItemsSummary({ data: { node: { __typename: "ProjectV2", items: { totalCount: 1, nodes: [{ id: "PVTI_one", isArchived: false, content: { __typename: "Issue", title: "Safe title", number: 20, url: "https://example.test/20", state: "OPEN", body: "secret", repository: { nameWithOwner: "example/repo" } }, fieldValues: { secret: true } }] } } } });
    expect(result).toEqual({ totalCount: 1, items: [{ id: "PVTI_one", type: "Issue", archived: false, content: { title: "Safe title", number: 20, url: "https://example.test/20", state: "OPEN", repository: "example/repo" } }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns selectable field metadata and validates update values", () => {
    const result = projectFieldsSummary({ data: { node: { __typename: "ProjectV2", fields: { totalCount: 1, nodes: [{ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_one", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "ready", name: "Ready" }] }] } } } });
    expect(result).toMatchObject({ totalCount: 1, fields: [{ id: "PVTSSF_one", options: [{ id: "ready", name: "Ready" }] }] });
    expect(projectFieldValue("text", "hello")).toEqual({ text: "hello" });
    expect(projectFieldValue("number", 2.5)).toEqual({ number: 2.5 });
    expect(projectFieldValue("date", "2026-07-22")).toEqual({ date: "2026-07-22" });
    expect(projectFieldValue("singleSelect", "ready")).toEqual({ singleSelectOptionId: "ready" });
    expect(projectFieldValue("iteration", "iteration-1")).toEqual({ iterationId: "iteration-1" });
    expect(() => projectFieldValue("date", "22/07/2026")).toThrow(/YYYY-MM-DD/);
    expect(() => projectFieldValue("number", Number.NaN)).toThrow(/finite/);
  });
});
