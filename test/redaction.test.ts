import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redactSecrets", () => {
  it("redacts GitHub tokens", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactSecrets(`token=${token}`)).not.toContain(token);
  });
  it("redacts bearer credentials", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz.12345")).toBe("Authorization: [REDACTED]");
  });
});
