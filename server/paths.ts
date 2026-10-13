import os from "node:os";
import path from "node:path";
import { HANDOFF_REL_DIR } from "../shared/baton";

export function resolveDaemonHome(): string {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

export function resolveDataDir(home: string): string {
  return path.join(home, "paseo-baton");
}

export function resolveStateFile(dataDir: string): string {
  return path.join(dataDir, "baton-state.json");
}

export function handoffFileName(agentId: string): string {
  return `${agentId}.md`;
}

export function handoffDirFor(workspaceDir: string): string {
  return path.join(workspaceDir, HANDOFF_REL_DIR);
}

export function handoffPathFor(workspaceDir: string, agentId: string): string {
  return path.join(handoffDirFor(workspaceDir), handoffFileName(agentId));
}