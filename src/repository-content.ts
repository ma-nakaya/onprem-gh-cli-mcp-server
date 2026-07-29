const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_GITHUB_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_PATH_COMPONENTS = 64;

export type RepositoryTreeEntryKind =
  | "file"
  | "executable"
  | "directory"
  | "symlink"
  | "submodule";

export interface RepositorySnapshot {
  commitSha: string;
  treeSha: string;
}

export interface RepositoryTreeEntry {
  path: string;
  kind: RepositoryTreeEntryKind;
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
}

export interface RepositoryTreePage {
  treeSha: string;
  upstreamTruncated: boolean;
  visibleTotalEntries: number;
  entries: RepositoryTreeEntry[];
}

export type RepositoryFileFormat = "utf8" | "base64";

export interface RepositoryFileChunk {
  format: RepositoryFileFormat;
  offsetBytes: number;
  limitBytes: number;
  totalBytes: number;
  returnedBytes: number;
  nextOffsetBytes: number | null;
  truncated: boolean;
  endedAtLineBoundary: boolean | null;
  content?: string;
  contentBase64?: string;
}

function objectResponse(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub CLI returned an unexpected ${label} response: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function fieldError(label: string, field: string, expectation: string): never {
  throw new Error(`GitHub CLI returned an unexpected ${label} response: "${field}" ${expectation}.`);
}

function shaField(item: Record<string, unknown>, field: string, label: string): string {
  const value = item[field];
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fieldError(label, field, "must be a lowercase 40-character Git SHA");
  }
  return value;
}

function nonNegativeIntegerField(
  item: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fieldError(label, field, "must be a non-negative safe integer");
  }
  return value;
}

function booleanField(item: Record<string, unknown>, field: string, label: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") {
    fieldError(label, field, "must be a boolean");
  }
  return value;
}

function safeInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export function assertGitReadRef(ref: string): void {
  const components = ref.split("/");
  if (
    ref.length < 1
    || ref.length > 255
    || ref.trim() !== ref
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.startsWith("-")
    || ref.endsWith(".")
    || ref.includes("..")
    || ref.includes("//")
    || ref.includes("@{")
    || ref === "@"
    || components.some((component) =>
      component.startsWith(".") || component.toLowerCase().endsWith(".lock")
    )
    || /[\0-\x20\x7f~^:?*[\]\\]/.test(ref)
  ) {
    throw new Error("Git ref must be a canonical branch, tag, or full commit SHA.");
  }
}

export function encodeGitReadRef(ref: string): string {
  assertGitReadRef(ref);
  return encodeURIComponent(ref);
}

export function canonicalRepositoryIdentity(
  value: unknown,
  requestedRepository: string,
): string {
  const label = "repository identity";
  const item = objectResponse(value, label);
  const fullName = item.fullName;
  const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (
    typeof fullName !== "string"
    || fullName.trim() !== fullName
    || !repositoryPattern.test(fullName)
    || fullName.split("/").some((component) => component === "." || component === "..")
  ) {
    fieldError(label, "fullName", "must be a canonical owner/name");
  }
  if (
    requestedRepository.trim() !== requestedRepository
    || !repositoryPattern.test(requestedRepository)
    || requestedRepository.split("/").some(
      (component) => component === "." || component === ".."
    )
  ) {
    throw new Error("Requested repository must be a canonical owner/name.");
  }
  if (fullName.toLowerCase() !== requestedRepository.toLowerCase()) {
    throw new Error(
      `GitHub resolved repository ${JSON.stringify(fullName)} when ${JSON.stringify(requestedRepository)} was requested; repository redirects are not allowed.`,
    );
  }
  return fullName;
}

export function assertRepositoryReadPath(path: string, allowRoot = false): void {
  if (allowRoot && path === "") return;
  const components = path.split("/");
  if (
    path.length < 1
    || path.length > 4096
    || path.trim() !== path
    || path.startsWith("/")
    || path.endsWith("/")
    || /^[A-Za-z]:\//.test(path)
    || /[\0\r\n\\]/.test(path)
    || components.length > MAX_PATH_COMPONENTS
    || components.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Repository path must be a normalized relative Git path.");
  }
}

export function repositorySnapshot(
  value: unknown,
  requestedRef: string,
): RepositorySnapshot {
  const label = "repository commit";
  const item = objectResponse(value, label);
  const commitSha = shaField(item, "commitSha", label);
  const treeSha = shaField(item, "treeSha", label);
  if (SHA_PATTERN.test(requestedRef) && commitSha !== requestedRef) {
    throw new Error(
      `GitHub CLI resolved commit ${commitSha} when ${requestedRef} was requested.`,
    );
  }
  return { commitSha, treeSha };
}

