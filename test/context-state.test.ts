import { describe, expect, it } from "vitest";
import { ContextStateStore, loadContextState, startsNewContext, parseContextUsage, contextPercent, reachesThreshold } from "../server/context-state";
import { resolveContextStateFile } from "../server/paths";
import { memoryIo } from "./support/memory-io";

const FILE = resolveContextStateFile("/data");

describe("new-context rule", () => {
  it("starts a new context only for a created or imported interactive session", () => {
    expect(startsNewContext("create", "interactive")).toBe(true);
    expect(startsNewContext("import", "interactive")).toBe(true);
    expect(startsNewContext("create", "history")).toBe(false);
    expect(startsNewContext("resume", "interactive")).toBe(false);
    expect(startsNewContext("refresh", "interactive")).toBe(false);
  });
});

describe("loading the stored context state", () => {
  it("reports a missing file as an empty state", async () => {
    const loaded = await loadContextState(memoryIo(), FILE);
    expect(loaded).toEqual({ state: { agents: {} }, status: "missing" });
  });

  it("reports a file that is not valid JSON as corrupt", async () => {
    const loaded = await loadContextState(memoryIo({ [FILE]: "{not json" }), FILE);
    expect(loaded.status).toBe("corrupt");
    expect(loaded.state.agents).toEqual({});
  });

  it("drops an entry outside the allowed range and keeps the valid ones beside it", async () => {
    const stored = JSON.stringify({
      agents: {
        "agent-a": { thresholdPercent: 3, contextGeneration: 1 },
        "agent-b": { thresholdPercent: 55, contextGeneration: 2 },
      },
    });
    const loaded = await loadContextState(memoryIo({ [FILE]: stored }), FILE);
    expect(loaded.status).toBe("loaded");
    expect(loaded.state.agents).toEqual({ "agent-b": { thresholdPercent: 55, contextGeneration: 2 } });
  });

  it("throws a read error that is not 'missing', so it cannot pass for an empty file", async () => {
    const io = memoryIo();
    io.readFile = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await expect(loadContextState(io, FILE)).rejects.toThrow("EACCES");
  });
});

describe("context state store", () => {
  it("rejects a threshold outside the whole percents the settings allow", async () => {
    const store = new ContextStateStore(memoryIo(), FILE, () => {});
    await store.whenReady();
    expect(() => store.setThresholdOverride("agent-a", 9)).toThrow(RangeError);
    expect(() => store.setThresholdOverride("agent-a", 96)).toThrow(RangeError);
    expect(() => store.setThresholdOverride("agent-a", 3.5)).toThrow(RangeError);
    expect(store.thresholdOverride("agent-a")).toBeUndefined();
  });

  it("keeps a change made before the stored file finished loading", async () => {
    const stored = JSON.stringify({
      agents: {
        "agent-a": { thresholdPercent: 30, contextGeneration: 0 },
        "agent-b": { thresholdPercent: 50, contextGeneration: 2 },
      },
    });
    const store = new ContextStateStore(memoryIo({ [FILE]: stored }), FILE, () => {});
    store.setThresholdOverride("agent-a", 45);
    await store.whenReady();
    expect(store.thresholdOverride("agent-a")).toBe(45);
    expect(store.thresholdOverride("agent-b")).toBe(50);
    expect(store.contextGeneration("agent-b")).toBe(2);
  });

  it("writes snapshots in order, so the file ends with the latest state", async () => {
    const io = memoryIo();
    const store = new ContextStateStore(io, FILE, () => {});
    await store.whenReady();
    for (let percent = 10; percent <= 20; percent += 1) store.setThresholdOverride("agent-a", percent);
    await store.flush();
    const saved = JSON.parse(io.files.get(FILE) ?? "{}");
    expect(saved.agents["agent-a"].thresholdPercent).toBe(20);
  });

  it("removes an agent's record when it is cleared, and keeps the removal on disk", async () => {
    const io = memoryIo();
    const store = new ContextStateStore(io, FILE, () => {});
    await store.whenReady();
    store.setThresholdOverride("agent-a", 40);
    store.startNewContext("agent-a");
    store.setThresholdOverride("agent-b", 70);
    store.clearAgent("agent-a");
    await store.flush();
    expect(store.thresholdOverride("agent-a")).toBeUndefined();
    expect(store.contextGeneration("agent-a")).toBe(0);
    const saved = JSON.parse(io.files.get(FILE) ?? "{}");
    expect(Object.keys(saved.agents)).toEqual(["agent-b"]);
  });
});

