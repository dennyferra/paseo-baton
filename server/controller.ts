import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import path, { dirname } from "node:path";
import { promisify } from "node:util";
import type { BatonEntry, BatonState, BatonSettings, HandoffInfo } from "../shared/baton";
import { batonSettingsSchema, BATON_WRITER_LABEL, BATON_WRITER_TITLE } from "../shared/baton";
import {
  DAY_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_SETTINGS,
  DETAIL_LIMITS,
  HANDOFF_FALLBACK_TIMEOUT_MS,
  isProjectIgnored,
  SUBAGENT_WAIT_LIMIT_MS,
} from "../shared/baton";
import {
  createPendingEntry,
  markContinued,
  markDisabled,
  markDone,
  markSkipped,
  markWriting,
  planRecovery,
  transition,
} from "./core";
import {
  buildWriterHandoffPrompt,
  extractHandoffDocument,
  extractTitleFromDocument,
  isHandoffDocument,
  stampHandoffDocument,
} from "./handoff";
import { handoffFileName, handoffPathFor, resolveStateFile } from "./paths";
import { gatherRepoFacts } from "./repo-facts";
import { isMissing, loadState, nodeStoreIo, saveState, type BatonStoreIo } from "./store";
import { renderMechanicalHandoff } from "./timeline-summary";

type AgentStatus = NonNullable<PaseoAgent["status"]>;
type RowData = {
  agentId: string;
  path: string;
  continuedAgentId?: string;
  continuedTitle?: string;
  notice?: string;
  savedAt?: number;
};
type BatonHandoffInfo = HandoffInfo;
type TurnAgent = { id: string; workspaceId: string | null; cwd: string; parentAgentId: string | null };

