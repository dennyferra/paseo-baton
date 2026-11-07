# Tasks

## 1. Gate and settings

- [x] 1.1 Confirm `lastUsage` is populated for an ordinary, non-writer agent in a real session on each provider in use, by recording `contextWindowUsedTokens` and `contextWindowMaxTokens` from `refresh()` after a turn. Record for each provider whether a maximum is reported: an unset maximum is expected for some providers and uses the 120,000-token fallback, so it is not a stop. Stop and return to the user only if `contextWindowUsedTokens` is missing for a provider
- [x] 1.2 Add global settings for the threshold (whole percent, 10 to 95, default 60) and the absolute fallback (default 120,000 tokens) in `shared/baton.ts`, and verify the settings tests cover the default, the range rejection, and that `migrate` keeps both keys
- [x] 1.3 Document the threshold and fallback settings in README.md and OVERVIEW.md, and verify the docs name the 60 percent default and the 120,000-token fallback

## 2. Per-agent state

- [x] 2.1 Store per-agent threshold overrides in plugin data keyed by agent id, and verify a test shows an override survives a controller reload
- [x] 2.2 Remove an agent's override and fired flag when the agent is archived, and verify a test shows the stored entries are gone after archive
- [x] 2.3 Add a per-agent context counter that advances on a new session and on continue, and verify tests show the counter changes on both events and not on ordinary turns

## 3. Threshold check

- [x] 3.1 At `agent.turn.after`, read usage with `paseo.agents.ref(id).refresh()` and trigger when used tokens are at least the effective percent of the reported maximum, and verify tests cover usage above, at, and below the threshold
- [x] 3.2 When no maximum is reported, apply the global percentage to the 120,000-token fallback (60% is 72,000 tokens) and ignore any per-agent percentage, and verify tests cover a trigger with no maximum and an override that is ignored
- [x] 3.3 Fire the threshold once per context using a fired flag keyed by agent and counter, and verify tests show repeated turns above the threshold trigger once and a new session or continue re-arms it
- [x] 3.4 Document the once-per-context rule and the fallback in README.md and OVERVIEW.md, and verify the docs match the spec wording

## 4. Threshold prompt

- [x] 4.1 Show the existing handoff message with "Create handoff" and "Create and continue" actions when the threshold triggers, and verify a test shows the prompt carries both actions
- [x] 4.2 "Create handoff" writes the handoff file through the existing writer without opening an agent, and verify a test checks the file is written and no agent is opened
- [x] 4.3 "Create and continue" writes the file and opens a new agent through the existing Continue action, and verify a test checks both happen after the click
- [x] 4.4 Confirm nothing is written or opened without a click, and verify a test shows a triggered threshold with no click produces no file and no agent

## 5. Chip and menu

- [x] 5.1 Show the chip as "Baton" plus the last reported percentage, updated at turn end, and "Baton" alone when no usage has been reported, and verify a test checks both labels
- [x] 5.2 Add a "Set context threshold" item to the agent's Baton menu that writes a per-agent override, and verify a test shows the item sets and clears the override

## 6. Idle interaction

- [x] 6.1 Skip the idle handoff when a context handoff already exists for the agent's current counter, and verify tests cover idle with no prior context handoff (writes) and idle after one (skips)
- [x] 6.2 Document the idle skip in README.md, and verify the note matches the idle-handoff requirement

## 7. Integration check

- [ ] 7.1 Run the threshold end to end in the live app: trigger the prompt in a real session, click each action, and confirm the handoff file and continue behaviour match the spec scenarios

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived specs match the behaviour seen in task 7.1.

> Status after implementation: 1.1 (live `lastUsage` probe) and 7.1 (live E2E) remain open for a real session; everything else is done in unit tests.
