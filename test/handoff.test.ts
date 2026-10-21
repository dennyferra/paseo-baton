import { describe, expect, it } from "vitest";
import { extractTitleFromDocument, stampHandoffDocument } from "../server/handoff";

describe("extractTitleFromDocument", () => {
  it("prefers the explicit Title line", () => {
    const doc = "Title: Fix flaky login test\n\n# Task\nInvestigate why the login spec fails intermittently on CI.\n";
    expect(extractTitleFromDocument(doc, "untitled task")).toBe("Fix flaky login test");
  });

  it("falls back to the first line of the Task section", () => {
    expect(extractTitleFromDocument("# Task\nAdd retries\n# Context\nx\n", "untitled task")).toBe("Add retries");
  });
});

describe("stampHandoffDocument", () => {
  const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
  const STAMP = "Created: 2026-10-19T12:00:00.000Z";

  it("puts the timestamp right under the Title line", () => {
    expect(stampHandoffDocument("Title: Fix login\n\n# Task\nx\n", NOW)).toBe(`Title: Fix login\n${STAMP}\n\n# Task\nx\n`);
  });

  it("puts the timestamp at the top when there is no Title line", () => {
    expect(stampHandoffDocument("# Task\nx\n", NOW)).toBe(`${STAMP}\n# Task\nx\n`);
  });

  it("replaces a Created line the writer added but leaves body text alone", () => {
    const doc = "Title: Fix login\nCreated: yesterday\n\n# Task\nCreated: a new endpoint\n";
    expect(stampHandoffDocument(doc, NOW)).toBe(`Title: Fix login\n${STAMP}\n\n# Task\nCreated: a new endpoint\n`);
  });
});
