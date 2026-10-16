import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handoffDirFor, handoffPathFor } from "../server/paths";

describe("handoffDirFor", () => {
  it("defaults to the workspace's .paseo/handoffs", () => {
    expect(handoffDirFor("/work")).toBe(path.join("/work", ".paseo/handoffs"));
    expect(handoffDirFor("/work", "   ")).toBe(path.join("/work", ".paseo/handoffs"));
  });

  it("uses an absolute custom directory as-is", () => {
    expect(handoffDirFor("/work", "/shared/handoffs")).toBe(path.resolve("/shared/handoffs"));
  });

  it("resolves a relative custom directory against the workspace", () => {
    expect(handoffDirFor("/work", "notes/handoffs")).toBe(path.resolve("/work", "notes/handoffs"));
  });

  it("expands a leading ~ to the home directory", () => {
    expect(handoffDirFor("/work", "~/handoffs")).toBe(path.join(os.homedir(), "/handoffs"));
  });
});

describe("handoffPathFor", () => {
  it("names the file after the agent", () => {
    expect(handoffPathFor("/work", "agent-a", "/shared")).toBe(path.resolve("/shared", "agent-a.md"));
  });
});
