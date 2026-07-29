import { describe, expect, it } from "vitest";
import {
  assertGitReadRef,
  assertRepositoryBlobRequest,
  assertRepositoryReadPath,
  canonicalRepositoryIdentity,
  encodeGitReadRef,
  GITHUB_BLOB_MAX_BYTES,
  prefixRepositoryPath,
  repositoryFileChunk,
  repositorySnapshot,
  repositoryTreeLookup,
  repositoryTreeLookupJq,
  repositoryTreePage,
  repositoryTreePageJq,
  type RepositoryTreeEntryKind,
} from "../src/repository-content.js";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);

describe("canonical repository identity validation", () => {
  it("accepts the requested repository and returns GitHub's canonical casing", () => {
    expect(canonicalRepositoryIdentity(
      { fullName: "Ma-Nakaya/Example" },
      "ma-nakaya/example",
    )).toBe("Ma-Nakaya/Example");
  });

  it.each([
    "other-owner/example",
    "ma-nakaya/renamed",
  ])("rejects a repository redirect to %j", (fullName) => {
    expect(() => canonicalRepositoryIdentity(
      { fullName },
      "ma-nakaya/example",
    )).toThrow(/repository redirects are not allowed/);
  });

  it.each([
    null,
    [],
    "ma-nakaya/example",
    {},
    { fullName: "" },
    { fullName: " ma-nakaya/example" },
    { fullName: "ma-nakaya/example " },
    { fullName: "ma-nakaya/example/extra" },
    { fullName: "ma nakaya/example" },
  ])("rejects a malformed repository identity response: %j", (value) => {
    expect(() => canonicalRepositoryIdentity(
      value,
      "ma-nakaya/example",
    )).toThrow(/unexpected repository identity response/);
  });

  it.each([
    "",
    " ma-nakaya/example",
    "ma-nakaya/example ",
    "ma-nakaya/example/extra",
  ])("rejects malformed requested repository identity %j", (requested) => {
    expect(() => canonicalRepositoryIdentity(
      { fullName: "ma-nakaya/example" },
      requested,
    )).toThrow(/Requested repository must be a canonical owner\/name/);
  });
});

describe("repository ref and path validation", () => {
  it.each([
    "main",
    "feature/read-repository-content",
    "release/v1.2.3",
    "refs/tags/v1.0.0",
    "日本語ブランチ",
    COMMIT_SHA,
  ])("accepts canonical Git ref %j", (ref) => {
    expect(() => assertGitReadRef(ref)).not.toThrow();
  });

  it.each([
    "",
    " main",
    "main ",
    "/main",
    "main/",
    "-main",
    "main.",
    "feature..branch",
    "feature//branch",
    "feature@{one}",
    "@",
    ".hidden",
    "feature/.hidden",
    "feature.lock",
    "feature.LOCK",
    "feature name",
    "feature\tname",
    "feature\nname",
    "feature\u007fname",
    "feature~name",
    "feature^name",
    "feature:name",
    "feature?name",
    "feature*name",
    "feature[name",
    "feature\\name",
  ])("rejects non-canonical Git ref %j", (ref) => {
    expect(() => assertGitReadRef(ref)).toThrow(
      /Git ref must be a canonical branch, tag, or full commit SHA/,
    );
  });

  it("rejects a Git ref longer than 255 characters", () => {
    expect(() => assertGitReadRef("a".repeat(256))).toThrow(/canonical branch/);
    expect(() => assertGitReadRef("a".repeat(255))).not.toThrow();
  });

  it("percent-encodes an already validated ref as one URL path component", () => {
    expect(() => encodeGitReadRef("feature/read this")).toThrow(/canonical branch/);
    expect(encodeGitReadRef("feature/read-content")).toBe(
      "feature%2Fread-content",
    );
    expect(encodeGitReadRef("日本語ブランチ")).toBe(
      encodeURIComponent("日本語ブランチ"),
    );
  });

  it.each([
    "README.md",
    "src/repository-content.ts",
    ".github/workflows/ci.yml",
    "directory with spaces/file.txt",
    "日本語/資料.md",
  ])("accepts normalized relative repository path %j", (path) => {
    expect(() => assertRepositoryReadPath(path)).not.toThrow();
  });

  it("allows the repository root only when explicitly requested", () => {
    expect(() => assertRepositoryReadPath("")).toThrow(/normalized relative/);
    expect(() => assertRepositoryReadPath("", true)).not.toThrow();
  });

  it.each([
    " file.txt",
    "file.txt ",
    "/file.txt",
    "directory/",
    "C:/file.txt",
    "C:\\file.txt",
    "directory\\file.txt",
    "directory//file.txt",
    "./file.txt",
    "directory/./file.txt",
    "../file.txt",
    "directory/../file.txt",
    "file\0name",
    "file\rname",
    "file\nname",
  ])("rejects unsafe or non-normalized repository path %j", (path) => {
    expect(() => assertRepositoryReadPath(path, true)).toThrow(
      /Repository path must be a normalized relative Git path/,
    );
  });

  it("enforces the repository path length limit", () => {
    expect(() => assertRepositoryReadPath("a".repeat(4096))).not.toThrow();
    expect(() => assertRepositoryReadPath("a".repeat(4097))).toThrow(
      /normalized relative/,
    );
  });

  it("caps repository traversal at 64 path components", () => {
    expect(() => assertRepositoryReadPath(
      Array.from({ length: 64 }, () => "a").join("/"),
    )).not.toThrow();
    expect(() => assertRepositoryReadPath(
      Array.from({ length: 65 }, () => "a").join("/"),
    )).toThrow(/normalized relative/);
  });
});

