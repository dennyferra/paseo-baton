import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { DETAIL_LIMITS, type DraftLimits } from "../shared/baton";

type TranscriptLimits = Pick<DraftLimits, "maxChars" | "maxUserChars" | "maxAssistantChars">;

export interface TimelineMessage {
  role: "user" | "assistant";
  text: string;
}

export function messageTexts(timeline: readonly AgentTimelineItem[]): TimelineMessage[] {
  const out: TimelineMessage[] = [];
  for (const item of timeline) {
    if (item.type === "user_message") out.push({ role: "user", text: item.text });
    else if (item.type === "assistant_message") out.push({ role: "assistant", text: item.text });
  }
  return out;
}

export function firstUserText(timeline: readonly AgentTimelineItem[]): string | null {
  for (const item of timeline) {
    if (item.type === "user_message" && item.text.trim()) return item.text;
  }
  return null;
}

/** The handoff file a session was started from, when its first message is Baton's "Read <file> and continue the task." */
export function previousHandoffPath(timeline: readonly AgentTimelineItem[]): string | null {
  const match = /^Read\s+(\S+\.md)\s+and continue the task\.?\s*$/.exec(firstUserText(timeline)?.trim() ?? "");
  return match ? match[1] : null;
}

export function lastAssistantText(timeline: readonly AgentTimelineItem[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message" && item.text.trim()) return item.text;
  }
  return null;
}

export function touchedFilePaths(timeline: readonly AgentTimelineItem[]): string[] {
  const out: string[] = [];
  for (const item of timeline) {
    if (item.type !== "tool_call") continue;
    const detail = item.detail;
    if (
      (detail.type === "read" || detail.type === "edit" || detail.type === "write") &&
      detail.filePath
    ) {
      out.push(detail.filePath);
    } else if (detail.type === "search" && detail.filePaths?.length) {
      out.push(...detail.filePaths);
    }
  }
  return [...new Set(out)];
}

function isToolCall(item: AgentTimelineItem): item is ToolCallTimelineItem {
  return item.type === "tool_call";
}

/**
 * What the agent did that left a trace: tool calls that name a file, URL or label, repeats folded into a count,
 * the most recent ones up to the limit. A call only gets a status when it did not complete. Calls with nothing
 * to name, such as shell commands, say nothing useful, so they are left out.
 */
export function toolSummaries(timeline: readonly AgentTimelineItem[], limit = 40): string[] {
  const lines: string[] = [];
  for (const item of timeline) {
    if (!isToolCall(item)) continue;
    const detail = item.detail;
    let target = "";
    if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
      target = detail.filePath ? ` ${detail.filePath}` : "";
    } else if (detail.type === "search" && detail.filePaths?.length) {
      target = ` ${detail.filePaths.slice(0, 3).join(", ")}`;
    } else if (detail.type === "fetch") {
      target = ` ${detail.url}`;
    } else if (detail.type === "plain_text" && detail.label) {
      target = ` ${detail.label}`;
    }
    if (!target) continue;
    lines.push(`- ${item.name}${target}${item.status === "completed" ? "" : ` (${item.status})`}`);
  }
  return foldRecent(lines, limit);
}

const MAX_FILES = 100;
const MAX_TODO_ITEMS = 40;
const MAX_FAILURES = 10;
const MAX_SUB_AGENTS = 10;
const MAX_ERROR_CHARS = 300;
const MAX_SUB_AGENT_CHARS = 120;

/** The newest task list the agent kept, as checkbox lines, or an empty list. */
export function latestTodos(timeline: readonly AgentTimelineItem[]): string[] {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "todo") continue;
    return item.items.slice(0, MAX_TODO_ITEMS).map((todo) => {
      const state = todo.completed || todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " ";
      return `- [${state}] ${cutMiddle(todo.text, 200)}`;
    });
  }
  return [];
}

/** The newest plan the agent wrote, or null. */
export function latestPlan(timeline: readonly AgentTimelineItem[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (isToolCall(item) && item.detail.type === "plan" && item.detail.text.trim()) return item.detail.text.trim();
  }
  return null;
}

/** Folds repeated lines into a count and keeps the most recent ones, in order of last use. */
function foldRecent(lines: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const count = counts.get(line) ?? 0;
    counts.delete(line);
    counts.set(line, count + 1);
  }
  return [...counts].map(([line, count]) => (count > 1 ? `${line} (x${count})` : line)).slice(-limit);
}

