import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBatonPills } from "./client/baton-pill";
import { BatonRow } from "./client/baton-row";
import { batonRowSchema, wakeRpc } from "./shared/baton";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "baton-ready",
    version: 1,
    schema: batonRowSchema,
    Component: BatonRow,
  });

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