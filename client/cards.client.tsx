import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginButtonContentProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import {
  readDetail,
  readHeatmap,
  type GrokExtras,
  type ProviderId,
  type QuotaRow,
  type StatsColumn,
  type ToolCategory,
} from "../shared/contracts.shared";
import {
  DASH,
  est,
  fmtClock,
  fmtDelta,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtPercent,
  fmtTokens,
  fmtTps,
  fmtUsd,
} from "../shared/format.shared";
import { HeatmapView } from "./heatmap.client";
import { relativeTo, T } from "./i18n.client";
import { Bar } from "./meter.client";
import { TpsChart } from "./tps-chart.client";

const CARD_WIDTH = 300;

function useDetail(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const read = useRpc(readDetail);
  return useQuery({
    queryKey: ["session-stats", "detail", agentId],
    queryFn: () => read({ agentId }),
    enabled: agentId !== "",
    refetchInterval: 4_000,
  });
}

function Card({ title, theme, children, sub }: { title: string; theme: PluginTheme; children: ReactNode; sub?: string }) {
  return (
    <View style={{ width: CARD_WIDTH, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground }}>{title}</Text>
        {sub ? <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{sub}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Row({ label, value, theme, indent }: { label: string; value: string; theme: PluginTheme; indent?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, paddingLeft: indent ? 10 : 0 }}>{label}</Text>
      <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

function Rule({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

function Status({ theme, loading, error }: { theme: PluginTheme; loading: boolean; error: unknown }) {
  return (
    <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
      {loading ? T.loading : T.failed(error instanceof Error ? error.message : String(error))}
    </Text>
  );
}

/** One secondary line: muted, single-line; the left side gives way so the right never wraps. */
function MutedLine({ left, right, theme }: { left: string; right: string; theme: PluginTheme }) {
  const style = { fontSize: 11, color: theme.colors.foregroundMuted };
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
      <Text numberOfLines={1} style={[style, { flexShrink: 1 }]}>
        {left}
      </Text>
      <Text numberOfLines={1} style={[style, { flexShrink: 0 }]}>
        {right}
      </Text>
    </View>
  );
}

// ---- Usage card ----

function DailyHeatmap({ provider, theme }: { provider: ProviderId; theme: PluginTheme }) {
  const readMap = useRpc(readHeatmap);
  const heat = useQuery({
    queryKey: ["session-stats", "heatmap", provider],
    queryFn: () => readMap({ provider }),
    refetchInterval: 60_000,
  });
  return heat.data ? (
    <HeatmapView data={heat.data} theme={theme} />
  ) : (
    <Status theme={theme} loading={heat.isLoading} error={heat.error} />
  );
}

function QuotaBlock({ row, theme }: { row: QuotaRow; theme: PluginTheme }) {
  return (
    <View style={{ gap: 4 }}>
      <Row label={T.quotaTitle[row.key]} value={T.quotaUsed(fmtPercent(row.percent), fmtDelta(row.turnDelta))} theme={theme} />
      <Bar percent={row.percent} theme={theme} />
      <MutedLine
        theme={theme}
        left={row.resetsAt ? T.resets(fmtClock(row.resetsAt), relativeTo(row.resetsAt)) : T.resetsUnknown}
        right={T.windowTokens(fmtTokens(row.windowTokens))}
      />
    </View>
  );
}

export function UsageCardContent(props: PluginButtonContentProps) {
  const { theme } = props;
  const q = useDetail(props);
  const d = q.data;
  const provider = d?.provider ?? null;
  return (
    <Card title={T.usageTitle} theme={theme}>
      {provider ? <DailyHeatmap provider={provider} theme={theme} /> : null}
      {provider ? <Rule theme={theme} /> : null}
      {!d ? (
        <Status theme={theme} loading={q.isLoading} error={q.error} />
      ) : (
        <>
          {d.usage.quotas.length > 0 ? (
            d.usage.quotas.map((row) => <QuotaBlock key={row.key} row={row} theme={theme} />)
          ) : (
            <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{T.noQuota}</Text>
          )}
          <Rule theme={theme} />
          <MutedLine
            theme={theme}
            left={T.compactions(d.usage.compactions === null ? DASH : String(d.usage.compactions))}
            right={
              d.usage.fetchedAt
                ? T.quotaAsOf(fmtClock(d.usage.fetchedAt), relativeTo(d.usage.fetchedAt))
                : T.quotaAsOfUnknown
            }
          />
        </>
      )}
    </Card>
  );
}

// ---- Session stats card ----

function Row3({ label, a, b, theme, indent }: { label: string; a: string; b: string; theme: PluginTheme; indent?: boolean }) {
  const color = theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: 12, color, paddingLeft: indent ? 10 : 0 }}>{label}</Text>
      <Text style={{ width: 70, textAlign: "right", fontSize: 12, color, fontVariant: ["tabular-nums"] }}>{a}</Text>
      <Text style={{ width: 70, textAlign: "right", fontSize: 12, color, fontVariant: ["tabular-nums"] }}>{b}</Text>
    </View>
  );
}

const CATEGORY_ORDER: ToolCategory[] = ["shell", "read", "edit", "search", "web", "agent", "mcp", "other"];

export function StatsCardContent(props: PluginButtonContentProps) {
  const { theme } = props;
  const q = useDetail(props);
  const d = q.data;
  if (!d) {
    return (
      <Card title={T.statsTitle} theme={theme}>
        <Status theme={theme} loading={q.isLoading} error={q.error} />
      </Card>
    );
  }
  const { turn, session } = d.stats;
  const cats = new Set([...Object.keys(turn.toolByCategory ?? {}), ...Object.keys(session.toolByCategory ?? {})]);
  const ordered = CATEGORY_ORDER.filter((c) => cats.has(c));
  const toolCell = (c: StatsColumn, cat: ToolCategory) =>
    c.toolByCategory === null ? DASH : fmtDuration(c.toolByCategory[cat] ?? 0);
  return (
    <Card title={T.statsTitle} theme={theme} sub={T.turnsSteps(String(d.turns ?? DASH), String(d.steps ?? DASH))}>
      <TpsChart points={d.stats.tpsSeries} unit={d.stats.seriesUnit} width={CARD_WIDTH - 24} theme={theme} />
      <Rule theme={theme} />
      <View style={{ gap: 3 }}>
        <Row3 label="" a={T.colTurn} b={T.colSession} theme={theme} />
        <Row3 label={T.ttft} a={est(fmtDuration(turn.ttftMs))} b={est(fmtDuration(session.ttftMs))} theme={theme} />
        <Row3 label={T.tps} a={fmtTps(turn.tps)} b={fmtTps(session.tps)} theme={theme} />
        <Row3 label={T.modelTime} a={est(fmtDuration(turn.modelMs))} b={est(fmtDuration(session.modelMs))} theme={theme} />
        <Row3 label={T.modelCalls} a={fmtInt(turn.calls)} b={fmtInt(session.calls)} theme={theme} />
        <Rule theme={theme} />
        <Row3 label={T.toolTime} a={fmtDuration(turn.toolMs)} b={fmtDuration(session.toolMs)} theme={theme} />
        <Row3 label={T.toolCalls} a={fmtInt(turn.toolCalls)} b={fmtInt(session.toolCalls)} theme={theme} />
        {ordered.map((cat) => (
          <Row3 key={cat} label={T.category[cat]} a={toolCell(turn, cat)} b={toolCell(session, cat)} theme={theme} indent />
        ))}
        <Rule theme={theme} />
        <Row3 label={T.apiRetries} a={fmtInt(turn.apiRetries)} b={fmtInt(session.apiRetries)} theme={theme} />
      </View>
    </Card>
  );
}

function GrokSection({ g, theme }: { g: GrokExtras; theme: PluginTheme }) {
  const n = (v: number | null) => fmtInt(v);
  const ms = (v: number | null) => (v === null ? DASH : String(Math.round(v)));
  return (
    <View style={{ gap: 3 }}>
      <Rule theme={theme} />
      <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{T.grokSection}</Text>
      <Row
        label={T.itl}
        value={`${ms(g.itlP50Ms)}/${ms(g.itlP99Ms)}/${ms(g.itlMaxMs)} ms · ${T.longPauses} ${n(g.longPauses)}`}
        theme={theme}
      />
      <Row
        label={T.failures}
        value={`${n(g.toolFailures)} · ${n(g.errors)} · ${n(g.cancellations)} · ${n(g.regenerations)}`}
        theme={theme}
      />
      <Row label={T.recoveries} value={`${n(g.doomLoopRecoveries)} · ${n(g.idleTimeouts)}`} theme={theme} />
    </View>
  );
}

// ---- Token card ----

export function TokenCardContent(props: PluginButtonContentProps) {
  const { theme } = props;
  const q = useDetail(props);
  const d = q.data;
  const t = d?.tokens;
  const share = t && t.output && t.thinking !== null ? t.thinking / t.output : null;
  const costLabel = t?.costSource === "provider" && d?.provider ? T.costProvider(d.provider) : T.costRates;
  return (
    <Card title={T.tokensTitle} theme={theme} sub={T.thisSession}>
      {!t ? (
        <Status theme={theme} loading={q.isLoading} error={q.error} />
      ) : (
        <View style={{ gap: 5 }}>
          <Row label={T.total} value={T.withDetail(fmtTokens(t.total), fmtInt(t.total))} theme={theme} />
          <Row label={T.input} value={fmtInt(t.input)} theme={theme} indent />
          <Row label={T.cacheRead} value={fmtInt(t.cacheRead)} theme={theme} indent />
          <Row label={T.cacheWrite} value={fmtInt(t.cacheWrite)} theme={theme} indent />
          <Row label={T.output} value={fmtInt(t.output)} theme={theme} indent />
          <Row
            label={T.thinking}
            value={t.thinking === null ? DASH : T.withDetail(fmtInt(t.thinking), fmtPct(share))}
            theme={theme}
            indent
          />
          <Rule theme={theme} />
          <Row label={T.hitRate} value={fmtPct(t.cacheHitRate, 1)} theme={theme} />
          <Row label={T.invalidations} value={fmtInt(t.cacheInvalidations)} theme={theme} />
          <Row label={costLabel} value={t.costSource === "rates" ? est(fmtUsd(t.costUsd)) : fmtUsd(t.costUsd)} theme={theme} />
          <Row
            label={T.turnCost}
            value={t.costSource === "rates" ? est(fmtUsd(t.turnCostUsd)) : fmtUsd(t.turnCostUsd)}
            theme={theme}
            indent
          />
          <Row label={T.model} value={t.models.length ? t.models.join(" / ") : DASH} theme={theme} />
        </View>
      )}
      {d?.grok ? <GrokSection g={d.grok} theme={theme} /> : null}
    </Card>
  );
}

// ---- Files card ----

const FILE_LIST_MAX = 8;

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.lastIndexOf("/") > 0 ? p.slice(0, p.lastIndexOf("/")) : "");