describe("threshold helpers", () => {
  it("reaches the threshold at and above the percent, and not below", () => {
    const usage = { usedTokens: 610_000, maxTokens: 1_000_000 };
    expect(reachesThreshold(usage, 60, 120_000)).toBe(true);
    expect(reachesThreshold(usage, 61, 120_000)).toBe(true); // 61% of 1M = 610k
    expect(reachesThreshold({ usedTokens: 500_000, maxTokens: 1_000_000 }, 60, 120_000)).toBe(false);
  });
  it("applies the threshold percent to the fallback limit when no maximum is reported", () => {
    // 60% of the 120,000-token fallback is 72,000 tokens.
    expect(reachesThreshold({ usedTokens: 130_000 }, 60, 120_000)).toBe(true);
    expect(reachesThreshold({ usedTokens: 72_000 }, 60, 120_000)).toBe(true);
    expect(reachesThreshold({ usedTokens: 71_999 }, 60, 120_000)).toBe(false);
  });
  it("shows the percent of the maximum, or of the fallback when there is none", () => {
    expect(contextPercent({ usedTokens: 620_000, maxTokens: 1_000_000 }, 120_000)).toBe(62);
    expect(contextPercent({ usedTokens: 90_000 }, 120_000)).toBe(75);
  });
  it("parses usage and rejects a missing used count", () => {
    expect(parseContextUsage({ contextWindowUsedTokens: 1, contextWindowMaxTokens: 2 })).toEqual({ usedTokens: 1, maxTokens: 2 });
    expect(parseContextUsage({ contextWindowMaxTokens: 2 })).toBeNull();
    expect(parseContextUsage(null)).toBeNull();
  });
  it("does not resurrect an agent archived before the first load", async () => {
    const stored = JSON.stringify({ agents: { "agent-a": { thresholdPercent: 40, contextGeneration: 3 } } });
    const store = new ContextStateStore(memoryIo({ [FILE]: stored }), FILE, () => {});
    store.clearAgent("agent-a");
    await store.whenReady();
    await store.flush();
    expect(store.thresholdOverride("agent-a")).toBeUndefined();
  });
  it("fires once per context and re-arms on a new context", async () => {
    const store = new ContextStateStore(memoryIo(), FILE, () => {});
    await store.whenReady();
    store.markThresholdFired("agent-a");
    expect(store.hasFiredForContext("agent-a")).toBe(true);
    store.startNewContext("agent-a");
    expect(store.hasFiredForContext("agent-a")).toBe(false);
  });
  it("records the last percent for the chip", async () => {
    const store = new ContextStateStore(memoryIo(), FILE, () => {});
    await store.whenReady();
    store.setLastPercent("agent-a", 62);
    expect(store.lastPercent("agent-a")).toBe(62);
  });
  it("records the reported maximum with the percent, and clears it when none is reported", async () => {
    const store = new ContextStateStore(memoryIo(), FILE, () => {});
    await store.whenReady();
    store.setLastPercent("agent-a", 40, 1_000_000);
    expect(store.lastMaxTokens("agent-a")).toBe(1_000_000);
    store.setLastPercent("agent-a", 41);
    expect(store.lastMaxTokens("agent-a")).toBeUndefined();
    expect(store.lastPercent("agent-a")).toBe(41);
  });
});
