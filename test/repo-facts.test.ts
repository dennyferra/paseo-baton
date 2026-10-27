import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gatherRepoFacts } from "../server/repo-facts";

describe("gatherRepoFacts", () => {
  it("reports the branch, changed files and recent commits of a git repo", async () => {
    const facts = await gatherRepoFacts(process.cwd());
    expect(facts).toContain("Branch: ");
    expect(facts).toContain("Changed files:");
    expect(facts).toContain("Recent commits:");
  });

  it("returns nothing outside a git repo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baton-no-git-"));
    expect(await gatherRepoFacts(dir)).toBe("");
  });

  it("still reports the branch and changes in a repo with no commits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baton-empty-git-"));
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
    const facts = await gatherRepoFacts(dir);
    expect(facts).toContain("Branch: trunk");
    expect(facts).toContain("Changed files:\n(clean)");
    expect(facts).not.toContain("Recent commits");
  });
});
