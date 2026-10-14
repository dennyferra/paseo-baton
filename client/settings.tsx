import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BatonSettings } from "../shared/baton";
import { batonSettings } from "../shared/baton";

const DEFAULTS: BatonSettings = {
  idleTtlMinutes: 5,
  safetyMarginSeconds: 30,
  handoffProviderModel: "",
  ignoredWorkspaceIds: [],
};

function parseIntOr(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseWorkspaceIds(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function BatonSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(batonSettings);
  const [draft, setDraft] = useState<BatonSettings | null>(null);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      field: {
        gap: 6,
        marginBottom: layout.compact ? 12 : 16,
      },
      label: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
      input: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 8 : 10,
        backgroundColor: theme.colors.surface1,
        minHeight: 44,
      },
      multiline: {
        minHeight: 80,
        textAlignVertical: "top" as const,
      },
      save: {
        marginTop: layout.compact ? 8 : 12,
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        alignItems: "center" as const,
        opacity: settings.saving ? 0.6 : 1,
      },
      saveText: {
        color: theme.colors.accentForeground,
        fontWeight: "600" as const,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: layout.compact ? 12 : 13,
        marginTop: 8,
      },
    }),
    [theme, layout.compact, settings.saving],
  );

  useEffect(() => {
    if (draft !== null) return;
    if (settings.status === "ready") setDraft(settings.values);
    else if (settings.status === "error" || settings.status === "invalid") setDraft(DEFAULTS);
  }, [draft, settings.status]);

  if (!draft) {
    return (
      <View style={styles.screen}>
        <Text style={styles.hint}>Loading settings...</Text>
      </View>
    );
  }

  const update = (patch: Partial<BatonSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const onSave = async () => {
    if (settings.status !== "ready") return;
    const ok = await settings.save(draft, settings.revision);
    if (ok) await settings.reload();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={styles.field}>
        <Text style={styles.label}>Idle delay (minutes)</Text>
        <Text style={styles.hint}>How long an agent sits idle before a handoff is written.</Text>
        <TextInput
          style={styles.input}
          value={String(draft.idleTtlMinutes)}
          keyboardType="number-pad"
          accessibilityLabel="Idle delay in minutes"
          onChangeText={(value) => update({ idleTtlMinutes: parseIntOr(value, draft.idleTtlMinutes) })}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Safety margin (seconds)</Text>
        <Text style={styles.hint}>How long before the cache expires the handoff runs.</Text>
        <TextInput
          style={styles.input}
          value={String(draft.safetyMarginSeconds)}
          keyboardType="number-pad"
          accessibilityLabel="Safety margin in seconds"
          onChangeText={(value) => update({ safetyMarginSeconds: parseIntOr(value, draft.safetyMarginSeconds) })}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Handoff writer model</Text>
        <Text style={styles.hint}>
          Leave empty to write handoffs with a dedicated agent using the idle agent's own model.
        </Text>
        <TextInput
          style={styles.input}
          value={draft.handoffProviderModel}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Handoff writer model"
          placeholder="claude/claude-sonnet-5-5"
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={(value) => update({ handoffProviderModel: value })}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Ignored workspace ids</Text>
        <Text style={styles.hint}>One workspace id per line; agents there never produce handoffs.</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={draft.ignoredWorkspaceIds.join("\n")}
          multiline
          accessibilityLabel="Ignored workspace ids"
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={(value) => update({ ignoredWorkspaceIds: parseWorkspaceIds(value) })}
        />
      </View>
      {settings.status === "invalid" ? <Text style={styles.error}>{settings.error}</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save baton settings"
        onPress={() => void onSave()}
        style={styles.save}
        disabled={settings.saving}
      >
        <Text style={styles.saveText}>{settings.saving ? "Saving..." : "Save"}</Text>
      </Pressable>
    </ScrollView>
  );
}