describe("repository snapshot validation", () => {
  it("selects only the resolved commit and root tree SHAs", () => {
    expect(repositorySnapshot({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
      message: "must not be returned",
      author: { email: "must-not-leak@example.com" },
    }, "main")).toEqual({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
    });
  });

  it("requires a requested full SHA to resolve exactly", () => {
    expect(repositorySnapshot({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
    }, COMMIT_SHA)).toEqual({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
    });
    expect(() => repositorySnapshot({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
    }, "d".repeat(40))).toThrow(/resolved commit .* when .* was requested/);
  });

  it.each([null, [], "response", 42])(
    "rejects a non-object snapshot response: %j",
    (value) => {
      expect(() => repositorySnapshot(value, "main")).toThrow(
        /unexpected repository commit response: expected an object/,
      );
    },
  );

  it.each([
    { commitSha: "a".repeat(39), treeSha: TREE_SHA },
    { commitSha: "A".repeat(40), treeSha: TREE_SHA },
    { commitSha: COMMIT_SHA, treeSha: "not-a-sha" },
    { commitSha: COMMIT_SHA },
  ])("rejects malformed snapshot SHAs", (value) => {
    expect(() => repositorySnapshot(value, "main")).toThrow(
      /must be a lowercase 40-character Git SHA/,
    );
  });
});