export function FilesCardContent(props: PluginButtonContentProps) {
  const { theme } = props;
  const q = useDetail(props);
  const f = q.data?.files;
  const muted = theme.colors.foregroundMuted;
  return (
    <Card title={T.filesTitle} theme={theme} sub={T.thisSession}>
      {!q.data ? (
        <Status theme={theme} loading={q.isLoading} error={q.error} />
      ) : !f || f.list.length === 0 ? (
        <Text style={{ fontSize: 12, color: muted }}>{T.filesNone}</Text>
      ) : (
        <>
          <View style={{ gap: 3 }}>
            <Row3 label="" a={T.colTurn} b={T.colSession} theme={theme} />
            <Row3 label={T.filesChanged} a={fmtInt(f.turn.files)} b={fmtInt(f.session.files)} theme={theme} />
            <Row3 label={T.linesAdded} a={`+${fmtInt(f.turn.added)}`} b={`+${fmtInt(f.session.added)}`} theme={theme} />
            <Row3 label={T.linesRemoved} a={`−${fmtInt(f.turn.removed)}`} b={`−${fmtInt(f.session.removed)}`} theme={theme} />
          </View>
          <Rule theme={theme} />
          <View style={{ gap: 3 }}>
            {f.list.slice(0, FILE_LIST_MAX).map((item) => (
              <View key={item.path} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {/* Files touched in the latest turn carry a dot. */}
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: item.inTurn ? theme.colors.accent : "transparent",
                  }}
                />
                {/* File name first so truncation only ever eats the directory. */}
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: muted }}>
                  {fileName(item.path)}
                  <Text style={{ fontSize: 11, opacity: 0.7 }}>{dirName(item.path) ? `  ${dirName(item.path)}` : ""}</Text>
                </Text>
                <Text style={{ fontSize: 12, color: muted, fontVariant: ["tabular-nums"] }}>
                  +{fmtInt(item.added)} −{fmtInt(item.removed)}
                </Text>
              </View>
            ))}
            {f.list.length > FILE_LIST_MAX ? (
              <Text style={{ fontSize: 11, color: muted, paddingLeft: 11 }}>{T.filesMore(f.list.length - FILE_LIST_MAX)}</Text>
            ) : null}
          </View>
        </>
      )}
      <Text style={{ fontSize: 10, color: muted }}>{T.filesNote}</Text>
    </Card>
  );
}
