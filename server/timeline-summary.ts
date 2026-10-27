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

/** The most recent tool calls, up to the limit. */
export function toolSummaries(timeline: readonly AgentTimelineItem[], limit = 40): string[] {
  const out: string[] = [];
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
    out.push(`- ${item.name}${target} (${item.status})`);
  }
  return out.slice(-limit);
}

const MAX_FILES = 100;

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
  const tried = toolSummaries(input.timeline);
  const triedText = tried.length > 0 ? tried.join("\n") : "None recorded.";
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
    ...(input.repoFacts ? ["## Repo state", "", input.repoFacts, ""] : []),
    "## Transcript",
    "",
    transcript,
    "",
  ].join("\n");
}