describe("repository tree lookup", () => {
  it("builds a fixed jq projection and JSON-escapes the path component", () => {
    const component = "name\")|.dangerous=true|(\"line\nbreak";
    const jq = repositoryTreeLookupJq(component);
    expect(jq).toBe(
      `{sha:.sha,truncated:.truncated,matches:(.tree|map(select(.path==${JSON.stringify(component)}))|map({path:.path,mode:.mode,type:.type,sha:.sha,size:(.size//null)}))}`,
    );
    expect(jq).toContain(`.path==${JSON.stringify(component)}`);
    expect(jq).not.toContain(`.path=="${component}")`);
  });

  it.each(["", "directory/file", "nul\0byte"])(
    "rejects invalid lookup component %j before constructing jq",
    (component) => {
      expect(() => repositoryTreeLookupJq(component)).toThrow(
        /non-empty Git tree entry name/,
      );
    },
  );

  const modes: Array<{
    mode: "040000" | "100644" | "100755" | "120000" | "160000";
    type: "blob" | "tree" | "commit";
    size: number | null;
    kind: RepositoryTreeEntryKind;
  }> = [
    { mode: "040000", type: "tree", size: null, kind: "directory" },
    { mode: "100644", type: "blob", size: 12, kind: "file" },
    { mode: "100755", type: "blob", size: 12, kind: "executable" },
    { mode: "120000", type: "blob", size: 12, kind: "symlink" },
    { mode: "160000", type: "commit", size: null, kind: "submodule" },
  ];

  it.each(modes)(
    "maps $mode/$type to $kind and removes extra fields",
    ({ mode, type, size, kind }) => {
      expect(repositoryTreeLookup({
        sha: TREE_SHA,
        truncated: false,
        matches: [{
          path: "component",
          mode,
          type,
          sha: BLOB_SHA,
          size,
          url: "must not be returned",
        }],
      }, TREE_SHA, "component")).toEqual({
        path: "component",
        kind,
        mode,
        type,
        sha: BLOB_SHA,
        size,
      });
    },
  );

  it("fails closed when GitHub reports a truncated non-recursive lookup", () => {
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: true,
      matches: [],
    }, TREE_SHA, "component")).toThrow(
      /truncated a non-recursive tree lookup/,
    );
  });

  it("requires the response tree SHA to match the requested tree", () => {
    expect(() => repositoryTreeLookup({
      sha: "d".repeat(40),
      truncated: false,
      matches: [],
    }, TREE_SHA, "component")).toThrow(
      /returned tree .* when .* was requested/,
    );
  });

  it.each([
    { matches: null, error: /"matches" must be an array/ },
    { matches: [], error: /resolved to 0 entries instead of exactly one/ },
    {
      matches: [
        { path: "component", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1 },
        { path: "component", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1 },
      ],
      error: /resolved to 2 entries instead of exactly one/,
    },
  ])("requires exactly one lookup match", ({ matches, error }) => {
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: false,
      matches,
    }, TREE_SHA, "component")).toThrow(error);
  });

  it("requires the returned match to have the requested component name", () => {
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: false,
      matches: [{
        path: "other",
        mode: "100644",
        type: "blob",
        sha: BLOB_SHA,
        size: 1,
      }],
    }, TREE_SHA, "component")).toThrow(/different repository path component/);
  });

  it.each([
    {
      entry: { path: "", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1 },
      error: /"path" must be a non-empty relative Git path/,
    },
    {
      entry: { path: "/component", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1 },
      error: /"path" must be a non-empty relative Git path/,
    },
    {
      entry: { path: "component/", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1 },
      error: /"path" must be a non-empty relative Git path/,
    },
    {
      entry: { path: "component", mode: "100644", type: "blob", sha: "bad", size: 1 },
      error: /"sha" must be a lowercase 40-character Git SHA/,
    },
    {
      entry: { path: "component", mode: "100644", type: "blob", sha: BLOB_SHA, size: -1 },
      error: /"size" must be a non-negative safe integer for a blob/,
    },
    {
      entry: { path: "component", mode: "100644", type: "blob", sha: BLOB_SHA, size: 1.5 },
      error: /"size" must be a non-negative safe integer for a blob/,
    },
  ])("rejects a malformed lookup match", ({ entry, error }) => {
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: false,
      matches: [entry],
    }, TREE_SHA, "component")).toThrow(error);
  });

  it.each([
    { mode: "040000", type: "tree", size: 0 },
    { mode: "160000", type: "commit", size: 0 },
    { mode: "100644", type: "tree", size: 1 },
    { mode: "100755", type: "commit", size: 1 },
    { mode: "120000", type: "blob", size: null },
    { mode: "100600", type: "blob", size: 1 },
  ])("rejects unsupported mode/type/size entry %#", (entry) => {
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: false,
      matches: [{ path: "component", sha: BLOB_SHA, ...entry }],
    }, TREE_SHA, "component")).toThrow(
      /unsupported Git tree entry mode\/type combination|non-negative safe integer for a blob/,
    );
  });

  it("rejects malformed lookup envelope fields", () => {
    expect(() => repositoryTreeLookup(null, TREE_SHA, "component")).toThrow(
      /expected an object/,
    );
    expect(() => repositoryTreeLookup({
      sha: TREE_SHA,
      truncated: "false",
      matches: [],
    }, TREE_SHA, "component")).toThrow(/"truncated" must be a boolean/);
  });
});

