import { promises as fs } from "node:fs";
import path from "node:path";
import { defineAgentTool, type AgentToolDefinition, type PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";
import { BATON_WRITER_LABEL, type BatonSettings } from "../shared/baton";
import { handoffDirFor } from "./paths";

/** Longest handoff returned to an agent, so one read cannot flood its context. */
const MAX_READ_CHARS = 40_000;

type ReadToolSettings = Pick<BatonSettings, "agentReadTools" | "handoffDirectory">;

export interface HandoffFileInfo {
  name: string;
  modified: string;
}

/** Lists the handoff files in a directory, newest first. A missing directory has no handoffs. */
export async function listHandoffFiles(dir: string): Promise<HandoffFileInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => {
        const stat = await fs.stat(path.join(dir, name));
        return { name, modified: stat.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Maps a file name from baton_list_handoffs to a path inside the handoff directory.
 * Rejects anything with a directory part, so the tools cannot read arbitrary files.
 */
export function resolveHandoffFile(dir: string, file: string): string | null {
  if (file !== path.basename(file) || !file.endsWith(".md") || file.startsWith(".")) return null;
  return path.join(dir, file);
}

const DISABLED_TEXT = "Baton's handoff tools are turned off in Baton settings.";

export function batonAgentTools(readSettings: () => Promise<ReadToolSettings>): AgentToolDefinition[] {
  const dirFor = async (cwd: string): Promise<string | null> => {
    const settings = await readSettings();
    if (!settings.agentReadTools) return null;
    return handoffDirFor(cwd, settings.handoffDirectory);
  };

  return [
    defineAgentTool({
      name: "baton_list_handoffs",
      title: "List handoffs",
      description:
        "List the handoff documents saved for this agent's workspace, newest first. Pass a name from the list to baton_read_handoff.",
      input: z.object({}),
      async execute(_input, { agent }) {
        const dir = await dirFor(agent.cwd);
        if (!dir) return { isError: true, text: DISABLED_TEXT };
        const files = await listHandoffFiles(dir);
        if (files.length === 0) return { text: "No handoffs are saved for this workspace." };
        return { text: files.map((file) => `${file.name} (saved ${file.modified})`).join("\n") };
      },
    }),
    defineAgentTool({
      name: "baton_read_handoff",
      title: "Read handoff",
      description: "Read one handoff document for this agent's workspace, by a file name from baton_list_handoffs.",
      input: z.object({ file: z.string().min(1).describe("A file name from baton_list_handoffs, such as <agentId>.md") }),
      async execute({ file }, { agent }) {
        const dir = await dirFor(agent.cwd);
        if (!dir) return { isError: true, text: DISABLED_TEXT };
        const full = resolveHandoffFile(dir, file);
        if (!full) return { isError: true, text: "That is not a handoff file for this workspace." };
        let text: string;
        try {
          text = await fs.readFile(full, "utf8");
        } catch {
          return { isError: true, text: "That handoff no longer exists." };
        }
        if (text.length <= MAX_READ_CHARS) return { text };
        return { text: `${text.slice(0, MAX_READ_CHARS)}\n\n[Truncated: showing the first ${MAX_READ_CHARS} characters.]` };
      },
    }),
  ];
}

/**
 * Adds the read tools to an interactive agent's session when the setting is on.
 * Handoff writers and history sessions never get them.
 */
export async function attachBatonTools(
  request: PluginSessionOpenRequest,
  readSettings: () => Promise<ReadToolSettings>,
): Promise<PluginSessionOpenRequest | undefined> {
  if (request.purpose !== "interactive" || request.labels[BATON_WRITER_LABEL]) return undefined;
  if (!(await readSettings()).agentReadTools) return undefined;
  return { ...request, tools: [...request.tools, ...batonAgentTools(readSettings)] };
}
