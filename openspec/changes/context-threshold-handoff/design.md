# Design

## Context

Baton's handoff writer runs today when an agent has been idle for the configured delay (15 minutes by default). The plugin already reads per-agent usage through `paseo.agents.ref(id).refresh()` for its writer agents, using the `lastUsage` field. The plugin SDK types do not declare `lastUsage`. Its fields are `contextWindowUsedTokens` and `contextWindowMaxTokens`, and some providers may leave the maximum unset. See proposal.md for motivation and specs/context-usage-handoff/spec.md for the requirements.

## Goals / Non-Goals

**Goals:**
- Trigger a handoff from context fill, read once per turn, without polling.
- Keep the idle handoff and avoid writing two handoffs for the same context.
- Keep the chip to text, with no colour and no new surface beyond the existing Baton menu.

**Non-Goals:**
- Auto-writing the handoff at the threshold, or auto-continuing into a new agent.
- Live usage updates during a turn.
- Colour states on the chip.
- Changing the handoff document format.

## Decisions

**Read usage at `agent.turn.after`, through `refresh()`.** The hook already fires once per turn with the agent id, and `refresh()` returns the daemon's current snapshot, including `lastUsage`. It does not trigger a model call. Alternative considered: subscribing to provider usage events. Rejected: the plugin SDK does not expose them.

**Store thresholds and per-context state in plugin data.** Global settings go in the existing Baton settings with new keys and defaults, with no version bump, so `migrate` keeps them. Per-agent overrides and the fired flag go in plugin data keyed by agent id, with the context identifier stored alongside the fired flag. Alternative considered: session memory. Rejected: a daemon restart would lose overrides, and the spec requires them to survive a restart.

**Track the context as a counter per agent.** The counter advances when a new session starts for the agent or when the user continues from a handoff. The prompt flag and the handoff flag each record the counter value they were set for, so a new context clears both without a reset. This avoids guessing context boundaries from usage numbers.

**Reuse the existing writer for the threshold handoff.** The threshold path calls the same handoff writer the idle path uses, so the file format, the "Handoff saved" row, and the Continue action stay unchanged. The writer's existing guard against concurrent writes for the same agent applies.

**Use the fallback only when no maximum is reported.** When `contextWindowMaxTokens` is present, the trigger uses the percentage of that maximum. When it is absent, the trigger applies the global percentage to the 120,000-token fallback, so 60% is 72,000 tokens. Alternative considered: hide the chip for those agents. Rejected by the user, who chose the fallback.

**Chip as a plugin button label.** The button's `label` carries the text, updated when a turn ends. The SDK has no colour field, so the chip shows no colour states.

**Idle skip uses a handoff flag, separate from the prompt flag.** A prompt sets only the prompt flag. A handoff file being written sets the handoff flag for the agent's current counter value. When the idle timer fires, Baton skips the idle write only if the handoff flag matches the current counter. An unacted prompt therefore never suppresses the idle handoff.

## Risks / Trade-offs

- **`lastUsage` may not be populated for ordinary agents.** The evidence so far comes from code paths and writer-agent logs, not from a real non-writer session. → Mitigation: before implementing the trigger, run a real session on each provider in use and confirm that `lastUsage` is populated. If it is not, stop and revisit the approach with the user.
- **Some providers report no context maximum.** → Mitigation: the absolute fallback in the spec, which is also the chip's basis for those agents.
- **The chip lags during a long turn.** Usage updates only at turn end. → Mitigation: accepted by the user. The chip is informational and the threshold check runs at turn end anyway.
- **`contextWindowUsedTokens` includes cache and output tokens, not only input.** A percentage therefore measures how full the window is, which matches the intent of the threshold. → Mitigation: document the meaning in the settings description.
- **A turn may end while a handoff write is already running.** → Mitigation: the existing writer guard prevents a second write for the same agent. The fired flag stops a repeat prompt.

## Migration Plan

- No settings version bump. The new keys have defaults, so an existing install behaves as before until the threshold triggers.
- Rollout is a plugin reload in Paseo.
- Rollback: set the global threshold to 95 and clear any per-agent overrides. Removing the code path is also possible, since the new keys are ignored when absent.
