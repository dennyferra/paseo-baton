import os from "node:os";
import path from "node:path";
import { HANDOFF_REL_DIR } from "../shared/baton";

export function resolveDaemonHome(): string {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

export function resolveDataDir(home: string): string {
  return path.join(home, "plugin-data", "baton");
}

export function resolveStateFile(dataDir: string): string {
  return path.join(dataDir, "baton-state.json");
}

/** The folder where writer prompts are kept when prompt saving is on. */
export function writerPromptDir(dataDir: string): string {
  return path.join(dataDir, "writer-prompts");
}

/** Where the writer's prompt is kept for one agent when prompt saving is on. */
export function writerPromptFile(dataDir: string, agentId: string): string {
  return path.join(writerPromptDir(dataDir), `${agentId}.md`);
}

export function handoffFileName(agentId: string): string {
  return `${agentId}.md`;
}

/**
 * Where handoffs for a workspace go: `<workspace>/.paseo/handoffs` by default, or the user's custom
 * directory. A custom path may start with `~`, be absolute, or be relative to the workspace.
 */
export function handoffDirFor(workspaceDir: string, customDir = ""): string {
  const custom = customDir.trim();
  if (!custom) return path.join(workspaceDir, HANDOFF_REL_DIR);
  if (custom === "~" || custom.startsWith("~/") || custom.startsWith("~\\")) {
    return path.join(os.homedir(), custom.slice(1));
  }
  return path.resolve(workspaceDir, custom);
}

export function handoffPathFor(workspaceDir: string, agentId: string, customDir = ""): string {
  return path.join(handoffDirFor(workspaceDir, customDir), handoffFileName(agentId));
}