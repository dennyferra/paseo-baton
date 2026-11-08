/**
 * Timeline ids for Baton's rows. Every id is built and parsed here, so the writer and the reader of a row cannot drift
 * apart.
 */

/**
 * The threshold prompt's row. One per agent: a later prompt replaces an earlier one in place, so an old prompt never
 * sits in the chat beside a newer one.
 */
export function thresholdRowId(agentId: string): string {
  return `baton-threshold:${agentId}`;
}

/** The prefix every handoff row id for an agent starts with. */
export function handoffRowPrefix(agentId: string): string {
  return `baton:${agentId}:`;
}

/** One handoff's row, keyed by when its entry began, so each handoff has its own row. */
export function handoffRowId(agentId: string, rowKey: number): string {
  return `${handoffRowPrefix(agentId)}${rowKey}`;
}

/** The row key of a handoff row id for this agent, or undefined when the id is not one of its handoff rows. */
export function handoffRowKey(agentId: string, rowId: string): number | undefined {
  const prefix = handoffRowPrefix(agentId);
  if (!rowId.startsWith(prefix)) return undefined;
  const key = rowId.slice(prefix.length);
  return /^\d+$/.test(key) ? Number(key) : undefined;
}
