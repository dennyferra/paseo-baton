export function buildHandoffPrompt(absPath: string): string {
  return [
    `Write a handoff document to ${absPath} so a fresh agent can continue this task without asking you anything.`,
    "",
    "Create the file if it does not exist. Use exactly these markdown headings:",
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
    "Fill every section from the conversation so far. Be concrete: name the files you changed, what works, what is broken, and the single next step. Do not modify any other files and do not start new work.",
    "",
    "When the file is written, reply with only the absolute path.",
  ].join("\n");
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