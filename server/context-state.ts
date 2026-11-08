import { z } from "zod";
import {
  contextThresholdPercentSchema,
  type ContextUsageReading,
  MAX_CONTEXT_THRESHOLD_PERCENT,
  MIN_CONTEXT_THRESHOLD_PERCENT,
} from "../shared/baton";
import { isMissing, writeJsonAtomic, type BatonStoreIo } from "./store";

export type SessionOpenReason = "create" | "resume" | "refresh" | "import";
export type SessionOpenPurpose = "interactive" | "history";

/** What Baton keeps for one agent: its threshold override, and how many contexts the agent has started. */
export interface AgentContextState {
  thresholdPercent?: number;
  contextGeneration: number;
  /**
   * The context generation a threshold prompt was already shown for. A prompt is
   * at most once per context, so it is not shown again while the generation
   * stays the same.
   */
  firedGeneration?: number;
  /** The context generation a handoff file was written for. The idle handoff is skipped for that generation. */
  handoffGeneration?: number;
  /** The last reported context percentage, whole, for the chip. */
  lastPercent?: number;
  /** The context maximum Paseo reported with that percentage. Absent when Paseo reported none. */
  lastMaxTokens?: number;
}

export interface ContextState {
  agents: Record<string, AgentContextState>;
}

const agentStateSchema = z.object({
  thresholdPercent: contextThresholdPercentSchema.optional(),
  contextGeneration: z.number().int().min(0),
  firedGeneration: z.number().int().min(0).optional(),
  handoffGeneration: z.number().int().min(0).optional(),
  lastPercent: z.number().int().min(0).optional(),
  lastMaxTokens: z.number().int().positive().optional(),
});

const storedFileSchema = z.object({ agents: z.record(z.string(), z.unknown()) });

function emptyState(): ContextState {
  return { agents: {} };
}

/**
 * A session that is created or imported as an interactive session starts a new context. A resume, a refresh, or a
 * history view keeps the context it belongs to.
 */
export function startsNewContext(reason: SessionOpenReason, purpose: SessionOpenPurpose): boolean {
  return (reason === "create" || reason === "import") && purpose === "interactive";
}

export type LoadStatus = "loaded" | "missing" | "corrupt";

/**
 * Reads the stored file. A read error other than "missing" throws, so it can't be mistaken for an empty file. A file
 * that is not valid JSON, or has the wrong shape, is reported as "corrupt"; a bad entry inside a valid file is dropped
 * alone and the others are kept.
 */
export async function loadContextState(
  io: BatonStoreIo,
  file: string,
): Promise<{ state: ContextState; status: LoadStatus }> {
  let raw: string;
  try {
    raw = await io.readFile(file);
  } catch (error) {
    if (isMissing(error)) return { state: emptyState(), status: "missing" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyState(), status: "corrupt" };
  }
  const stored = storedFileSchema.safeParse(parsed);
  if (!stored.success) return { state: emptyState(), status: "corrupt" };
  const state = emptyState();
  for (const [agentId, value] of Object.entries(stored.data.agents)) {
    const result = agentStateSchema.safeParse(value);
    if (result.success) state.agents[agentId] = result.data;
  }
  return { state, status: "loaded" };
}

export async function saveContextState(io: BatonStoreIo, file: string, state: ContextState): Promise<void> {
  await writeJsonAtomic(io, file, JSON.stringify(state, null, 2));
}

/**
 * Holds the context state in memory and writes it back in order.
 *
 * Changes made before the stored file has loaded are kept: the loaded file fills in only the agents not already set in
 * memory. If the stored file cannot be read, nothing is written over it, and the next write tries to read it again.
 */
export class ContextStateStore {
  private state: ContextState = emptyState();
  /** False while the stored file is unreadable: writing then would replace what is on disk with less. */
  private writable = false;
  private readonly ready: Promise<void>;
  /** Writes run one after another, so the newest state is always the last one saved. */
  private writeQueue: Promise<void>;
  /** True once the stored file has been read, whether or not it could be used. */
  private loaded = false;
  /** Changes made before that. They run in order once the file is read, so none lands on an empty state. */
  private deferred: Array<() => void> = [];

