import { describe, expect, it } from "vitest";
import type { BatonStoreIo } from "../server/store";
import { BatonController } from "../server/controller";
import { batonStateSchema, type BatonSettings } from "../shared/baton";

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

function settings(overrides: Partial<BatonSettings> = {}) {
  const values: BatonSettings = {
    idleDelayMinutes: 15,
    handoffProfileId: "",
    handoffDirectory: "",
    deleteStaleHandoffs: true,
    ignoredWorkspaceIds: [],
    ignoredProjectIds: [],
    ...overrides,
  };
  return {
    read: async () => ({ status: "ready" as const, revision: "r", values }),
    subscribe: () => () => {},
  };
}

function stubPaseo(opts: { createId?: string } = {}) {
  const createId = opts.createId ?? "agent-continued";
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const agents: Array<{ id: string; status: string; provider: string; model: string | null; workspaceId: string }> = [
    { id: "agent-a", status: "idle", provider: "claude", model: "claude-sonnet-5-5", workspaceId: "wks-a" },
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
        archive: async () => {
          archived.push(agentId);
          calls.push(`archive:${agentId}`);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: {
          append: async () => {
            calls.push(`append:${agentId}`);
            return { seq: 1, epoch: "e" };
          },
        },
      }),
    },
    config: {
      get: async () => ({
        config: {
          agentProfiles: [
            { id: "profile-1", name: "Planner", provider: "claude", model: "claude-haiku-5-5", modeId: "plan", thinkingOptionId: "low" },
          ],
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({ id: workspaceId, projectId: "proj-1", workspaceDirectory: "/work" }),
        agents: {
          create: async (options: Record<string, unknown>) => {
            calls.push(`create:${workspaceId}`);
            created.push(options);
            return { id: createId, ...options };
          },
        },
      }),
    },
  };
  return { paseo, calls, created, archived };
}

