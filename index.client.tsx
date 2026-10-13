import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBatonPills } from "./client/baton-pill";
import { BatonRow, setOpenHandoff } from "./client/baton-row";
import { batonRowSchema, openHandoffRpc, wakeRpc } from "./shared/baton";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "baton-ready",
    version: 1,
    schema: batonRowSchema,
    Component: BatonRow,
  });

  setOpenHandoff((path) => client.rpc(openHandoffRpc, { path }));

  const pills = createBatonPills({ client });

  void client
    .rpc(wakeRpc, {})
    .then(({ handoffs }) => {
      for (const info of handoffs) pills.registerHandoff(info);
    })
    .catch((error: unknown) => {
      console.error(`[baton] wake failed: ${String(error)}`);
    });

  return () => {
    pills.dispose();
  };
}