describe("repository tree pagination", () => {
  it("builds a fixed jq projection with validated numeric slice boundaries", () => {
    expect(repositoryTreePageJq(2, 3)).toBe(
      "{sha:.sha,truncated:.truncated,visibleTotalEntries:(.tree|length),entries:(.tree[2:5]|map({path:.path,mode:.mode,type:.type,sha:.sha,size:(.size//null)}))}",
    );
  });

  it.each([
    { offset: -1, limit: 1, error: /offset.*greater than or equal to 0/ },
    { offset: 0.5, limit: 1, error: /offset.*safe integer/ },
    { offset: 0, limit: 0, error: /limit.*greater than or equal to 1/ },
    { offset: 0, limit: 1.5, error: /limit.*safe integer/ },
    {
      offset: Number.MAX_SAFE_INTEGER,
      limit: 1,
      error: /page boundary exceeds the safe integer range/,
    },
  ])("rejects unsafe jq page range %#", ({ offset, limit, error }) => {
    expect(() => repositoryTreePageJq(offset, limit)).toThrow(error);
  });

  it("returns every supported tree entry kind in a page", () => {
    const entries = [
      { path: "dir", mode: "040000", type: "tree", sha: "1".repeat(40), size: null },
      { path: "file", mode: "100644", type: "blob", sha: "2".repeat(40), size: 0 },
      { path: "script", mode: "100755", type: "blob", sha: "3".repeat(40), size: 10 },
      { path: "link", mode: "120000", type: "blob", sha: "4".repeat(40), size: 6 },
      { path: "module", mode: "160000", type: "commit", sha: "5".repeat(40), size: null },
    ];
    expect(repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: entries.length,
      entries,
    }, TREE_SHA, 0, entries.length)).toEqual({
      treeSha: TREE_SHA,
      upstreamTruncated: false,
      visibleTotalEntries: 5,
      entries: [
        { ...entries[0], kind: "directory" },
        { ...entries[1], kind: "file" },
        { ...entries[2], kind: "executable" },
        { ...entries[3], kind: "symlink" },
        { ...entries[4], kind: "submodule" },
      ],
    });
  });

  it("reports upstream recursive-tree truncation without hiding visible results", () => {
    expect(repositoryTreePage({
      sha: TREE_SHA,
      truncated: true,
      visibleTotalEntries: 1,
      entries: [{
        path: "visible.txt",
        mode: "100644",
        type: "blob",
        sha: BLOB_SHA,
        size: 7,
      }],
    }, TREE_SHA, 0, 10)).toMatchObject({
      treeSha: TREE_SHA,
      upstreamTruncated: true,
      visibleTotalEntries: 1,
      entries: [{ path: "visible.txt", kind: "file" }],
    });
  });

  it("accepts an empty page at and beyond the visible total", () => {
    expect(repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: 2,
      entries: [],
    }, TREE_SHA, 2, 10).entries).toEqual([]);
    expect(repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: 2,
      entries: [],
    }, TREE_SHA, 20, 10).entries).toEqual([]);
  });

  it("requires the response tree SHA to match the requested tree", () => {
    expect(() => repositoryTreePage({
      sha: "d".repeat(40),
      truncated: false,
      visibleTotalEntries: 0,
      entries: [],
    }, TREE_SHA, 0, 10)).toThrow(/returned tree .* when .* was requested/);
  });

  it.each([
    {
      value: { sha: TREE_SHA, truncated: "false", visibleTotalEntries: 0, entries: [] },
      error: /"truncated" must be a boolean/,
    },
    {
      value: { sha: TREE_SHA, truncated: false, visibleTotalEntries: -1, entries: [] },
      error: /"visibleTotalEntries" must be a non-negative safe integer/,
    },
    {
      value: { sha: TREE_SHA, truncated: false, visibleTotalEntries: 0.5, entries: [] },
      error: /"visibleTotalEntries" must be a non-negative safe integer/,
    },
    {
      value: { sha: TREE_SHA, truncated: false, visibleTotalEntries: 0, entries: null },
      error: /"entries" must be an array/,
    },
  ])("rejects malformed tree page envelope %#", ({ value, error }) => {
    expect(() => repositoryTreePage(value, TREE_SHA, 0, 10)).toThrow(error);
  });

  it("rejects more entries than the requested limit", () => {
    const entry = {
      path: "file",
      mode: "100644",
      type: "blob",
      sha: BLOB_SHA,
      size: 1,
    };
    expect(() => repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: 2,
      entries: [entry, { ...entry, path: "other" }],
    }, TREE_SHA, 0, 1)).toThrow(/exceeding the requested limit of 1/);
  });

  it("rejects more entries than the visible tree total", () => {
    expect(() => repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: 0,
      entries: [{
        path: "file",
        mode: "100644",
        type: "blob",
        sha: BLOB_SHA,
        size: 1,
      }],
    }, TREE_SHA, 0, 10)).toThrow(/more tree entries than the visible tree total/);
  });

  it("requires the exact page length implied by offset, limit, and total", () => {
    expect(() => repositoryTreePage({
      sha: TREE_SHA,
      truncated: false,
      visibleTotalEntries: 3,
      entries: [{
        path: "second",
        mode: "100644",
        type: "blob",
        sha: BLOB_SHA,
        size: 1,
      }],
    }, TREE_SHA, 1, 2)).toThrow(
      /returned 1 tree entries when 2 were expected for this page/,
    );
  });

  it("validates caller ranges before reading a page envelope", () => {
    expect(() => repositoryTreePage(null, TREE_SHA, -1, 1)).toThrow(
      /offset.*greater than or equal to 0/,
    );
    expect(() => repositoryTreePage(null, TREE_SHA, 0, 0)).toThrow(
      /limit.*greater than or equal to 1/,
    );
  });
});

