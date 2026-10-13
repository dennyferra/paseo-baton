import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

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
    if (out.length >= limit) break;
  }
  return out;
}

export function transcriptExcerpt(
  timeline: readonly AgentTimelineItem[],
  maxMessages = 30,
  maxCharsPerMessage = 2000,
): string {
  const messages = messageTexts(timeline);
  const tail = messages.slice(-maxMessages);
  const lines: string[] = [];
  for (const message of tail) {
    const text = message.text.length > maxCharsPerMessage
      ? `${message.text.slice(0, maxCharsPerMessage)}...`
      : message.text;
    lines.push(`> ${message.role}: ${text.replace(/\n+/g, " ")}`);
  }
  return lines.join("\n");
}

export interface MechanicalHandoffInput {
  agentId: string;
  workspaceId: string;
  cwd: string;
  provider: string | null;
  timeline: readonly AgentTimelineItem[];
  now: number;
}

export function renderMechanicalHandoff(input: MechanicalHandoffInput): string {
  const task = firstUserText(input.timeline) ?? "Not captured.";
  const currentState = lastAssistantText(input.timeline) ?? "Not captured.";
  const files = touchedFilePaths(input.timeline);
  const filesText = files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "None recorded.";
  const tried = toolSummaries(input.timeline);
  const triedText = tried.length > 0 ? tried.join("\n") : "None recorded.";
  const transcript = transcriptExcerpt(input.timeline);

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
    "## Transcript",
    "",
    transcript,
    "",
  ].join("\n");
}