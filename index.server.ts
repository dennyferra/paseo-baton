import type { PluginServerContext } from "@getpaseo/plugin/server";
import { attachBatonTools } from "./server/agent-tools";
import { BatonController } from "./server/controller";
import { resolveDaemonHome, resolveDataDir } from "./server/paths";
import { batonSettings, archiveAgentRpc, continueHandoffRpc, createNowRpc, createThresholdHandoffRpc, getContextThresholdRpc, openHandoffRpc, readHandoffRpc, setContextThresholdRpc, setEnabledRpc, wakeRpc } from "./shared/baton";

export default function contribute(server: PluginServerContext) {
  const dataDir = resolveDataDir(resolveDaemonHome());
  const settings = server.registerSettings(batonSettings);
  const controller = new BatonController({
    dataDir,
    settings,
    log: (message) => console.log(`[baton] ${message}`),
  });

  server.addHook("agent.open.before", async ({ request }) => {
    controller.onSessionOpened(request.agentId, request.reason, request.purpose);
    return attachBatonTools(request, () => controller.readSettings());
  });

  server.addHook("agent.turn.before", async (event) => {
    controller.onTurnStarted(event.agent);
  });

  server.addHook("agent.turn.after", async (event, context) => {
    void controller
      .onTurnEnded(event.agent, event.timeline, context.paseo)
      .catch((error: unknown) => console.error(`[baton] turn.after failed: ${String(error)}`));
  });

  server.addHook("agent.close.after", async (event) => {
    controller.onClosed(event.agent);
  });

  server.addHook("agent.archive.after", async (event) => {
    controller.onArchived(event.agent);
  });

  server.handle(continueHandoffRpc, (input, context) =>
    controller.continue(input, context.paseo),
  );

  server.handle(archiveAgentRpc, (input, context) => controller.archive(input, context.paseo));

  server.handle(openHandoffRpc, (input, context) =>
    controller.openHandoff(input.path, context.paseo),
  );

  server.handle(readHandoffRpc, (input, context) => controller.readHandoff(input.path, context.paseo));

  server.handle(createNowRpc, (input, context) => controller.createNow(input, context.paseo));

  server.handle(setEnabledRpc, (input, context) => controller.setEnabled(input, context.paseo));

  server.handle(setContextThresholdRpc, (input) => controller.setContextThreshold(input.agentId, input.percent));

  server.handle(getContextThresholdRpc, (input) => controller.getContextThreshold(input.agentId));

  server.handle(createThresholdHandoffRpc, (input, context) => controller.createThresholdHandoff(input, context.paseo));

  server.handle(wakeRpc, async (input, context) => {
    try {
      return await controller.wake(context.paseo, input.workspaceIds);
    } catch (error: unknown) {
      console.error(`[baton] wake failed: ${String(error)}`);
      return { recovered: false, handoffs: [], disabledAgentIds: [], writingAgentIds: [], ignoredWorkspaces: {}, contextPercents: {} };
    }
  });

  console.log(`[baton] running; data dir: ${dataDir}`);

  return () => controller.dispose();
}