describe("repository blob request validation", () => {
  it("accepts empty blobs and the maximum GitHub blob size", () => {
    expect(GITHUB_BLOB_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(() => assertRepositoryBlobRequest(0, 0, 1)).not.toThrow();
    expect(() => assertRepositoryBlobRequest(
      GITHUB_BLOB_MAX_BYTES,
      GITHUB_BLOB_MAX_BYTES,
      Number.MAX_SAFE_INTEGER,
    )).not.toThrow();
  });

  it("rejects blobs larger than the supported GitHub limit", () => {
    expect(() => assertRepositoryBlobRequest(
      GITHUB_BLOB_MAX_BYTES + 1,
      0,
      1,
    )).toThrow(/exceeds the supported .* GitHub limit/);
  });

  it.each([
    { total: -1, offset: 0, limit: 1, field: "totalBytes" },
    { total: 1.5, offset: 0, limit: 1, field: "totalBytes" },
    { total: 1, offset: -1, limit: 1, field: "offsetBytes" },
    { total: 1, offset: 0.5, limit: 1, field: "offsetBytes" },
    { total: 1, offset: 0, limit: 0, field: "limitBytes" },
    { total: 1, offset: 0, limit: 1.5, field: "limitBytes" },
    {
      total: 1,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER + 1,
      field: "limitBytes",
    },
  ])("rejects unsafe numeric blob request %#", ({ total, offset, limit, field }) => {
    expect(() => assertRepositoryBlobRequest(total, offset, limit)).toThrow(
      new RegExp(`${field}.*safe integer`),
    );
  });

  it("rejects an offset past the end while allowing the exact end", () => {
    expect(() => assertRepositoryBlobRequest(3, 3, 1)).not.toThrow();
    expect(() => assertRepositoryBlobRequest(3, 4, 1)).toThrow(
      /offsetBytes 4 exceeds .* size of 3 bytes/,
    );
  });
});

describe("UTF-8 repository file chunks", () => {
  it("returns a complete ASCII text file without truncation", () => {
    const bytes = Buffer.from("hello");
    expect(repositoryFileChunk(bytes, bytes.length, 0, 100, "utf8")).toEqual({
      format: "utf8",
      offsetBytes: 0,
      limitBytes: 100,
      totalBytes: 5,
      returnedBytes: 5,
      nextOffsetBytes: null,
      truncated: false,
      endedAtLineBoundary: true,
      content: "hello",
    });
  });

  it("prefers the last newline without exceeding the requested byte limit", () => {
    const file = Buffer.from("first\nsecond\nthird");
    expect(repositoryFileChunk(
      file.subarray(0, 15),
      file.length,
      0,
      15,
      "utf8",
    )).toEqual({
      format: "utf8",
      offsetBytes: 0,
      limitBytes: 15,
      totalBytes: 18,
      returnedBytes: 13,
      nextOffsetBytes: 13,
      truncated: true,
      endedAtLineBoundary: true,
      content: "first\nsecond\n",
    });
  });

  it("returns a non-line-aligned chunk when no newline is available", () => {
    expect(repositoryFileChunk(
      Buffer.from("hello"),
      10,
      0,
      5,
      "utf8",
    )).toEqual({
      format: "utf8",
      offsetBytes: 0,
      limitBytes: 5,
      totalBytes: 10,
      returnedBytes: 5,
      nextOffsetBytes: 5,
      truncated: true,
      endedAtLineBoundary: false,
      content: "hello",
    });
  });

  it("uses UTF-8 byte offsets and returns an emoji only at exact boundaries", () => {
    const file = Buffer.from("A😀B");
    expect(repositoryFileChunk(
      file.subarray(1, 5),
      file.length,
      1,
      4,
      "utf8",
    )).toEqual({
      format: "utf8",
      offsetBytes: 1,
      limitBytes: 4,
      totalBytes: 6,
      returnedBytes: 4,
      nextOffsetBytes: 5,
      truncated: true,
      endedAtLineBoundary: false,
      content: "😀",
    });
  });

  it("drops a partial trailing character so the next chunk can retry it", () => {
    const file = Buffer.from("A😀B");
    expect(repositoryFileChunk(
      file.subarray(0, 3),
      file.length,
      0,
      3,
      "utf8",
    )).toEqual({
      format: "utf8",
      offsetBytes: 0,
      limitBytes: 3,
      totalBytes: 6,
      returnedBytes: 1,
      nextOffsetBytes: 1,
      truncated: true,
      endedAtLineBoundary: false,
      content: "A",
    });
  });

  it("rejects a limit that cannot include the next complete UTF-8 character", () => {
    const file = Buffer.from("😀B");
    expect(() => repositoryFileChunk(
      file.subarray(0, 2),
      file.length,
      0,
      2,
      "utf8",
    )).toThrow(/limitBytes 2 is too small.*complete UTF-8 character/);
  });

  it("rejects an offset in the middle of a UTF-8 character", () => {
    const file = Buffer.from("A😀B");
    expect(() => repositoryFileChunk(
      file.subarray(2, 4),
      file.length,
      2,
      2,
      "utf8",
    )).toThrow(/offsetBytes is not on a UTF-8 character boundary/);
  });

  it("accepts a UTF-8 BOM and reports the bytes consumed", () => {
    const file = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(repositoryFileChunk(file, file.length, 0, file.length, "utf8"))
      .toEqual({
        format: "utf8",
        offsetBytes: 0,
        limitBytes: 5,
        totalBytes: 5,
        returnedBytes: 5,
        nextOffsetBytes: null,
        truncated: false,
        endedAtLineBoundary: true,
        content: "hi",
      });
  });

  it("preserves U+FEFF at the start of a continuation chunk", () => {
    const file = Buffer.from("A\uFEFFB", "utf8");
    expect(repositoryFileChunk(
      file.subarray(1),
      file.length,
      1,
      file.length - 1,
      "utf8",
    )).toMatchObject({
      offsetBytes: 1,
      returnedBytes: 4,
      nextOffsetBytes: null,
      truncated: true,
      content: "\uFEFFB",
    });
  });

  it.each([
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xe3, 0x81]),
  ])("rejects invalid or incomplete UTF-8 bytes %#", (bytes) => {
    expect(() => repositoryFileChunk(
      bytes,
      bytes.length,
      0,
      Math.max(1, bytes.length),
      "utf8",
    )).toThrow(/not valid UTF-8; use format base64/);
  });

  it("handles an empty file and an exact end offset", () => {
    expect(repositoryFileChunk(Buffer.alloc(0), 0, 0, 1, "utf8")).toEqual({
      format: "utf8",
      offsetBytes: 0,
      limitBytes: 1,
      totalBytes: 0,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: false,
      endedAtLineBoundary: true,
      content: "",
    });
    expect(repositoryFileChunk(Buffer.alloc(0), 3, 3, 1, "utf8")).toEqual({
      format: "utf8",
      offsetBytes: 3,
      limitBytes: 1,
      totalBytes: 3,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
      content: "",
    });
  });

  it("marks a final continuation chunk truncated because its prefix was omitted", () => {
    expect(repositoryFileChunk(
      Buffer.from("tail"),
      8,
      4,
      100,
      "utf8",
    )).toMatchObject({
      content: "tail",
      returnedBytes: 4,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: true,
    });
  });
});

