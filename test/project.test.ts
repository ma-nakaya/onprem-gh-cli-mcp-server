import { describe, expect, it } from "vitest";
import { buildUpdateProjectMutation, graphqlProject, ownerNodeId, projectIdentifier, projectSummary } from "../src/project.js";

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
});
