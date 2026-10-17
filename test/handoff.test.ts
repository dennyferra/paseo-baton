import { describe, expect, it } from "vitest";
import { extractTitleFromDocument } from "../server/handoff";

describe("extractTitleFromDocument", () => {
  it("prefers the explicit Title line", () => {
    const doc = "Title: Fix flaky login test\n\n# Task\nInvestigate why the login spec fails intermittently on CI.\n";
    expect(extractTitleFromDocument(doc, "untitled task")).toBe("Fix flaky login test");
  });

  it("falls back to the first line of the Task section", () => {
    expect(extractTitleFromDocument("# Task\nAdd retries\n# Context\nx\n", "untitled task")).toBe("Add retries");
  });
});
