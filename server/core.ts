import type { BatonEntry, BatonState } from "../shared/baton";
import { MIN_FIRE_DELAY_MS } from "../shared/baton";

export interface BatonClock {
  now(): number;
}

export function createPendingEntry(input: {
  agentId: string;
  workspaceId: string;
  cwd?: string;
  idleSince: number;
  ttlMs: number;
  marginMs: number;
}): BatonEntry {
  const deadline = input.idleSince + input.ttlMs;
  const fireAt = Math.max(input.idleSince + MIN_FIRE_DELAY_MS, deadline - input.marginMs);
  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    idleSince: input.idleSince,
    fireAt,
    deadline,
    updatedAt: input.idleSince,
    status: "pending",
  };
}

export function transition(entry: BatonEntry, patch: Partial<BatonEntry>, now: number): BatonEntry {
  return { ...entry, ...patch, updatedAt: now };
}

export function markWriting(entry: BatonEntry, now: number): BatonEntry {
  return transition(entry, { status: "writing" }, now);
}

export function markDone(entry: BatonEntry, path: string, now: number): BatonEntry {
  return transition(entry, { status: "done", path }, now);
}

export function markSkipped(entry: BatonEntry, now: number): BatonEntry {
  return transition(entry, { status: "skipped" }, now);
}

export function markContinued(entry: BatonEntry, continuedAgentId: string, now: number): BatonEntry {
  return transition(entry, { continuedAgentId }, now);
}

export function isExpired(entry: BatonEntry, now: number): boolean {
  return now > entry.deadline;
}

export type RecoveryAction =
  | { kind: "drop" }
  | { kind: "keepDone" }
  | { kind: "keepSkipped" }
  | { kind: "markSkipped" }
  | { kind: "fireNow" }
  | { kind: "schedule"; delayMs: number }
  | { kind: "recoverDone"; path: string };

export interface PlanRecoveryInput {
  state: BatonState;
  now: number;
  knownAgentIds: ReadonlySet<string>;
  ignoredWorkspaceIds?: ReadonlySet<string>;
  handoffPath: (agentId: string) => string | null;
  retentionMs: number;
}

export interface PlanRecoveryResult {
  state: BatonState;
  actions: Map<string, RecoveryAction>;
}

export function planRecovery(input: PlanRecoveryInput): PlanRecoveryResult {
  const actions = new Map<string, RecoveryAction>();
  const next: BatonState = {};
  for (const [agentId, entry] of Object.entries(input.state)) {
    const action = decideEntry(agentId, entry, input);
    actions.set(agentId, action);
    if (action.kind === "drop") continue;
    if (action.kind === "recoverDone") {
      next[agentId] = markDone(entry, action.path, input.now);
    } else if (action.kind === "markSkipped") {
      next[agentId] = markSkipped(entry, input.now);
    } else {
      next[agentId] = entry;
    }
  }
  return { state: next, actions };
}

function decideEntry(
  agentId: string,
  entry: BatonEntry,
  input: PlanRecoveryInput,
): RecoveryAction {
  const age = input.now - entry.updatedAt;
  if (entry.status === "done") {
    return age >= input.retentionMs ? { kind: "drop" } : { kind: "keepDone" };
  }
  if (entry.status === "skipped") {
    return age >= input.retentionMs ? { kind: "drop" } : { kind: "keepSkipped" };
  }
  if (!input.knownAgentIds.has(agentId)) return { kind: "drop" };
  if (input.ignoredWorkspaceIds?.has(entry.workspaceId)) return { kind: "drop" };
  if (entry.status === "writing") {
    const existing = input.handoffPath(agentId);
    if (existing) return { kind: "recoverDone", path: existing };
  }
  if (input.now > entry.deadline) return { kind: "markSkipped" };
  if (input.now >= entry.fireAt) return { kind: "fireNow" };
  return { kind: "schedule", delayMs: entry.fireAt - input.now };
}