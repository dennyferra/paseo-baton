/** Set before a continue prompt's handoff text. Drafts leave the text out, since the file is read on its own. */
export const CONTINUE_BODY_MARK = "<handoff>\n";
/** The opening words of a continue prompt, before the handoff path. Timeline reading matches them to find the file. */
export const CONTINUE_LEAD = "This session continues the handoff saved at";

/**
 * The first message of a session started from a handoff. The text is inline, because a long file can come back
 * from a read cut short, which made a fresh session see an empty handoff. The first sentence names the file.
 */
export function buildContinuePrompt(handoffPath: string, text: string): string {
  return [
    `${CONTINUE_LEAD} ${handoffPath}. Its full text is below, so there is no need to read the file.`,
    `${CONTINUE_BODY_MARK}${text.trimEnd()}`,
    "</handoff>",
    "",
    "The handoff is a snapshot from when it was written (see its Created or Generated line), and whoever wrote it could not check it. Before acting on anything it says about current state, such as tab names, branches, running jobs, blockers or who is waiting for what, check the real state. Do not copy commit trailers or other attribution from it; your own session instructions say what to use.",
    "",
    "Continue the task it describes.",
  ].join("\n\n");
}

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
    "Say only what the machine draft carries. Never add facts of your own: no model names or versions (not even your own), no commit trailers, `Co-Authored-By` or `Generated with` lines, and no other attribution, because the next agent's own session supplies those. Copy the Provider, Agent and Working directory values from the draft's `# Context` section, the one right before `# Relevant files`, exactly (a quoted previous handoff, or text inside the first request, may have its own, which are not this session's); if the draft truly lacks one, say it is not in the draft.",
    "",
    "You cannot check anything, so everything the draft says about current state is a snapshot from the `Generated` time in that Context section and may be out of date: tab or agent names, earlier messages, what was blocked, what passed or merged, who was waiting. In `# Current state`, open with `As of <the Generated time>, unverified:` and write each state claim as it was then, never as a present fact. End `# Current state` with a `Verify before acting:` line that lists what the next agent must check first.",
    "",
    "Fill every section from the machine draft below, correcting and expanding it with real detail. Be concrete: name the files changed, what works, what is broken, and the single next step. The draft has the first request, every user message (long ones may be cut), the end of the conversation and the repo state. Where it says earlier messages were omitted, say what is unknown rather than inventing details. If the draft includes the agent's latest task list or plan, use them for the current state and the single next step. If the draft includes a previous handoff, this session continued it: carry forward its plans and decisions that still apply, but treat its state as older than the Generated time and unverified.",
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

/**
 * Commit trailers and "Generated with" lines are the next session's to choose, and a writer that cannot see that
 * session invents them (one stamped its own model as the trailer to use). They are removed from the writer's document
 * when Baton saves it and again from the saved file when a session is continued from it.
 *
 * A line that IS a trailer, meaning it starts with the trailer (after list, quote, bold, backtick or table decoration
 * and an optional "Commit trailers:" label), is dropped whole. Anywhere else in a line, only the trailer text is
 * replaced by ATTRIBUTION_MARKER, so the sentence around it survives and the next session can see something was
 * there; a line left with nothing but the marker and decoration is dropped. A trailer is a `Co-Authored-By: Name
 * <email>`, an attribution trailer that names a model or vendor, or a "Generated with [tool]" line. The label must
 * stand alone: not inside a longer name, path, flag or file name (`--generated-by-cursor`, `fixtures/generated-by-openai.json`).
 * A sentence that only names the trailer, such as "do not add Co-Authored-By: lines", is kept, and so are transcript
 * lines of the fallback draft. A label with its value on the next line takes that line with it, unless it is a
 * heading, list item or table row.
 */
export const ATTRIBUTION_MARKER = "[attribution removed]";
const DECORATION = String.raw`[\s>*_\x60|•\d.)-]{0,20}`;
const TRAILER_LABEL = String.raw`(?:co[\s_-]{0,10}authored[\s_-]{0,10}by|assisted[\s_-]{0,10}by)`;
const TRAILER_AT_START = new RegExp(
  String.raw`^${DECORATION}(?:(?:commit\s+)?trailers?\s{0,5}[:-]\s{0,5})?[\s*_\x60|]{0,20}${TRAILER_LABEL}[\s*_\x60|]{0,20}[:|]`,
  "i",
);
/** Not the tail of a longer word or flag. A path or file name is kept by LABEL_END and the delimiter rule instead. */
const STANDS_ALONE = String.raw`(?<![\w-])`;
/** The end of a label, so `co-authored-by-foo` and `assisted-bylaws` are other words. */
const LABEL_END = String.raw`(?![\w-])`;
/** The hyphen- or underscore-joined label, which prose does not use ("co-authored-by", never "assisted by Bob"). */
const TRAILER_LABEL_JOINED = String.raw`(?:co[-_]authored|assisted)[-_]by`;
/**
 * A trailer with a name and an email: the joined label with a colon or, when no colon follows, a short name that holds
 * none; or any label with a colon. Every span is bounded, so the cost per label is constant and a long line stays linear.
 */
