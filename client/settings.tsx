import { useSettings, usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import type { PaseoApi } from "@getpaseo/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BatonSettings } from "../shared/baton";
import {
  batonSettings,
  DEFAULT_SETTINGS,
  DETAIL_LEVELS,
  DETAIL_LIMITS,
  isProjectIgnored,
  MAX_CLEANUP_DAYS,
  MAX_IDLE_DELAY_MINUTES,
  type DetailLevel,
} from "../shared/baton";

interface ProfileChoice {
  value: string;
  name: string;
  detail: string;
}

interface WorkspaceChoice {
  id: string;
  name: string;
  project: string;
  projectId: string;
}

const SAME_AS_RUNNING = "";

const DETAIL_INFO: Record<DetailLevel, { name: string; note: string }> = {
  compact: { name: "Compact", note: "Cheapest, least detail." },
  standard: { name: "Standard", note: "A good balance." },
  full: { name: "Full", note: "Most detail, higher writer cost." },
};

// e.g. "Up to about 60k characters of conversation, 2000 history entries. A good balance."
function describeDetail(level: DetailLevel): string {
  const limits = DETAIL_LIMITS[level];
  return `Up to about ${Math.round(limits.maxChars / 1000)}k characters of conversation, ${limits.historyEntries} history entries. ${DETAIL_INFO[level].note}`;
}

type ProviderSnapshot = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;
type DaemonProfile = NonNullable<Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"]["agentProfiles"]>[number];

// Detail line like "Claude · Sonnet 5.5 · Plan mode · Low", falling back to raw ids for unknown providers.
function describeProfile(profile: DaemonProfile, snapshot: ProviderSnapshot | null): string {
  const entry = snapshot?.entries.find((candidate) => candidate.provider === profile.provider);
  const model = entry?.models?.find((candidate) => candidate.id === profile.model);
  const mode = entry?.modes?.find((candidate) => candidate.id === profile.modeId);
  const effort = model?.thinkingOptions?.find((candidate) => candidate.id === profile.thinkingOptionId);
  const parts = [
    entry?.label ?? profile.provider,
    profile.model ? (model?.label ?? profile.model) : null,
    profile.modeId ? `${mode?.label ?? profile.modeId} mode` : null,
    profile.thinkingOptionId ? (effort?.label ?? profile.thinkingOptionId) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

/** How long after the last change the settings are saved, so typing in a field saves once. */
const AUTOSAVE_DELAY_MS = 800;

/** JSON with sorted keys, so two copies of the same settings compare equal whatever order their keys came in. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

function clampInt(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

export function BatonSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(batonSettings);
  const paseo = usePaseo();
  const toast = useToast();
  const [draft, setDraft] = useState<BatonSettings | null>(null);
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The draft that last failed to save; it is not retried until the user changes something. */
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const savedJson = settings.status === "ready" ? stableJson(settings.values) : null;
  const revision = settings.status === "ready" ? settings.revision : null;
  const draftJson = draft === null ? null : stableJson(draft);

  // The timer below runs later, so it reads the newest values from here instead of the render that set it.
  const latest = useRef({ draft, settings, toast });
  useEffect(() => {
    latest.current = { draft, settings, toast };
  });

  // Changes are saved on their own shortly after the last edit.
  useEffect(() => {
    if (draftJson === null || savedJson === null || settings.saving) return;
    if (draftJson === savedJson || draftJson === failedDraft) return;
    const timer = setTimeout(() => {
      void (async () => {
        const { draft: toSave, settings: current } = latest.current;
        // A save already running re-arms this effect when it finishes.
        if (!toSave || current.status !== "ready" || current.saving) return;
        const savedDraft = stableJson(toSave);
        if (await current.save(toSave, current.revision)) {
          setFailedDraft(null);
          await current.reload();
        } else {
          setFailedDraft(savedDraft);
          latest.current.toast.error("Could not save Baton settings");
        }
      })();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftJson, savedJson, revision, settings.saving, failedDraft]);

  useEffect(() => {
    if (draft !== null) return;
    if (settings.status === "ready") setDraft(settings.values);
    else if (settings.status === "error" || settings.status === "invalid") setDraft(DEFAULT_SETTINGS);
  }, [draft, settings.status]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [daemon, listed, snapshot] = await Promise.all([
          paseo.config.get(),
          paseo.workspaces.list(),
          paseo.providers.snapshot().catch(() => null),
        ]);
        if (cancelled) return;
        setProfiles(
          (daemon.config.agentProfiles ?? []).map((profile) => ({
            value: profile.id,
            name: profile.name,
            detail: describeProfile(profile, snapshot),
          })),
        );
        setWorkspaces(
          listed.entries.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            project: workspace.projectDisplayName,
            projectId: workspace.projectId,
          })),
        );
        setWorkspacesLoaded(true);
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
      profileRow: {
        padding: 10,
        marginBottom: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        gap: 2,
      },
      profileRowSelected: {
        borderColor: theme.colors.accent,
      },
      profileName: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 17 : 19,
        fontWeight: "700" as const,
        marginTop: layout.compact ? 12 : 16,
        marginBottom: 8,
      },
      subTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 15 : 16,
        fontWeight: "600" as const,
        marginTop: 12,
        marginBottom: 6,
      },
      saveBar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      saveBarStatus: {
        flex: 1,
        fontSize: layout.compact ? 13 : 14,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: layout.compact ? 12 : 13,
        marginTop: 8,
      },
    }),
    [theme, layout.compact],
  );

  const projects = useMemo(() => {
    const grouped = new Map<string, { name: string; items: WorkspaceChoice[] }>();
    for (const workspace of workspaces) {
      const group = grouped.get(workspace.projectId) ?? { name: workspace.project, items: [] };
      group.items.push(workspace);
      grouped.set(workspace.projectId, group);
    }
    return [...grouped.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name));
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

  const profileOptions: ProfileChoice[] = [
    { value: SAME_AS_RUNNING, name: "Same as running agent", detail: "The idle agent's own provider, model and effort" },
    ...profiles,
  ];
  // Keep a saved profile visible while the list loads or if the profile was deleted.
  if (draft.handoffProfileId && !profiles.some((profile) => profile.value === draft.handoffProfileId)) {
    profileOptions.push({ value: draft.handoffProfileId, name: "Unknown profile", detail: draft.handoffProfileId });
  }

  const toggleProject = (id: string, ignored: boolean) => {
    const rest = draft.ignoredProjectIds.filter((existing) => existing !== id);
    update({
      ignoredProjectIds: ignored ? [...rest, id] : rest,
      knownProjectIds: [...new Set([...draft.knownProjectIds, id])],
    });
  };

  // Projects that exist when the switch is turned on stay active; only projects that appear later are ignored.
  const setIgnoreNewProjects = (value: boolean) => {
    update({
      ignoreNewProjects: value,
      knownProjectIds: value ? [...new Set([...draft.knownProjectIds, ...projects.map(([id]) => id)])] : draft.knownProjectIds,
    });
  };

  const toggleWorkspace = (id: string, ignored: boolean) => {
    const rest = draft.ignoredWorkspaceIds.filter((existing) => existing !== id);
    update({ ignoredWorkspaceIds: ignored ? [...rest, id] : rest });
  };

  const dirty = savedJson !== null && draftJson !== savedJson;
  const failed = dirty && draftJson === failedDraft;
  const saveStatus = failed ? "Could not save. Change a setting to try again." : dirty || settings.saving ? "Saving..." : "All changes saved";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 24 }} stickyHeaderIndices={[0]}>
      <View style={styles.saveBar}>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.saveBarStatus, { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted }]}
        >
          {saveStatus}
        </Text>
      </View>
      <Text style={styles.sectionTitle}>When to write a handoff</Text>
      <SettingsCard>
        <SettingsInput
          label="Idle delay (minutes)"
          hint={`Write a handoff once an agent has been idle this long (1-${MAX_IDLE_DELAY_MINUTES}). The countdown starts when the agent's own turn ends, even if subagents it started are still running.`}
          initialValue={String(draft.idleDelayMinutes)}
          onChangeText={(value) => update({ idleDelayMinutes: clampInt(value, draft.idleDelayMinutes, MAX_IDLE_DELAY_MINUTES) })}
        />
        <SettingsSwitch
          label="Wait for subagents to finish"
          hint="If agents started by this one are still working when the countdown ends, restart it instead of writing the handoff. Turn off to write it regardless. A subagent still running after 4 hours is no longer waited for. Subagents that run inside the provider itself (for example Claude's Task tool) are not visible to Baton and are not waited for."
          value={draft.waitForSubagents}
          onValueChange={(value) => update({ waitForSubagents: value })}
        />
      </SettingsCard>
      <Text style={styles.sectionTitle}>Handoff writer</Text>
      <SettingsCard>
        <Text style={[styles.hint, { marginBottom: 8 }]}>
          Provider, model and effort come from the profile; its mode is ignored.
        </Text>
        {profileOptions.map((option) => {
          const selected = draft.handoffProfileId === option.value;
          return (
            <Pressable
              key={option.value || "same"}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${option.name}: ${option.detail}`}
              onPress={() => update({ handoffProfileId: option.value })}
              style={[styles.profileRow, selected ? styles.profileRowSelected : null]}
            >
              <Text style={styles.profileName}>{selected ? `\u2713 ${option.name}` : option.name}</Text>
              <Text style={styles.hint}>{option.detail}</Text>
            </Pressable>
          );
        })}
      </SettingsCard>
      <Text style={styles.sectionTitle}>Handoff detail</Text>
      <SettingsCard>
        <Text style={[styles.hint, { marginBottom: 8 }]}>
          How much of the conversation the writer sees. Long messages keep their start and end, and the writer is told
          when earlier history was left out.
        </Text>
        {DETAIL_LEVELS.map((level) => {
          const selected = draft.conversationDetail === level;
          return (
            <Pressable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${DETAIL_INFO[level].name}: ${describeDetail(level)}`}
              onPress={() => update({ conversationDetail: level })}
              style={[styles.profileRow, selected ? styles.profileRowSelected : null]}
            >
              <Text style={styles.profileName}>{selected ? `\u2713 ${DETAIL_INFO[level].name}` : DETAIL_INFO[level].name}</Text>
              <Text style={styles.hint}>{describeDetail(level)}</Text>
            </Pressable>
          );
        })}
        <SettingsSwitch
          label="Include repo state"
          hint="Add the branch, changed files and recent commit titles from git. They go to the writer's provider with the conversation. Turn off to keep file names and commit messages out of the draft."
          value={draft.includeRepoState}
          onValueChange={(value) => update({ includeRepoState: value })}
        />
        <SettingsSwitch
          label="Save the writer's prompt"
          hint="For checking what the writer was given. Keeps the latest prompt for each agent in Baton's data folder (~/.paseo/plugin-data/baton/writer-prompts). It contains your conversation text, so leave it off unless you are debugging."
          value={draft.saveWriterPrompts}
          onValueChange={(value) => update({ saveWriterPrompts: value })}
        />
      </SettingsCard>
      <Text style={styles.sectionTitle}>Handoff files</Text>
      <SettingsCard>
        <SettingsInput
          label="Storage location"
          hint="Where handoff files are saved. Leave empty for the default, .paseo/handoffs inside each workspace. Use an absolute path, ~/..., or a path relative to the workspace. Handoffs contain excerpts of your conversations, so add this folder to .gitignore if it is inside a git repository."
          placeholder=".paseo/handoffs"
          initialValue={draft.handoffDirectory}
          onChangeText={(value) => update({ handoffDirectory: value })}
        />
        <SettingsSwitch
          label="Delete unused handoffs when a session resumes"
          hint="If you keep working in the original session and nobody continued the handoff, delete its file. Turn off to keep every file."
          value={draft.deleteStaleHandoffs}
          onValueChange={(value) => update({ deleteStaleHandoffs: value })}
        />
        <SettingsSwitch
          label="Clean up old handoffs automatically"
          hint="Once a day, and when Baton starts, delete handoff files that nobody continued after the number of days below. Handoffs you continued are kept."
          value={draft.cleanupOldHandoffs}
          onValueChange={(value) => update({ cleanupOldHandoffs: value })}
        />
        {draft.cleanupOldHandoffs ? (
          <SettingsInput
            label="Clean up after (days)"
            hint={`1-${MAX_CLEANUP_DAYS}. Counted from when the handoff was written.`}
            initialValue={String(draft.cleanupAfterDays)}
            onChangeText={(value) => update({ cleanupAfterDays: clampInt(value, draft.cleanupAfterDays, MAX_CLEANUP_DAYS) })}
          />
        ) : null}
      </SettingsCard>
      <Text style={styles.sectionTitle}>Ignored projects and workspaces</Text>
      <Text style={[styles.hint, { marginBottom: 8 }]}>
        Agents in an ignored project or workspace never produce handoffs. Ignoring a project covers all of its
        workspaces, including ones created later.
      </Text>
      <SettingsCard>
        <SettingsSwitch
          label="Ignore new projects by default"
          hint="Off by default, so new projects get handoffs. Turn on to leave projects that appear from now on ignored until you switch them on here. Projects listed below keep their current setting."
          value={draft.ignoreNewProjects}
          disabled={!workspacesLoaded}
          onValueChange={setIgnoreNewProjects}
        />
      </SettingsCard>
      {projects.map(([projectId, group]) => {
        const projectIgnored = isProjectIgnored(draft, projectId);
        return (
          <View key={projectId}>
            <Text style={styles.subTitle}>{group.name}</Text>
            <SettingsCard>
              <SettingsSwitch
                label="Ignore entire project"
                value={projectIgnored}
                onValueChange={(value) => toggleProject(projectId, value)}
              />
              {group.items.map((workspace) => (
                <SettingsSwitch
                  key={workspace.id}
                  label={workspace.name}
                  value={projectIgnored || draft.ignoredWorkspaceIds.includes(workspace.id)}
                  disabled={projectIgnored}
                  onValueChange={(value) => toggleWorkspace(workspace.id, value)}
                />
              ))}
            </SettingsCard>
          </View>
        );
      })}
      {loadError ? <Text style={styles.error}>Could not load profiles or workspaces: {loadError}</Text> : null}
      {settings.status === "invalid" ? <Text style={styles.error}>{settings.error}</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </ScrollView>
  );
}
