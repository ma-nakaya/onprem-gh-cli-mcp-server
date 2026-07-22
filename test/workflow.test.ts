import { describe, expect, it } from "vitest";
import { assertActiveWorkflow, isWorkflowIdentifier, normalizeWorkflowInputs, workflowSummary } from "../src/workflow.js";

describe("workflow dispatch validation", () => {
  it("accepts numeric IDs and workflow YAML file names", () => {
    expect(isWorkflowIdentifier("12345")).toBe(true);
    expect(isWorkflowIdentifier("deploy.yml")).toBe(true);
    expect(isWorkflowIdentifier("release-workflow.yaml")).toBe(true);
    expect(isWorkflowIdentifier(".github/workflows/deploy.yml")).toBe(false);
    expect(isWorkflowIdentifier("../deploy.yml")).toBe(false);
    expect(isWorkflowIdentifier("deploy.json")).toBe(false);
  });

  it("allows only active workflows", () => {
    expect(() => assertActiveWorkflow({ state: "active" }, "ci.yml")).not.toThrow();
    expect(() => assertActiveWorkflow({ state: "disabled_manually" }, "ci.yml")).toThrow(/not active/);
    expect(() => assertActiveWorkflow(null, "ci.yml")).toThrow(/unexpected workflow response/);
  });

  it("returns workflow metadata without workflow definition content", () => {
    expect(workflowSummary({
      id: 123,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
      html_url: "https://github.com/example/repo/actions/workflows/ci.yml",
      inputs: { environment: "production" },
    })).toEqual({
      id: 123,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
      url: "https://github.com/example/repo/actions/workflows/ci.yml",
    });
  });

  it("limits workflow input names, counts, and value lengths", () => {
    expect(normalizeWorkflowInputs({ environment: "staging" })).toEqual({ environment: "staging" });
    expect(() => normalizeWorkflowInputs({ "bad name": "value" })).toThrow(/Invalid workflow input name/);
    expect(() => normalizeWorkflowInputs({ environment: "x".repeat(1025) })).toThrow(/exceeds 1024/);
    expect(() => normalizeWorkflowInputs(Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`input_${i}`, "x"])))).toThrow(/more than 25/);
  });
});