export interface BatonControllerDeps {
  dataDir: string;
  settings: PluginSettings<typeof batonSettingsSchema>;
  log(message: string): void;
  io?: BatonStoreIo;
  now?: () => number;
  openFile?: (filePath: string) => Promise<void>;
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

/** Timeline entries are read back in pages of this size, as many as the conversation detail level allows. */
const TIMELINE_PAGE_SIZE = 200;
/** The writer's own conversation is short: its prompt and one reply. */
const WRITER_TIMELINE_PAGES = 2;
const HISTORY_CUT_NOTICE = "Earlier history was cut, so the task may be incomplete.";
const WRITER_READ_ATTEMPTS = 3;
const WRITER_READ_RETRY_MS = 500;

function idleDelayMs(settings: BatonSettings): number {
  return settings.idleDelayMinutes * 60_000;
}

export class BatonController {
  private readonly dataDir: string;
  private readonly settings: PluginSettings<typeof batonSettingsSchema>;
  private readonly log: (message: string) => void;
  private readonly io: BatonStoreIo;
  private readonly now: () => number;
  private readonly openFile: (filePath: string) => Promise<void>;
  private readonly stateFile: string;
  private paseo: PaseoApi | null = null;
  /** Subagents mid-turn, keyed by subagent id, valued by when the turn started. */
  private readonly busySubagents = new Map<string, number>();
  /** Subagent id to parent id, kept after the turn ends so nested subagents can be traced to their root. */
  private readonly parentOf = new Map<string, string>();
  private entries = new Map<string, BatonEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingHandoff = new Set<string>();
  /** The conversation read back for each agent; `cut` means older entries were left out, so the first request may be missing. */
  private lastTimeline = new Map<string, { items: readonly AgentTimelineItem[]; cut: boolean }>();
  private workspaceDirCache = new Map<string, string | null>();
  private writerAgentIds = new Set<string>();
  private pathNotices = new Map<string, string>();
  private writerByAgentId = new Map<string, string>();
  private housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupRun: Promise<number> | null = null;
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
        this.startHousekeeping();
      });
    return this.recoveryPromise.then(() => this.recovered);
  }

  async onTurnEnded(
    agent: TurnAgent,
    timeline: readonly AgentTimelineItem[],
    paseo: PaseoApi,
  ): Promise<void> {
    this.setPaseo(paseo);
    this.busySubagents.delete(agent.id);
    await this.ensureRecovered(paseo);
    if (this.disposed) return;
    // Newer Paseo versions send an empty timeline here, so an empty one is read back when it is needed.
    if (timeline.length > 0) this.lastTimeline.set(agent.id, { items: timeline, cut: false });
    else this.lastTimeline.delete(agent.id);
    if (this.pendingHandoff.has(agent.id)) {
      await this.finalizeHandoff(agent.id, paseo);
      return;
    }
    if (this.writerByAgentId.has(agent.id)) {
      const originalAgentId = this.writerByAgentId.get(agent.id) ?? agent.id;
      this.writerByAgentId.delete(agent.id);
      this.writerAgentIds.delete(agent.id);
      const document = timeline.length > 0 ? extractHandoffDocument(timeline) : await this.readWriterDocument(agent.id, paseo);
      await this.finalizeHandoff(originalAgentId, paseo, document);
      await this.logWriterUsage(originalAgentId, agent.id, paseo);
      await this.archiveAgent(paseo, agent.id);
      return;
    }
    await this.beginIdle(agent, paseo);
  }

  onTurnStarted(agent: Pick<TurnAgent, "id"> & { parentAgentId?: string | null }): void {
    const agentId = agent.id;
    if (agent.parentAgentId) {
      this.parentOf.set(agentId, agent.parentAgentId);
      this.busySubagents.set(agentId, this.now());
    }
    this.clearTimer(agentId);
    this.clearFallbackTimer(agentId);
    if (this.pendingHandoff.has(agentId)) {
      return;
    }
    const entry = this.entries.get(agentId);
    if (!entry || entry.status === "disabled") return;
    this.entries.delete(agentId);
    this.persistEntries();
    // The user kept working in this session, so a handoff nobody continued is stale.
    if (entry.status === "done" && entry.path && !entry.continuedAgentId) {
      void this.removeStaleHandoff(entry.path);
    }
  }

  /** Runs the cleanup now and then once a day for as long as the plugin runs. */
  private startHousekeeping(): void {
    if (this.disposed || this.housekeepingTimer) return;
    const run = () => {
      void this.cleanupOldHandoffs().catch((error: unknown) => {
        this.log(`Handoff cleanup failed: ${String(error)}`);
      });
    };
    run();
    this.housekeepingTimer = setInterval(run, DAY_MS);
    this.housekeepingTimer.unref?.();
  }

  /** Deletes handoff files nobody continued once they are older than the configured number of days. */
  cleanupOldHandoffs(): Promise<number> {
    this.cleanupRun ??= this.sweepOldHandoffs().finally(() => {
      this.cleanupRun = null;
    });
    return this.cleanupRun;
  }

  private async sweepOldHandoffs(): Promise<number> {
    const settings = await this.readSettings();
    if (!settings.cleanupOldHandoffs) return 0;
    const cutoff = this.now() - settings.cleanupAfterDays * DAY_MS;
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.status !== "done" || !entry.path || entry.continuedAgentId || entry.updatedAt > cutoff) continue;
      // Only ever delete the agent's own handoff file, whatever the state file says.
      if (path.basename(entry.path) !== handoffFileName(entry.agentId)) continue;
      // Drop the record first so a handoff can't be continued while its file is being deleted.
      this.entries.delete(entry.agentId);
      try {
        await this.io.unlink(entry.path);
      } catch (error: unknown) {
        if (!isMissing(error)) {
          this.log(`Removing old handoff ${entry.path} failed: ${String(error)}`);
          this.entries.set(entry.agentId, entry);
          continue;
        }
      }
      removed += 1;
    }
    if (removed > 0) await this.persistEntries();
    return removed;
  }

  private async removeStaleHandoff(handoffPath: string): Promise<void> {
    try {
      if (!(await this.readSettings()).deleteStaleHandoffs) return;
      await this.io.unlink(handoffPath);
    } catch (error: unknown) {
      this.log(`Removing stale handoff ${handoffPath} failed: ${String(error)}`);
    }
  }

  /** Writes the handoff immediately instead of waiting for the idle timer. */
  async createNow(input: { agentId: string }, paseo: PaseoApi): Promise<{ started: boolean }> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    const { agentId } = input;
    const existing = this.entries.get(agentId);
    if (existing?.status === "done") throw new Error("A handoff already exists for this agent.");
    if (existing?.status === "writing" || this.pendingHandoff.has(agentId)) {
      throw new Error("A handoff is already being written for this agent.");
    }
    if (existing?.status === "disabled") throw new Error("Handoffs are turned off for this agent. Turn them on first.");
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot) throw new Error("The agent no longer exists.");
    const agent = snapshot.agent;
    if (agent.status !== "idle") throw new Error("The agent is still working. Try again once it is idle.");
    if (agent.labels?.[BATON_WRITER_LABEL]) throw new Error("Handoff writers do not get handoffs.");
    if (!agent.workspaceId) throw new Error("The agent has no workspace.");
    const settings = await this.readSettings();
    if (settings.ignoredWorkspaceIds.includes(agent.workspaceId)) throw new Error("This workspace is ignored in Baton settings.");
    const projectId = await this.workspaceProjectId(paseo, agent.workspaceId);
    if (projectId && isProjectIgnored(settings, projectId)) {
      throw new Error("This project is ignored in Baton settings.");
    }
    this.clearTimer(agentId);
    await this.ensureTimeline(agentId, paseo, settings);
    const entry = createPendingEntry({
      agentId,
      workspaceId: agent.workspaceId,
      projectId: projectId ?? undefined,
      cwd: agent.cwd,
      idleSince: this.now(),
      delayMs: 0,
    });
    this.entries.set(agentId, entry);
    await this.persistEntries();
    void this.fire(entry, paseo).catch((error: unknown) => {
      this.log(`Creating handoff now for ${agentId} failed: ${String(error)}`);
    });
    return { started: true };
  }

  // The writer's reply may not be in the timeline the instant its turn ends, so look a few times.
  private async readWriterDocument(writerId: string, paseo: PaseoApi): Promise<string | null> {
    for (let attempt = 0; attempt < WRITER_READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, WRITER_READ_RETRY_MS));
      const document = extractHandoffDocument((await this.fetchTimeline(writerId, paseo, WRITER_TIMELINE_PAGES)).items);
      if (document) return document;
    }
    return null;
  }

  /** Reads the conversation back newest page first, up to maxPages; `cut` is true when older entries remain. */
  private async fetchTimeline(
    agentId: string,
    paseo: PaseoApi,
    maxPages: number,
  ): Promise<{ items: AgentTimelineItem[]; cut: boolean }> {
    try {
      const timeline = paseo.agents.ref(agentId).timeline;
      let page = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE_SIZE });
      let items = page.entries.map((entry) => entry.item);
      for (let pages = 1; page.hasOlder && page.startCursor && pages < maxPages; pages++) {
        page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: TIMELINE_PAGE_SIZE });
        items = [...page.entries.map((entry) => entry.item), ...items];
      }
      return { items, cut: Boolean(page.hasOlder) };
    } catch (error: unknown) {
      this.log(`Reading the conversation for ${agentId} failed: ${String(error)}`);
      return { items: [], cut: false };
    }
  }

  // Turn events may carry no conversation (always so on recent Paseo, and after a plugin reload),
  // so read the recent conversation back when a handoff is about to be written.
  private async ensureTimeline(agentId: string, paseo: PaseoApi, settings: BatonSettings): Promise<void> {
    if ((this.lastTimeline.get(agentId)?.items.length ?? 0) > 0) return;
    const pages = Math.ceil(DETAIL_LIMITS[settings.conversationDetail].historyEntries / TIMELINE_PAGE_SIZE);
    const { items, cut } = await this.fetchTimeline(agentId, paseo, pages);
    if (items.length > 0) this.lastTimeline.set(agentId, { items, cut });
  }

  /** The machine draft: what Baton knows of the conversation, within the configured detail level. */
  private async buildDraft(entry: BatonEntry, handoffPath: string, paseo: PaseoApi): Promise<string> {
    const settings = await this.readSettings();
    await this.ensureTimeline(entry.agentId, paseo, settings);
    const conversation = this.lastTimeline.get(entry.agentId);
    const cwd = entry.cwd ?? path.dirname(path.dirname(handoffPath));
    return renderMechanicalHandoff({
      agentId: entry.agentId,
      workspaceId: entry.workspaceId,
      cwd,
      provider: null,
      timeline: conversation?.items ?? [],
      now: this.now(),
      limits: DETAIL_LIMITS[settings.conversationDetail],
      historyCut: conversation?.cut ?? false,
      repoFacts: settings.includeRepoState ? await gatherRepoFacts(cwd) : "",
    });
  }

  async setEnabled(
    input: { agentId: string; enabled: boolean },
    paseo: PaseoApi,
  ): Promise<{ enabled: boolean }> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    const existing = this.entries.get(input.agentId);
    if (input.enabled) {
      if (existing?.status === "disabled") {
        this.entries.delete(input.agentId);
        await this.persistEntries();
      }
      return { enabled: true };
    }
    if (existing?.status === "disabled") return { enabled: false };
    if (existing?.status === "done") throw new Error("A handoff already exists for this agent.");
    const snapshot = await paseo.agents.ref(input.agentId).refresh();
    if (!snapshot) throw new Error("The agent no longer exists.");
    const workspaceId = snapshot.agent.workspaceId ?? existing?.workspaceId;
    if (!workspaceId) throw new Error("The agent has no workspace.");
    this.clearTimer(input.agentId);
    this.clearFallbackTimer(input.agentId);
    const now = this.now();
    this.entries.set(
      input.agentId,
      markDisabled(
        existing ?? {
          agentId: input.agentId,
          workspaceId,
          cwd: snapshot.agent.cwd,
          idleSince: now,
          fireAt: now,
          deadline: now,
          updatedAt: now,
          status: "pending",
        },
        now,
      ),
    );
    await this.persistEntries();
    return { enabled: false };
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
    const thinkingOptionId = source.agent.thinkingOptionId ?? null;
    const created = await paseo.workspaces.ref(workspaceId).agents.create({
      config: thinkingOptionId ? { provider: configProvider, thinkingOptionId } : { provider: configProvider },
      title: `[Handoff] ${title}`,
      prompt: `Read ${entry.path} and continue the task.`,
    });
    const newAgentId = created.id;
    const updated = markContinued(entry, newAgentId, this.now(), `[Handoff] ${title}`);
    this.entries.set(input.agentId, updated);
    this.persistEntries();
    await this.appendRow(paseo, input.agentId, {
      agentId: input.agentId,
      path: entry.path,
      continuedAgentId: newAgentId,
    });
    return { agentId: newAgentId, title };
  }

  async archive(input: { agentId: string }, paseo: PaseoApi): Promise<{ archived: boolean }> {
    const entry = this.entries.get(input.agentId);
    if (!entry || entry.status !== "done" || !entry.continuedAgentId) {
      throw new Error("Only an agent whose handoff was continued can be archived from Baton.");
    }
    await paseo.agents.ref(input.agentId).archive();
    return { archived: true };
  }

  async wake(
    paseo: PaseoApi,
    workspaceIds: readonly string[] = [],
  ): Promise<{
    recovered: boolean;
    handoffs: BatonHandoffInfo[];
    disabledAgentIds: string[];
    writingAgentIds: string[];
    ignoredWorkspaces: Record<string, "workspace" | "project">;
  }> {
    this.setPaseo(paseo);
    const recovered = await this.ensureRecovered(paseo);
    const handoffs: BatonHandoffInfo[] = [];
    const disabledAgentIds: string[] = [];
    const writingAgentIds: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "disabled") disabledAgentIds.push(entry.agentId);
      if (entry.status === "writing") writingAgentIds.push(entry.agentId);
      if (entry.status === "done" && entry.path) {
        handoffs.push({
          agentId: entry.agentId,
          workspaceId: entry.workspaceId,
          path: entry.path,
          continuedAgentId: entry.continuedAgentId,
        });
      }
    }
    const ignoredWorkspaces = await this.ignoredWorkspaces(paseo, workspaceIds);
    return { recovered, handoffs, disabledAgentIds, writingAgentIds, ignoredWorkspaces };
  }

  async readHandoff(pathToRead: string, paseo: PaseoApi): Promise<{ content: string }> {
    this.setPaseo(paseo);
    await this.ensureRecovered(paseo);
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.status === "done" && candidate.path === pathToRead,
    );
    if (!entry) throw new Error("This handoff can no longer be opened here because the session was continued after it was saved. The file may still be on disk.");
    try {
      return { content: await this.io.readFile(pathToRead) };
    } catch {
      throw new Error("The handoff file is missing.");
    }
  }

  private async ignoredWorkspaces(
    paseo: PaseoApi,
    workspaceIds: readonly string[],
  ): Promise<Record<string, "workspace" | "project">> {
    const ignored: Record<string, "workspace" | "project"> = {};
    if (workspaceIds.length === 0) return ignored;
    const settings = await this.readSettings();
    for (const workspaceId of new Set(workspaceIds)) {
      if (settings.ignoredWorkspaceIds.includes(workspaceId)) {
        ignored[workspaceId] = "workspace";
      } else if (settings.ignoredProjectIds.length > 0 || settings.ignoreNewProjects) {
        const projectId = await this.workspaceProjectId(paseo, workspaceId);
        if (projectId && isProjectIgnored(settings, projectId)) ignored[workspaceId] = "project";
      }
    }
    return ignored;
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
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = null;
    this.timers.clear();
    this.fallbackTimers.clear();
    await this.cleanupRun?.catch(() => undefined);
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
      isProjectIgnored: (projectId) => isProjectIgnored(recoverySettings, projectId),
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
    agent: TurnAgent,
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
    if (this.entries.get(agent.id)?.status === "disabled") return;
    const settings = await this.readSettings();
    if (settings.ignoredWorkspaceIds.includes(agent.workspaceId)) {
      return;
    }
    const projectId = await this.workspaceProjectId(paseo, agent.workspaceId);
    if (projectId && isProjectIgnored(settings, projectId)) return;
    const now = this.now();
    const entry = createPendingEntry({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      projectId: projectId ?? undefined,
      cwd: agent.cwd,
      idleSince: now,
      delayMs: idleDelayMs(settings),
    });
    await this.armEntry(entry);
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

  /** Restarts the countdown instead of writing while the agent's subagents are still working. */
  private async deferOrFire(entry: BatonEntry, paseo: PaseoApi): Promise<void> {
    const settings = await this.readSettings();
    if (settings.waitForSubagents && this.hasBusySubagents(entry.agentId)) {
      const now = this.now();
      await this.armEntry(transition(entry, { fireAt: now + idleDelayMs(settings) }, now));
      return;
    }
    await this.fire(entry, paseo);
  }

  /** True while any descendant of the agent is mid-turn; turns older than the wait limit are ignored. */
  private hasBusySubagents(agentId: string): boolean {
    const now = this.now();
    for (const [subagentId, since] of this.busySubagents) {
      if (now - since > SUBAGENT_WAIT_LIMIT_MS) continue;
      const seen = new Set<string>();
      for (let id = this.parentOf.get(subagentId); id && !seen.has(id); id = this.parentOf.get(id)) {
        if (id === agentId) return true;
        seen.add(id);
      }
    }
    return false;
  }

  private async armEntry(entry: BatonEntry): Promise<void> {
    this.entries.set(entry.agentId, entry);
    await this.persistEntries();
    this.setTimer(entry.agentId, entry.fireAt - this.now(), entry);
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
      // A file left by an earlier handoff must not be mistaken for one the writer saved itself.
      await this.io.unlink(handoffPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
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
    const draft = await this.buildDraft(entry, handoffPath, paseo);
    const writer = await paseo.workspaces.ref(entry.workspaceId).agents.create({
      config: thinkingOptionId ? { provider: providerModel, thinkingOptionId } : { provider: providerModel },
      title: BATON_WRITER_TITLE,
      labels: { [BATON_WRITER_LABEL]: "1" },
      prompt: buildWriterHandoffPrompt(draft),
    });
    this.writerAgentIds.add(writer.id);
    this.writerByAgentId.set(writer.id, entry.agentId);
  }

  private async finalizeHandoff(agentId: string, paseo: PaseoApi, document: string | null = null): Promise<void> {
    this.clearFallbackTimer(agentId);
    this.pendingHandoff.delete(agentId);
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) {
      this.markSkippedEntry(agentId);
      return;
    }
    // The writer's reply is the document. A writer that saved the file itself and replied with only a
    // confirmation is accepted too, so either way Baton ends up stamping a real handoff.
    const saved = (document && (await this.saveWriterDocument(agentId, handoffPath, document))) || (await this.stampSavedFile(agentId, handoffPath));
    const path = saved ? handoffPath : await this.writeMechanical(entry, paseo);
    const done = markDone(entry, path, this.now());
    this.entries.set(agentId, done);
    this.persistEntries();
    await this.appendRow(paseo, agentId, {
      agentId,
      path,
      continuedAgentId: done.continuedAgentId,
    });
  }

  private async saveWriterDocument(agentId: string, handoffPath: string, document: string): Promise<boolean> {
    try {
      await this.io.mkdir(dirname(handoffPath));
      await this.io.writeFile(handoffPath, stampHandoffDocument(document, this.now()));
      return true;
    } catch (error: unknown) {
      this.log(`Writing handoff document for ${agentId} failed: ${String(error)}`);
      return false;
    }
  }

  /** Adds the Created line to a handoff file the writer saved itself. False when there is no usable file. */
  private async stampSavedFile(agentId: string, handoffPath: string): Promise<boolean> {
    try {
      const text = await this.io.readFile(handoffPath);
      if (!isHandoffDocument(text)) return false;
      await this.io.writeFile(handoffPath, stampHandoffDocument(text, this.now()));
      return true;
    } catch (error: unknown) {
      if (!isMissing(error)) this.log(`Reading the handoff file for ${agentId} failed: ${String(error)}`);
      return false;
    }
  }

  private async writeMechanical(entry: BatonEntry, paseo: PaseoApi): Promise<string> {
    const handoffPath = await this.pathForEntry(entry, paseo);
    if (!handoffPath) throw new Error(`Cannot resolve handoff path for ${entry.agentId}`);
    await this.io.mkdir(path.dirname(handoffPath));
    const content = await this.buildDraft(entry, handoffPath, paseo);
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
      void this.deferOrFire(current, paseo).catch((error: unknown) => {
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
    this.busySubagents.delete(agentId);
    this.parentOf.delete(agentId);
    this.dropEntry(agentId);
    this.pendingHandoff.delete(agentId);
    this.lastTimeline.delete(agentId);
    this.writerAgentIds.delete(agentId);
    this.writerByAgentId.delete(agentId);
  }

  /** Logs the writer's last model call, which shows how big its context was and what the handoff cost. */
  private async logWriterUsage(agentId: string, writerId: string, paseo: PaseoApi): Promise<void> {
    try {
      const usage = (await paseo.agents.ref(writerId).refresh())?.agent.lastUsage;
      this.log(`Handoff writer for ${agentId} usage: ${JSON.stringify(usage ?? null)}`);
    } catch (error: unknown) {
      this.log(`Reading the handoff writer's usage for ${writerId} failed: ${String(error)}`);
    }
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
    if (entry.status === "done" && entry.path) return entry.path;
    const cwd = entry.cwd || (await this.resolveWorkspaceDir(entry.workspaceId, paseo));
    if (!cwd) return null;
    const custom = (await this.readSettings()).handoffDirectory;
    const chosen = handoffPathFor(cwd, entry.agentId, custom);
    if (!custom.trim()) return chosen;
    try {
      await this.io.mkdir(dirname(chosen));
      this.pathNotices.delete(entry.agentId);
      return chosen;
    } catch (error: unknown) {
      // An unusable custom location must not lose the handoff; use the default folder and say so.
      this.log(`Storage location ${custom} is not usable: ${String(error)}`);
      const reason = error instanceof Error ? error.message : String(error);
      this.pathNotices.set(
        entry.agentId,
        `Saved to the default folder because the storage location "${custom}" could not be used: ${reason}`,
      );
      return handoffPathFor(cwd, entry.agentId);
    }
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

  /** The notices for an agent's row: why the handoff went to another folder, and that history was cut. */
  private takeNotice(agentId: string): string {
    const notice = [this.pathNotices.get(agentId), this.lastTimeline.get(agentId)?.cut ? HISTORY_CUT_NOTICE : undefined]
      .filter(Boolean)
      .join(" ");
    this.pathNotices.delete(agentId);
    return notice;
  }

  private async appendRow(
    paseo: PaseoApi,
    agentId: string,
    data: RowData,
  ): Promise<void> {
    // One row per handoff: idleSince is stable for the entry's life, so continuing updates the row in
    // place, while a later handoff for the same agent gets its own row instead of reusing the old one.
    const rowKey = this.entries.get(agentId)?.idleSince ?? 0;
    const continuedTitle = this.entries.get(agentId)?.continuedTitle;
    const savedAt = this.entries.get(agentId)?.savedAt;
    if (savedAt && !data.savedAt) data = { ...data, savedAt };
    if (continuedTitle && !data.continuedTitle) data = { ...data, continuedTitle };
    const notice = this.takeNotice(agentId);
    if (notice) data = { ...data, notice };
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `baton:${agentId}:${rowKey}`,
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