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

let continueHandoff: ((agentId: string, path: string) => Promise<unknown>) | null = null;

export function setContinueHandoff(continueFrom: (agentId: string, path: string) => Promise<unknown>): void {
  continueHandoff = continueFrom;
}

let createThresholdHandoff: ((agentId: string, continueAfter: boolean) => Promise<unknown>) | null = null;

export function setCreateThresholdHandoff(create: (agentId: string, continueAfter: boolean) => Promise<unknown>): void {
  createThresholdHandoff = create;
}

export function BatonRow({ item, theme, layout }: PluginTimelineItemProps<BatonRowData>) {
  const data = item.data;
  const [archiving, setArchiving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [creating, setCreating] = useState<null | "create" | "continue">(null);
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
      <Text style={styles.title}>
        {data.usedPercent !== undefined ? `Handoff (${Math.round(data.usedPercent)}% full)` : "Handoff saved"}
      </Text>
      {data.usedPercent !== undefined ? (
        <Text style={styles.hint}>This context is {Math.round(data.usedPercent)}% full. Create a handoff to continue in a fresh session.</Text>
      ) : null}
      {data.path !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review the handoff"
          onPress={() => {
            if (openHandoff && data.path !== undefined) void openHandoff(data.path).catch((error: unknown) => {
              console.error(`[baton] opening handoff failed: ${String(error)}`);
            });
          }}
        >
          <Text style={styles.path} numberOfLines={2}>
            {data.path}
          </Text>
        </Pressable>
      ) : null}
      {data.usedPercent !== undefined && !data.continuedAgentId ? (
        <View style={{ flexDirection: "row", gap: layout.compact ? 6 : 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create handoff"
            disabled={creating !== null}
            onPress={() => {
              if (!createThresholdHandoff || creating !== null) return;
              setCreating("create");
              void createThresholdHandoff(data.agentId, false).catch((error: unknown) => {
                setCreating(null);
                console.error(`[baton] create handoff failed: ${String(error)}`);
              });
            }}
          >
            <Text style={styles.path}>{creating === "create" ? "Creating..." : "Create handoff"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create and continue"
            disabled={creating !== null}
            onPress={() => {
              if (!createThresholdHandoff || creating !== null) return;
              setCreating("continue");
              void createThresholdHandoff(data.agentId, true).catch((error: unknown) => {
                setCreating(null);
                console.error(`[baton] create and continue failed: ${String(error)}`);
              });
            }}
          >
            <Text style={styles.path}>{creating === "continue" ? "Continuing..." : "Create and continue"}</Text>
          </Pressable>
        </View>
      ) : null}
      {data.savedAt ? <Text style={styles.hint}>Saved {new Date(data.savedAt).toLocaleString()}</Text> : null}
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
      ) : data.usedPercent === undefined && data.path !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue from this handoff"
          disabled={continuing}
          onPress={() => {
            if (!continueHandoff || continuing || data.path === undefined) return;
            setContinuing(true);
            void continueHandoff(data.agentId, data.path).catch((error: unknown) => {
              setContinuing(false);
              console.error(`[baton] continue failed: ${String(error)}`);
            });
          }}
        >
          <Text style={styles.path}>{continuing ? "Continuing..." : "Continue from this handoff"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}