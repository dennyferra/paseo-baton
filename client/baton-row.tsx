import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { batonRowSchema } from "../shared/baton";

type BatonRowData = z.output<typeof batonRowSchema>;

export function BatonRow({ item, theme, layout }: PluginTimelineItemProps<BatonRowData>) {
  const data = item.data;
  const styles = useMemo(
    () => ({
      card: {
        flexDirection: "column" as const,
        gap: layout.compact ? 4 : 6,
        padding: layout.compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      body: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
      hint: {
        color: theme.colors.accent,
        fontSize: layout.compact ? 12 : 13,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Handoff saved</Text>
      <Text style={styles.body} numberOfLines={2}>
        {data.path}
      </Text>
      {data.continuedAgentId ? (
        <Text style={styles.hint}>Continued in agent {data.continuedAgentId}</Text>
      ) : (
        <Text style={styles.hint}>Use the Baton pill in the composer to continue.</Text>
      )}
    </View>
  );
}