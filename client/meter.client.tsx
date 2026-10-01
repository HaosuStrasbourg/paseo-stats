import type { PluginTheme } from "@getpaseo/plugin";
import { View } from "react-native";

export function tone(percent: number, theme: PluginTheme): string {
  if (percent > 90) return theme.colors.statusDanger;
  if (percent >= 70) return theme.colors.statusWarning;
  return theme.colors.accent;
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** Ring gauge drawn from two clipped half-circle borders (no SVG in the plugin runtime). */
export function Ring({ percent, size, theme }: { percent: number | null; size: number; theme: PluginTheme }) {
  const stroke = Math.max(2, Math.round(size / 5));
  const fill = clamp(percent ?? 0);
  const color = percent === null ? theme.colors.foregroundMuted : tone(fill, theme);
  const track = theme.colors.border;
  const arc = {
    position: "absolute" as const,
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: stroke,
    borderColor: "transparent",
    borderTopColor: color,
    borderRightColor: color,
  };
  const firstHalf = Math.min(fill, 50) * 3.6;
  const secondHalf = Math.max(fill - 50, 0) * 3.6;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={percent === null ? "—" : `${Math.round(fill)}%`}
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <View
        style={{ position: "absolute", width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: track }}
      />
      {fill > 0 ? (
        <View style={{ position: "absolute", right: 0, top: 0, width: size / 2, height: size, overflow: "hidden" }}>
          <View style={[arc, { right: 0, transform: [{ rotate: `${firstHalf - 135}deg` }] }]} />
        </View>
      ) : null}
      {fill > 50 ? (
        <View style={{ position: "absolute", left: 0, top: 0, width: size / 2, height: size, overflow: "hidden" }}>
          <View style={[arc, { left: 0, transform: [{ rotate: `${secondHalf + 45}deg` }] }]} />
        </View>
      ) : null}
    </View>
  );
}

export function Bar({ percent, theme, color }: { percent: number | null; theme: PluginTheme; color?: string }) {
  const fill = clamp(percent ?? 0);
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      {percent === null ? null : (
        <View style={{ height: 6, borderRadius: 3, width: `${fill}%`, backgroundColor: color ?? tone(fill, theme) }} />
      )}
    </View>
  );
}
