import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { batonRowSchema } from "../shared/baton";

type BatonRowData = z.output<typeof batonRowSchema>;

let openHandoff: ((path: string) => Promise<unknown>) | null = null;

export function setOpenHandoff(open: (path: string) => Promise<unknown>): void {
  openHandoff = open;
}

let archiveAgent: ((agentId: string) => Promise<unknown>) | null = null;

export function setArchiveAgent(archive: (agentId: string) => Promise<unknown>): void {
  archiveAgent = archive;
}

export function BatonRow({ item, theme, layout }: PluginTimelineItemProps<BatonRowData>) {
  const data = item.data;
  const [archiving, setArchiving] = useState(false);
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
      path: {
        color: theme.colors.accent,
        fontSize: layout.compact ? 12 : 13,
        textDecorationLine: "underline" as const,
      },
      warning: {
        color: theme.colors.statusWarning,
        fontSize: layout.compact ? 12 : 13,
      },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Handoff saved</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Review the handoff"
        onPress={() => {
          if (openHandoff) void openHandoff(data.path).catch((error: unknown) => {
            console.error(`[baton] opening handoff failed: ${String(error)}`);
          });
        }}
      >
        <Text style={styles.path} numberOfLines={2}>
          {data.path}
        </Text>
      </Pressable>
      {data.notice ? <Text style={styles.warning}>{data.notice}</Text> : null}
      {data.continuedAgentId ? (
        <>
          <Text style={styles.hint}>
            Continued on {data.continuedTitle ? `"${data.continuedTitle}"` : `agent ${data.continuedAgentId}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Archive this tab"
            disabled={archiving}
            onPress={() => {
              if (!archiveAgent || archiving) return;
              setArchiving(true);
              void archiveAgent(data.agentId).catch((error: unknown) => {
                setArchiving(false);
                console.error(`[baton] archive failed: ${String(error)}`);
              });
            }}
          >
            <Text style={styles.path}>{archiving ? "Archiving..." : "Archive this tab"}</Text>
          </Pressable>
        </>
      ) : (
        <Text style={styles.hint}>Use the Baton chip in the composer to continue.</Text>
      )}
    </View>
  );
}