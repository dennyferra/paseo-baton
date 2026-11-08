import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBatonPills } from "./client/baton-pill";
import { BatonRow, setBatonRowActions } from "./client/baton-row";
import { HANDOFF_VIEW_SCREEN_ID, HandoffViewScreen } from "./client/handoff-view";
import { OPEN_AGENT_SCREEN_ID, OpenAgentScreen } from "./client/open-agent";
import { BatonSettingsScreen } from "./client/settings";
import { archiveAgentRpc, BATON_ROW_KIND, batonRowSchema, continueHandoffRpc, createThresholdHandoffRpc } from "./shared/baton";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: BATON_ROW_KIND,
    version: 1,
    schema: batonRowSchema,
    Component: BatonRow,
  });

  client.addSettingsScreen({
    id: "baton-settings",
    title: "Baton",
    icon: "Settings",
    Component: BatonSettingsScreen,
  });

  client.addScreen({
    id: OPEN_AGENT_SCREEN_ID,
    title: "Handoff agent",
    Component: OpenAgentScreen,
  });

  client.addScreen({
    id: HANDOFF_VIEW_SCREEN_ID,
    title: "Handoff",
    Component: HandoffViewScreen,
  });

  setBatonRowActions({
    openHandoff: (path) => {
      client.openScreen({ screenId: HANDOFF_VIEW_SCREEN_ID, params: { path } });
      return Promise.resolve();
    },
    archiveAgent: (agentId) => client.rpc(archiveAgentRpc, { agentId }),
    continueHandoff: (agentId, path) =>
      client.rpc(continueHandoffRpc, { agentId, path }).then(({ agentId: newAgentId }) => {
        client.openScreen({ screenId: OPEN_AGENT_SCREEN_ID, params: { agentId: newAgentId } });
      }),
    createThresholdHandoff: (agentId, shouldContinue) =>
      client.rpc(createThresholdHandoffRpc, { agentId, continue: shouldContinue }).then(() => undefined),
    openAgent: (agentId) => {
      client.openScreen({ screenId: OPEN_AGENT_SCREEN_ID, params: { agentId } });
      return Promise.resolve();
    },
  });

  const pills = createBatonPills({ client });

  void pills.refresh();

  return () => {
    pills.dispose();
  };
}