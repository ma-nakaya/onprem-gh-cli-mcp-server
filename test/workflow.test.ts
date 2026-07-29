import { describe, expect, it } from "vitest";
import {
  assertActiveWorkflow,
  assertWorkflowJobIdentity,
  isWorkflowIdentifier,
  normalizeWorkflowInputs,
  workflowRunJobs,
  workflowRunLogChunk,
  workflowSummary,
} from "../src/workflow.js";

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

describe("read-only workflow run response handling", () => {
  it("validates a workflow job against the requested run and job IDs", () => {
    expect(() => assertWorkflowJobIdentity({
      id: 123,
      runId: 456,
      status: "completed",
      name: "must not be used",
    }, 456, 123)).not.toThrow();
  });

  it("rejects malformed or mismatched workflow job identities", () => {
    expect(() => assertWorkflowJobIdentity([], 456, 123)).toThrow(/expected an object/);
    expect(() => assertWorkflowJobIdentity({
      id: 0,
      runId: 456,
      status: "completed",
    }, 456, 123)).toThrow(/"id".*positive safe integer/);
    expect(() => assertWorkflowJobIdentity({
      id: 123,
      runId: 456,
      status: "",
    }, 456, 123)).toThrow(/"status".*non-empty string/);
    expect(() => assertWorkflowJobIdentity({
      id: 124,
      runId: 456,
      status: "completed",
    }, 456, 123)).toThrow(/job 124.*job 123/);
    expect(() => assertWorkflowJobIdentity({
      id: 123,
      runId: 457,
      status: "completed",
    }, 456, 123)).toThrow(/run 457.*run 456/);
    expect(() => assertWorkflowJobIdentity({
      id: 123,
      runId: 456,
      status: "completed",
    }, 0, 123)).toThrow(/expectedRunId.*positive safe integer/);
    expect(() => assertWorkflowJobIdentity({
      id: 123,
      runId: 456,
      status: "completed",
    }, 456, Number.MAX_SAFE_INTEGER + 1)).toThrow(/expectedJobId.*positive safe integer/);
  });

  it("selects fixed job metadata and omits URLs, steps, and other fields", () => {
    expect(workflowRunJobs([
      {
        id: 123,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: "GitHub Actions 1",
        runnerGroupName: "GitHub Actions",
        labels: ["ubuntu-latest", "x64"],
        htmlUrl: "https://github.com/example/repo/actions/runs/1/job/123",
        steps: [{ name: "Untrusted step", conclusion: "success" }],
        runnerId: 456,
      },
      {
        id: 124,
        name: "queued",
        status: "queued",
        conclusion: null,
        startedAt: null,
        completedAt: null,
        runnerName: null,
        runnerGroupName: null,
        labels: [],
      },
    ], 2)).toEqual([
      {
        id: 123,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: "GitHub Actions 1",
        runnerGroupName: "GitHub Actions",
        labels: ["ubuntu-latest", "x64"],
      },
      {
        id: 124,
        name: "queued",
        status: "queued",
        conclusion: null,
        startedAt: null,
        completedAt: null,
        runnerName: null,
        runnerGroupName: null,
        labels: [],
      },
    ]);
  });

  it("rejects malformed or oversized workflow job responses", () => {
    expect(() => workflowRunJobs({ jobs: [] })).toThrow(/expected an array/);
    expect(() => workflowRunJobs([], -1)).toThrow(/non-negative safe integer/);
    expect(() => workflowRunJobs([], 0.5)).toThrow(/non-negative safe integer/);
    expect(() => workflowRunJobs([
      {
        id: 1,
        name: "one",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: null,
        runnerGroupName: null,
        labels: [],
      },
      {
        id: 2,
        name: "two",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: null,
        runnerGroupName: null,
        labels: [],
      },
    ], 1)).toThrow(/exceeding the requested maximum/);
    expect(() => workflowRunJobs([
      {
        id: 0,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-30T00:00:00Z",
        completedAt: "2026-07-30T00:01:00Z",
        runnerName: null,
        runnerGroupName: null,
        labels: [],
      },
    ])).toThrow(/"id".*positive safe integer/);
    expect(() => workflowRunJobs([
      {
        id: 1,
        name: "test",
        status: "completed",
        conclusion: null,
        startedAt: null,
        completedAt: null,
        runnerName: null,
        runnerGroupName: null,
        labels: ["ubuntu-latest", 42],
      },
    ])).toThrow(/"labels".*array of strings/);
  });
});

describe("workflow run log byte chunking", () => {
  it("prefers a newline without exceeding the byte limit", () => {
    expect(workflowRunLogChunk("line 1\nline 2\n", 0, 10)).toEqual({
      log: "line 1\n",
      offsetBytes: 0,
      limitBytes: 10,
      totalBytes: 14,
      returnedBytes: 7,
      nextOffsetBytes: 7,
      truncated: true,
      endedAtLineBoundary: true,
      completeness: "not_guaranteed",
    });
  });

  it("uses exact UTF-8 byte offsets and never splits a character", () => {
    expect(workflowRunLogChunk("AあB\n", 1, 3)).toEqual({
      log: "あ",
      offsetBytes: 1,
      limitBytes: 3,
      totalBytes: 6,
      returnedBytes: 3,
      nextOffsetBytes: 4,
      truncated: true,
      endedAtLineBoundary: false,
      completeness: "not_guaranteed",
    });
  });

  it("marks continuation chunks as truncated and complete first chunks as untruncated", () => {
    expect(workflowRunLogChunk("line 1\nline 2\n", 7, 100)).toEqual({
      log: "line 2\n",
      offsetBytes: 7,
      limitBytes: 100,
      totalBytes: 14,
      returnedBytes: 7,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
      completeness: "not_guaranteed",
    });
    expect(workflowRunLogChunk("line 1\n", 0, 100).truncated).toBe(false);
  });

  it("accepts an exact end offset and an empty log", () => {
    expect(workflowRunLogChunk("abc", 3, 1)).toMatchObject({
      log: "",
      totalBytes: 3,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
    });
    expect(workflowRunLogChunk("", 0, 1)).toMatchObject({
      log: "",
      totalBytes: 0,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: false,
      endedAtLineBoundary: true,
    });
  });

  it("rejects invalid or unsafe byte ranges", () => {
    expect(() => workflowRunLogChunk("AあB", 2, 4)).toThrow(/UTF-8 character boundary/);
    expect(() => workflowRunLogChunk("AあB", 1, 2)).toThrow(/too small.*UTF-8 character/);
    expect(() => workflowRunLogChunk("abc", 4, 1)).toThrow(/exceeds.*3 bytes/);
    expect(() => workflowRunLogChunk("abc", -1, 1)).toThrow(/offsetBytes.*greater than or equal to 0/);
    expect(() => workflowRunLogChunk("abc", 0, 0)).toThrow(/limitBytes.*greater than or equal to 1/);
    expect(() => workflowRunLogChunk("abc", 0.5, 1)).toThrow(/offsetBytes.*safe integer/);
  });
});
