import { promises as fs } from "node:fs";
import path from "node:path";
import { defineAgentTool, type AgentToolDefinition, type AgentToolResult, type PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";
import { BATON_WRITER_LABEL, type BatonSettings } from "../shared/baton";
import { handoffDirFor, handoffPathForName, isHandoffFileName } from "./paths";

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
    names.filter(isHandoffFileName).map(async (name): Promise<HandoffFileInfo | null> => {
      try {
        const stat = await fs.stat(path.join(dir, name));
        return { name, modified: stat.mtime.toISOString() };
      } catch {
        // Removed between listing the folder and reading the file; leave it out.
        return null;
      }
    }),
  );
  return files
    .filter((file): file is HandoffFileInfo => file !== null)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function batonAgentTools(readSettings: () => Promise<ReadToolSettings>): AgentToolDefinition[] {
  // Runs a tool only while the setting is on, against the handoff folder for the agent's workspace.
  async function inHandoffDir(cwd: string, run: (dir: string) => Promise<AgentToolResult>): Promise<AgentToolResult> {
    const settings = await readSettings();
    if (!settings.agentReadTools) return { isError: true, text: "Baton's handoff tools are turned off in Baton settings." };
    return run(handoffDirFor(cwd, settings.handoffDirectory));
  }

  return [
    defineAgentTool({
      name: "baton_list_handoffs",
      title: "List handoffs",
      description:
        "List the handoff documents saved for this agent's workspace, newest first. Pass a name from the list to baton_read_handoff.",
      input: z.object({}),
      async execute(_input, { agent }) {
        return inHandoffDir(agent.cwd, async (dir) => {
          const files = await listHandoffFiles(dir);
          if (files.length === 0) return { text: "No handoffs are saved for this workspace." };
          return { text: files.map((file) => `${file.name} (saved ${file.modified})`).join("\n") };
        });
      },
    }),
    defineAgentTool({
      name: "baton_read_handoff",
      title: "Read handoff",
      description: "Read one handoff document for this agent's workspace, by a file name from baton_list_handoffs.",
      input: z.object({ file: z.string().min(1).describe("A file name from baton_list_handoffs, such as <agentId>.md") }),
      async execute({ file }, { agent }) {
        return inHandoffDir(agent.cwd, async (dir) => {
          // Rejects anything with a directory part, so the tool cannot read arbitrary files.
          const full = handoffPathForName(dir, file);
          if (!full) return { isError: true, text: "That is not a handoff file for this workspace." };
          let text: string;
          try {
            text = await fs.readFile(full, "utf8");
          } catch {
            return { isError: true, text: "That handoff no longer exists." };
          }
          if (text.length <= MAX_READ_CHARS) return { text };
          return { text: `${text.slice(0, MAX_READ_CHARS)}\n\n[Truncated: showing the first ${MAX_READ_CHARS} characters.]` };
        });
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
