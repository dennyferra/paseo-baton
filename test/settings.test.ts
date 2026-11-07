import { describe, expect, it } from "vitest";
import { batonSettings, batonSettingsSchema, DEFAULT_SETTINGS } from "../shared/baton";

describe("settings migration", () => {
  it("keeps every stored setting that still validates, including the read-tools toggle", async () => {
    const migrate = batonSettings.migrate;
    if (!migrate) throw new Error("expected a migration");
    const migrated = await migrate(
      { idleDelayMinutes: 30, agentReadTools: true, conversationDetail: "full", cleanupAfterDays: 0, unknownSetting: 1 },
      10,
    );
    expect(migrated).toMatchObject({ idleDelayMinutes: 30, agentReadTools: true, conversationDetail: "full" });
    expect(migrated).toMatchObject({ cleanupAfterDays: DEFAULT_SETTINGS.cleanupAfterDays });
    expect(migrated).not.toHaveProperty("unknownSetting");
  });

  it("reads a stored file with no read-tools key as off, and keeps the toggle once it is turned on", () => {
    expect(batonSettingsSchema.parse({ idleDelayMinutes: 15 }).agentReadTools).toBe(false);
    expect(batonSettingsSchema.parse({ idleDelayMinutes: 15, agentReadTools: true }).agentReadTools).toBe(true);
  });

  it("defaults the context threshold to 60 percent and the fallback to 120,000 tokens", () => {
    const parsed = batonSettingsSchema.parse({});
    expect(parsed.contextThresholdPercent).toBe(60);
    expect(parsed.contextFallbackTokens).toBe(120_000);
  });

  it("rejects a context threshold outside 10 to 95 percent", () => {
    expect(batonSettingsSchema.safeParse({ contextThresholdPercent: 9 }).success).toBe(false);
    expect(batonSettingsSchema.safeParse({ contextThresholdPercent: 96 }).success).toBe(false);
    expect(batonSettingsSchema.safeParse({ contextThresholdPercent: 10 }).success).toBe(true);
    expect(batonSettingsSchema.safeParse({ contextThresholdPercent: 95 }).success).toBe(true);
  });

  it("keeps the context threshold and fallback through a migration", async () => {
    const migrate = batonSettings.migrate;
    if (!migrate) throw new Error("expected a migration");
    const migrated = await migrate({ contextThresholdPercent: 75, contextFallbackTokens: 200_000 }, 11);
    expect(migrated).toMatchObject({ contextThresholdPercent: 75, contextFallbackTokens: 200_000 });
  });
});
