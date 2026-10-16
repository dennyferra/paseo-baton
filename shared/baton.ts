import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const BATON_PLUGIN_ID = "baton";

export const BATON_STATUS = z.enum(["pending", "writing", "done", "skipped", "disabled"]);
export type BatonStatus = z.infer<typeof BATON_STATUS>;

export const batonEntrySchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().optional(),
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

export const DEFAULT_IDLE_DELAY_MINUTES = 15;
export const HANDOFF_DEADLINE_SLACK_MS = 60 * 60 * 1000;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_FALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
export const MIN_FIRE_DELAY_MS = 1000;

export const batonSettingsSchema = z.object({
  idleDelayMinutes: z.number().int().min(1).max(240).default(DEFAULT_IDLE_DELAY_MINUTES),
  handoffProfileId: z.string().trim().max(200).default(""),
  handoffDirectory: z.string().trim().max(500).default(""),
  deleteStaleHandoffs: z.boolean().default(true),
  ignoredWorkspaceIds: z.array(z.string()).default([]),
  ignoredProjectIds: z.array(z.string()).default([]),
});
export type BatonSettings = z.infer<typeof batonSettingsSchema>;

export const DEFAULT_SETTINGS: BatonSettings = batonSettingsSchema.parse({});

export const batonSettings = defineSettings({
  id: "baton",
  scope: "host",
  version: 7,
  schema: batonSettingsSchema,
  migrate: (values) => {
    const old = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...(typeof old.idleDelayMinutes === "number" ? { idleDelayMinutes: old.idleDelayMinutes } : {}),
      ...(typeof old.handoffProfileId === "string" ? { handoffProfileId: old.handoffProfileId } : {}),
      ...(typeof old.deleteStaleHandoffs === "boolean" ? { deleteStaleHandoffs: old.deleteStaleHandoffs } : {}),
      ...(typeof old.handoffDirectory === "string" ? { handoffDirectory: old.handoffDirectory } : {}),
      ...(Array.isArray(old.ignoredWorkspaceIds) ? { ignoredWorkspaceIds: old.ignoredWorkspaceIds } : {}),
    };
  },
});

export const BATON_WRITER_LABEL = "baton-writer";
export const BATON_WRITER_TITLE = "[Handoff writer]";

export const batonRowSchema = z.object({
  agentId: z.string(),
  path: z.string(),
  continuedAgentId: z.string().optional(),
  notice: z.string().optional(),
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

export const readHandoffRpc = defineRpc({
  name: "baton.read",
  input: z.object({
    path: z.string(),
  }),
  output: z.object({
    content: z.string(),
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
  input: z.object({ workspaceIds: z.array(z.string()).default([]) }),
  output: z.object({
    recovered: z.boolean(),
    handoffs: z.array(handoffInfoSchema),
    disabledAgentIds: z.array(z.string()).default([]),
    writingAgentIds: z.array(z.string()).default([]),
    ignoredWorkspaces: z.record(z.string(), z.enum(["workspace", "project"])).default({}),
  }),
});

export const createNowRpc = defineRpc({
  name: "baton.create-now",
  input: z.object({
    agentId: z.string(),
  }),
  output: z.object({
    started: z.boolean(),
  }),
});

export const setEnabledRpc = defineRpc({
  name: "baton.set-enabled",
  input: z.object({
    agentId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    enabled: z.boolean(),
  }),
});