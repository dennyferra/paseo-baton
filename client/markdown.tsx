import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { ReactNode } from "react";
import { parseInline, parseMarkdown } from "./markdown-parse";

// The host exposes no markdown component, so this renders the subset handoff documents use:
// headings, paragraphs, bullet/numbered lists, quotes, fenced code, pipe tables, rules, and
// bold/italic/inline code. Links render as their text.

export function Markdown({ source, theme, compact }: { source: string; theme: PluginTheme; compact: boolean }) {
  const size = compact ? 14 : 15;
  const mono = "Menlo";
  const inline = (text: string): ReactNode =>
    parseInline(text).map((span, index) => (
      <Text
        key={index}
        style={{
          fontWeight: span.bold ? "700" : undefined,
          fontStyle: span.italic ? "italic" : undefined,
          fontFamily: span.code ? mono : undefined,
          backgroundColor: span.code ? theme.colors.surface2 : undefined,
        }}
      >
        {span.text}
      </Text>
    ));
  const body = { color: theme.colors.foreground, fontSize: size, lineHeight: size * 1.5 };

  return (
    <View style={{ gap: 10 }}>
      {parseMarkdown(source).map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <Text
                key={index}
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontWeight: "700",
                  fontSize: size + Math.max(0, 7 - block.level * 2),
                  marginTop: block.level <= 2 ? 8 : 4,
                }}
              >
                {inline(block.text)}
              </Text>
            );
          case "list":
            return (
              <View key={index} style={{ gap: 4 }}>
                {block.items.map((entry, itemIndex) => (
                  <View key={itemIndex} style={{ flexDirection: "row", gap: 8, paddingLeft: entry.indent * 16 }}>
                    <Text style={body}>{entry.marker}</Text>
                    <Text selectable style={[body, { flex: 1 }]}>
                      {inline(entry.text)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 }}>
                <Text selectable style={[body, { color: theme.colors.foregroundMuted }]}>
                  {inline(block.text)}
                </Text>
              </View>
            );
          case "code":
            return (
              <View
                key={index}
                style={{ backgroundColor: theme.colors.surface1, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: theme.colors.border }}
              >
                <Text selectable style={{ color: theme.colors.foreground, fontFamily: mono, fontSize: size - 1 }}>
                  {block.text.replace(/^​/, "")}
                </Text>
              </View>
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          default:
            return (
              <Text key={index} selectable style={body}>
                {inline(block.text)}
              </Text>
            );
        }
      })}
    </View>
  );
}
