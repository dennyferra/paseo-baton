# Paseo registry submission

Notes for submitting Baton to the Paseo plugin registry. Not shipped in the npm package.

Submission form: https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml

Use the form (not a blank issue) so the issue gets the `submission` label that starts intake.

## Form fields

**Source** (required):

```
paseo-baton
```

The GitHub URL, `https://github.com/dennyferra/paseo-baton`, also works. The npm name is the stronger
source: the reviewer inspects the published package, and releases carry provenance.

**Categories:** tick **Orchestration** first (the first tick is the main one), then **Utils**.

## Updating the listing

Baton is listed with `paseo-baton` on npm as its source, so the registry's bump workflow proposes each new
npm version in a pull request (twice a day) and a reviewer approves it. You do not resubmit. If a listing was
ever pinned to a Git commit instead, updates are manual: open a new submission issue with the same form and
`paseo-baton` as the source.

## Comment to add after the issue opens

This answers the review policy's checklist (https://github.com/getpaseo/plugins/blob/main/REVIEW.md).
Update the version before pasting.

```
Baton <version> (npm: paseo-baton, published from GitHub Actions with provenance).
Source: https://github.com/dennyferra/paseo-baton

For review:
- Dependencies: none at runtime. package.json has only devDependencies, no install
  or lifecycle scripts, and package-lock.json is committed.
- Network: Baton makes no network requests and never reads credentials or environment
  secrets. The overview's Data section explains that the writer agent sends a draft of
  recent conversation text to the provider of the profile you choose.
- Filesystem: writes handoff files to .paseo/handoffs in the workspace (or a user-chosen
  folder) and its own state file under ~/.paseo/plugin-data/baton. By default it deletes
  an unused handoff when the original session resumes, and deletes unused handoff files
  older than 3 days (on start and once a day). Both have settings to turn them off, and it
  only ever deletes <agentId>.md files it recorded itself. For a session started with Continue from
  handoff it also reads the handoff named in that session's first message, but only a handoff it
  recorded or a .md file inside a folder called handoffs. The only environment variable
  it reads is PASEO_HOME, to find the daemon home.
- Execution: the OS opener (open / xdg-open / cmd start), run only when the user clicks
  "Open in default app" on a handoff Baton saved, and read-only git commands (branch --show-current,
  status --short, log -n 8, with core.fsmonitor off and no optional locks) run in the agent's
  workspace when a handoff is written; a setting turns that off.
- Draft contents: the writer's draft also carries the agent's latest task list and plan, error
  messages (cut to 300 characters) and failed shell calls as program name and exit code only,
  never the command line or tool output.
- Subagent: for each handoff it starts one short-lived subagent of the idle agent (labelled baton-writer, with
  a parent label), using the user's own agent profile or the idle agent's provider, under the user's normal
  permission mode. The writer is told not to use tools and to reply with the document, and Baton accepts a
  file it saved itself at the handoff path. Baton archives only the earlier writers it created for the same
  agent, and leaves the finished one in place so the user can read its prompt.
- No runtime software installation. The package is readable TypeScript with no bundling.
```

## Checklist before submitting

- `OVERVIEW.md` has no `paseo plugin add`, `npm install` or `npm i` (the validator rejects them).
- `paseo-plugin.json` lists the screenshots under `media`, and `package.json` `files` includes `assets/`.
- The version on npm is the one you want reviewed. The reviewer records that exact version.
- `npm pack --dry-run` lists every new source file (for example `server/repo-facts.ts` and `server/timeline-summary.ts`).
- `paseo-plugin.json` has the icon and `requirements.paseo` matches the README and OVERVIEW.
- Re-check each statement in the comment above against the code if behavior has changed.
