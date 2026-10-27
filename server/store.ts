import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BatonState } from "../shared/baton";
import { batonEntrySchema } from "../shared/baton";

export interface BatonStoreIo {
  mkdir(dir: string): Promise<void>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
}

export const nodeStoreIo: BatonStoreIo = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async readFile(file) {
    return await readFile(file, "utf8");
  },
  async writeFile(file, data) {
    await writeFile(file, data, "utf8");
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async unlink(file) {
    await unlink(file);
  },
  async exists(file) {
    try {
      await readFile(file, "utf8");
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
};

export function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function loadState(io: BatonStoreIo, stateFile: string): Promise<BatonState> {
  let raw: string;
  try {
    raw = await io.readFile(stateFile);
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const state: BatonState = {};
  for (const [agentId, value] of Object.entries(parsed)) {
    const result = batonEntrySchema.safeParse(value);
    if (result.success) state[agentId] = result.data;
  }
  return state;
}

export async function saveState(
  io: BatonStoreIo,
  stateFile: string,
  state: BatonState,
): Promise<void> {
  await io.mkdir(path.dirname(stateFile));
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(tmp, JSON.stringify(state, null, 2));
  await io.rename(tmp, stateFile);
}