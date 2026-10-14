import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { BatonEntry, BatonState, BatonSettings, HandoffInfo } from "../shared/baton";
import { batonSettingsSchema, BATON_WRITER_LABEL, BATON_WRITER_TITLE } from "../shared/baton";
import {
  DEFAULT_RETENTION_MS,
  DEFAULT_SETTINGS,
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
import { buildWriterHandoffPrompt, extractTitleFromDocument } from "./handoff";
import { handoffPathFor, legacyStateFiles, resolveDaemonHome, resolveStateFile } from "./paths";
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
  openFile?: (filePath: string) => Promise<void>;
  home?: string;
}

function buildProviderModel(provider: string, model: string | null): string {
  if (provider.includes("/")) return provider;
  return model ? `${provider}/${model}` : provider;
}

async function openFileWithOs(filePath: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  if (process.platform === "darwin") {
    await execFileAsync("open", [filePath]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", filePath]);
  } else {
    await execFileAsync("xdg-open", [filePath]);
  }
}

export class BatonController {
  private readonly dataDir: string;
  private readonly settings: PluginSettings<typeof batonSettingsSchema>;
  private readonly log: (message: string) => void;
  private readonly io: BatonStoreIo;
  private readonly now: () => number;
  private readonly openFile: (filePath: string) => Promise<void>;
  private readonly stateFile: string;
  private readonly home: string;
  private paseo: PaseoApi | null = null;
  private entries = new Map<string, BatonEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingHandoff = new Set<string>();
  private lastTimeline = new Map<string, readonly AgentTimelineItem[]>();
  private workspaceDirCache = new Map<string, string | null>();
  private writerAgentIds = new Set<string>();
  private writerByAgentId = new Map<string, string>();
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
    this.openFile = deps.openFile ?? openFileWithOs;
    this.stateFile = resolveStateFile(this.dataDir);
    this.home = deps.home ?? resolveDaemonHome();
  }

  async migrateStateFileIfNeeded(): Promise<void> {
    let hasNew = false;
    try {
      hasNew = await this.io.exists(this.stateFile);
    } catch (error: unknown) {
      this.log(`Checking state file failed: ${String(error)}`);
    }
    if (hasNew) return;
    for (const legacy of legacyStateFiles(this.home)) {
      if (legacy === this.stateFile) continue;
      let hasLegacy = false;
      try {
        hasLegacy = await this.io.exists(legacy);
      } catch (error: unknown) {
        this.log(`Checking legacy state file failed: ${String(error)}`);
      }
      if (!hasLegacy) continue;
      try {
        await this.io.mkdir(path.dirname(this.stateFile));
        await this.io.rename(legacy, this.stateFile);
        this.log(`Migrated state file from ${legacy}`);
        return;
      } catch (error: unknown) {
        this.log(`Migrating legacy state file failed: ${String(error)}`);
      }
    }
  }

  setPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  ensureRecovered(paseo: PaseoApi): Promise<boolean> {
    this.setPaseo(paseo);
    if (this.recovered) return Promise.resolve(true);
    if (this.recoveryPromise) return this.recoveryPromise.then(() => this.recovered);
    this.recoveryPromise = this.migrateStateFileIfNeeded()
      .then(() => this.doRecover(paseo))
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
    agent: { id: string; workspaceId: string | null; cwd: string; parentAgentId: string | null },
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
    if (this.writerByAgentId.has(agent.id)) {
      const originalAgentId = this.writerByAgentId.get(agent.id) ?? agent.id;
      this.writerByAgentId.delete(agent.id);
      this.writerAgentIds.delete(agent.id);
      await this.finalizeHandoff(originalAgentId, paseo);
      await this.archiveAgent(paseo, agent.id);
      return;
    }
    await this.beginIdle(agent, paseo);
  }

  onTurnStarted(agent: { id: string }): void {
    const agentId = agent.id;
    this.clearTimer(agentId);
    this.clearFallbackTimer(agentId);
    if (this.pendingHandoff.has(agentId)) {
      return;
    }
    if (this.entries.delete(agentId)) {
      this.persistEntries();
    }
  }

  onClosed(agent: { id: string }): void {
    this.cleanupAgent(agent.id);
  }

  onArchived(agent: { id: string }): void {
    this.cleanupAgent(agent.id);
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
    const configProvider = buildProviderModel(source.agent.provider, source.agent.model);
    if (!configProvider.includes("/")) {
      throw new Error(
        `Cannot determine a provider/model for agent ${input.agentId}; provider=${source.agent.provider}, model=${source.agent.model ?? "none"}.`,
      );
    }
    const created = await paseo.workspaces.ref(workspaceId).agents.create({
      config: { provider: configProvider },
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

  async openHandoff(pathToOpen: string, paseo: PaseoApi): Promise<{ opened: boolean }> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.status === "done" && candidate.path === pathToOpen,
    );
    if (!entry) throw new Error("Unknown handoff path.");
    let exists = false;
    try {
      exists = await this.io.exists(pathToOpen);
    } catch (error: unknown) {
      this.log(`Checking handoff file failed: ${String(error)}`);
    }
    if (!exists) throw new Error("The handoff file is missing.");
    await this.openFile(pathToOpen);
    return { opened: true };
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
      for (const entry of entries) {
        knownAgentIds.add(entry.agent.id);
        if (entry.agent.labels?.[BATON_WRITER_LABEL] === "1") {
          void this.archiveAgent(paseo, entry.agent.id);
        }
      }
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

    const recoverySettings = await this.readSettings();
    const planned = planRecovery({
      state: loaded,
      now: this.now(),
      knownAgentIds,
      ignoredWorkspaceIds: new Set(recoverySettings.ignoredWorkspaceIds),
      ignoredProjectIds: new Set(recoverySettings.ignoredProjectIds),
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
    agent: { id: string; workspaceId: string | null; cwd: string; parentAgentId: string | null },
    paseo: PaseoApi,
  ): Promise<void> {
    if (!agent.workspaceId) {
      return;
    }
    if (agent.parentAgentId) {
      return;
    }
    if (this.writerAgentIds.has(agent.id)) {
      return;
    }
    const settings = await this.readSettings();
    if (settings.ignoredWorkspaceIds.includes(agent.workspaceId)) {
      return;
    }
    const projectId = await this.workspaceProjectId(paseo, agent.workspaceId);
    if (projectId && settings.ignoredProjectIds.includes(projectId)) return;
    const now = this.now();
    const entry = createPendingEntry({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      projectId: projectId ?? undefined,
      cwd: agent.cwd,
      idleSince: now,
      delayMs: settings.idleDelayMinutes * 60_000,
    });
    this.entries.set(agent.id, entry);
    await this.persistEntries();
    this.setTimer(agent.id, entry.fireAt - now, entry);
  }

  private async workspaceProjectId(paseo: PaseoApi, workspaceId: string): Promise<string | null> {
    try {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      return workspace?.projectId ?? null;
    } catch (error: unknown) {
      this.log(`Reading project for workspace ${workspaceId} failed: ${String(error)}`);
      return null;
    }
  }

  private async readSettings(): Promise<BatonSettings> {
    try {
      const state = await this.settings.read();
      if (state.status === "ready") return state.values;
    } catch (error: unknown) {
      this.log(`Reading settings failed: ${String(error)}`);
    }
    return DEFAULT_SETTINGS;
  }

  private async fire(entry: BatonEntry, paseo: PaseoApi): Promise<void> {
    const { agentId } = entry;
    if (this.disposed) return;
    const status = await this.agentStatus(paseo, agentId);
    this.log(`fire agent=${agentId} status=${status}`);
    if (status !== "idle") {
      this.dropEntry(agentId);
      return;
    }
    this.entries.set(agentId, markWriting(entry, this.now()));
    this.persistEntries();
    this.pendingHandoff.add(agentId);
    this.log(`fire agent=${agentId} handoff started`);
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) {
      this.pendingHandoff.delete(agentId);
      this.markSkippedEntry(agentId);
      return;
    }
    try {
      await this.io.mkdir(path.dirname(handoffPath));
      const settings = await this.readSettings();
      const writer =
        (await this.profileProviderModel(paseo, settings.handoffProfileId)) ??
        (await this.agentProviderModel(paseo, agentId));
      if (writer && writer.providerModel.includes("/")) {
        await this.spawnHandoffWriter(entry, handoffPath, writer, paseo);
      } else {
        this.log(`fire agent=${agentId} no writer model, using mechanical fallback`);
        const path = await this.writeMechanical(entry, paseo);
        const done = markDone(entry, path, this.now());
        this.entries.set(agentId, done);
        this.persistEntries();
        this.pendingHandoff.delete(agentId);
        await this.appendRow(paseo, agentId, {
          agentId,
          path,
          continuedAgentId: done.continuedAgentId,
        });
        return;
      }
    } catch (error: unknown) {
      await this.finalizeHandoff(agentId, paseo);
      this.log(`Handoff prompt for ${agentId} failed, wrote mechanical fallback: ${String(error)}`);
      return;
    }
    this.setFallbackTimer(agentId);
  }

  // Only provider/model/effort are applied; a profile's mode (e.g. plan) would stop the writer saving the file.
  private async profileProviderModel(
    paseo: PaseoApi,
    profileId: string,
  ): Promise<{ providerModel: string; thinkingOptionId: string | null } | null> {
    if (!profileId) return null;
    try {
      const { config } = await paseo.config.get();
      const profile = config.agentProfiles?.find((candidate) => candidate.id === profileId);
      if (!profile) return null;
      return {
        providerModel: buildProviderModel(profile.provider, profile.model ?? null),
        thinkingOptionId: profile.thinkingOptionId ?? null,
      };
    } catch (error: unknown) {
      this.log(`Reading agent profile ${profileId} failed: ${String(error)}`);
      return null;
    }
  }

  private async agentProviderModel(
    paseo: PaseoApi,
    agentId: string,
  ): Promise<{ providerModel: string; thinkingOptionId: string | null } | null> {
    try {
      const snapshot = await paseo.agents.ref(agentId).refresh();
      if (!snapshot) return null;
      return {
        providerModel: buildProviderModel(snapshot.agent.provider, snapshot.agent.model),
        thinkingOptionId: snapshot.agent.thinkingOptionId ?? null,
      };
    } catch (error: unknown) {
      this.log(`Reading agent model for ${agentId} failed: ${String(error)}`);
      return null;
    }
  }

  private async spawnHandoffWriter(
    entry: BatonEntry,
    handoffPath: string,
    writerModel: { providerModel: string; thinkingOptionId: string | null },
    paseo: PaseoApi,
  ): Promise<void> {
    const { providerModel, thinkingOptionId } = writerModel;
    if (!providerModel.includes("/")) {
      throw new Error(`Invalid handoff writer model "${providerModel}"; expected provider/model format.`);
    }
    if (!entry.workspaceId) throw new Error("No workspace for handoff writer.");
    const draft = renderMechanicalHandoff({
      agentId: entry.agentId,
      workspaceId: entry.workspaceId,
      cwd: entry.cwd ?? path.dirname(path.dirname(handoffPath)),
      provider: null,
      timeline: this.lastTimeline.get(entry.agentId) ?? [],
      now: this.now(),
    });
    const writer = await paseo.workspaces.ref(entry.workspaceId).agents.create({
      config: thinkingOptionId ? { provider: providerModel, thinkingOptionId } : { provider: providerModel },
      title: BATON_WRITER_TITLE,
      labels: { [BATON_WRITER_LABEL]: "1" },
      prompt: buildWriterHandoffPrompt(handoffPath, draft),
    });
    this.writerAgentIds.add(writer.id);
    this.writerByAgentId.set(writer.id, entry.agentId);
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

  private cleanupAgent(agentId: string): void {
    this.dropEntry(agentId);
    this.pendingHandoff.delete(agentId);
    this.lastTimeline.delete(agentId);
    this.writerAgentIds.delete(agentId);
    this.writerByAgentId.delete(agentId);
  }

  private async archiveAgent(paseo: PaseoApi, agentId: string): Promise<void> {
    try {
      await paseo.agents.ref(agentId).archive();
    } catch (error: unknown) {
      this.log(`Archiving agent ${agentId} failed: ${String(error)}`);
    }
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