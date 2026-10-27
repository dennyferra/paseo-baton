import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  cutMiddle,
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

  it("adds the repo state when it has some", () => {
    const doc = renderMechanicalHandoff({
      agentId: "agent-a",
      workspaceId: "w",
      cwd: "/work/a",
      provider: null,
      timeline: [],
      now: 1_000,
      repoFacts: "Branch: main",
    });
    expect(doc).toContain("## Repo state\n\nBranch: main");
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
describe("transcriptExcerpt limits", () => {
  const limits = { maxChars: 400, maxUserChars: 300, maxAssistantChars: 20 };

  it("keeps long user messages far longer than assistant replies", () => {
    const items = timeline([
      { type: "user_message", text: `Spec ${"u".repeat(150)}` },
      { type: "assistant_message", text: `Reply ${"a".repeat(100)}` },
    ]);
    const text = transcriptExcerpt(items, limits);
    expect(text).toContain(`Spec ${"u".repeat(150)}`);
    expect(text).toContain("(...cut...)");
    expect(text).not.toContain("a".repeat(40));
  });

  it("drops the oldest messages first and says how many were left out", () => {
    const items = timeline(
      Array.from({ length: 10 }, (_, i) => ({ type: "user_message" as const, text: `message ${i} ${"x".repeat(80)}` })),
    );
    const text = transcriptExcerpt(items, limits);
    expect(text).toContain("message 9");
    expect(text).not.toContain("message 0");
    expect(text).toMatch(/\(\d+ earlier messages omitted\)/);
  });
});

describe("cutMiddle", () => {
  it("keeps short text as it is", () => {
    expect(cutMiddle("short", 100)).toBe("short");
  });

  it("never returns more than the limit, even a limit shorter than the marker", () => {
    expect(cutMiddle("x".repeat(100), 5)).toBe("xxxxx");
    expect(cutMiddle("x".repeat(100), 0)).toBe("");
    expect(cutMiddle("x".repeat(100), 13).length).toBeLessThanOrEqual(13);
  });

  it("keeps the start and the end of long text", () => {
    const text = `START ${"x".repeat(500)} the real question?`;
    const cut = cutMiddle(text, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.startsWith("START")).toBe(true);
    expect(cut.endsWith("the real question?")).toBe(true);
    expect(cut).toContain("(...cut...)");
  });
});

describe("renderMechanicalHandoff limits", () => {
  const limits = { maxChars: 1_000, maxUserChars: 500, maxAssistantChars: 100, maxTextChars: 200 };
  const base = { agentId: "a", workspaceId: "w", cwd: "/work", provider: null, now: 1_000, limits };

  it("caps a huge first request and the last reply, keeping both ends", () => {
    const doc = renderMechanicalHandoff({
      ...base,
      timeline: timeline([
        { type: "user_message", text: `FIRST ${"p".repeat(5_000)} LAST-ASK` },
        { type: "assistant_message", text: `OPEN ${"r".repeat(5_000)} CLOSE` },
      ]),
    });
    const task = doc.split("# Context")[0];
    expect(task.length).toBeLessThan(400);
    expect(task).toContain("FIRST");
    expect(task).toContain("LAST-ASK");
    const state = doc.split("# Current state")[1].split("# What was tried")[0];
    expect(state).toContain("OPEN");
    expect(state).toContain("CLOSE");
  });

  it("says when the conversation was longer than what was read", () => {
    const doc = renderMechanicalHandoff({ ...base, timeline: [], historyCut: true });
    expect(doc).toContain("Earlier history was not read");
    expect(renderMechanicalHandoff({ ...base, timeline: [] })).not.toContain("Earlier history was not read");
  });

  it("lists the most recent tool calls, not the first ones", () => {
    const calls = Array.from({ length: 50 }, (_, i) => ({
      type: "tool_call" as const,
      callId: String(i),
      name: "read",
      status: "completed" as const,
      error: null,
      detail: { type: "read" as const, filePath: `file-${i}.ts` },
    }));
    const summaries = toolSummaries(timeline(calls));
    expect(summaries).toHaveLength(40);
    expect(summaries[0]).toContain("file-10.ts");
    expect(summaries[39]).toContain("file-49.ts");
  });

  it("shows at most the 100 most recent files", () => {
    const calls = Array.from({ length: 120 }, (_, i) => ({
      type: "tool_call" as const,
      callId: String(i),
      name: "edit",
      status: "completed" as const,
      error: null,
      detail: { type: "edit" as const, filePath: `f-${i}.ts` },
    }));
    const doc = renderMechanicalHandoff({ ...base, timeline: timeline(calls) });
    expect(doc).toContain("(20 earlier files not shown)");
    expect(doc).toContain("- f-119.ts");
    expect(doc).not.toContain("- f-19.ts\n");
  });
});
