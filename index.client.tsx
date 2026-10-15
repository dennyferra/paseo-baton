import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBatonPills } from "./client/baton-pill";
import { BatonRow, setOpenHandoff } from "./client/baton-row";
import { HANDOFF_VIEW_SCREEN_ID, HandoffViewScreen } from "./client/handoff-view";
import { OPEN_AGENT_SCREEN_ID, OpenAgentScreen } from "./client/open-agent";
import { BatonSettingsScreen } from "./client/settings";
import { batonRowSchema } from "./shared/baton";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "baton-ready",
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

  setOpenHandoff((path) => {
    client.openScreen({ screenId: HANDOFF_VIEW_SCREEN_ID, params: { path } });
    return Promise.resolve();
  });

  const pills = createBatonPills({ client });

  void pills.refresh();

  return () => {
    pills.dispose();
  };
}