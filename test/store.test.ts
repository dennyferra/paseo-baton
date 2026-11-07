import { describe, expect, it } from "vitest";
import { loadState, saveState } from "../server/store";
import { memoryIo } from "./support/memory-io";

const STATE_FILE = "/home/.paseo/plugin-data/baton/baton-state.json";

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