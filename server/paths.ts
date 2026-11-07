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

export function resolveContextStateFile(dataDir: string): string {
  return path.join(dataDir, "baton-context-state.json");
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

/** A markdown file name that can name a handoff: not hidden, and with no directory part. */
export function isHandoffFileName(name: string): boolean {
  return name === path.basename(name) && name.endsWith(".md") && !name.startsWith(".");
}

/** The path of a handoff file name inside a handoff directory, or null when the name is not one. */
export function handoffPathForName(dir: string, name: string): string | null {
  return isHandoffFileName(name) ? path.join(dir, name) : null;
}

/** True when `filePath` is exactly the agent's own handoff file for that workspace and storage setting. */
export function isAgentHandoffPath(filePath: string, agentId: string, workspaceDir: string, customDir = ""): boolean {
  return path.resolve(filePath) === path.resolve(handoffPathFor(workspaceDir, agentId, customDir));
}