  constructor(
    private readonly io: BatonStoreIo,
    private readonly file: string,
    private readonly log: (message: string) => void,
  ) {
    this.ready = this.loadFromDisk();
    this.writeQueue = this.ready;
  }

  thresholdOverride(agentId: string): number | undefined {
    return this.state.agents[agentId]?.thresholdPercent;
  }

  contextGeneration(agentId: string): number {
    return this.state.agents[agentId]?.contextGeneration ?? 0;
  }

  /** True when the threshold prompt was already shown for the agent's current context. */
  hasFiredForContext(agentId: string): boolean {
    return this.state.agents[agentId]?.firedGeneration === this.contextGeneration(agentId);
  }

  /** Marks the threshold prompt as shown for the agent's current context. */
  markThresholdFired(agentId: string): void {
    this.change(() => this.update(agentId, { firedGeneration: this.contextGeneration(agentId) }));
  }

  /**
   * True when a handoff file was already written for the agent's current context. Only a written file counts: a prompt
   * that nobody acted on does not stop the idle handoff.
   */
  hasHandoffForContext(agentId: string): boolean {
    return this.state.agents[agentId]?.handoffGeneration === this.contextGeneration(agentId);
  }

  /** Marks that a handoff file was written for the agent's current context. */
  markHandoffWritten(agentId: string): void {
    this.change(() => this.update(agentId, { handoffGeneration: this.contextGeneration(agentId) }));
  }

  /** Clears the handoff mark once its file has been deleted, so the idle handoff can write again for the context. */
  clearHandoffWritten(agentId: string): void {
    this.change(() => {
      if (this.state.agents[agentId]?.handoffGeneration === undefined) return;
      this.update(agentId, { handoffGeneration: undefined });
    });
  }

  /**
   * Every agent's last context reading, for the chip. Covers agents with no other record; an agent with no reported
   * percentage is left out.
   */
  contextReadings(): Record<string, ContextUsageReading> {
    const readings: Record<string, ContextUsageReading> = {};
    for (const [agentId, agent] of Object.entries(this.state.agents)) {
      if (agent.lastPercent === undefined) continue;
      readings[agentId] =
        agent.lastMaxTokens === undefined
          ? { percent: agent.lastPercent }
          : { percent: agent.lastPercent, maxTokens: agent.lastMaxTokens };
    }
    return readings;
  }

  /** The last reported context percentage a chip should show, or undefined when none was reported. */
  lastPercent(agentId: string): number | undefined {
    return this.state.agents[agentId]?.lastPercent;
  }

  /** The context maximum reported alongside the last percentage, when Paseo reported one. */
  lastMaxTokens(agentId: string): number | undefined {
    return this.state.agents[agentId]?.lastMaxTokens;
  }

  /** Records the latest reported context percentage and maximum for the chip and the threshold menu. */
  setLastPercent(agentId: string, percent: number, maxTokens?: number): void {
    this.change(() =>
      this.update(agentId, {
        lastPercent: Math.max(0, Math.round(percent)),
        lastMaxTokens: maxTokens,
      }),
    );
  }

  /** Throws a RangeError for a value outside the whole percents the settings allow. */
  setThresholdOverride(agentId: string, percent: number): void {
    const parsed = contextThresholdPercentSchema.safeParse(percent);
    if (!parsed.success) {
      throw new RangeError(
        `A context threshold must be a whole percent from ${MIN_CONTEXT_THRESHOLD_PERCENT} to ${MAX_CONTEXT_THRESHOLD_PERCENT}; got ${percent}.`,
      );
    }
    this.change(() => this.update(agentId, { thresholdPercent: parsed.data }));
  }

  /** Starts a new context for the agent, so a threshold that already fired can fire again. */
  startNewContext(agentId: string): void {
    this.change(() => this.update(agentId, { contextGeneration: this.contextGeneration(agentId) + 1 }));
  }

  /** Drops an agent's threshold override. */
  clearThresholdOverride(agentId: string): void {
    this.change(() => {
      if (this.state.agents[agentId]?.thresholdPercent === undefined) return;
      this.update(agentId, { thresholdPercent: undefined });
    });
  }

