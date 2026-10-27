import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// No fsmonitor, so a repository's own config cannot make these commands run something else, and no
// optional locks, so they never block or race the user's own git commands.
const SAFE_GIT = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...SAFE_GIT, ...args], { cwd, timeout: 5000, maxBuffer: 256 * 1024 });
  return stdout.trim();
}

const MAX_CHANGED_FILES = 40;

/**
 * Where the repo stands (branch, changed files, recent commits), or an empty string outside a git repo.
 * Each command stands alone, so a repo with no commits yet still reports its branch and changes.
 */
export async function gatherRepoFacts(cwd: string): Promise<string> {
  const [branch, status, log] = await Promise.allSettled([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--short"]),
    git(cwd, ["log", "-n", "8", "--oneline"]),
  ]);
  if (branch.status === "rejected" && status.status === "rejected" && log.status === "rejected") return "";
  const sections: string[] = [];
  if (branch.status === "fulfilled") sections.push(`Branch: ${branch.value || "(detached HEAD)"}`);
  if (status.status === "fulfilled") {
    const lines = status.value.split("\n").filter(Boolean);
    const shown = lines.slice(0, MAX_CHANGED_FILES).join("\n");
    const more = lines.length > MAX_CHANGED_FILES ? `\n(${lines.length - MAX_CHANGED_FILES} more not shown)` : "";
    sections.push(`Changed files:\n${shown || "(clean)"}${more}`);
  }
  if (log.status === "fulfilled") sections.push(`Recent commits:\n${log.value || "(none)"}`);
  return sections.join("\n\n");
}
