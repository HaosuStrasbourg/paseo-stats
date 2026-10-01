import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TpsPoint } from "../shared/contracts.shared";
import { fmtClock, fmtInt } from "../shared/format.shared";
import { T } from "./i18n.client";

const HEIGHT = 48;
const MAX_POINTS = 80;

/**
 * Per-call output speed, oldest to newest. Points are evenly spaced by call order: on a
 * wall-clock axis the idle time between turns would squeeze each turn into a narrow clump.
 * Drawn with rotated Views because the plugin runtime has no SVG.
 */
export function TpsChart({
  points,
  unit,
  width,
  theme,
}: {
  points: TpsPoint[];
  unit: "call" | "turn";
  width: number;
  theme: PluginTheme;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const data = points.slice(-MAX_POINTS);
  const geo = useMemo(() => {
    const max = Math.max(1, ...data.map((p) => p.tps)) * 1.1;
    const step = data.length > 1 ? width / (data.length - 1) : 0;
    const xy = data.map((p, i) => ({
      x: data.length > 1 ? i * step : width / 2,
      y: HEIGHT - (p.tps / max) * HEIGHT,
    }));
    // Token-weighted: total tokens over total streaming seconds.
    const seconds = data.reduce((s, p) => s + p.tokens / p.tps, 0);
    const avg = seconds > 0 ? data.reduce((s, p) => s + p.tokens, 0) / seconds : 0;
    const firstCurrent = data.findIndex((p) => p.current);
    return { max, step, xy, avg, avgY: HEIGHT - (avg / max) * HEIGHT, firstCurrent };
  }, [data, width]);

  const muted = theme.colors.foregroundMuted;
  if (data.length === 0) {
    return (
      <Text style={{ fontSize: 11, color: muted }}>{T.noData}</Text>
    );
  }
  const f = focus !== null ? data[focus] : null;
  const last = data[data.length - 1]!;
  const peak = Math.max(...data.map((p) => p.tps));
  const hit = data.length > 1 ? geo.step : width;
  const strong = { fontSize: 13, fontWeight: "600" as const, color: muted, fontVariant: ["tabular-nums" as const] };
  const small = { fontSize: 11, color: muted };

  return (
    <View style={{ gap: 4 }}>
      {f ? (
        <View style={{ flexDirection: "row", flexWrap: "nowrap", alignItems: "baseline", gap: 6, height: 18, overflow: "hidden" }}>
          <Text numberOfLines={1} style={small}>{fmtClock(f.at)}</Text>
          <Text numberOfLines={1} style={strong}>~{Math.round(f.tps)}</Text>
          <Text numberOfLines={1} style={small}>tok/s · {fmtInt(f.tokens)} tok</Text>
        </View>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "nowrap", alignItems: "baseline", gap: 6, height: 18, overflow: "hidden" }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.accent, alignSelf: "center" }} />
          <Text numberOfLines={1} style={small}>{T.chartNow}</Text>
          <Text numberOfLines={1} style={strong}>~{Math.round(last.tps)}</Text>
          <View style={{ width: 10, borderTopWidth: 1, borderStyle: "dashed", borderColor: muted, alignSelf: "center", marginLeft: 6 }} />
          <Text numberOfLines={1} style={small}>{T.chartAvg}</Text>
          <Text numberOfLines={1} style={strong}>~{Math.round(geo.avg)}</Text>
          <Text numberOfLines={1} style={small}>tok/s</Text>
          <Text numberOfLines={1} style={[small, { marginLeft: "auto" }]}>
            {T.chartPeak} ~{Math.round(peak)}
          </Text>
        </View>
      )}
      <View style={{ width, height: HEIGHT, position: "relative" }}>
        {geo.firstCurrent >= 0 ? (
          // The latest turn's calls sit on a faint band.
          <View
            style={{
              position: "absolute",
              left: Math.max(0, geo.xy[geo.firstCurrent]!.x - hit / 2),
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: theme.colors.surface2,
              borderRadius: 3,
            }}
          />
        ) : null}
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: geo.avgY,
            borderTopWidth: 1,
            borderStyle: "dashed",
            borderColor: muted,
            opacity: 0.6,
          }}
        />
        {geo.xy.slice(1).map((b, i) => {
          const a = geo.xy[i]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          return (
            <View
              key={i}
              style={{
                position: "absolute",
                left: (a.x + b.x) / 2 - len / 2,
                top: (a.y + b.y) / 2 - 1,
                width: len,
                height: 2,
                borderRadius: 1,
                backgroundColor: theme.colors.accent,
                transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
              }}
            />
          );
        })}
        {(focus !== null ? [focus] : [data.length - 1]).map((i) => (
          <View
            key={`dot-${i}`}
            style={{
              position: "absolute",
              left: geo.xy[i]!.x - 4,
              top: geo.xy[i]!.y - 4,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.accent,
              borderWidth: 2,
              borderColor: theme.colors.surface1,
            }}
          />
        ))}
        {data.map((_, i) => (
          <Pressable
            key={`hit-${i}`}
            accessibilityLabel={`${fmtClock(data[i]!.at)} ${Math.round(data[i]!.tps)} tok/s`}
            onHoverIn={() => setFocus(i)}
            onHoverOut={() => setFocus((x) => (x === i ? null : x))}
            onPress={() => setFocus((x) => (x === i ? null : i))}
            style={{ position: "absolute", left: geo.xy[i]!.x - hit / 2, width: hit, top: 0, bottom: 0 }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 10, color: muted }}>{fmtClock(data[0]!.at)}</Text>
        <Text style={{ fontSize: 10, color: muted }}>
          {unit === "call" ? T.chartPerCall(data.length) : T.chartPerTurn(data.length)}
        </Text>
        <Text style={{ fontSize: 10, color: muted }}>{fmtClock(last.at)}</Text>
      </View>
    </View>
  );
}
