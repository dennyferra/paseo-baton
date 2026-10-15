import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBatonPills } from "./client/baton-pill";
import { BatonRow, setOpenHandoff } from "./client/baton-row";
import { BatonSettingsScreen } from "./client/settings";
import { batonRowSchema, openHandoffRpc } from "./shared/baton";

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

  setOpenHandoff((path) => client.rpc(openHandoffRpc, { path }));

  const pills = createBatonPills({ client });

  void pills.refresh();

  return () => {
    pills.dispose();
  };
}