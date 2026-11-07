# Spec Delta

## Purpose

Lets Baton hand off an agent when its context window fills, instead of waiting for the agent to go idle, so the next session starts from a compact summary.

## ADDED Requirements

### Requirement: Global context threshold setting

Baton SHALL provide a global context threshold setting, a whole percentage from 10 to 95, with a default of 60.

#### Scenario: Default threshold

- **WHEN** no threshold has been set in plugin settings
- **THEN** the effective threshold is 60 percent

#### Scenario: Out-of-range value rejected

- **WHEN** a user saves a threshold below 10 or above 95
- **THEN** the setting is not saved and the previous value remains in effect

### Requirement: Per-agent threshold override

Baton SHALL let a user set a percentage threshold for one agent from that agent's Baton menu. A per-agent threshold SHALL take precedence over the global threshold for that agent only.

#### Scenario: Override applies to one agent

- **WHEN** a user sets a threshold of 40 percent for agent A and the global threshold is 60 percent
- **THEN** agent A triggers at 40 percent and every other agent still triggers at 60 percent

#### Scenario: Override removed on archive

- **WHEN** an agent with a per-agent threshold is archived
- **THEN** its per-agent threshold is removed from plugin data

#### Scenario: Override survives daemon restart

- **WHEN** the daemon restarts after a per-agent threshold has been set
- **THEN** the agent still uses that threshold

### Requirement: Threshold check at end of turn

Baton SHALL check an agent's context usage at the end of each turn, using the usage Paseo reports for that agent. Baton SHALL trigger when the used context tokens are at least the effective threshold percentage of the reported context maximum.

Baton SHALL NOT trigger the threshold prompt for subagents, handoff writer agents, disabled agents, or agents in an ignored workspace or project. Their usage is still shown on the chip.

#### Scenario: Usage reaches threshold

- **WHEN** a turn ends and the agent reports 610,000 used tokens of a 1,000,000 maximum with an effective threshold of 60 percent
- **THEN** Baton triggers the threshold prompt for that agent

#### Scenario: Usage below threshold

- **WHEN** a turn ends and the agent reports 500,000 used tokens of a 1,000,000 maximum with an effective threshold of 60 percent
- **THEN** Baton does not trigger the threshold prompt

### Requirement: Threshold prompt offers two actions

When the threshold triggers, Baton SHALL show the existing handoff message with two actions: "Create handoff" and "Create and continue". Baton SHALL NOT write a handoff or open a new agent until the user clicks one of these actions.

#### Scenario: Create handoff only

- **WHEN** the user clicks "Create handoff" on the threshold prompt
- **THEN** Baton writes the handoff file and does not open a new agent

#### Scenario: Create and continue

- **WHEN** the user clicks "Create and continue" on the threshold prompt
- **THEN** Baton writes the handoff file and opens a new Paseo agent through the existing Continue action

#### Scenario: Writer takes longer than a click

- **WHEN** the user clicks "Create and continue" and the handoff writer takes minutes to finish
- **THEN** Baton does not fail the click; it opens the new agent through the Continue action once the handoff file is written and its row is in the timeline

#### Scenario: No automatic action

- **WHEN** the threshold triggers and the user does not click either action
- **THEN** Baton writes no handoff file and opens no agent

### Requirement: Threshold fires once per context

Baton SHALL trigger the threshold at most once per context. It SHALL re-arm for an agent only when a new session starts for that agent or the user continues from a handoff.

#### Scenario: Repeated turns above threshold

- **WHEN** an agent stays above its threshold across several turns
- **THEN** Baton triggers the threshold prompt once

#### Scenario: Re-arm after continue

- **WHEN** the user continues an agent from a handoff, and that new agent later crosses the threshold
- **THEN** Baton triggers the threshold prompt again for the new context

### Requirement: Absolute fallback for agents without a context maximum

When an agent reports no context maximum, Baton SHALL measure the global threshold percentage against a global absolute fallback limit of 120,000 tokens for that agent. A per-agent percentage threshold SHALL NOT apply to such an agent.

#### Scenario: Fallback triggers

- **WHEN** an agent reports 130,000 used tokens and no context maximum, with a global threshold of 60 percent
- **THEN** Baton triggers the threshold prompt, because 130,000 is at least 60 percent of the 120,000-token fallback limit (72,000 tokens)

#### Scenario: Fallback below threshold

- **WHEN** an agent reports 71,999 used tokens and no context maximum, with a global threshold of 60 percent
- **THEN** Baton does not trigger the threshold prompt

#### Scenario: Override ignored without a maximum

- **WHEN** an agent with a per-agent 40 percent threshold reports 60,000 used tokens and no context maximum
- **THEN** Baton uses the global 60 percent of the fallback (72,000 tokens) and does not trigger, because the per-agent 40 percent (48,000 tokens) does not apply

### Requirement: Context usage chip

Baton SHALL show a text chip for each agent that reports usage, with the agent's last reported percentage of its effective limit, such as "Baton 62%". The chip SHALL update at the end of each turn and SHALL NOT change colour.

#### Scenario: Chip shows last value

- **WHEN** a turn ends and the agent reports 62 percent of its maximum
- **THEN** the chip reads "Baton 62%"

#### Scenario: Chip survives a restart

- **WHEN** Baton restarts and an agent with no handoff entry reported a percentage before the restart
- **THEN** the chip shows that last stored percentage

#### Scenario: Chip shown for a gated agent

- **WHEN** an agent is in an ignored workspace and reports usage
- **THEN** the chip shows its percentage, although the agent never gets a threshold prompt

#### Scenario: No usage reported yet

- **WHEN** an agent has not reported any usage
- **THEN** the chip shows the label "Baton" with no percentage

### Requirement: Idle handoff kept with context handoff

Baton SHALL keep the idle handoff. When an agent goes idle and a handoff file already exists for the same context, Baton SHALL NOT write a second handoff for that context. A threshold prompt that was shown but not acted on does not write a file, so it does not suppress the idle handoff.

#### Scenario: Idle without prior context handoff

- **WHEN** an agent goes idle and no context handoff exists for its current context
- **THEN** Baton writes an idle handoff as it does today

#### Scenario: Idle after context handoff

- **WHEN** an agent goes idle after a handoff file was written for its current context
- **THEN** Baton writes no idle handoff for that context

#### Scenario: Idle after an unacted threshold prompt

- **WHEN** an agent goes idle after the threshold prompt was shown and the user clicked neither action
- **THEN** Baton writes an idle handoff as it does today