/** The program a shell command runs, without its arguments, which can hold tokens and other secrets. */
export function shellProgram(command: string): string {
  const skipped = new Set(["cd", "export", "set", "source", "."]);
  for (const segment of command.split(/&&|;|\|\|/)) {
    const words = segment.trim().split(/\s+/).filter((word) => word && !/^\w+=/.test(word));
    if (words.length === 0 || skipped.has(words[0])) continue;
    return words[0].replace(/^["']|["']$/g, "").split("/").pop()?.slice(0, 40) || "command";
  }
  return "command";
}

/** What broke: error items, and shell calls that failed, named by program and exit code only. */
export function failureSummaries(timeline: readonly AgentTimelineItem[], limit = MAX_FAILURES): string[] {
  const lines: string[] = [];
  for (const item of timeline) {
    if (item.type === "error") {
      lines.push(`- error: ${cutMiddle(item.message.replace(/\s+/g, " ").trim(), MAX_ERROR_CHARS)}`);
    } else if (isToolCall(item) && item.detail.type === "shell") {
      const exit = item.detail.exitCode;
      if (item.status === "failed" || (typeof exit === "number" && exit !== 0)) {
        lines.push(`- shell: ${shellProgram(item.detail.command)} failed${typeof exit === "number" ? ` (exit ${exit})` : ""}`);
      }
    }
  }
  return foldRecent(lines, limit);
}

/** Work the agent handed to sub-agents, by their short descriptions. */
export function subAgentSummaries(timeline: readonly AgentTimelineItem[], limit = MAX_SUB_AGENTS): string[] {
  const lines: string[] = [];
  for (const item of timeline) {
    if (!isToolCall(item) || item.detail.type !== "sub_agent" || !item.detail.description) continue;
    const kind = item.detail.subAgentType ? ` (${item.detail.subAgentType})` : "";
    lines.push(`- sub-agent${kind}: ${cutMiddle(item.detail.description.replace(/\s+/g, " ").trim(), MAX_SUB_AGENT_CHARS)}`);
  }
  return foldRecent(lines, limit);
}

/** How many times the agent's own conversation was compacted, which leaves earlier history only as a summary. */
export function compactionCount(timeline: readonly AgentTimelineItem[]): number {
  return timeline.filter((item) => item.type === "compaction" && item.status === "completed").length;
}

const CUT_MARKER = " (...cut...) ";

/** Keeps the start and the end of a long text, so a question after a big paste is not lost. */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= CUT_MARKER.length) return text.slice(0, Math.max(max, 0));
  const keep = max - CUT_MARKER.length;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${CUT_MARKER}${text.slice(text.length - (keep - head))}`;
}

export function transcriptExcerpt(
  timeline: readonly AgentTimelineItem[],
  limits: TranscriptLimits = DETAIL_LIMITS.standard,
): string {
  const messages = messageTexts(timeline);
  const kept: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const max = message.role === "user" ? limits.maxUserChars : limits.maxAssistantChars;
    const line = `> ${message.role}: ${cutMiddle(message.text, max).replace(/\n+/g, " ")}`;
    if (used + line.length > limits.maxChars && kept.length > 0) break;
    kept.push(line);
    used += line.length;
  }
  const omitted = messages.length - kept.length;
  const lines = kept.reverse();
  if (omitted > 0) lines.unshift(`> (${omitted} earlier messages omitted)`);
  return lines.join("\n");
}

export interface MechanicalHandoffInput {
  agentId: string;
  workspaceId: string;
  cwd: string;
  provider: string | null;
  timeline: readonly AgentTimelineItem[];
  now: number;
  /** Branch, changed files and recent commits, gathered by Baton. */
  repoFacts?: string;
  /** Limits on what the draft carries; the standard ones when omitted. */
  limits?: Omit<DraftLimits, "historyEntries">;
  /** True when the conversation was longer than what could be read, so the first request may be missing. */
  historyCut?: boolean;
  /** The handoff this session was started from, since the first message only points to it. */
  previousHandoff?: string;
}

export function renderMechanicalHandoff(input: MechanicalHandoffInput): string {
  const limits = input.limits ?? DETAIL_LIMITS.standard;
  const capped = (text: string | null) => (text === null ? "Not captured." : cutMiddle(text, limits.maxTextChars));
  const task = capped(firstUserText(input.timeline));
  const currentState = capped(lastAssistantText(input.timeline));
  const files = touchedFilePaths(input.timeline);
  const shownFiles = files.slice(-MAX_FILES);
  const filesText =
    files.length > 0
      ? [...(files.length > shownFiles.length ? [`(${files.length - shownFiles.length} earlier files not shown)`] : []), ...shownFiles.map((file) => `- ${file}`)].join("\n")
      : "None recorded.";
  const tried = [...toolSummaries(input.timeline), ...subAgentSummaries(input.timeline), ...failureSummaries(input.timeline)];
  const triedText = tried.length > 0 ? tried.join("\n") : "None recorded.";
  const todos = latestTodos(input.timeline);
  const plan = latestPlan(input.timeline);
  const compactions = compactionCount(input.timeline);
  const transcript = transcriptExcerpt(input.timeline, limits);

  return [
    "# Task",
    "",
    task,
    "",
    "# Context",
    "",
    `- Workspace: ${input.workspaceId}`,
    `- Working directory: ${input.cwd}`,
    `- Provider: ${input.provider ?? "unknown"}`,
    `- Agent: ${input.agentId}`,
    `- Generated: ${new Date(input.now).toISOString()}`,
    ...(input.historyCut
      ? ["- Earlier history was not read because the conversation is longer than the read limit, so the Task below may be a later request than the first."]
      : []),
    ...(compactions > 0
      ? [`- The agent's own conversation was compacted ${compactions} time${compactions === 1 ? "" : "s"}, so some earlier history exists only as a summary.`]
      : []),
    "",
    "# Relevant files",
    "",
    filesText,
    "",
    "# Current state",
    "",
    currentState,
    "",
    "# What was tried",
    "",
    triedText,
    "",
    "# Decisions",
    "",
    "Not available from the session snapshot.",
    "",
    "# Acceptance criteria",
    "",
    "Not available from the session snapshot.",
    "",
    "# Constraints",
    "",
    "Not available from the session snapshot.",
    "",
    ...(todos.length > 0 ? ["## Task list (latest)", "", ...todos, ""] : []),
    ...(plan ? ["## Plan (latest)", "", cutMiddle(plan, limits.maxTextChars), ""] : []),
    ...(input.repoFacts ? ["## Repo state", "", input.repoFacts, ""] : []),
    ...(input.previousHandoff
      ? ["## Previous handoff", "", "This session was started from this handoff, so its details still apply.", "", cutMiddle(input.previousHandoff, limits.maxTextChars * 2), ""]
      : []),
    "## Transcript",
    "",
    transcript,
    "",
  ].join("\n");
}