function treeEntry(value: unknown, label: string): RepositoryTreeEntry {
  const item = objectResponse(value, label);
  const path = item.path;
  if (
    typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\0")
  ) {
    fieldError(label, "path", "must be a non-empty relative Git path");
  }
  const mode = item.mode;
  const type = item.type;
  const sha = shaField(item, "sha", label);
  const size = item.size;

  if (mode === "040000" && type === "tree" && size === null) {
    return { path, kind: "directory", mode, type, sha, size: null };
  }
  if (mode === "160000" && type === "commit" && size === null) {
    return { path, kind: "submodule", mode, type, sha, size: null };
  }
  if (
    (mode === "100644" || mode === "100755" || mode === "120000")
    && type === "blob"
  ) {
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      fieldError(label, "size", "must be a non-negative safe integer for a blob");
    }
    const kind = mode === "120000"
      ? "symlink"
      : mode === "100755"
        ? "executable"
        : "file";
    return { path, kind, mode, type, sha, size };
  }
  throw new Error(
    `GitHub CLI returned an unsupported Git tree entry mode/type combination in ${label}.`,
  );
}

export function repositoryTreeLookupJq(component: string): string {
  if (
    component.length === 0
    || component.includes("/")
    || component.includes("\0")
  ) {
    throw new Error("Repository path component must be a non-empty Git tree entry name.");
  }
  const literal = JSON.stringify(component);
  return `{sha:.sha,truncated:.truncated,matches:(.tree|map(select(.path==${literal}))|map({path:.path,mode:.mode,type:.type,sha:.sha,size:(.size//null)}))}`;
}

export function repositoryTreeLookup(
  value: unknown,
  expectedTreeSha: string,
  component: string,
): RepositoryTreeEntry {
  const label = "repository tree lookup";
  const item = objectResponse(value, label);
  const treeSha = shaField(item, "sha", label);
  if (treeSha !== expectedTreeSha) {
    throw new Error(
      `GitHub CLI returned tree ${treeSha} when ${expectedTreeSha} was requested.`,
    );
  }
  if (booleanField(item, "truncated", label)) {
    throw new Error("GitHub truncated a non-recursive tree lookup; the path cannot be resolved safely.");
  }
  if (!Array.isArray(item.matches)) {
    fieldError(label, "matches", "must be an array");
  }
  if (item.matches.length !== 1) {
    throw new Error(
      `Repository path component ${JSON.stringify(component)} resolved to ${item.matches.length} entries instead of exactly one.`,
    );
  }
  const entry = treeEntry(item.matches[0], "repository tree lookup match");
  if (entry.path !== component) {
    throw new Error("GitHub CLI returned a different repository path component than requested.");
  }
  return entry;
}

export function repositoryTreePageJq(offset: number, limit: number): string {
  safeInteger(offset, "offset", 0);
  safeInteger(limit, "limit", 1);
  const end = offset + limit;
  if (!Number.isSafeInteger(end)) {
    throw new Error("Repository tree page boundary exceeds the safe integer range.");
  }
  return `{sha:.sha,truncated:.truncated,visibleTotalEntries:(.tree|length),entries:(.tree[${offset}:${end}]|map({path:.path,mode:.mode,type:.type,sha:.sha,size:(.size//null)}))}`;
}

export function repositoryTreePage(
  value: unknown,
  expectedTreeSha: string,
  offset: number,
  limit: number,
): RepositoryTreePage {
  safeInteger(offset, "offset", 0);
  safeInteger(limit, "limit", 1);
  const label = "repository tree page";
  const item = objectResponse(value, label);
  const treeSha = shaField(item, "sha", label);
  if (treeSha !== expectedTreeSha) {
    throw new Error(
      `GitHub CLI returned tree ${treeSha} when ${expectedTreeSha} was requested.`,
    );
  }
  const upstreamTruncated = booleanField(item, "truncated", label);
  const visibleTotalEntries = nonNegativeIntegerField(
    item,
    "visibleTotalEntries",
    label,
  );
  if (!Array.isArray(item.entries)) {
    fieldError(label, "entries", "must be an array");
  }
  if (item.entries.length > limit) {
    throw new Error(
      `GitHub CLI returned ${item.entries.length} tree entries, exceeding the requested limit of ${limit}.`,
    );
  }
  if (item.entries.length > visibleTotalEntries) {
    throw new Error("GitHub CLI returned more tree entries than the visible tree total.");
  }
  const expectedPageLength = Math.min(
    limit,
    Math.max(0, visibleTotalEntries - offset),
  );
  if (item.entries.length !== expectedPageLength) {
    throw new Error(
      `GitHub CLI returned ${item.entries.length} tree entries when ${expectedPageLength} were expected for this page.`,
    );
  }
  const entries = item.entries.map((entry, index) =>
    treeEntry(entry, `repository tree entry at index ${index}`)
  );
  return { treeSha, upstreamTruncated, visibleTotalEntries, entries };
}

