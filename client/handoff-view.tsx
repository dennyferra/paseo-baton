import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Markdown } from "./markdown";
import { openHandoffRpc, readHandoffRpc } from "../shared/baton";

export const HANDOFF_VIEW_SCREEN_ID = "baton-handoff";

type Loaded = { status: "loading" } | { status: "ready"; content: string } | { status: "error"; message: string };

export function HandoffViewScreen({ theme, layout, params }: PluginScreenProps) {
  const path = params.path ?? "";
  const read = useRpc(readHandoffRpc);
  const open = useRpc(openHandoffRpc);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: "loading" });
    read({ path })
      .then(({ content }) => {
        if (!cancelled) setLoaded({ status: "ready", content });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const padding = layout.compact ? 16 : 24;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding, gap: 12 }}>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 12 : 13 }}>
        {path}
      </Text>
      {loaded.status === "loading" ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading handoff...</Text> : null}
      {loaded.status === "error" ? <Text style={{ color: theme.colors.statusDanger }}>{loaded.message}</Text> : null}
      {loaded.status === "ready" ? (
        <View style={{ gap: 12 }}>
          <Markdown source={loaded.content} theme={theme} compact={layout.compact} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the handoff file in its default app"
            onPress={() => void open({ path }).catch((error: unknown) => console.error(`[baton] open failed: ${String(error)}`))}
            style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface1, alignItems: "center" }}
          >
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Open in default app</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}
