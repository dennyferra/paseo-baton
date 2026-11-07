# Proposal

## Why

Baton writes a handoff only after an agent has been idle for a while. Long sessions can grow large well before they go idle, and every further turn re-sends that growing context. Users want to hand off when a session is getting full, not after a timeout, so the next session starts from a compact summary.

## What Changes

- Add a context threshold, a percentage of the model's reported context window. The global default is 60%, set in plugin settings from 10 to 95.
- Each agent can override its threshold from its Baton menu ("Set context threshold"). The override is stored in the plugin's data, keyed by agent id, and cleared when the agent is archived.
- Check usage at the end of every turn, reading the agent's reported usage. When usage reaches the threshold, show the existing handoff message with two actions:
  - **Create handoff** writes the handoff file only.
  - **Create and continue** writes the file, then opens a new Paseo agent through the existing Continue action, only after the user clicks.
- Fire once per context. Re-arm only when a new session starts or the user continues from a handoff.
- Show a text chip such as "Baton 62%" with the last reported percentage, updated at the end of each turn. The chip has no colour states.
- For agents that report no context maximum, the global threshold percentage applies to a fallback limit of 120,000 tokens (60% is 72,000 tokens). The chip shows the percentage of that fallback, and a per-agent override does not apply to those agents.
- Keep the idle handoff. Skip it when a context handoff already exists for the same context.
- No auto-handoff and no auto-continue in this change.

## Capabilities

### New Capabilities

- `context-usage-handoff`: Handoffs triggered by how full an agent's context is. Covers the threshold and its per-agent override, the fallback limit, the chip text, the handoff actions at the threshold, the once-per-context rule, and how the idle handoff interacts with it.

### Modified Capabilities

None. The project has no existing specs under `openspec/specs/`.

## Impact

- `shared/baton.ts` and the plugin settings: a new threshold key, a new absolute fallback key, and per-agent override storage. No settings version bump; `migrate` keeps the new keys.
- `server/controller.ts`: a new check at `agent.turn.after` that reads usage through `paseo.agents.ref(id).refresh()`, the same call the writer path already uses. Idle handoff gains a skip when a context handoff exists.
- `client/baton-pill.ts`: the chip label, and a "Set context threshold" menu item.
- The handoff message at the threshold reuses the existing "Handoff saved" row and Continue action.
- Paseo dependency: usage is taken from `lastUsage`, which the SDK types do not declare. Confirm it is populated for ordinary, non-writer agents in a real session before relying on it, and check which providers report a context maximum.

## Implementation note

The working tree also contains the `fix/handoff-open-continue` changes
("Continue from this handoff" row, `entryFromRow`, timeline-summary
previous-handoff extraction). Those are separate from this change and are kept
as-is; they share no state with the threshold check except the existing
Continue action, which this change reuses.