const STATE_FILE = "/home/.paseo/plugin-data/baton/baton-state.json";

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
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded(
      { id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null },
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
    expect(entry.fireAt).toBe(NOW + 15 * 60 * 1000);
    controller.dispose();
  });

  it("drops the pending entry on turn_started", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"]).toBeUndefined();
  });

  function makeController(io: ReturnType<typeof memoryIo>) {
    return new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
  }

  it("skips idle handoffs while disabled for the session and resumes when re-enabled", async () => {
    const io = memoryIo();
    const controller = makeController(io);
    const { paseo } = stubPaseo();
    const agent = { id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null };
    await controller.setEnabled({ agentId: "agent-a", enabled: false }, paseo as never);
    await controller.onTurnEnded(agent, [], paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await controller.onTurnEnded(agent, [], paseo as never);
    let state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].status).toBe("disabled");
    expect((await controller.wake(paseo as never)).disabledAgentIds).toEqual(["agent-a"]);
    await controller.setEnabled({ agentId: "agent-a", enabled: true }, paseo as never);
    await controller.onTurnEnded(agent, [], paseo as never);
    state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].status).toBe("pending");
    await controller.dispose();
  });

  it("reports which workspaces are ignored by workspace or by project", async () => {
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({
        idleDelayMinutes: 15,
        handoffProfileId: "",
        ignoredWorkspaceIds: ["wks-a"],
        ignoredProjectIds: ["proj-1"],
      }),
      log: () => {},
      io: memoryIo(),
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    const result = await controller.wake(paseo as never, ["wks-a", "wks-b"]);
    expect(result.ignoredWorkspaces).toEqual({ "wks-a": "workspace", "wks-b": "project" });
    await controller.dispose();
  });

  it("refuses to disable once a handoff exists", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nx",
    });
    const controller = makeController(io);
    const { paseo } = stubPaseo();
    await expect(controller.setEnabled({ agentId: "agent-a", enabled: false }, paseo as never)).rejects.toThrow(
      "already exists",
    );
    await controller.dispose();
  });

  it("removes an uncontinued handoff when the original session resumes", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nx",
    });
    const controller = makeController(io);
    const { paseo } = stubPaseo();
    await controller.ensureRecovered(paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(io.files.has(HANDOFF_PATH)).toBe(false);
    await controller.dispose();
  });

  it("reads a saved handoff for review and rejects unknown paths", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nReview me",
    });
    const controller = makeController(io);
    const { paseo } = stubPaseo();
    expect(await controller.readHandoff(HANDOFF_PATH, paseo as never)).toEqual({ content: "# Task\n\nReview me" });
    await expect(controller.readHandoff("/etc/passwd", paseo as never)).rejects.toThrow("can no longer be opened");
    await controller.dispose();
  });

  it("keeps an uncontinued handoff on disk when deleting stale handoffs is off", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nx",
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ deleteStaleHandoffs: false }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.ensureRecovered(paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(io.files.has(HANDOFF_PATH)).toBe(true);
    await controller.dispose();
  });

  it("keeps a continued handoff when the original session resumes", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": { ...doneEntry(), continuedAgentId: "agent-b" } }),
      [HANDOFF_PATH]: "# Task\n\nx",
    });
    const controller = makeController(io);
    const { paseo } = stubPaseo();
    await controller.ensureRecovered(paseo as never);
    controller.onTurnStarted({ id: "agent-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(io.files.has(HANDOFF_PATH)).toBe(true);
    await controller.dispose();
  });

  it("keeps a done entry across recovery and continues it into a new agent", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nFix the bug.\n\n# Current state\n\nAlmost there.",
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
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
    expect(created[0].config).toEqual({ provider: "claude/claude-sonnet-5-5" });
    expect(calls).toContain("append:agent-a");
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].continuedAgentId).toBe("agent-continued");
  });

  it("rejects continue when no handoff is done", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
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

  it("opens only a known done handoff path", async () => {
    const opened: string[] = [];
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "# Task\n\nFix the bug.",
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
      openFile: async (filePath) => {
        opened.push(filePath);
      },
    });
    const { paseo } = stubPaseo();
    const result = await controller.openHandoff(HANDOFF_PATH, paseo as never);
    expect(result.opened).toBe(true);
    expect(opened).toEqual([HANDOFF_PATH]);
    await expect(controller.openHandoff("/etc/passwd", paseo as never)).rejects.toThrow("Unknown handoff path");
    expect(opened).toEqual([HANDOFF_PATH]);
    await controller.dispose();
  });

  it("schedules the handoff after the configured idle delay", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ idleDelayMinutes: 20, handoffProfileId: "", ignoredWorkspaceIds: [], ignoredProjectIds: [] }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    const entry = state["agent-a"];
    expect(entry.fireAt).toBe(NOW + 20 * 60 * 1000);
    await controller.dispose();
  });

  it("does not schedule handoffs for subagents or ignored workspaces", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ idleDelayMinutes: 15, handoffProfileId: "", ignoredWorkspaceIds: ["wks-a"], ignoredProjectIds: [] }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: "parent-1" }, [], paseo as never);
    await controller.onTurnEnded({ id: "agent-b", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(Object.keys(state)).toEqual([]);
  });

  it("does not schedule handoffs for ignored projects", async () => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ idleDelayMinutes: 15, handoffProfileId: "", ignoredWorkspaceIds: [], ignoredProjectIds: ["proj-1"] }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(Object.keys(state)).toEqual([]);
  });

  it("saves the handoff in the custom directory from settings", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({
        "agent-a": {
          agentId: "agent-a",
          workspaceId: "wks-a",
          cwd: "/work",
          idleSince: NOW - 60_000,
          fireAt: NOW,
          deadline: NOW + 60_000,
          updatedAt: NOW - 60_000,
          status: "pending",
        },
      }),
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ handoffDirectory: "/shared/handoffs" }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, calls } = stubPaseo({ createId: "writer-1" });
    await controller.ensureRecovered(paseo as never);
    for (let tries = 0; tries < 50 && !calls.includes("create:wks-a"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await controller.onTurnEnded(
      { id: "writer-1", workspaceId: "wks-a", cwd: "/work", parentAgentId: null },
      [{ type: "assistant_message", text: "# Task\nShip it" }],
      paseo as never,
    );
    expect(io.files.get("/shared/handoffs/agent-a.md")).toContain("# Task\nShip it");
    expect(io.files.has(HANDOFF_PATH)).toBe(false);
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].path).toBe("/shared/handoffs/agent-a.md");
  });

  it("spawns a handoff writer from the configured profile (provider, model, effort; no mode) and finalizes from its turn", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({
        "agent-a": {
          agentId: "agent-a",
          workspaceId: "wks-a",
          cwd: "/work",
          idleSince: NOW - 60_000,
          fireAt: NOW,
          deadline: NOW + 60_000,
          updatedAt: NOW - 60_000,
          status: "pending",
        },
      }),
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({
        idleDelayMinutes: 15,
        handoffProfileId: "profile-1",
        ignoredWorkspaceIds: [],
    ignoredProjectIds: [],
      }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, calls, archived, created } = stubPaseo({ createId: "writer-1" });
    await controller.ensureRecovered(paseo as never);
    // Recovery fires the handoff in the background; the writer only ends its turn after it exists.
    for (let tries = 0; tries < 50 && !calls.includes("create:wks-a"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await controller.onTurnEnded(
      { id: "writer-1", workspaceId: "wks-a", cwd: "/work", parentAgentId: null },
      [{ type: "assistant_message", text: "# Task\nShip it\n\n# Context\nDone so far" }],
      paseo as never,
    );
    expect(io.files.get(HANDOFF_PATH)).toContain("# Task\nShip it");
    expect(calls).toContain("create:wks-a");
    expect(created[0].config).toEqual({ provider: "claude/claude-haiku-5-5", thinkingOptionId: "low" });
    expect(archived).toContain("writer-1");
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(state["agent-a"].status).toBe("done");
    expect(state["agent-a"].path).toContain("agent-a.md");
  });

});