  /** Drops an agent's override and context count, for example when the agent is archived. */
  clearAgent(agentId: string): void {
    this.change(() => {
      const agents = { ...this.state.agents };
      delete agents[agentId];
      this.state = { agents };
      this.persist();
    });
  }

  /** Resolves once the stored file has been read and merged. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Resolves once every queued write has finished. It waits for the load first, since changes made before the load are
   * queued as it finishes.
   */
  async flush(): Promise<void> {
    await this.ready;
    await this.writeQueue;
  }

  /** Applies a change now once the stored file has been read; before that, it waits for the read. */
  private change(apply: () => void): void {
    if (this.loaded) apply();
    else this.deferred.push(apply);
  }

  private update(agentId: string, patch: Partial<AgentContextState>): void {
    const current: AgentContextState = this.state.agents[agentId] ?? { contextGeneration: 0 };
    this.state = { agents: { ...this.state.agents, [agentId]: { ...current, ...patch } } };
    this.persist();
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const loaded = await loadContextState(this.io, this.file);
      if (loaded.status === "corrupt") {
        // Keep the unreadable file aside rather than writing over it.
        await this.io.rename(this.file, `${this.file}.corrupt`);
        this.log(`Baton context state was unreadable and was moved to ${this.file}.corrupt`);
      }
      // Merge field by field, so a change kept in memory does not drop the stored fields of the same agent.
      const merged: Record<string, AgentContextState> = { ...loaded.state.agents };
      for (const [agentId, record] of Object.entries(this.state.agents)) {
        merged[agentId] = { ...merged[agentId], ...record };
      }
      this.state = { agents: merged };
      this.writable = true;
    } catch (error: unknown) {
      this.writable = false;
      this.log(`Reading baton context state failed; leaving the stored file alone: ${String(error)}`);
    }
    this.finishLoad();
  }

  /** Marks the file as read and applies the changes that waited for it, in the order they were made. */
  private finishLoad(): void {
    this.loaded = true;
    const waiting = this.deferred;
    this.deferred = [];
    for (const apply of waiting) apply();
  }

  private persist(): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.writable) await this.loadFromDisk();
        if (!this.writable) return;
        await saveContextState(this.io, this.file, this.state);
      })
      .catch((error: unknown) => {
        this.log(`Writing baton context state failed: ${String(error)}`);
      });
  }
}
/** The usage Paseo reports for a context check, as read from `lastUsage`. */
export interface ContextUsage {
  usedTokens: number;
  maxTokens?: number;
}

/**
 * Parses `lastUsage` from an agent snapshot. Null when no usable usage was
 * reported: a missing `contextWindowUsedTokens` is not a guess.
 */
export function parseContextUsage(value: unknown): ContextUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const used = typeof record.contextWindowUsedTokens === "number" ? record.contextWindowUsedTokens : null;
  if (used === null || !Number.isFinite(used)) return null;
  // A maximum of zero is no maximum: it would make every percentage infinite, so the fallback applies instead.
  const max = typeof record.contextWindowMaxTokens === "number" && Number.isFinite(record.contextWindowMaxTokens) && record.contextWindowMaxTokens > 0
    ? record.contextWindowMaxTokens
    : undefined;
  return { usedTokens: used, maxTokens: max };
}

/** The size a percentage is measured against: the reported maximum, or the absolute fallback when none is reported. */
export function limitTokens(usage: ContextUsage, fallbackTokens: number): number {
  return usage.maxTokens ?? fallbackTokens;
}

/**
 * The context percentage a chip should show: of the reported maximum when it
 * exists, and of the absolute fallback otherwise. Null when no limit can be
 * named at all.
 */
export function contextPercent(usage: ContextUsage, fallbackTokens: number): number | null {
  const limit = limitTokens(usage, fallbackTokens);
  if (!limit || limit <= 0 || !Number.isFinite(limit)) return null;
  return (usage.usedTokens / limit) * 100;
}

/**
 * Whether usage has reached the threshold: the percentage of the reported maximum, or of the absolute fallback when no
 * maximum is reported. The caller decides which percentage applies; this only compares.
 */
export function reachesThreshold(usage: ContextUsage, thresholdPercent: number, fallbackTokens: number): boolean {
  return usage.usedTokens >= (limitTokens(usage, fallbackTokens) * thresholdPercent) / 100;
}
