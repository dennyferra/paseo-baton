import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachBatonTools, batonAgentTools, listHandoffFiles, resolveHandoffFile } from "../server/agent-tools";
import { BATON_WRITER_LABEL } from "../shared/baton";

let cwd: string;
let handoffDir: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "baton-tools-"));
  handoffDir = path.join(cwd, ".paseo", "handoffs");
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeHandoff(name: string, text: string, dir = handoffDir): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), text);
}

const readOn = async () => ({ agentReadTools: true, handoffDirectory: "" });
const readOff = async () => ({ agentReadTools: false, handoffDirectory: "" });

function toolNamed(name: string, readSettings = readOn) {
  const tool = batonAgentTools(readSettings).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

const contextFor = (dir: string) => ({ agent: { id: "agent-a", workspaceId: "ws", cwd: dir } }) as never;

describe("resolveHandoffFile", () => {
  it("accepts a plain markdown file name inside the handoff directory", () => {
    expect(resolveHandoffFile(handoffDir, "agent-a.md")).toBe(path.join(handoffDir, "agent-a.md"));
  });

  it("rejects paths, traversal, hidden files and non-markdown names", () => {
    for (const file of ["../secret.md", "sub/agent.md", "/etc/passwd", "..", "agent.txt", ".hidden.md", ""]) {
      expect(resolveHandoffFile(handoffDir, file), file).toBeNull();
    }
  });
});

describe("listHandoffFiles", () => {
  it("returns an empty list when the handoff directory does not exist", async () => {
    expect(await listHandoffFiles(handoffDir)).toEqual([]);
  });

  it("lists only markdown files, newest first", async () => {
    await writeHandoff("old.md", "# Task\nold");
    await writeHandoff("notes.txt", "ignored");
    const older = new Date("2020-01-01T00:00:00Z");
    await utimes(path.join(handoffDir, "old.md"), older, older);
    await writeHandoff("new.md", "# Task\nnew");
    const files = await listHandoffFiles(handoffDir);
    expect(files.map((file) => file.name)).toEqual(["new.md", "old.md"]);
  });
});

describe("baton_list_handoffs", () => {
  it("lists the handoffs in the workspace's default directory", async () => {
    await writeHandoff("agent-a.md", "# Task\nship it");
    const result = await toolNamed("baton_list_handoffs").execute({}, contextFor(cwd));
    expect(result).toMatchObject({ text: expect.stringContaining("agent-a.md") });
  });

  it("follows the custom handoff directory setting", async () => {
    const shared = path.join(cwd, "shared");
    await writeHandoff("elsewhere.md", "# Task\nx", shared);
    const readCustom = async () => ({ agentReadTools: true, handoffDirectory: shared });
    const result = await toolNamed("baton_list_handoffs", readCustom).execute({}, contextFor(cwd));
    expect(result).toMatchObject({ text: expect.stringContaining("elsewhere.md") });
  });

  it("refuses when the setting is off", async () => {
    const result = await toolNamed("baton_list_handoffs", readOff).execute({}, contextFor(cwd));
    expect(result).toMatchObject({ isError: true });
  });
});

describe("baton_read_handoff", () => {
  it("returns the handoff text", async () => {
    await writeHandoff("agent-a.md", "# Task\nship it");
    const result = await toolNamed("baton_read_handoff").execute({ file: "agent-a.md" }, contextFor(cwd));
    expect(result).toEqual({ text: "# Task\nship it" });
  });

  it("refuses a traversal attempt without reading", async () => {
    const result = await toolNamed("baton_read_handoff").execute({ file: "../x.md" }, contextFor(cwd));
    expect(result).toMatchObject({ isError: true });
  });

  it("reports a handoff that was deleted after listing", async () => {
    const result = await toolNamed("baton_read_handoff").execute({ file: "gone.md" }, contextFor(cwd));
    expect(result).toMatchObject({ isError: true, text: "That handoff no longer exists." });
  });

  it("refuses when the setting is off", async () => {
    await writeHandoff("agent-a.md", "# Task\nship it");
    const result = await toolNamed("baton_read_handoff", readOff).execute({ file: "agent-a.md" }, contextFor(cwd));
    expect(result).toMatchObject({ isError: true });
  });

  it("truncates very long handoffs", async () => {
    await writeHandoff("big.md", "x".repeat(50_000));
    const result = (await toolNamed("baton_read_handoff").execute({ file: "big.md" }, contextFor(cwd))) as { text: string };
    expect(result.text).toContain("[Truncated");
    expect(result.text.length).toBeLessThan(41_000);
  });
});

describe("attachBatonTools", () => {
  function makeRequest(overrides: Record<string, unknown> = {}) {
    return {
      agentId: "agent-a",
      workspaceId: "ws",
      provider: "claude",
      cwd,
      reason: "create",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
      ...overrides,
    } as never;
  }

  it("appends the Baton tools to an interactive agent when the setting is on", async () => {
    const result = (await attachBatonTools(makeRequest(), readOn)) as unknown as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual(["baton_list_handoffs", "baton_read_handoff"]);
  });

  it("keeps tools that were already attached", async () => {
    const existing = { name: "other_tool" };
    const result = (await attachBatonTools(makeRequest({ tools: [existing] }), readOn)) as unknown as { tools: { name: string }[] };
    expect(result.tools[0]).toBe(existing);
    expect(result.tools).toHaveLength(3);
  });

  it("does nothing when the setting is off", async () => {
    expect(await attachBatonTools(makeRequest(), readOff)).toBeUndefined();
  });

  it("leaves history sessions and handoff writers alone", async () => {
    expect(await attachBatonTools(makeRequest({ purpose: "history" }), readOn)).toBeUndefined();
    expect(await attachBatonTools(makeRequest({ labels: { [BATON_WRITER_LABEL]: "1" } }), readOn)).toBeUndefined();
  });
});
