import { useSettings, usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BatonSettings } from "../shared/baton";
import { batonSettings, DEFAULT_SETTINGS } from "../shared/baton";

interface ModelChoice {
  value: string;
  label: string;
  effortOptions: Array<{ label: string; value: string }>;
}

interface WorkspaceChoice {
  id: string;
  name: string;
  project: string;
}

const SAME_AS_RUNNING = "";

function clampDelay(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(240, Math.max(1, parsed));
}

export function BatonSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(batonSettings);
  const paseo = usePaseo();
  const [draft, setDraft] = useState<BatonSettings | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (draft !== null) return;
    if (settings.status === "ready") setDraft(settings.values);
    else if (settings.status === "error" || settings.status === "invalid") setDraft(DEFAULT_SETTINGS);
  }, [draft, settings.status]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [snapshot, listed] = await Promise.all([paseo.providers.snapshot(), paseo.workspaces.list()]);
        if (cancelled) return;
        const choices: ModelChoice[] = [];
        for (const entry of snapshot.entries) {
          if (!entry.enabled || entry.status !== "ready") continue;
          for (const model of entry.models ?? []) {
            if (model.isSelectable === false) continue;
            choices.push({
              value: `${entry.provider}/${model.id}`,
              label: `${entry.label ?? entry.provider} / ${model.label}`,
              effortOptions: (model.thinkingOptions ?? []).map((option) => ({
                label: option.label,
                value: option.id,
              })),
            });
          }
        }
        setModels(choices);
        setWorkspaces(
          listed.entries.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            project: workspace.projectDisplayName,
          })),
        );
      } catch (error: unknown) {
        if (!cancelled) setLoadError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
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

  const projects = useMemo(() => {
    const grouped = new Map<string, WorkspaceChoice[]>();
    for (const workspace of workspaces) {
      grouped.set(workspace.project, [...(grouped.get(workspace.project) ?? []), workspace]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [workspaces]);

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

  const modelOptions = [
    { label: "Same as running agent", value: SAME_AS_RUNNING },
    ...models.map(({ value, label }) => ({ label, value })),
  ];
  // Keep a previously saved model selectable even if its provider is currently unavailable.
  if (draft.handoffProviderModel && !models.some((model) => model.value === draft.handoffProviderModel)) {
    modelOptions.push({ label: draft.handoffProviderModel, value: draft.handoffProviderModel });
  }
  const selectedModel = models.find((model) => model.value === draft.handoffProviderModel);
  const effortOptions = [{ label: "Model default", value: "" }, ...(selectedModel?.effortOptions ?? [])];

  const toggleWorkspace = (id: string, ignored: boolean) => {
    const rest = draft.ignoredWorkspaceIds.filter((existing) => existing !== id);
    update({ ignoredWorkspaceIds: ignored ? [...rest, id] : rest });
  };

  const onSave = async () => {
    if (settings.status !== "ready") return;
    const ok = await settings.save(draft, settings.revision);
    if (ok) await settings.reload();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 24 }}>
      <SettingsSection title="When to write a handoff">
        <SettingsInput
          label="Idle delay (minutes)"
          hint="Write a handoff once an agent has been idle this long (1-240)."
          initialValue={String(draft.idleDelayMinutes)}
          onChangeText={(value) => update({ idleDelayMinutes: clampDelay(value, draft.idleDelayMinutes) })}
        />
      </SettingsSection>
      <SettingsSection title="Handoff writer">
        <SettingsSelect
          label="Model"
          hint="The agent that writes the handoff. Defaults to the idle agent's own model and effort."
          value={draft.handoffProviderModel}
          options={modelOptions}
          onValueChange={(value) => update({ handoffProviderModel: value, handoffThinkingOptionId: "" })}
        />
        {selectedModel && selectedModel.effortOptions.length > 0 ? (
          <SettingsSelect
            label="Effort"
            value={draft.handoffThinkingOptionId}
            options={effortOptions}
            onValueChange={(value) => update({ handoffThinkingOptionId: value })}
          />
        ) : null}
      </SettingsSection>
      {projects.length > 0 ? (
        <Text style={[styles.hint, { marginBottom: 8 }]}>
          Ignored workspaces: agents in checked workspaces never produce handoffs.
        </Text>
      ) : null}
      {projects.map(([project, items]) => (
        <SettingsSection key={project} title={project}>
          {items.map((workspace) => (
            <SettingsSwitch
              key={workspace.id}
              label={workspace.name}
              value={draft.ignoredWorkspaceIds.includes(workspace.id)}
              onValueChange={(value) => toggleWorkspace(workspace.id, value)}
            />
          ))}
        </SettingsSection>
      ))}
      {loadError ? <Text style={styles.error}>Could not load providers or workspaces: {loadError}</Text> : null}
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
