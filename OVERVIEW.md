# Baton

Baton saves your agent's work state when you walk away. When an agent finishes a turn and stays
idle, Baton writes a handoff document just before the prompt cache expires, so the next agent can
pick the task up without re-reading the whole conversation and without paying to rebuild context.

It helps when you step away from a long coding session and want to continue later in a fresh agent,
or hand a task to a different model.

## How it works

When an agent turn ends, Baton starts a timer for a little less than the prompt cache TTL. If no new
turn starts, it asks the idle agent to write a handoff file to `.paseo/handoffs/<agentId>.md` in its
workspace, using the template Task, Context, Relevant files, Current state, What was tried,
Decisions, Acceptance criteria, and Constraints. If the agent cannot answer, Baton writes a
mechanical handoff from the conversation snapshot instead, with no model call.

Once the file exists, a "Handoff saved" row appears in that agent's chat and a Continue pill becomes
available in the composer. Pressing it creates a new agent in the same workspace titled
`[Handoff] <task>` with the prompt to read the file and continue the task. The row updates to show
which agent continued.

## Setup

Requires Paseo 0.11.2 or newer. No accounts, tokens, or external tools. The idle delay defaults to
5 minutes and is configurable in the plugin settings.

## Capabilities and limits

The idle delay sets how long an agent must sit idle before a handoff is written. It should stay just
under your provider's prompt cache window. Entries persist in a JSON file under the daemon home, so
a daemon restart recovers pending handoffs, skips expired ones, and re-appends chat rows for saved
handoffs. A handoff is written at most once per idle period.

Done entries are pruned when the agent is archived or after 7 days. Chat rows live in daemon memory
and are restored after a daemon restart. Baton reads agent lifecycle events and writes handoff files
and its own state file; it never reads credentials and never logs secrets.