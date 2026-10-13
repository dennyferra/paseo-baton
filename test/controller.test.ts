import { describe, expect, it } from "vitest";
import type { BatonStoreIo } from "../server/store";
import { BatonController } from "../server/controller";
import { batonStateSchema } from "../shared/baton";

const NOW = 1_000_000;
const HANDOFF_PATH = "/work/.paseo/handoffs/agent-a.md";

function memoryIo(initial: Record<string, string> = {}): BatonStoreIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async mkdir() {},
    async readFile(file) {
      const value = files.get(file);
      if (value === undefined) {
        const error = new Error(`ENOENT: ${file}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    async writeFile(file, data) {
      files.set(file, data);
    },
    async rename(from, to) {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    async unlink(file) {
      files.delete(file);
    },
    async exists(file) {
      return files.has(file);
    },
  };
}

function settings(values = { idleTtlMinutes: 5 }) {
  return {
    read: async () => ({ status: "ready" as const, revision: "r", values }),
    subscribe: () => () => {},
  };
}

function stubPaseo() {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const agents: Array<{ id: string; status: string; provider: string; workspaceId: string }> = [
    { id: "agent-a", status: "idle", provider: "claude", workspaceId: "wks-a" },
  ];
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      ref: (agentId: string) => ({
        refresh: async () => {
          const agent = agents.find((a) => a.id === agentId);
          return agent ? { agent } : null;
        },
        send: async () => {
          calls.push(`send:${agentId}`);
        },
        timeline: {
          append: async () => {
            calls.push(`append:${agentId}`);
            return { seq: 1, epoch: "e" };
          },
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({ id: workspaceId, workspaceDirectory: "/work" }),
        agents: {
          create: async (options: Record<string, unknown>) => {
            calls.push(`create:${workspaceId}`);
            created.push(options);
            return { id: "agent-continued", ...options };
          },
        },
      }),
    },
  };
  return { paseo, calls, created };
}

const STATE_FILE = "/home/.paseo/paseo-baton/baton-state.json";

function doneEntry() {
  return {
    agentId: "agent-a",
    workspaceId: "wks-a",
    cwd: "/work",
    idleSince: NOW,
    fireAt: NOW + 1000,
    deadline: NOW + 5000,
    updatedAt: NOW + 5000,
    status: "done" as const,
    path: HANDOFF_PATH,
  };
}

describe("BatonController", () => {
  it("creates a pending entry on turn_ended and persists it", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/paseo-baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded(
      { id: "agent-a", workspaceId: "wks-a", cwd: "/work" },
      [],
      paseo as never,
    );
    const state = await batonStateSchema.parseAsync(
      JSON.parse(io.files.get(STATE_FILE) ?? "{}"),
    );
    const entry = state["agent-a"];
    expect(entry).toBeDefined();
    expect(entry.status).toBe("pending");
    expect(entry.workspaceId).toBe("wks-a");
    expect(entry.deadline).toBe(NOW + 5 * 60 * 1000);
    controller.dispose();
  });

  it("drops the pending entry on turn_started", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/paseo-baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work" }, [], paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"]).toBeUndefined();
  });

  it("keeps a done entry across recovery and continues it into a new agent", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nFix the bug.\n\n# Current state\n\nAlmost there.",
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/paseo-baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, calls, created } = stubPaseo();
    const result = await controller.continue(
      { agentId: "agent-a", path: HANDOFF_PATH },
      paseo as never,
    );
    expect(result.agentId).toBe("agent-continued");
    expect(result.title).toContain("Fix the bug");
    expect(created[0].title).toBe("[Handoff] Fix the bug.");
    expect(created[0].prompt).toContain(HANDOFF_PATH);
    expect(calls).toContain("append:agent-a");
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].continuedAgentId).toBe("agent-continued");
  });

  it("rejects continue when no handoff is done", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/paseo-baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await expect(controller.continue({ agentId: "agent-a", path: HANDOFF_PATH }, paseo as never)).rejects.toThrow(
      "No handoff is ready",
    );
    await controller.dispose();
  });
});