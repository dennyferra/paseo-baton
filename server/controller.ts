import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginSettings } from "@getpaseo/plugin/server";
import path from "node:path";
import type { BatonEntry, BatonState, HandoffInfo } from "../shared/baton";
import { batonSettingsSchema } from "../shared/baton";
import {
  DEFAULT_RETENTION_MS,
  DEFAULT_SAFETY_MARGIN_MS,
  DEFAULT_IDLE_TTL_MS,
  HANDOFF_FALLBACK_TIMEOUT_MS,
} from "../shared/baton";
import {
  createPendingEntry,
  markContinued,
  markDone,
  markSkipped,
  markWriting,
  planRecovery,
} from "./core";
import { buildHandoffPrompt, extractTitleFromDocument } from "./handoff";
import { handoffPathFor, resolveStateFile } from "./paths";
import { loadState, nodeStoreIo, saveState, type BatonStoreIo } from "./store";
import { renderMechanicalHandoff } from "./timeline-summary";

type AgentStatus = NonNullable<PaseoAgent["status"]>;
type RowData = { agentId: string; path: string; continuedAgentId?: string };
type BatonHandoffInfo = HandoffInfo;

export interface BatonControllerDeps {
  dataDir: string;
  settings: PluginSettings<typeof batonSettingsSchema>;
  log(message: string): void;
  io?: BatonStoreIo;
  now?: () => number;
}

export class BatonController {
  private readonly dataDir: string;
  private readonly settings: PluginSettings<typeof batonSettingsSchema>;
  private readonly log: (message: string) => void;
  private readonly io: BatonStoreIo;
  private readonly now: () => number;
  private readonly stateFile: string;
  private paseo: PaseoApi | null = null;
  private entries = new Map<string, BatonEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingHandoff = new Set<string>();
  private lastTimeline = new Map<string, readonly AgentTimelineItem[]>();
  private workspaceDirCache = new Map<string, string | null>();
  private recoveryPromise: Promise<void> | null = null;
  private recovered = false;
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(deps: BatonControllerDeps) {
    this.dataDir = deps.dataDir;
    this.settings = deps.settings;
    this.log = deps.log;
    this.io = deps.io ?? nodeStoreIo;
    this.now = deps.now ?? Date.now;
    this.stateFile = resolveStateFile(this.dataDir);
  }

  setPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  ensureRecovered(paseo: PaseoApi): Promise<boolean> {
    this.setPaseo(paseo);
    if (this.recovered) return Promise.resolve(true);
    if (this.recoveryPromise) return this.recoveryPromise.then(() => this.recovered);
    this.recoveryPromise = this.doRecover(paseo)
      .then(() => {
        this.recovered = true;
      })
      .catch((error: unknown) => {
        this.log(`Recovery failed: ${String(error)}`);
      })
      .finally(() => {
        this.recoveryPromise = null;
      });
    return this.recoveryPromise.then(() => this.recovered);
  }

