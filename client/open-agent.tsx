import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

export const OPEN_AGENT_SCREEN_ID = "baton-open-agent";

// Composer menu actions get no navigation handle, but screens do, so continuing opens this
// transient screen, which forwards to the new agent. Agents already forwarded show a button
// instead, so pressing back from the agent does not bounce straight forward again.
const forwarded = new Set<string>();

export function OpenAgentScreen({ theme, navigation, params }: PluginScreenProps) {
  const agentId = params.agentId ?? "";
  const canOpen = Boolean(navigation && agentId);

  useEffect(() => {
    if (!navigation || !agentId || forwarded.has(agentId)) return;
    forwarded.add(agentId);
    navigation.openAgent({ agentId });
  }, [navigation, agentId]);

  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {canOpen ? "Opening the continuation agent..." : "The continuation agent was created."}
      </Text>
      {canOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open continuation agent"
          onPress={() => navigation?.openAgent({ agentId })}
          style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent, alignItems: "center" }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>Open agent</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
