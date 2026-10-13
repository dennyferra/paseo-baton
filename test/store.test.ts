import { describe, expect, it } from "vitest";
import type { BatonStoreIo } from "../server/store";
import { loadState, saveState } from "../server/store";

function memoryIo(initial: Record<string, string> = {}): BatonStoreIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async mkdir() {},
    async readFile(file) {
      const value = files.get(file);
      if (value === undefined) {
        const error = new Error(`ENOENT: ${file}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    async writeFile(file, data) {
      files.set(file, data);
    },
    async rename(from, to) {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    async unlink(file) {
      files.delete(file);
    },
    async exists(file) {
      return files.has(file);
    },
  };
}

const STATE_FILE = "/home/.paseo/paseo-baton/baton-state.json";

describe("loadState", () => {
  it("returns an empty state when the file is missing", async () => {
    const io = memoryIo();
    expect(await loadState(io, STATE_FILE)).toEqual({});
  });

  it("returns an empty state when the file is not valid JSON", async () => {
    const io = memoryIo({ [STATE_FILE]: "not json" });
    expect(await loadState(io, STATE_FILE)).toEqual({});
  });

  it("drops entries that do not match the schema", async () => {
    const io = memoryIo({
      [STATE_FILE]: JSON.stringify({
        "agent-a": { agentId: "agent-a", status: "pending" },
        "agent-b": {
          agentId: "agent-b",
          workspaceId: "w",
          idleSince: 1,
          fireAt: 2,
          deadline: 3,
          updatedAt: 1,
          status: "pending",
        },
      }),
    });
    const state = await loadState(io, STATE_FILE);
    expect(state["agent-a"]).toBeUndefined();
    expect(state["agent-b"]).toBeDefined();
  });
});

describe("saveState", () => {
  it("writes a readable state file and does not leave temp files behind", async () => {
    const io = memoryIo();
    const state = {
      "agent-a": {
        agentId: "agent-a",
        workspaceId: "w",
        idleSince: 1,
        fireAt: 2,
        deadline: 3,
        updatedAt: 1,
        status: "pending",
      },
    };
    await saveState(io, STATE_FILE, state as never);
    expect(await loadState(io, STATE_FILE)).toEqual(state);
    const leftovers = [...io.files.keys()].filter((file) => file.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});