# Baton

Baton saves your agent's work state when you walk away. When an agent finishes a turn and stays
idle for a while, Baton writes a handoff document so the next agent can pick the task up without
re-reading the whole conversation.

It helps when you step away from a long coding session and want to continue later in a fresh agent,
or hand a task to a different model.

## How it works

When an agent turn ends, Baton starts an idle timer. If no new turn starts before it fires, a
short-lived writer agent drafts the handoff, and Baton saves it as `<agentId>.md` in `.paseo/handoffs` in its
workspace (or your configured storage location), using the template Task, Context, Relevant files, Current state, What was tried,
Decisions, Acceptance criteria, and Constraints. If the agent cannot answer, Baton writes a
mechanical handoff from the conversation snapshot instead, with no model call.

Once the file exists, a "Handoff saved" row appears in that agent's chat; clicking its path opens an in-app
view of the handoff for review, with a button to open the file in your default app. Every agent has a **Baton**
chip in the composer that opens a menu:

- **Continue from handoff** (only when a handoff exists) creates a new agent in the same workspace
  titled `[Handoff] <task>` with the prompt to read the file and continue the task. The row updates
  to show which agent continued.
- **Turn off / Turn on handoff for this session** stops Baton from writing a handoff for that agent.
  The state is saved, so it survives restarts. Turning off is disabled once a handoff exists. In an ignored workspace or project the menu shows
  a disabled note saying so instead of the toggle.

If you keep working in the original session after a handoff was saved and nobody continued it, Baton
deletes the stale handoff file. A handoff that was already continued in a new agent is kept. The
"Handoff saved" row stays in the chat history, but its link then says the handoff is no longer available.

## Setup

Requires Paseo 0.11.2 or newer. No accounts, tokens, or external tools. Settings are configurable
in the plugin settings.

## Settings

Settings live under Settings -> Plugins -> Baton.

- **Idle delay** (`idleDelayMinutes`, default 15, 1-240): how long an agent sits idle before a
  handoff is written. It does not depend on any provider's prompt cache.
- **Handoff writer** (`handoffProfileId`): pick one of your Paseo agent profiles. Its provider,
  model and effort are used; its mode is ignored. The writer never needs file access: it replies with the document and Baton writes the file. The default,
  "Same as running agent", uses the idle agent's own model and effort. The writer is a short-lived
  dedicated agent archived after its turn, so the idle agent's chat only shows the Handoff saved row.
- **Storage location** (`handoffDirectory`, default empty): where handoff files are saved. Empty means
  `.paseo/handoffs` inside each workspace. A custom value can be an absolute path, `~/...`, or a path
  relative to the workspace. Files are named `<agentId>.md`. Existing handoffs keep their saved path.
- **Ignored projects and workspaces** (`ignoredProjectIds`, `ignoredWorkspaceIds`): switches grouped by
  project. Ignoring a project covers all its workspaces, including ones created later; ignoring a
  workspace covers just that one. Ignored agents never produce handoffs.

## Data

Writing a handoff sends part of the conversation to an agent provider. The writer agent receives a
draft built from the conversation Paseo reports when a turn ends: the last 30 messages (each cut at
2,000 characters), the files the agent touched, and a short list of its tool calls with their targets,
such as file paths and URLs. Tool output is not included. The writer runs on the provider and model of the profile you pick, or on the idle agent's
own provider and model by default, so that provider sees this text. If the writer fails, the
fallback summary is built locally and nothing is sent.

Handoff files stay on the machine that runs the Paseo daemon, in `.paseo/handoffs` inside each
workspace or in the storage location you set. They contain a summary of the conversation, so keep
that folder out of version control if the work is private. Baton's own state file is in
`~/.paseo/plugin-data/baton`. Baton makes no network requests and never reads credentials. The "Open
in default app" button hands the file to your operating system's opener.

## Capabilities and limits

Entries persist in a JSON file under the daemon home, so a daemon restart recovers pending handoffs,
skips expired ones, and re-appends chat rows for saved handoffs. A handoff is written at most once
per idle period. Subagent tool calls are not handed off because they are provider child sessions
rather than agents. Done entries are pruned when the agent is archived or after 7 days. Chat rows
live in daemon memory and are restored after a daemon restart. Baton reads agent lifecycle events
and writes handoff files and its own state file, and never logs secrets.