export function buildWriterHandoffPrompt(draft: string): string {
  return [
    "Write a handoff document so a fresh agent can continue the task described below without asking the original agent anything.",
    "",
    "Reply with only the markdown document, no preamble and no code fence. Do not use any tools, read or modify any files, or start new work. Start with a single line `Title: <3 to 8 word summary of the work>`, a short label the user can scan later to remember what this was about. Then use exactly these headings:",
    "",
    "# Task",
    "# Context",
    "# Relevant files",
    "# Current state",
    "# What was tried",
    "# Decisions",
    "# Acceptance criteria",
    "# Constraints",
    "",
    "Fill every section from the machine draft below, correcting and expanding it with real detail. Be concrete: name the files changed, what works, what is broken, and the single next step. The draft has the first request, every user message (long ones may be cut), the end of the conversation and the repo state. Where it says earlier messages were omitted, say what is unknown rather than inventing details. If the draft includes the agent's latest task list or plan, use them for the current state and the single next step. If the draft includes a previous handoff, this session continued it: carry forward what still applies from it.",
    "",
    "## Machine draft",
    "",
    draft,
  ].join("\n");
}

/** True when the text looks like a handoff document, meaning it has a Task heading. */
export function isHandoffDocument(text: string): boolean {
  return /^#\s*Task\s*$/im.test(text);
}

/** Returns the writer's reply as a handoff document, or null if it does not look like one. */
export function extractHandoffDocument(timeline: ReadonlyArray<{ type: string; text?: string }>): string | null {
  const text = timeline
    .filter((item) => item.type === "assistant_message" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n/i, "")
    .replace(/\n```\s*$/, "")
    .trim();
  return isHandoffDocument(text) ? `${text}\n` : null;
}

export function extractTitleFromDocument(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  const explicit = text.match(/^\s*Title:[ \t]*([^\r\n]+)/i)?.[1]?.trim();
  if (explicit) return explicit.slice(0, 80);
  let raw: string | null = null;
  let inTask = false;
  for (const line of lines) {
    if (/^#\s*Task\s*$/i.test(line)) {
      inTask = true;
      continue;
    }
    if (!inTask) continue;
    if (/^#\s/.test(line)) break;
    if (line.trim()) {
      raw = line.trim();
      break;
    }
  }
  if (!raw) {
    const firstHeading = text.match(/^#\s+(.+)$/m);
    raw = firstHeading?.[1]?.trim() ?? null;
  }
  if (!raw) {
    raw = lines.map((line) => line.trim()).find((line) => line.length > 0) ?? fallback;
  }
  const cleaned = (raw ?? fallback).replace(/^#+\s*/, "").trim();
  return cleaned.slice(0, 80) || fallback;
}

/** Adds a `Created:` line below the title line (or at the top when there is none), replacing any the writer added. */
export function stampHandoffDocument(document: string, now: number): string {
  const stamp = `Created: ${new Date(now).toISOString()}`;
  const headingIndex = document.split("\n").findIndex((line) => /^#/.test(line));
  const lines = document
    .split("\n")
    .filter((line, index) => !(/^\s*Created:/i.test(line) && (headingIndex < 0 || index < headingIndex)));
  const titleIndex = lines.findIndex((line) => /^\s*Title:/i.test(line));
  lines.splice(titleIndex + 1, 0, stamp);
  return lines.join("\n");
}
