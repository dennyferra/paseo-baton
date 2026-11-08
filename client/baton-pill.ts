import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { OPEN_AGENT_SCREEN_ID } from "./open-agent";
import { BATON_WRITER_LABEL, batonRowSchema, continueHandoffRpc, createNowRpc, getContextThresholdRpc, setContextThresholdRpc, setEnabledRpc, wakeRpc } from "../shared/baton";

export interface BatonHandoffInfo {
  agentId: string;
  workspaceId: string;
  path: string;
  continuedAgentId?: string;
}

export interface AgentLike {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: string;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
}

interface TrackedAgent {
  workspaceId: string;
  status: string | undefined;
}

export interface BatonPillsDeps {
  client: PluginClientContext;
}

export interface BatonPillsHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * A threshold menu label: the percent, with the token count it stands for when the agent's maximum is known.
 * Without a reported maximum the per-agent override does not apply, so the label stays a bare percent.
 */
function thresholdTitle(percent: number, maxTokens: number | undefined): string {
  if (maxTokens === undefined) return `${percent}%`;
  const tokens = Math.round((maxTokens * percent) / 100);
  return `${percent}% · ${tokens.toLocaleString("en-US")} tokens`;
}

export function createBatonPills({ client }: BatonPillsDeps): BatonPillsHandle {
  const pills = new Map<string, PluginButtonRegistration>();
  const subscriptions = new Map<string, () => void>();
  const infoByAgent = new Map<string, BatonHandoffInfo>();
  const tracked = new Map<string, TrackedAgent>();
  const disabled = new Set<string>();
  const writing = new Set<string>();
  const contextPercents = new Map<string, number>();
  // The context maximum, in tokens, that Paseo reported per agent. Agents without one have no entry.
  const contextLimits = new Map<string, number>();
  const thresholdOverrides = new Map<string, number | null>();
  let ignoredWorkspaces: Record<string, "workspace" | "project"> = {};
  const controller = new AbortController();

  function removePill(agentId: string): void {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    infoByAgent.delete(agentId);
    tracked.delete(agentId);
    disabled.delete(agentId);
    writing.delete(agentId);
    contextPercents.delete(agentId);
    contextLimits.delete(agentId);
    thresholdOverrides.delete(agentId);
  }

  function releaseSubscription(agentId: string): void {
    const release = subscriptions.get(agentId);
    if (release) release();
    subscriptions.delete(agentId);
  }

  function buildButton(agentId: string) {
    const info = infoByAgent.get(agentId);
    const isDisabled = disabled.has(agentId);
    const ignoredBy = ignoredWorkspaces[tracked.get(agentId)?.workspaceId ?? ""];
    const percent = contextPercents.get(agentId);
    // The chip carries the last reported percentage, updated at turn end. It
    // has no colour states; "Baton" alone means no usage has been reported.
    const chipLabel = percent === undefined ? "Baton" : `Baton ${Math.round(percent)}%`;
    const override = thresholdOverrides.get(agentId) ?? null;
    return {
      title: "Baton",
      icon: isDisabled || ignoredBy ? ("Pause" as const) : ("Play" as const),
      label: chipLabel,
      behavior: {
        kind: "menu" as const,
        items: [
          {
            kind: "item" as const,
            id: "continue",
            title: "Continue from handoff",
            icon: "Play" as const,
            visible: Boolean(info),
            behavior: {
              kind: "action" as const,
              onPress(): void {
                if (!info) return;
                void client
                  .rpc(continueHandoffRpc, { agentId, path: info.path })
                  .then(({ agentId: newAgentId }) => {
                    client.openScreen({ screenId: OPEN_AGENT_SCREEN_ID, params: { agentId: newAgentId } });
                  })
                  .catch((error: unknown) => {
                    console.error(`[baton] continue failed: ${String(error)}`);
                  });
              },
            },
          },
          {
            kind: "item" as const,
            id: "create-now",
            title: writing.has(agentId) ? "Creating handoff..." : "Create handoff now",
            icon: "Play" as const,
            visible: !ignoredBy,
            // Needs a working, idle session with no handoff yet and automatic handoffs on.
            disabled: Boolean(info) || isDisabled || writing.has(agentId) || tracked.get(agentId)?.status !== "idle",
            behavior: {
              kind: "action" as const,
              onPress(): void {
                void client
                  .rpc(createNowRpc, { agentId })
                  .then(() => refresh())
                  .catch((error: unknown) => {
                    console.error(`[baton] create handoff failed: ${String(error)}`);
                  });
              },
            },
          },
          ignoredBy
            ? {
                kind: "item" as const,
                id: "ignored",
                title: `Handoff is off: this ${ignoredBy} is ignored in Baton settings`,
                icon: "Pause" as const,
                disabled: true,
                behavior: { kind: "action" as const, onPress(): void {} },
              }
            : {
                kind: "item" as const,
                id: "toggle",
                title: isDisabled ? "Turn on handoff for this session" : "Turn off handoff for this session",
                icon: isDisabled ? ("Play" as const) : ("Pause" as const),
                // Once a handoff exists there is nothing left to turn off.
                disabled: !isDisabled && Boolean(info),
                behavior: {
                  kind: "action" as const,
                  onPress(): void {
                    void client
                      .rpc(setEnabledRpc, { agentId, enabled: isDisabled })
                      .then(() => refresh())
                      .catch((error: unknown) => {
                        console.error(`[baton] toggle failed: ${String(error)}`);
                      });
                  },
                },
              },
          // Per-agent threshold override; "Use global threshold" clears it.
          {
            kind: "item" as const,
            id: "set-threshold",
            title: override === null ? "Set context threshold" : `Context threshold: ${override}%`,
            icon: "Play" as const,
            visible: !ignoredBy,
            behavior: {
              kind: "menu" as const,
              items: [
                ...[20, 30, 40, 50, 60, 70, 80, 90].map((percent) => ({
                  kind: "item" as const,
                  id: `threshold-${percent}`,
                  title: thresholdTitle(percent, contextLimits.get(agentId)),
                  behavior: {
                    kind: "action" as const,
                    onPress(): void {
                      void client
                        .rpc(setContextThresholdRpc, { agentId, percent })
                        .then(() => {
                          thresholdOverrides.set(agentId, percent);
                          syncPill(agentId);
                          void refresh();
                        })
                        .catch((error: unknown) => {
                          console.error(`[baton] set context threshold failed: ${String(error)}`);
                        });
                    },
                  },
                })),
                {
                  kind: "item" as const,
                  id: "threshold-global",
                  title: "Use global threshold",
                  visible: override !== null,
                  behavior: {
                    kind: "action" as const,
                    onPress(): void {
                      void client
                        .rpc(setContextThresholdRpc, { agentId, percent: null })
                        .then(() => {
                          thresholdOverrides.set(agentId, null);
                          syncPill(agentId);
                          void refresh();
                        })
                        .catch((error: unknown) => {
                          console.error(`[baton] clear context threshold failed: ${String(error)}`);
                        });
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }

  function syncPill(agentId: string): void {
    const agent = tracked.get(agentId);
    if (!agent) return;
    const button = buildButton(agentId);
    const existing = pills.get(agentId);
    if (existing) {
      existing.update(button);
      return;
    }
    pills.set(
      agentId,
      client.addComposerPill({ id: "baton", workspaceId: agent.workspaceId, agentId, button }),
    );
  }

  function registerPill(info: BatonHandoffInfo): void {
    infoByAgent.set(info.agentId, info);
    writing.delete(info.agentId);
    if (!tracked.has(info.agentId)) tracked.set(info.agentId, { workspaceId: info.workspaceId, status: undefined });
    syncPill(info.agentId);
  }

  let refreshing: Promise<void> | null = null;
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = client
      .rpc(wakeRpc, { workspaceIds: [...new Set([...tracked.values()].map((agent) => agent.workspaceId))] })
      .then(({ handoffs, disabledAgentIds, writingAgentIds, ignoredWorkspaces: ignored, contextPercents: percents, contextLimits: limits }) => {
        ignoredWorkspaces = ignored;
        const ready = new Map(handoffs.map((info) => [info.agentId, info]));
        disabled.clear();
        for (const id of disabledAgentIds) disabled.add(id);
        writing.clear();
        for (const id of writingAgentIds) writing.add(id);
        // The chip needs each agent's last percentage; the round-trip also
        // refreshes a cached per-agent threshold override on first sight.
        for (const [agentId, percent] of Object.entries(percents ?? {})) contextPercents.set(agentId, percent);
        for (const [agentId, tokens] of Object.entries(limits ?? {})) contextLimits.set(agentId, tokens);
        for (const agentId of tracked.keys()) {
          if (!thresholdOverrides.has(agentId)) {
            void client
              .rpc(getContextThresholdRpc, { agentId })
              .then(({ percent }) => {
                thresholdOverrides.set(agentId, percent);
                syncPill(agentId);
              })
              .catch((error: unknown) => {
                console.error(`[baton] get context threshold failed: ${String(error)}`);
              });
          }
        }
        for (const agentId of tracked.keys()) {
          const info = ready.get(agentId);
          if (info) infoByAgent.set(agentId, info);
          else infoByAgent.delete(agentId);
          syncPill(agentId);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        console.error(`[baton] refresh failed: ${String(error)}`);
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function observeAgent(agent: AgentLike): void {
    if (!agent.workspaceId || agent.archivedAt) return;
    if (agent.parentAgentId || agent.labels?.[BATON_WRITER_LABEL]) return;
    const known = tracked.get(agent.id);
    if (known) {
      // A status change (e.g. a new turn) can add or clear a handoff, so re-read the state.
      if (known.status !== agent.status) {
        known.status = agent.status;
        void refresh();
      }
      return;
    }
    tracked.set(agent.id, { workspaceId: agent.workspaceId, status: agent.status });
    syncPill(agent.id);
    void refresh();
    if (subscriptions.has(agent.id)) return;
    let release: () => void;
    try {
      release = client.paseo.agents.ref(agent.id).timeline.subscribe((stream) => {
        if (stream.event.type !== "timeline") return;
        const item = stream.event.item;
        if (item.type !== "plugin" || item.kind !== "baton-ready") return;
        const parsed = batonRowSchema.safeParse(item.data);
        // A threshold prompt has no path: there is no handoff file to show or continue yet.
        if (!parsed.success || parsed.data.path === undefined) return;
        registerPill({
          agentId: agent.id,
          workspaceId: agent.workspaceId ?? "",
          path: parsed.data.path,
          continuedAgentId: parsed.data.continuedAgentId,
        });
      });
    } catch (error: unknown) {
      console.error(`[baton] timeline subscription failed: ${String(error)}`);
      return;
    }
    subscriptions.set(agent.id, release);
  }

  function cleanupAgent(agentId: string): void {
    removePill(agentId);
    releaseSubscription(agentId);
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: controller.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) observeAgent(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "upsert") observeAgent(payload.agent);
          else cleanupAgent(payload.agentId);
        },
        error: (error: unknown) => {
          console.error(`[baton] agent observation failed: ${String(error)}`);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.error(`[baton] agent observation failed: ${String(error)}`);
      }
    });

  return {
    refresh,
    dispose(): void {
      controller.abort();
      for (const agentId of [...subscriptions.keys()]) releaseSubscription(agentId);
      for (const agentId of [...pills.keys()]) removePill(agentId);
    },
  };
}