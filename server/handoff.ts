export function buildWriterHandoffPrompt(draft: string): string {
  return [
    "Write a handoff document so a fresh agent can continue the task described below without asking the original agent anything.",
    "",
    "Reply with only the markdown document, no preamble and no code fence. Do not use any tools, read or modify any files, or start new work. Use exactly these headings:",
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
    "Fill every section from the machine draft below, correcting and expanding it with real detail. Be concrete: name the files changed, what works, what is broken, and the single next step.",
    "",
    "## Machine draft",
    "",
    draft,
  ].join("\n");
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
  return /^#\s*Task\s*$/im.test(text) ? `${text}\n` : null;
}

export function extractTitleFromDocument(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
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