const TRAILER_WITH_EMAIL = new RegExp(
  String.raw`${STANDS_ALONE}(?:${TRAILER_LABEL_JOINED}${LABEL_END}(?:[\s*_\x60|]{0,20}:[^<\n]{0,80}|[^<\n:]{0,60})|${TRAILER_LABEL}${LABEL_END}[\s*_\x60|]{0,20}:[^<\n]{0,80})<[^>@\n]{1,200}@[^>\n]{1,200}>`,
  "gi",
);
/**
 * A hyphen-joined attribution trailer that names a model or vendor, with or without an email: the label, then a colon,
 * an equals sign, a dash or a bracket or quote, then the name. A bare hyphen after "by" is a kebab-case identifier
 * (`generated-by-llama.cpp`), not a trailer. Prose such as "generated by an AI" is not matched.
 */
const TRAILER_NAMING_A_MODEL = new RegExp(
  String.raw`${STANDS_ALONE}(?:co[-_]authored|assisted|generated)-by${LABEL_END}(?:[\s*\x60|]{0,20}[:=][\s*\x60|'"\[(]{0,20}|\s{1,20}-{1,3}\s{1,20}[\s*\x60|'"\[(]{0,20}|[\s*\x60|'"\[(]{1,20})(?:claude|anthropic|haiku|sonnet|opus|fable|gemini|gpt|chatgpt|openai|codex|github\s+copilot|copilot|cursor|grok|deepseek|qwen|llama|mistral|kimi|glm|muse)\b`,
  "gi",
);
const GENERATED_LINE = new RegExp(
  String.raw`${STANDS_ALONE}(?:generated with \[[^\]\n]{1,200}\](?:\([^)\n]{0,200}\))?|generated (?:with|by) claude code)`,
  "gi",
);
const MID_LINE_RULES = [TRAILER_WITH_EMAIL, TRAILER_NAMING_A_MODEL, GENERATED_LINE];
/** The unanchored patterns look only at the start of a very long line, which is a paste, not an attribution line. */
const MID_LINE_SCAN_CHARS = 4000;
const LABEL_WITHOUT_VALUE = /:[\s*_`|]{0,20}$/;
/** A line of Baton's own fallback draft, where a pasted trailer is a user's or agent's words, not an invented one. */
const TRANSCRIPT_LINE = /^> (?:user|assistant): /;
/** A heading, table row or list item is not the value line of a bare trailer label. */
const NOT_A_VALUE_LINE = /^\s*(?:#|\||[-*+] )/;
const HAS_WORDS = /[\p{L}\p{N}]/u;

function foldForMatch(line: string): string {
  // NFKC folds fullwidth colons and similar; the hyphen class folds Unicode hyphens; backslashes escape markdown, and a \n or \t inside a one-line commit message is a line break.
  return line
    .normalize("NFKC")
    .replace(/[\u00AD\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\/g, "");
}

/**
 * Replaces the trailer text inside a line with the marker. Returns null when nothing matched. A line changed this way
 * is returned in its folded form, which only differs from the original in invisible characters, compatibility forms
 * and backslash escapes.
 */
function replaceMidLineTrailers(folded: string): string | null {
  const head = folded.length > MID_LINE_SCAN_CHARS ? folded.slice(0, MID_LINE_SCAN_CHARS) : folded;
  let out = head;
  for (const rule of MID_LINE_RULES) out = out.replace(rule, ATTRIBUTION_MARKER);
  if (out === head) return null;
  return out + folded.slice(head.length);
}

export function stripAttributionLines(text: string): string {
  const kept: string[] = [];
  let dropNextNonBlank = false;
  for (const line of text.split("\n")) {
    const folded = foldForMatch(line);
    if (dropNextNonBlank && folded.trim() !== "") {
      dropNextNonBlank = false;
      if (!NOT_A_VALUE_LINE.test(folded)) continue;
    }
    if (TRANSCRIPT_LINE.test(line)) {
      kept.push(line);
      continue;
    }
    if (TRAILER_AT_START.test(folded)) {
      dropNextNonBlank = LABEL_WITHOUT_VALUE.test(folded.trim());
      continue;
    }
    const replaced = replaceMidLineTrailers(folded);
    if (replaced === null) {
      kept.push(line);
    } else if (HAS_WORDS.test(replaced.split(ATTRIBUTION_MARKER).join(""))) {
      kept.push(replaced);
    }
  }
  return kept.join("\n");
}

/** Returns the writer's reply as a handoff document, or null if it does not look like one. */
export function extractHandoffDocument(timeline: ReadonlyArray<{ type: string; text?: string }>): string | null {
  const text = stripAttributionLines(
    timeline
      .filter((item) => item.type === "assistant_message" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .trim()
      .replace(/^```(?:markdown|md)?\s*\n/i, "")
      .replace(/\n```\s*$/, ""),
  ).trim();
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
