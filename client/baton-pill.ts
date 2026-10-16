import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { OPEN_AGENT_SCREEN_ID } from "./open-agent";
import { BATON_WRITER_LABEL, batonRowSchema, continueHandoffRpc, createNowRpc, setEnabledRpc, wakeRpc } from "../shared/baton";

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
  registerHandoff(info: BatonHandoffInfo): void;
  refresh(): Promise<void>;
  dispose(): void;
}

export function createBatonPills({ client }: BatonPillsDeps): BatonPillsHandle {
  const pills = new Map<string, PluginButtonRegistration>();
  const subscriptions = new Map<string, () => void>();
  const infoByAgent = new Map<string, BatonHandoffInfo>();
  const tracked = new Map<string, TrackedAgent>();
  const disabled = new Set<string>();
  const writing = new Set<string>();
  let ignoredWorkspaces: Record<string, "workspace" | "project"> = {};
  const controller = new AbortController();

  function removePill(agentId: string): void {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    infoByAgent.delete(agentId);
    tracked.delete(agentId);
    disabled.delete(agentId);
    writing.delete(agentId);
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
    return {
      title: "Baton",
      icon: isDisabled || ignoredBy ? ("Pause" as const) : ("Play" as const),
      label: "Baton",
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
      .then(({ handoffs, disabledAgentIds, writingAgentIds, ignoredWorkspaces: ignored }) => {
        ignoredWorkspaces = ignored;
        const ready = new Map(handoffs.map((info) => [info.agentId, info]));
        disabled.clear();
        for (const id of disabledAgentIds) disabled.add(id);
        writing.clear();
        for (const id of writingAgentIds) writing.add(id);
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
        if (!parsed.success) return;
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
    registerHandoff(info: BatonHandoffInfo): void {
      registerPill(info);
    },
    refresh,
    dispose(): void {
      controller.abort();
      for (const agentId of [...subscriptions.keys()]) releaseSubscription(agentId);
      for (const agentId of [...pills.keys()]) removePill(agentId);
    },
  };
}