export function assertRepositoryBlobRequest(
  totalBytes: number,
  offsetBytes: number,
  limitBytes: number,
): void {
  safeInteger(totalBytes, "totalBytes", 0);
  safeInteger(offsetBytes, "offsetBytes", 0);
  safeInteger(limitBytes, "limitBytes", 1);
  if (totalBytes > MAX_GITHUB_BLOB_BYTES) {
    throw new Error(
      `Git blob size ${totalBytes} exceeds the supported ${MAX_GITHUB_BLOB_BYTES}-byte GitHub limit.`,
    );
  }
  if (offsetBytes > totalBytes) {
    throw new Error(
      `offsetBytes ${offsetBytes} exceeds the repository file size of ${totalBytes} bytes.`,
    );
  }
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8SequenceLength(value: number): number {
  if (value <= 0x7f) return 1;
  if (value >= 0xc2 && value <= 0xdf) return 2;
  if (value >= 0xe0 && value <= 0xef) return 3;
  if (value >= 0xf0 && value <= 0xf4) return 4;
  return 0;
}

function decodeUtf8(bytes: Buffer, stripInitialBom: boolean): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new Error("Repository file is not valid UTF-8; use format base64.");
  }
  return stripInitialBom && content.startsWith("\uFEFF")
    ? content.slice(1)
    : content;
}

function utf8Content(bytes: Buffer, reachesEndOfFile: boolean, limitBytes: number): {
  bytes: Buffer;
  content: string;
} {
  if (bytes.length === 0) return { bytes, content: "" };
  if (isContinuationByte(bytes[0]!)) {
    throw new Error("offsetBytes is not on a UTF-8 character boundary.");
  }

  let suffixStart = bytes.length - 1;
  while (
    suffixStart > 0
    && isContinuationByte(bytes[suffixStart]!)
    && bytes.length - suffixStart < 4
  ) {
    suffixStart -= 1;
  }
  const expectedSequenceLength = utf8SequenceLength(bytes[suffixStart]!);
  const actualSequenceLength = bytes.length - suffixStart;
  let end = bytes.length;
  if (
    expectedSequenceLength > 1
    && actualSequenceLength < expectedSequenceLength
    && bytes.subarray(suffixStart + 1).every(isContinuationByte)
  ) {
    if (reachesEndOfFile) {
      throw new Error("Repository file is not valid UTF-8; use format base64.");
    }
    end = suffixStart;
  }
  if (end === 0) {
    throw new Error(
      `limitBytes ${limitBytes} is too small to include the next complete UTF-8 character.`,
    );
  }

  const selected = bytes.subarray(0, end);
  return { bytes: selected, content: decodeUtf8(selected, false) };
}

export function repositoryFileChunk(
  bytes: Buffer,
  expectedTotalBytes: number,
  offsetBytes: number,
  limitBytes: number,
  format: RepositoryFileFormat,
): RepositoryFileChunk {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("Repository file chunk must be a Buffer.");
  }
  assertRepositoryBlobRequest(expectedTotalBytes, offsetBytes, limitBytes);
  const requestedEndBytes = Math.min(expectedTotalBytes, offsetBytes + limitBytes);
  const requestedLength = requestedEndBytes - offsetBytes;
  if (bytes.length !== requestedLength) {
    throw new Error(
      `Repository file chunk contained ${bytes.length} bytes instead of the requested ${requestedLength}.`,
    );
  }
  let selected = bytes;

  if (format === "utf8") {
    const decoded = utf8Content(
      selected,
      requestedEndBytes === expectedTotalBytes,
      limitBytes,
    );
    selected = decoded.bytes;
    if (offsetBytes + selected.length < expectedTotalBytes) {
      const newline = selected.lastIndexOf(0x0a);
      if (newline >= 0) {
        selected = selected.subarray(0, newline + 1);
      }
    }
    const returnedBytes = selected.length;
    const nextOffsetBytes = offsetBytes + returnedBytes < expectedTotalBytes
      ? offsetBytes + returnedBytes
      : null;
    return {
      format,
      offsetBytes,
      limitBytes,
      totalBytes: expectedTotalBytes,
      returnedBytes,
      nextOffsetBytes,
      truncated: offsetBytes > 0 || nextOffsetBytes !== null,
      endedAtLineBoundary: nextOffsetBytes === null || selected[selected.length - 1] === 0x0a,
      content: decodeUtf8(selected, offsetBytes === 0),
    };
  }

  if (format !== "base64") {
    throw new Error(`Unsupported repository file format: ${String(format)}`);
  }
  const returnedBytes = selected.length;
  const nextOffsetBytes = offsetBytes + returnedBytes < expectedTotalBytes
    ? offsetBytes + returnedBytes
    : null;
  return {
    format,
    offsetBytes,
    limitBytes,
    totalBytes: expectedTotalBytes,
    returnedBytes,
    nextOffsetBytes,
    truncated: offsetBytes > 0 || nextOffsetBytes !== null,
    endedAtLineBoundary: null,
    contentBase64: selected.toString("base64"),
  };
}

export function prefixRepositoryPath(basePath: string, entryPath: string): string {
  return basePath === "" ? entryPath : `${basePath}/${entryPath}`;
}

export const GITHUB_BLOB_MAX_BYTES = MAX_GITHUB_BLOB_BYTES;
