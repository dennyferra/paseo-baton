import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { batonRowSchema, continueHandoffRpc } from "../shared/baton";

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
}

export interface BatonPillsDeps {
  client: PluginClientContext;
}

export interface BatonPillsHandle {
  registerHandoff(info: BatonHandoffInfo): void;
  dispose(): void;
}

export function createBatonPills({ client }: BatonPillsDeps): BatonPillsHandle {
  const pills = new Map<string, PluginButtonRegistration>();
  const subscriptions = new Map<string, () => void>();
  const infoByAgent = new Map<string, BatonHandoffInfo>();
  const controller = new AbortController();

  function removePill(agentId: string): void {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    infoByAgent.delete(agentId);
  }

  function releaseSubscription(agentId: string): void {
    const release = subscriptions.get(agentId);
    if (release) release();
    subscriptions.delete(agentId);
  }

  function registerPill(info: BatonHandoffInfo): void {
    infoByAgent.set(info.agentId, info);
    const button = {
      title: "Continue from handoff",
      icon: "Play" as const,
      label: "Continue",
      behavior: {
        kind: "action" as const,
        onPress(): void {
          void client
            .rpc(continueHandoffRpc, { agentId: info.agentId, path: info.path })
            .catch((error: unknown) => {
              console.error(`[baton] continue failed: ${String(error)}`);
            });
        },
      },
    };
    const existing = pills.get(info.agentId);
    if (existing) {
      existing.update(button);
      return;
    }
    pills.set(
      info.agentId,
      client.addComposerPill({
        id: "baton-continue",
        workspaceId: info.workspaceId,
        agentId: info.agentId,
        button,
      }),
    );
  }

  function observeAgent(agent: AgentLike): void {
    if (!agent.workspaceId || agent.archivedAt) return;
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
    dispose(): void {
      controller.abort();
      for (const agentId of [...subscriptions.keys()]) releaseSubscription(agentId);
      for (const agentId of [...pills.keys()]) removePill(agentId);
    },
  };
}