describe("base64 repository file chunks", () => {
  it("returns arbitrary binary bytes without UTF-8 validation", () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80]);
    expect(repositoryFileChunk(
      bytes.subarray(0, 3),
      bytes.length,
      0,
      3,
      "base64",
    )).toEqual({
      format: "base64",
      offsetBytes: 0,
      limitBytes: 3,
      totalBytes: 5,
      returnedBytes: 3,
      nextOffsetBytes: 3,
      truncated: true,
      endedAtLineBoundary: null,
      contentBase64: "AP/+",
    });
  });

  it("returns a final binary continuation chunk at its exact byte offset", () => {
    expect(repositoryFileChunk(
      Buffer.from([0x0a, 0x80]),
      5,
      3,
      10,
      "base64",
    )).toEqual({
      format: "base64",
      offsetBytes: 3,
      limitBytes: 10,
      totalBytes: 5,
      returnedBytes: 2,
      nextOffsetBytes: null,
      truncated: true,
      endedAtLineBoundary: null,
      contentBase64: "CoA=",
    });
  });

  it("handles an empty binary file", () => {
    expect(repositoryFileChunk(Buffer.alloc(0), 0, 0, 1, "base64")).toEqual({
      format: "base64",
      offsetBytes: 0,
      limitBytes: 1,
      totalBytes: 0,
      returnedBytes: 0,
      nextOffsetBytes: null,
      truncated: false,
      endedAtLineBoundary: null,
      contentBase64: "",
    });
  });

  it("requires an exact Buffer length for the requested range", () => {
    expect(() => repositoryFileChunk(
      Buffer.from("ab"),
      3,
      0,
      3,
      "base64",
    )).toThrow(/contained 2 bytes instead of the requested 3/);
    expect(() => repositoryFileChunk(
      Buffer.from("abcd"),
      3,
      0,
      3,
      "base64",
    )).toThrow(/contained 4 bytes instead of the requested 3/);
  });

  it("rejects non-Buffers and unsupported formats", () => {
    expect(() => repositoryFileChunk(
      new Uint8Array([1]) as unknown as Buffer,
      1,
      0,
      1,
      "base64",
    )).toThrow(/must be a Buffer/);
    expect(() => repositoryFileChunk(
      Buffer.from([1]),
      1,
      0,
      1,
      "hex" as "base64",
    )).toThrow(/Unsupported repository file format: hex/);
  });
});

describe("repository tree path prefixing", () => {
  it("preserves a root entry and prefixes a nested entry exactly once", () => {
    expect(prefixRepositoryPath("", "README.md")).toBe("README.md");
    expect(prefixRepositoryPath("src/lib", "index.ts")).toBe(
      "src/lib/index.ts",
    );
  });
});
