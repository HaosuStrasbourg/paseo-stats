import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Heatmap } from "../shared/contracts.shared";
import { fmtTokens } from "../shared/format.shared";
import { T } from "./i18n.client";

const WEEKS = 16;
const CELL = 12;
const GAP = 2;
const GRID_WIDTH = WEEKS * (CELL + GAP) - GAP;
/** Widest month label at 9px ("10月", "Sep"), with a little slack. */
const MONTH_LABEL_ROOM = 26;
const LEVEL_OPACITY = [0.22, 0.4, 0.58, 0.78, 1];
const DAY_MS = 86_400_000;

/** Date keys are calendar dates; do arithmetic in UTC so the client's time zone never shifts them. */
function addDays(key: string, n: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
const mondayIndex = (key: string) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;

/**
 * Five tiers by rank among days with data, so one very heavy day does not flatten the
 * rest into the lightest tier.
 */
export function levels(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  return (v: number) => {
    if (!(v > 0) || sorted.length === 0) return 0;
    let below = 0;
    while (below < sorted.length && sorted[below]! < v) below++;
    let upto = below;
    while (upto < sorted.length && sorted[upto] === v) upto++;
    // Mid-rank of ties, in (0, 1].
    const rank = (below + upto) / 2 / sorted.length;
    return Math.min(5, Math.max(1, Math.ceil(rank * 5)));
  };
}

export function HeatmapView({ data, theme }: { data: Heatmap; theme: PluginTheme }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const grid = useMemo(() => {
    const lastMonday = addDays(data.today, -mondayIndex(data.today));
    const firstMonday = addDays(lastMonday, -7 * (WEEKS - 1));
    const columns: string[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col: string[] = [];
      for (let d = 0; d < 7; d++) {
        const key = addDays(firstMonday, w * 7 + d);
        if (key > data.today) break;
        col.push(key);
      }
      columns.push(col);
    }
    const visible = columns.flat().map((k) => data.days[k] ?? 0);
    const level = levels(visible);
    const months = columns.map((col, i) => {
      const m = Number(col[0]!.slice(5, 7));
      const prev = i > 0 ? Number(columns[i - 1]![0]!.slice(5, 7)) : null;
      return prev === null || prev !== m ? T.month(m) : "";
    });
    // A partial first month would collide with the next label.
    if (months[1]) months[0] = "";
    return { columns, level, months };
  }, [data]);

  const focus = hovered ?? selected;
  const muted = theme.colors.foregroundMuted;
  const empty = theme.colors.surface2;

  // One line, always: short date, weekday, compact total. Anything longer is cut, not wrapped.
  const detail = focus
    ? `${T.shortDate(focus)} ${T.weekdayLong(mondayIndex(focus))} · ${
        data.days[focus] ? `${fmtTokens(data.days[focus])} tok` : T.noData
      }`
    : T.heatmapFooter(data.provider);

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 16, marginTop: 14, gap: GAP }}>
          {T.weekdays.map((d, i) => (
            <Text key={i} style={{ height: CELL, fontSize: 9, lineHeight: CELL, color: muted }}>
              {i % 2 === 0 ? d : ""}
            </Text>
          ))}
        </View>
        <View>
          <View style={{ height: 14, width: GRID_WIDTH }}>
            {grid.months.map((m, i) => {
              if (!m) return null;
              const left = i * (CELL + GAP);
              // Near the right edge a left-anchored label has no room and would wrap; anchor it right instead.
              const anchor = left + MONTH_LABEL_ROOM > GRID_WIDTH ? { right: 0 } : { left };
              return (
                <Text key={i} numberOfLines={1} style={{ position: "absolute", ...anchor, top: 0, fontSize: 9, color: muted }}>
                  {m}
                </Text>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: GAP }}>
            {grid.columns.map((col, w) => (
              <View key={w} style={{ gap: GAP }}>
                {col.map((key) => {
                  const lv = grid.level(data.days[key] ?? 0);
                  const isFocus = key === focus;
                  return (
                    <Pressable
                      key={key}
                      accessibilityLabel={`${key} ${fmtTokens(data.days[key] ?? null)} tok`}
                      onPress={() => setSelected((s) => (s === key ? null : key))}
                      onHoverIn={() => setHovered(key)}
                      onHoverOut={() => setHovered((h) => (h === key ? null : h))}
                      hitSlop={1}
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 2,
                        backgroundColor: lv === 0 ? empty : theme.colors.accent,
                        opacity: lv === 0 ? 1 : LEVEL_OPACITY[lv - 1],
                        borderWidth: isFocus ? 1 : 0,
                        borderColor: theme.colors.foreground,
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text numberOfLines={1} style={{ fontSize: 11, color: muted, flexShrink: 1 }}>
          {detail}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <Text style={{ fontSize: 9, color: muted, marginRight: 2 }}>{T.less}</Text>
          <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: empty }} />
          {LEVEL_OPACITY.map((o) => (
            <View key={o} style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: theme.colors.accent, opacity: o }} />
          ))}
          <Text style={{ fontSize: 9, color: muted, marginLeft: 2 }}>{T.more}</Text>
        </View>
      </View>
    </View>
  );
}