  async onTurnEnded(
    agent: { id: string; workspaceId: string | null; cwd: string },
    timeline: readonly AgentTimelineItem[],
    paseo: PaseoApi,
  ): Promise<void> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    if (this.disposed) return;
    this.lastTimeline.set(agent.id, timeline);
    if (this.pendingHandoff.has(agent.id)) {
      await this.finalizeHandoff(agent.id, paseo);
      return;
    }
    await this.beginIdle(agent, paseo);
  }

  onTurnStarted(agent: { id: string }): void {
    const agentId = agent.id;
    this.clearTimer(agentId);
    this.clearFallbackTimer(agentId);
    if (this.pendingHandoff.has(agentId)) return;
    if (this.entries.delete(agentId)) this.persistEntries();
  }

  onClosed(agent: { id: string }): void {
    this.dropEntry(agent.id);
    this.pendingHandoff.delete(agent.id);
    this.lastTimeline.delete(agent.id);
  }

  onArchived(agent: { id: string }): void {
    this.dropEntry(agent.id);
    this.pendingHandoff.delete(agent.id);
    this.lastTimeline.delete(agent.id);
  }

  async continue(
    input: { agentId: string; path: string },
    paseo: PaseoApi,
  ): Promise<{ agentId: string; title: string }> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    const entry = this.entries.get(input.agentId);
    if (!entry || entry.status !== "done" || !entry.path) {
      throw new Error("No handoff is ready for this agent yet.");
    }
    const source = await paseo.agents.ref(input.agentId).refresh();
    if (!source) throw new Error("The handoff agent no longer exists.");
    const workspaceId = source.agent.workspaceId ?? entry.workspaceId;
    if (!workspaceId) throw new Error("The handoff workspace no longer exists.");
    let text: string;
    try {
      text = await this.io.readFile(entry.path);
    } catch {
      throw new Error("The handoff file is missing.");
    }
    const title = extractTitleFromDocument(text, "untitled task");
    const created = await paseo.workspaces.ref(workspaceId).agents.create({
      config: { provider: source.agent.provider },
      title: `[Handoff] ${title}`,
      prompt: `Read ${entry.path} and continue the task.`,
    });
    const newAgentId = created.id;
    const updated = markContinued(entry, newAgentId, this.now());
    this.entries.set(input.agentId, updated);
    this.persistEntries();
    await this.appendRow(paseo, input.agentId, {
      agentId: input.agentId,
      path: entry.path,
      continuedAgentId: newAgentId,
    });
    return { agentId: newAgentId, title };
  }

  async wake(paseo: PaseoApi): Promise<{ recovered: boolean; handoffs: BatonHandoffInfo[] }> {
    this.setPaseo(paseo);
    const recovered = await this.ensureRecovered(paseo);
    const handoffs: BatonHandoffInfo[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "done" && entry.path) {
        handoffs.push({
          agentId: entry.agentId,
          workspaceId: entry.workspaceId,
          path: entry.path,
          continuedAgentId: entry.continuedAgentId,
        });
      }
    }
    return { recovered, handoffs };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.fallbackTimers.clear();
    await this.writeQueue;
  }

  private async doRecover(paseo: PaseoApi): Promise<void> {
    const loaded = await loadState(this.io, this.stateFile);
    this.entries = new Map(Object.entries(loaded));
    if (Object.keys(loaded).length === 0) return;

    const knownAgentIds = new Set<string>();
    try {
      const { entries } = await paseo.agents.list({});
      for (const entry of entries) knownAgentIds.add(entry.agent.id);
    } catch (error: unknown) {
      this.log(`Listing agents during recovery failed: ${String(error)}`);
    }

    const existingPaths = new Map<string, string>();
    for (const entry of Object.values(loaded)) {
      if (entry.status !== "writing") continue;
      const handoffPath = await this.pathForEntry(entry, paseo);
      if (!handoffPath) continue;
      try {
        if (await this.io.exists(handoffPath)) existingPaths.set(entry.agentId, handoffPath);
      } catch (error: unknown) {
        this.log(`Checking handoff file for ${entry.agentId} failed: ${String(error)}`);
      }
    }

    const planned = planRecovery({
      state: loaded,
      now: this.now(),
      knownAgentIds,
      handoffPath: (agentId) => existingPaths.get(agentId) ?? null,
      retentionMs: DEFAULT_RETENTION_MS,
    });

    this.entries = new Map(Object.entries(planned.state));
    this.persistEntries();

    for (const [agentId, action] of planned.actions) {
      if (action.kind === "fireNow" || action.kind === "schedule") {
        const status = await this.agentStatus(paseo, agentId);
        if (status !== "idle") this.dropEntry(agentId);
      }
    }

    for (const [agentId, action] of planned.actions) {
      const entry = this.entries.get(agentId);
      if (!entry) continue;
      if (action.kind === "keepDone" || action.kind === "recoverDone") {
        if (entry.path) {
          await this.appendRow(paseo, agentId, {
            agentId,
            path: entry.path,
            continuedAgentId: entry.continuedAgentId,
          });
        }
      } else if (action.kind === "fireNow") {
        void this.fire(entry, paseo).catch((error: unknown) => {
          this.log(`Firing handoff for ${agentId} failed: ${String(error)}`);
        });
      } else if (action.kind === "schedule") {
        this.setTimer(agentId, action.delayMs, entry);
      }
    }
  }

  private async beginIdle(
    agent: { id: string; workspaceId: string | null; cwd: string },
    paseo: PaseoApi,
  ): Promise<void> {
    if (!agent.workspaceId) return;
    const ttlMs = await this.idleTtlMs();
    const now = this.now();
    const entry = createPendingEntry({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      idleSince: now,
      ttlMs,
      marginMs: DEFAULT_SAFETY_MARGIN_MS,
    });
    this.entries.set(agent.id, entry);
    await this.persistEntries();
    this.setTimer(agent.id, entry.fireAt - now, entry);
  }

  private async idleTtlMs(): Promise<number> {
    try {
      const state = await this.settings.read();
      if (state.status === "ready") return state.values.idleTtlMinutes * 60_000;
    } catch (error: unknown) {
      this.log(`Reading settings failed: ${String(error)}`);
    }
    return DEFAULT_IDLE_TTL_MS;
  }

  private async fire(entry: BatonEntry, paseo: PaseoApi): Promise<void> {
    const { agentId } = entry;
    if (this.disposed) return;
    const status = await this.agentStatus(paseo, agentId);
    if (status !== "idle") {
      this.dropEntry(agentId);
      return;
    }
    this.entries.set(agentId, markWriting(entry, this.now()));
    this.persistEntries();
    this.pendingHandoff.add(agentId);
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) {
      this.pendingHandoff.delete(agentId);
      this.markSkippedEntry(agentId);
      return;
    }
    try {
      await this.io.mkdir(path.dirname(handoffPath));
      await paseo.agents.ref(agentId).send(buildHandoffPrompt(handoffPath));
    } catch (error: unknown) {
      await this.finalizeHandoff(agentId, paseo);
      this.log(`Handoff prompt for ${agentId} failed, wrote mechanical fallback: ${String(error)}`);
      return;
    }
    this.setFallbackTimer(agentId);
  }

  private async finalizeHandoff(agentId: string, paseo: PaseoApi): Promise<void> {
    this.clearFallbackTimer(agentId);
    this.pendingHandoff.delete(agentId);
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) {
      this.markSkippedEntry(agentId);
      return;
    }
    let path = handoffPath;
    let exists = false;
    try {
      exists = await this.io.exists(handoffPath);
    } catch (error: unknown) {
      this.log(`Checking handoff file for ${agentId} failed: ${String(error)}`);
    }
    if (!exists) {
      path = await this.writeMechanical(entry, paseo);
    }
    const done = markDone(entry, path, this.now());
    this.entries.set(agentId, done);
    this.persistEntries();
    await this.appendRow(paseo, agentId, {
      agentId,
      path,
      continuedAgentId: done.continuedAgentId,
    });
  }

  private async writeMechanical(entry: BatonEntry, paseo: PaseoApi): Promise<string> {
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) throw new Error(`Cannot resolve handoff path for ${entry.agentId}`);
    await this.io.mkdir(path.dirname(handoffPath));
    const timeline = this.lastTimeline.get(entry.agentId) ?? [];
    const cwd = entry.cwd ?? path.dirname(path.dirname(handoffPath));
    const content = renderMechanicalHandoff({
      agentId: entry.agentId,
      workspaceId: entry.workspaceId,
      cwd,
      provider: null,
      timeline,
      now: this.now(),
    });
    await this.io.writeFile(handoffPath, content);
    return handoffPath;
  }

  private setTimer(agentId: string, delayMs: number, entry: BatonEntry): void {
    this.clearTimer(agentId);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      if (this.disposed) return;
      const current = this.entries.get(agentId);
      if (!current || current.updatedAt !== entry.updatedAt) return;
      const paseo = this.paseo;
      if (!paseo) return;
      void this.fire(current, paseo).catch((error: unknown) => {
        this.log(`Handoff fire for ${agentId} failed: ${String(error)}`);
      });
    }, delayMs);
    this.timers.set(agentId, timer);
  }

  private clearTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private setFallbackTimer(agentId: string): void {
    this.clearFallbackTimer(agentId);
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(agentId);
      if (this.disposed) return;
      const entry = this.entries.get(agentId);
      if (!entry || !this.pendingHandoff.has(agentId)) return;
      this.pendingHandoff.delete(agentId);
      const paseo = this.paseo;
      if (!paseo) return;
      void (async () => {
        const handoffPath = await this.writeMechanical(entry, paseo);
        const done = markDone(entry, handoffPath, this.now());
        this.entries.set(agentId, done);
        this.persistEntries();
        await this.appendRow(paseo, agentId, {
          agentId,
          path: handoffPath,
          continuedAgentId: done.continuedAgentId,
        });
      })().catch((error: unknown) => {
        this.log(`Mechanical fallback for ${agentId} failed: ${String(error)}`);
      });
    }, HANDOFF_FALLBACK_TIMEOUT_MS);
    this.fallbackTimers.set(agentId, timer);
  }

  private clearFallbackTimer(agentId: string): void {
    const timer = this.fallbackTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.fallbackTimers.delete(agentId);
  }

  private dropEntry(agentId: string): void {
    this.clearTimer(agentId);
    this.clearFallbackTimer(agentId);
    if (this.entries.delete(agentId)) this.persistEntries();
  }

  private markSkippedEntry(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    this.entries.set(agentId, markSkipped(entry, this.now()));
    this.persistEntries();
  }

  private async agentStatus(paseo: PaseoApi, agentId: string): Promise<AgentStatus | null> {
    try {
      const result = await paseo.agents.ref(agentId).refresh();
      return result?.agent.status ?? null;
    } catch {
      return null;
    }
  }

  private async pathForEntry(entry: BatonEntry, paseo: PaseoApi): Promise<string | null> {
    const cwd = entry.cwd || (await this.resolveWorkspaceDir(entry.workspaceId, paseo));
    return cwd ? handoffPathFor(cwd, entry.agentId) : null;
  }

  private async resolveWorkspaceDir(workspaceId: string, paseo: PaseoApi): Promise<string | null> {
    if (this.workspaceDirCache.has(workspaceId)) return this.workspaceDirCache.get(workspaceId) ?? null;
    let dir: string | null = null;
    try {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      dir = workspace?.workspaceDirectory ?? null;
    } catch {
      dir = null;
    }
    this.workspaceDirCache.set(workspaceId, dir);
    return dir;
  }

  private async appendRow(
    paseo: PaseoApi,
    agentId: string,
    data: RowData,
  ): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `baton:${agentId}`,
        kind: "baton-ready",
        version: 1,
        data,
      });
    } catch (error: unknown) {
      this.log(`Appending baton row for ${agentId} failed: ${String(error)}`);
    }
  }

  private persistEntries(): Promise<void> {
    const snapshot: BatonState = {};
    for (const [agentId, entry] of this.entries) snapshot[agentId] = entry;
    this.writeQueue = this.writeQueue
      .then(() => saveState(this.io, this.stateFile, snapshot))
      .catch((error: unknown) => {
        this.log(`Writing baton state failed: ${String(error)}`);
      });
    return this.writeQueue;
  }
}