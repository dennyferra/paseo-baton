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
  only ever deletes <agentId>.md files it recorded itself. The only environment variable
  it reads is PASEO_HOME, to find the daemon home.
- Execution: one subprocess, the OS opener (open / xdg-open / cmd start), run only when
  the user clicks "Open in default app" on a handoff Baton saved.
- No runtime software installation. The package is readable TypeScript with no bundling.
```

## Checklist before submitting

- `OVERVIEW.md` has no `paseo plugin add`, `npm install` or `npm i` (the validator rejects them).
- `paseo-plugin.json` lists the screenshots under `media`, and `package.json` `files` includes `assets/`.
- The version on npm is the one you want reviewed. The reviewer records that exact version.
- Re-check each statement in the comment above against the code if behavior has changed.
