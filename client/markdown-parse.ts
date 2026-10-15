// Pure parsing for the markdown subset handoff documents use; rendering lives in markdown.tsx.

export type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: Array<{ text: string; indent: number; marker: string }> }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "rule" };

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const entry = {
        text: item[3],
        indent: Math.floor(item[1].replace(/\t/g, "  ").length / 2),
        marker: /\d/.test(item[2]) ? item[2] : "•",
      };
      const last = blocks[blocks.length - 1];
      if (last?.type === "list") last.items.push(entry);
      else blocks.push({ type: "list", items: [entry] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const text = line.replace(/^\s*>\s?/, "");
      const last = blocks[blocks.length - 1];
      if (last?.type === "quote") last.text += ` ${text}`;
      else blocks.push({ type: "quote", text });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.type === "code" && last.text.startsWith("​|")) last.text += `\n${line}`;
      else blocks.push({ type: "code", text: `​${line}` });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index) });
    const token = match[0];
    if (match[1]) spans.push({ text: token.slice(1, -1), code: true });
    else if (match[2]) spans.push({ text: token.slice(2, -2), bold: true });
    else if (match[3]) spans.push({ text: token.slice(1, -1), italic: true });
    else spans.push({ text: token.slice(1, token.indexOf("]")) });
    last = match.index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

