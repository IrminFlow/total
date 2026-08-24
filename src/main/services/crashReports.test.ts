import { describe, expect, it } from "vitest";
import { redactCrashText } from "./crashReports";

describe("crash envelope redaction", () => {
  it("removes homes, contacts and credential-looking tokens", () => {
    const redacted = redactCrashText("Failure /Users/person/books/acme.db person@example.com sk-secretVALUE123 at line\nnext");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("/Users/person");
    expect(redacted).not.toContain("secretVALUE123");
    expect(redacted).toContain("<email>");
  });
});
