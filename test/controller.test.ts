import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatonStoreIo } from "../server/store";
import { BatonController } from "../server/controller";
import { batonStateSchema, DEFAULT_SETTINGS, SUBAGENT_WAIT_LIMIT_MS, type BatonSettings } from "../shared/baton";

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
    waitForSubagents: true,
    cleanupOldHandoffs: true,
    cleanupAfterDays: 3,
    ignoredWorkspaceIds: [],
    ignoredProjectIds: [],
    ignoreNewProjects: false,
    knownProjectIds: [],
    ...overrides,
  };
  return {
    read: async () => ({ status: "ready" as const, revision: "r", values }),
    subscribe: () => () => {},
  };
}

function stubPaseo(opts: { createId?: string; history?: Record<string, unknown[]> } = {}) {
  const createId = opts.createId ?? "agent-continued";
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const appended: Array<Record<string, unknown>> = [];
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
          refetch: async () => ({ entries: (opts.history?.[agentId] ?? []).map((item) => ({ item })) }),
          append: async (item: Record<string, unknown>) => {
            calls.push(`append:${agentId}`);
            appended.push(item);
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
  return { paseo, calls, created, archived, appended, agents };
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

  describe("waiting for subagents", () => {
    const DELAY = DEFAULT_SETTINGS.idleDelayMinutes * 60 * 1000;
    const parent = { id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null };

    function setup(overrides: Partial<BatonSettings> = {}) {
      vi.useFakeTimers();
      const clock = { now: NOW };
      const io = memoryIo();
      const controller = new BatonController({
        dataDir: "/home/.paseo/plugin-data/baton",
        settings: settings(overrides),
        log: () => {},
        io,
        now: () => clock.now,
      });
      const stub = stubPaseo();
      const elapse = async (ms: number) => {
        clock.now += ms;
        await vi.advanceTimersByTimeAsync(ms);
      };
      const readEntry = async () =>
        (await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}")))["agent-a"];
      return { controller, clock, elapse, readEntry, ...stub };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("restarts the countdown while a subagent is still working", async () => {
      const { controller, clock, elapse, readEntry, paseo, created } = setup();
      await controller.onTurnEnded(parent, [], paseo as never);
      controller.onTurnStarted({ id: "child-1", parentAgentId: "agent-a" });
      await elapse(DELAY);
      expect(created).toHaveLength(0);
      const entry = await readEntry();
      expect(entry.status).toBe("pending");
      expect(entry.fireAt).toBe(clock.now + DELAY);

      await controller.onTurnEnded({ ...parent, id: "child-1", parentAgentId: "agent-a" }, [], paseo as never);
      await elapse(DELAY);
      expect(created).toHaveLength(1);
      controller.dispose();
    });

    it("writes the handoff despite working subagents when waiting is off", async () => {
      const { controller, elapse, paseo, created } = setup({ waitForSubagents: false });
      await controller.onTurnEnded(parent, [], paseo as never);
      controller.onTurnStarted({ id: "child-1", parentAgentId: "agent-a" });
      await elapse(DELAY);
      expect(created).toHaveLength(1);
      controller.dispose();
    });

    it("waits for a nested subagent even when its parent subagent is idle", async () => {
      const { controller, elapse, paseo, created } = setup();
      await controller.onTurnEnded(parent, [], paseo as never);
      controller.onTurnStarted({ id: "child-1", parentAgentId: "agent-a" });
      await controller.onTurnEnded({ ...parent, id: "child-1", parentAgentId: "agent-a" }, [], paseo as never);
      controller.onTurnStarted({ id: "grandchild-1", parentAgentId: "child-1" });
      await elapse(DELAY);
      expect(created).toHaveLength(0);
      controller.dispose();
    });

    it("stops waiting for a subagent that never reports back", async () => {
      const { controller, elapse, paseo, created } = setup();
      await controller.onTurnEnded(parent, [], paseo as never);
      controller.onTurnStarted({ id: "child-1", parentAgentId: "agent-a" });
      await elapse(SUBAGENT_WAIT_LIMIT_MS);
      expect(created).toHaveLength(0);
      await elapse(DELAY);
      expect(created).toHaveLength(1);
      controller.dispose();
    });
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

  it("creates a handoff right away from the menu and refuses when it cannot", async () => {
    const io = memoryIo();
    const controller = makeController(io);
    const { paseo, calls, agents } = stubPaseo({ createId: "writer-1" });
    agents[0].status = "running";
    await expect(controller.createNow({ agentId: "agent-a" }, paseo as never)).rejects.toThrow("still working");
    agents[0].status = "idle";
    expect(await controller.createNow({ agentId: "agent-a" }, paseo as never)).toEqual({ started: true });
    for (let tries = 0; tries < 50 && !calls.includes("create:wks-a"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(calls).toContain("create:wks-a");
    await expect(controller.createNow({ agentId: "agent-a" }, paseo as never)).rejects.toThrow("already being written");
    await controller.onTurnEnded(
      { id: "writer-1", workspaceId: "wks-a", cwd: "/work", parentAgentId: null },
      [{ type: "assistant_message", text: "# Task\nShip it" }],
      paseo as never,
    );
    expect(io.files.get(HANDOFF_PATH)).toContain("# Task\nShip it");
    await expect(controller.createNow({ agentId: "agent-a" }, paseo as never)).rejects.toThrow("already exists");
    await controller.dispose();
  });

  it("does not create a handoff now when handoffs are off for the agent", async () => {
    const controller = makeController(memoryIo());
    const { paseo } = stubPaseo();
    await controller.setEnabled({ agentId: "agent-a", enabled: false }, paseo as never);
    await expect(controller.createNow({ agentId: "agent-a" }, paseo as never)).rejects.toThrow("turned off");
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

  it("shows the continued title on the row and keeps it when the row is re-appended", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({ "agent-a": doneEntry() }),
      [HANDOFF_PATH]: "Title: Fix login bug\n\n# Task\n\nFix the bug.",
    });
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, appended } = stubPaseo();
    await controller.continue({ agentId: "agent-a", path: HANDOFF_PATH }, paseo as never);
    const rowsAfterContinue = appended.slice(1);
    expect((rowsAfterContinue[0].data as { continuedTitle?: string }).continuedTitle).toBe("[Handoff] Fix login bug");
    // A later re-append (recovery, finalize) passes no title; the entry's stored title is used.
    await controller.wake(paseo as never, ["wks-a"]);
    const titles = appended.slice(1).map((item) => (item.data as { continuedTitle?: string }).continuedTitle);
    expect(titles.every((title) => title === "[Handoff] Fix login bug")).toBe(true);
    await controller.dispose();
  });

  it("archives only an agent whose handoff was continued", async () => {
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
    });
    const { paseo, archived } = stubPaseo();
    await expect(controller.archive({ agentId: "agent-a" }, paseo as never)).rejects.toThrow("Only an agent");
    expect(archived).toEqual([]);
    await controller.continue({ agentId: "agent-a", path: HANDOFF_PATH }, paseo as never);
    await expect(controller.archive({ agentId: "agent-a" }, paseo as never)).resolves.toEqual({ archived: true });
    expect(archived).toEqual(["agent-a"]);
    await controller.dispose();
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

  it.each([
    { name: "ignores a project that is new", known: [], expected: [] },
    { name: "keeps a known project active", known: ["proj-1"], expected: ["agent-a"] },
  ])("when new projects are ignored by default, $name", async ({ known, expected }) => {
    const io = memoryIo();
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ ignoreNewProjects: true, knownProjectIds: known }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo } = stubPaseo();
    await controller.onTurnEnded({ id: "agent-a", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    await controller.dispose();
    const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
    expect(Object.keys(state)).toEqual(expected);
  });

  describe("cleaning up old handoffs", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const doneEntry = (agentId: string, updatedAt: number, extra: object = {}) => ({
      agentId,
      workspaceId: "wks-a",
      idleSince: updatedAt,
      fireAt: updatedAt,
      deadline: updatedAt,
      updatedAt,
      status: "done",
      path: `/work/.paseo/handoffs/${agentId}.md`,
      ...extra,
    });

    async function run(overrides: Partial<BatonSettings>) {
      const io = memoryIo({
        [STATE_FILE]: JSON.stringify({
          old: doneEntry("old", NOW - 4 * DAY),
          fresh: doneEntry("fresh", NOW - 2 * DAY),
          continued: doneEntry("continued", NOW - 4 * DAY, { continuedAgentId: "next" }),
        }),
        "/work/.paseo/handoffs/old.md": "x",
        "/work/.paseo/handoffs/fresh.md": "x",
        "/work/.paseo/handoffs/continued.md": "x",
      });
      const controller = new BatonController({
        dataDir: "/home/.paseo/plugin-data/baton",
        settings: settings(overrides),
        log: () => {},
        io,
        now: () => NOW,
      });
      await controller.ensureRecovered(stubPaseo().paseo as never);
      const removed = await controller.cleanupOldHandoffs();
      await controller.dispose();
      const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
      return { io, removed, state };
    }

    it("deletes unused handoffs older than the limit and keeps the rest", async () => {
      const { io, state } = await run({});
      expect(io.files.has("/work/.paseo/handoffs/old.md")).toBe(false);
      expect(io.files.has("/work/.paseo/handoffs/fresh.md")).toBe(true);
      expect(io.files.has("/work/.paseo/handoffs/continued.md")).toBe(true);
      expect(Object.keys(state).sort()).toEqual(["continued", "fresh"]);
    });

    it("never deletes a file that is not the agent's own handoff", async () => {
      const io = memoryIo({
        [STATE_FILE]: JSON.stringify({ old: doneEntry("old", NOW - 4 * DAY, { path: "/etc/important.txt" }) }),
        "/etc/important.txt": "x",
      });
      const controller = new BatonController({
        dataDir: "/home/.paseo/plugin-data/baton",
        settings: settings({}),
        log: () => {},
        io,
        now: () => NOW,
      });
      await controller.ensureRecovered(stubPaseo().paseo as never);
      expect(await controller.cleanupOldHandoffs()).toBe(0);
      await controller.dispose();
      expect(io.files.has("/etc/important.txt")).toBe(true);
    });

    it("keeps the record when the file cannot be deleted", async () => {
      const io = memoryIo({
        [STATE_FILE]: JSON.stringify({ old: doneEntry("old", NOW - 4 * DAY) }),
        "/work/.paseo/handoffs/old.md": "x",
      });
      io.unlink = async () => {
        throw new Error("EACCES");
      };
      const controller = new BatonController({
        dataDir: "/home/.paseo/plugin-data/baton",
        settings: settings({}),
        log: () => {},
        io,
        now: () => NOW,
      });
      await controller.ensureRecovered(stubPaseo().paseo as never);
      expect(await controller.cleanupOldHandoffs()).toBe(0);
      await controller.dispose();
      const state = await batonStateSchema.parseAsync(JSON.parse(io.files.get(STATE_FILE) ?? "{}"));
      expect(Object.keys(state)).toEqual(["old"]);
    });

    it("does nothing when cleanup is turned off", async () => {
      const { io, removed } = await run({ cleanupOldHandoffs: false });
      expect(removed).toBe(0);
      expect(io.files.has("/work/.paseo/handoffs/old.md")).toBe(true);
    });
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

  it("falls back to the default folder and says so when the storage location is unusable", async () => {
    const base = memoryIo({
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
    const io = {
      ...base,
      async mkdir(dir: string) {
        if (dir.startsWith("/bad")) throw new Error("EACCES: permission denied");
      },
    };
    const controller = new BatonController({
      dataDir: "/home/.paseo/plugin-data/baton",
      settings: settings({ handoffDirectory: "/bad/handoffs" }),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, calls, appended } = stubPaseo({ createId: "writer-1" });
    await controller.ensureRecovered(paseo as never);
    for (let tries = 0; tries < 50 && !calls.includes("create:wks-a"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await controller.onTurnEnded(
      { id: "writer-1", workspaceId: "wks-a", cwd: "/work", parentAgentId: null },
      [{ type: "assistant_message", text: "# Task\nShip it" }],
      paseo as never,
    );
    expect(base.files.get(HANDOFF_PATH)).toContain("# Task\nShip it");
    const row = appended.find((item) => item.kind === "baton-ready");
    expect((row?.data as { notice?: string }).notice).toContain("EACCES: permission denied");
    expect((row?.data as { path: string }).path).toBe(HANDOFF_PATH);
    await controller.dispose();
  });

  it("reads the conversation back when turn events carry none", async () => {
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
      settings: settings(),
      log: () => {},
      io,
      now: () => NOW,
    });
    const { paseo, calls, created } = stubPaseo({
      createId: "writer-1",
      history: {
        "agent-a": [{ type: "user_message", text: "Fix the login bug" }],
        "writer-1": [{ type: "assistant_message", text: "# Task\nFix the login bug\n" }],
      },
    });
    await controller.ensureRecovered(paseo as never);
    for (let tries = 0; tries < 50 && !calls.includes("create:wks-a"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(String(created[0].prompt)).toContain("Fix the login bug");
    await controller.onTurnEnded({ id: "writer-1", workspaceId: "wks-a", cwd: "/work", parentAgentId: null }, [], paseo as never);
    expect(io.files.get(HANDOFF_PATH)).toContain("# Task\nFix the login bug");
    expect(io.files.get(HANDOFF_PATH)).not.toContain("Not captured");
    await controller.dispose();
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