import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BatonController } from "./server/controller";
import { resolveDaemonHome, resolveDataDir } from "./server/paths";
import { batonSettings, continueHandoffRpc, createNowRpc, openHandoffRpc, readHandoffRpc, setEnabledRpc, wakeRpc } from "./shared/baton";

export default function contribute(server: PluginServerContext) {
  const dataDir = resolveDataDir(resolveDaemonHome());
  const settings = server.registerSettings(batonSettings);
  const controller = new BatonController({
    dataDir,
    settings,
    log: (message) => console.log(`[baton] ${message}`),
  });

  server.on("agent.turn_started", (event) => {
    controller.onTurnStarted(event.agent);
  });

  server.on("agent.turn_ended", (event, context) => {
    void controller
      .onTurnEnded(event.agent, event.timeline, context.paseo)
      .catch((error: unknown) => console.error(`[baton] turn_ended failed: ${String(error)}`));
  });

  server.on("agent.closed", (event) => {
    controller.onClosed(event.agent);
  });

  server.on("agent.archived", (event) => {
    controller.onArchived(event.agent);
  });

  server.handle(continueHandoffRpc, (input, context) =>
    controller.continue(input, context.paseo),
  );

  server.handle(openHandoffRpc, (input, context) =>
    controller.openHandoff(input.path, context.paseo),
  );

  server.handle(readHandoffRpc, (input, context) => controller.readHandoff(input.path, context.paseo));

  server.handle(createNowRpc, (input, context) => controller.createNow(input, context.paseo));

  server.handle(setEnabledRpc, (input, context) => controller.setEnabled(input, context.paseo));

  server.handle(wakeRpc, async (input, context) => {
    try {
      return await controller.wake(context.paseo, input.workspaceIds);
    } catch (error: unknown) {
      console.error(`[baton] wake failed: ${String(error)}`);
      return { recovered: false, handoffs: [], disabledAgentIds: [], writingAgentIds: [], ignoredWorkspaces: {} };
    }
  });

  console.log(`[baton] running; data dir: ${dataDir}`);

  return () => controller.dispose();
}