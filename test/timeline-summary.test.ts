import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  firstUserText,
  lastAssistantText,
  renderMechanicalHandoff,
  toolSummaries,
  touchedFilePaths,
  transcriptExcerpt,
} from "../server/timeline-summary";

function timeline(items: AgentTimelineItem[]): readonly AgentTimelineItem[] {
  return items;
}

describe("timeline extraction", () => {
  it("finds the first user text and the last assistant text", () => {
    const items = timeline([
      { type: "user_message", text: "Build a CLI" },
      { type: "assistant_message", text: "Starting." },
      { type: "user_message", text: "Add tests" },
      { type: "assistant_message", text: "Done." },
    ]);
    expect(firstUserText(items)).toBe("Build a CLI");
    expect(lastAssistantText(items)).toBe("Done.");
  });

  it("collects file paths from tool calls", () => {
    const items = timeline([
      {
        type: "tool_call",
        callId: "1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "src/a.ts" },
      },
      {
        type: "tool_call",
        callId: "2",
        name: "search",
        status: "completed",
        error: null,
        detail: { type: "search", query: "x", filePaths: ["src/a.ts", "src/b.ts"] },
      },
    ]);
    expect(touchedFilePaths(items)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("summarizes tool calls with status", () => {
    const items = timeline([
      {
        type: "tool_call",
        callId: "1",
        name: "write",
        status: "failed",
        error: null,
        detail: { type: "write", filePath: "src/a.ts" },
      },
    ]);
    expect(toolSummaries(items)).toEqual(["- write src/a.ts (failed)"]);
  });
});

describe("renderMechanicalHandoff", () => {
  it("renders every template section", () => {
    const doc = renderMechanicalHandoff({
      agentId: "agent-a",
      workspaceId: "w",
      cwd: "/work/a",
      provider: "codex",
      timeline: [],
      now: 1_000,
    });
    for (const section of [
      "# Task",
      "# Context",
      "# Relevant files",
      "# Current state",
      "# What was tried",
      "# Decisions",
      "# Acceptance criteria",
      "# Constraints",
    ]) {
      expect(doc).toContain(section);
    }
  });

  it("includes the transcript for text messages", () => {
    const items = timeline([
      { type: "user_message", text: "Hello" },
      { type: "assistant_message", text: "Hi there" },
    ]);
    const doc = renderMechanicalHandoff({
      agentId: "agent-a",
      workspaceId: "w",
      cwd: "/work/a",
      provider: null,
      timeline: items,
      now: 1_000,
    });
    expect(transcriptExcerpt(items)).toContain("> user: Hello");
    expect(transcriptExcerpt(items)).toContain("> assistant: Hi there");
    expect(doc).toContain("# Task");
    expect(doc).toContain("Hello");
  });
});