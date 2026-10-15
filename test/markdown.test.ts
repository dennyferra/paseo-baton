import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../client/markdown-parse";

describe("parseMarkdown", () => {
  it("parses headings, paragraphs, lists, quotes, code and rules", () => {
    const blocks = parseMarkdown(
      ["# Task", "Fix the", "bug.", "", "- one", "  - nested", "1. first", "> note", "```", "a = 1", "```", "---"].join("\n"),
    );
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Task" },
      { type: "paragraph", text: "Fix the bug." },
      {
        type: "list",
        items: [
          { text: "one", indent: 0, marker: "•" },
          { text: "nested", indent: 1, marker: "•" },
          { text: "first", indent: 0, marker: "1." },
        ],
      },
      { type: "quote", text: "note" },
      { type: "code", text: "a = 1" },
      { type: "rule" },
    ]);
  });

  it("keeps table rows together as one monospace block", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
  });
});

describe("parseInline", () => {
  it("splits bold, italic, code and links", () => {
    expect(parseInline("a **b** *c* `d` [e](http://x)")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " " },
      { text: "e" },
    ]);
  });
});
