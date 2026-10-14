import { describe, expect, it } from "vitest";
import {
  createPendingEntry,
  isExpired,
  markContinued,
  markDone,
  markSkipped,
  markWriting,
  planRecovery,
  type RecoveryAction,
} from "../server/core";

const NOW = 1_000_000;
const DELAY = 15 * 60 * 1000;

function pending(overrides: Record<string, unknown> = {}) {
  return {
    ...createPendingEntry({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      cwd: "/work/a",
      idleSince: NOW,
      delayMs: DELAY,
    }),
    ...overrides,
  };
}

describe("createPendingEntry", () => {
  it("fires after the idle delay and allows slack before the deadline", () => {
    const entry = pending();
    expect(entry.fireAt).toBe(NOW + DELAY);
    expect(entry.deadline).toBeGreaterThan(entry.fireAt);
    expect(entry.status).toBe("pending");
  });

  it("never fires before idleSince plus the minimum delay", () => {
    const entry = createPendingEntry({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      idleSince: NOW,
      delayMs: 500,
    });
    expect(entry.fireAt).toBe(NOW + 1000);
  });
});

describe("transitions", () => {
  it("marks writing, done, skipped, and continued without losing fields", () => {
    const entry = pending();
    const writing = markWriting(entry, NOW + 10);
    expect(writing.status).toBe("writing");
    expect(writing.updatedAt).toBe(NOW + 10);
    const done = markDone(writing, "/work/a/.paseo/handoffs/agent-a.md", NOW + 20);
    expect(done.status).toBe("done");
    expect(done.path).toBe("/work/a/.paseo/handoffs/agent-a.md");
    expect(done.workspaceId).toBe("workspace-a");
    const skipped = markSkipped(entry, NOW + 30);
    expect(skipped.status).toBe("skipped");
    const continued = markContinued(done, "agent-b", NOW + 40);
    expect(continued.continuedAgentId).toBe("agent-b");
    expect(continued.path).toBe(done.path);
  });
});

describe("isExpired", () => {
  it("is expired only after the deadline", () => {
    const entry = pending();
    expect(isExpired(entry, entry.deadline)).toBe(false);
    expect(isExpired(entry, entry.deadline + 1)).toBe(true);
  });
});

function plan(state: Record<string, unknown>, options: { now?: number; known?: string[]; ignored?: string[] } = {}) {
  return planRecovery({
    state: state as never,
    now: options.now ?? NOW,
    knownAgentIds: new Set(options.known ?? ["agent-a", "agent-b"]),
    ignoredWorkspaceIds: new Set(options.ignored ?? []),
    handoffPath: () => null,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
}

function actionFor(result: ReturnType<typeof plan>, agentId: string): RecoveryAction | undefined {
  return result.actions.get(agentId);
}

describe("planRecovery", () => {
  it("drops entries for agents that no longer exist", () => {
    const result = plan({ "agent-ghost": pending({ agentId: "agent-ghost" }) }, { known: [] });
    expect(actionFor(result, "agent-ghost")).toEqual({ kind: "drop" });
    expect(result.state["agent-ghost"]).toBeUndefined();
  });

  it("drops pending entries in ignored workspaces", () => {
    const result = plan({ "agent-a": pending() }, { ignored: ["workspace-a"] });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "drop" });
    expect(result.state["agent-a"]).toBeUndefined();
  });

  it("keeps recent done entries for row re-append", () => {
    const entry = markDone(pending(), "/work/a/.paseo/handoffs/agent-a.md", NOW);
    const result = plan({ "agent-a": entry });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "keepDone" });
    expect(result.state["agent-a"]).toBe(entry);
  });

  it("drops done entries older than the retention window", () => {
    const entry = markDone(pending(), "/work/a/.paseo/handoffs/agent-a.md", NOW);
    const result = plan({ "agent-a": entry }, { now: NOW + 8 * 24 * 60 * 60 * 1000 });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "drop" });
  });

  it("keeps recent skipped entries and drops old ones", () => {
    const fresh = markSkipped(pending(), NOW);
    const result = plan({ "agent-a": fresh });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "keepSkipped" });

    const old = markSkipped(pending(), NOW);
    const aged = plan({ "agent-a": old }, { now: NOW + 8 * 24 * 60 * 60 * 1000 });
    expect(actionFor(aged, "agent-a")).toEqual({ kind: "drop" });
  });

  it("marks skipped when the deadline has passed", () => {
    const entry = pending();
    const result = plan({ "agent-a": entry }, { now: entry.deadline + 1 });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "markSkipped" });
    expect(result.state["agent-a"].status).toBe("skipped");
  });

  it("fires immediately when now is inside the window and past fireAt", () => {
    const entry = pending();
    const result = plan({ "agent-a": entry }, { now: entry.fireAt });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "fireNow" });
    expect(result.state["agent-a"].status).toBe("pending");
  });

  it("schedules a timer for the remainder when now is before fireAt", () => {
    const entry = pending();
    const result = plan({ "agent-a": entry }, { now: entry.idleSince });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "schedule", delayMs: entry.fireAt - entry.idleSince });
  });

  it("reclaims a writing entry whose handoff file exists", () => {
    const entry = markWriting(pending(), NOW);
    const result = planRecovery({
      state: { "agent-a": entry },
      now: NOW,
      knownAgentIds: new Set(["agent-a"]),
      handoffPath: (agentId) =>
        agentId === "agent-a" ? "/work/a/.paseo/handoffs/agent-a.md" : null,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(actionFor(result, "agent-a")).toEqual({ kind: "recoverDone", path: "/work/a/.paseo/handoffs/agent-a.md" });
    expect(result.state["agent-a"].status).toBe("done");
    expect(result.state["agent-a"].path).toBe("/work/a/.paseo/handoffs/agent-a.md");
  });

  it("treats a writing entry with no file like a pending entry while time remains", () => {
    const entry = markWriting(pending(), NOW);
    const before = plan({ "agent-a": entry }, { now: entry.idleSince });
    expect(actionFor(before, "agent-a")).toEqual({ kind: "schedule", delayMs: entry.fireAt - entry.idleSince });

    const atFire = plan({ "agent-a": entry }, { now: entry.fireAt });
    expect(actionFor(atFire, "agent-a")).toEqual({ kind: "fireNow" });

    const after = plan({ "agent-a": entry }, { now: entry.deadline + 1 });
    expect(actionFor(after, "agent-a")).toEqual({ kind: "markSkipped" });
  });
});