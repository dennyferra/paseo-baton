import { useSettings, usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BatonSettings } from "../shared/baton";
import { batonSettings, DEFAULT_SETTINGS } from "../shared/baton";

interface ProfileChoice {
  value: string;
  label: string;
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
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
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
        const [daemon, listed] = await Promise.all([paseo.config.get(), paseo.workspaces.list()]);
        if (cancelled) return;
        setProfiles(
          (daemon.config.agentProfiles ?? []).map((profile) => ({
            value: profile.id,
            label: profile.name,
          })),
        );
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

  const profileOptions = [{ label: "Same as running agent", value: SAME_AS_RUNNING }, ...profiles];
  // Keep a saved profile selectable while the list loads or if the profile was deleted.
  if (draft.handoffProfileId && !profiles.some((profile) => profile.value === draft.handoffProfileId)) {
    profileOptions.push({ label: "Unknown profile", value: draft.handoffProfileId });
  }

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
          label="Agent profile"
          hint="Provider, model and effort come from the profile (its mode is ignored). Defaults to the idle agent's own."
          value={draft.handoffProfileId}
          options={profileOptions}
          onValueChange={(value) => update({ handoffProfileId: value })}
        />
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
      {loadError ? <Text style={styles.error}>Could not load profiles or workspaces: {loadError}</Text> : null}
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
