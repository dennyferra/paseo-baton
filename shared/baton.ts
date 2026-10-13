import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BATON_PLUGIN_ID = "paseo-baton";

export const BATON_STATUS = z.enum(["pending", "writing", "done", "skipped"]);
export type BatonStatus = z.infer<typeof BATON_STATUS>;

export const batonEntrySchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  cwd: z.string().optional(),
  idleSince: z.number(),
  fireAt: z.number(),
  deadline: z.number(),
  updatedAt: z.number(),
  status: BATON_STATUS,
  path: z.string().optional(),
  continuedAgentId: z.string().optional(),
});
export type BatonEntry = z.infer<typeof batonEntrySchema>;

export const batonStateSchema = z.record(z.string(), batonEntrySchema);
export type BatonState = z.infer<typeof batonStateSchema>;

export const HANDOFF_REL_DIR = ".paseo/handoffs";

export const HANDOFF_TEMPLATE_SECTIONS = [
  "Task",
  "Context",
  "Relevant files",
  "Current state",
  "What was tried",
  "Decisions",
  "Acceptance criteria",
  "Constraints",
] as const;

export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SAFETY_MARGIN_MS = 30 * 1000;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_FALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
export const MIN_FIRE_DELAY_MS = 1000;

export const batonSettingsSchema = z.object({
  idleTtlMinutes: z.number().int().min(1).max(1440).default(5),
});
export type BatonSettings = z.infer<typeof batonSettingsSchema>;

export const batonRowSchema = z.object({
  agentId: z.string(),
  path: z.string(),
  continuedAgentId: z.string().optional(),
});
export type BatonRowData = z.infer<typeof batonRowSchema>;

export const continueHandoffRpc = defineRpc({
  name: "baton.continue",
  input: z.object({
    agentId: z.string(),
    path: z.string(),
  }),
  output: z.object({
    agentId: z.string(),
    title: z.string(),
  }),
});

export const openHandoffRpc = defineRpc({
  name: "baton.open",
  input: z.object({
    path: z.string(),
  }),
  output: z.object({
    opened: z.boolean(),
  }),
});

export const handoffInfoSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  continuedAgentId: z.string().optional(),
});
export type HandoffInfo = z.infer<typeof handoffInfoSchema>;

export const wakeRpc = defineRpc({
  name: "baton.wake",
  input: z.object({}),
  output: z.object({
    recovered: z.boolean(),
    handoffs: z.array(handoffInfoSchema),
  }),
});