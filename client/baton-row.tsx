import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { batonRowSchema } from "../shared/baton";

type BatonRowData = z.output<typeof batonRowSchema>;

/** What the rows can ask the plugin to do. The plugin supplies them once, when it loads. */
export interface BatonRowActions {
  openHandoff(path: string): Promise<unknown>;
  archiveAgent(agentId: string): Promise<unknown>;
  continueHandoff(agentId: string, path: string): Promise<unknown>;
  createThresholdHandoff(agentId: string, continueAfter: boolean): Promise<unknown>;
  openAgent(agentId: string): Promise<unknown>;
}

let actions: Partial<BatonRowActions> = {};

export function setBatonRowActions(next: Partial<BatonRowActions>): void {
  actions = next;
}

/** The catch for a row's action: logs the failure, so the row can carry on. */
function logFailure(action: string) {
  return (error: unknown) => {
    console.error(`[baton] ${action} failed: ${String(error)}`);
  };
}

export function BatonRow({ item, theme, layout }: PluginTimelineItemProps<BatonRowData>) {
  const data = item.data;
  const [archiving, setArchiving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [creating, setCreating] = useState<null | "create" | "continue">(null);
  // Set by this row's own "Create and continue". The new agent opens when the row reports it, and only then, so a
  // row that is merely re-read later does not open anything.
  const awaitingContinue = useRef(false);
  useEffect(() => {
    if (!awaitingContinue.current || !data.continuedAgentId) return;
    awaitingContinue.current = false;
    const open = actions.openAgent;
    if (open) void open(data.continuedAgentId).catch(logFailure("opening the continued agent"));
  }, [data.continuedAgentId]);
  // "Create handoff" and "Create and continue" share this. The button shows its phase until the write finishes.
  function runCreate(continueAfter: boolean): void {
    const create = actions.createThresholdHandoff;
    if (!create || creating !== null) return;
    setCreating(continueAfter ? "continue" : "create");
    awaitingContinue.current = continueAfter;
    void create(data.agentId, continueAfter)
      .then(() => setCreating(null))
      .catch((error: unknown) => {
        awaitingContinue.current = false;
        setCreating(null);
        logFailure(continueAfter ? "create and continue" : "create handoff")(error);
      });
  }
  // The percent of a threshold prompt still waiting on the user. Its two buttons stand until the handoff is written;
  // after that the row shows the outcome instead.
  const promptPercent =
    data.usedPercent !== undefined && !data.requested && !data.saved && !data.continuedAgentId ? data.usedPercent : undefined;
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
      {promptPercent !== undefined ? (
        <Text style={styles.hint}>This context is {Math.round(promptPercent)}% full. Create a handoff to continue in a fresh session.</Text>
      ) : null}
      {data.saved && !data.continuedAgentId ? (
        <Text style={styles.hint}>A handoff was saved for this context. It appears below.</Text>
      ) : null}
      {data.requested && !data.saved && !data.continuedAgentId ? (
        <Text style={styles.hint}>Handoff requested. It appears below when it is saved.</Text>
      ) : null}
      {data.path !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review the handoff"
          onPress={() => {
            const open = actions.openHandoff;
            const path = data.path;
            if (open && path !== undefined) void open(path).catch(logFailure("opening handoff"));
          }}
        >
          <Text style={styles.path} numberOfLines={2}>
            {data.path}
          </Text>
        </Pressable>
      ) : null}
      {promptPercent !== undefined ? (
        <View style={{ flexDirection: "row", gap: layout.compact ? 6 : 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create handoff"
            disabled={creating !== null}
            onPress={() => runCreate(false)}
          >
            <Text style={styles.path}>{creating === "create" ? "Creating..." : "Create handoff"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create and continue"
            disabled={creating !== null}
            onPress={() => runCreate(true)}
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
            {data.continuedAt ? ` at ${new Date(data.continuedAt).toLocaleString()}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open continued agent"
            onPress={() => {
              const target = data.continuedAgentId;
              const open = actions.openAgent;
              if (!open || !target) return;
              void open(target).catch(logFailure("opening the continued agent"));
            }}
          >
            <Text style={styles.path}>Open continued agent</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Archive this tab"
            disabled={archiving}
            onPress={() => {
              const archive = actions.archiveAgent;
              if (!archive || archiving) return;
              setArchiving(true);
              void archive(data.agentId).catch((error: unknown) => {
                setArchiving(false);
                logFailure("archive")(error);
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
            const continueFrom = actions.continueHandoff;
            if (!continueFrom || continuing || data.path === undefined) return;
            setContinuing(true);
            void continueFrom(data.agentId, data.path).catch((error: unknown) => {
              setContinuing(false);
              logFailure("continue")(error);
            });
          }}
        >
          <Text style={styles.path}>{continuing ? "Continuing..." : "Continue from this handoff"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}