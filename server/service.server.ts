import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  isProvider,
  type Heatmap,
  type PillData,
  type ProviderId,
  type QuotaRow,
  type SessionDetail,
  type StatsColumn,
  type TokenCard,
  type ToolCategory,
} from "../shared/contracts.shared.ts";
import type { DailyStore } from "./daily.server.ts";
import { dayKey, paseoHome } from "./env.server.ts";
import { filesCard } from "./files.server.ts";
import { findGrokSession, grokSessionVersion, grokTokensSince, readGrokStats, type GrokStats } from "./grok.server.ts";
import type { LiveTracker } from "./live.server.ts";
import { readQuota, sameReset, windowStart } from "./quota.server.ts";
import {
  cacheHitRate,
  costUsd,
  findSessionTranscript,
  readRates,
  readSessionStats,
  tokensSince,
  totalTokens,
  type CallRecord,
  type Period,
  type SessionStats,
  type TokenTotals,
} from "./transcript.server.ts";

// ---- agent -> provider / session ----

/**
 * Fallback for agents whose snapshot this process has not seen yet (e.g. right after a
 * reload): Paseo's own agent record. Its layout is internal to Paseo, so only two fields
 * are read and any failure just yields null.
 */
async function agentRecord(agentId: string): Promise<{ provider: ProviderId | null; sessionId: string | null }> {
  const none = { provider: null, sessionId: null };
  if (!/^[\w-]+$/.test(agentId)) return none;
  const dir = path.join(paseoHome(), "agents");
  let workspaces;
  try {
    workspaces = await readdir(dir, { withFileTypes: true });
  } catch {
    return none;
  }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, w.name, `${agentId}.json`), "utf8"));
      const id = raw?.persistence?.sessionId;
      return { provider: isProvider(raw?.provider) ? raw.provider : null, sessionId: typeof id === "string" && id ? id : null };
    } catch {
      // not in this workspace
    }
  }
  return none;
}

// ---- Claude ----

const claudePaths = new Map<string, string>();
const claudeCache = new Map<string, { mtimeMs: number; size: number; stats: SessionStats }>();

async function claudeStats(sessionId: string): Promise<SessionStats | null> {
  let file = claudePaths.get(sessionId) ?? null;
  if (!file) {
    file = await findSessionTranscript(sessionId);
    if (!file) return null;
    claudePaths.set(sessionId, file);
  }
  let st;
  try {
    st = await stat(file);
  } catch {
    claudePaths.delete(sessionId);
    return null;
  }
  const cached = claudeCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.stats;
  const stats = await readSessionStats(file);
  claudeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, stats });
  return stats;
}

export interface CallSpeed {
  call: CallRecord;
  ms: number;
  tps: number;
  /** Start taken from a live message_start rather than the request send time. */
  measured: boolean;
  /** Request sent -> message_start; only when measured. */
  ttftMs: number | null;
}

/**
 * Output speed per call. Tokens and the end (last block written) come from the transcript.
 * The start is the first live streaming-usage update after the request went out, i.e. the
 * call's message_start; without one, or when it arrived implausibly late (the host sometimes
 * delivers a whole call's events at its end), the request send time is used, which can only
 * understate the speed.
 */
export function callSpeeds(calls: CallRecord[], marks: number[]): CallSpeed[] {
  const sorted = [...marks].sort((x, y) => x - y);
  const out: CallSpeed[] = [];
  for (const call of calls) {
    const total = call.lastMs - call.startMs;
    if (!(total > 0) || call.output <= 0) continue;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= call.startMs) lo = mid + 1;
      else hi = mid;
    }
    const mark = sorted[lo];
    const plausible = mark !== undefined && mark <= call.lastMs && mark - call.startMs <= Math.max(3_000, total * 0.5);
    const start = plausible ? mark : call.startMs;
    const ms = call.lastMs - start;
    if (ms < 200) continue;
    const tps = call.output / (ms / 1000);
    if (tps > 1_000) continue;
    out.push({ call, ms, tps, measured: plausible, ttftMs: plausible ? mark - call.startMs : null });
  }
  return out;
}

const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function claudeColumn(
  period: Period,
  stats: SessionStats,
  inTurn: boolean,
  waits: Record<string, number>,
  lastTurn: number,
  speeds: CallSpeed[],
): StatsColumn {
  // Tool time excludes time spent waiting for the user to approve the call.
  let toolMs = 0;
  let toolCalls = 0;
  const byCat: Partial<Record<ToolCategory, number>> = {};
  for (const t of stats.tools) {
    if (t.endMs === null || (inTurn && t.turn !== lastTurn)) continue;
    const ms = Math.max(0, t.endMs - t.startMs - (waits[t.id] ?? 0));
    toolMs += ms;
    toolCalls += 1;
    byCat[t.category] = (byCat[t.category] ?? 0) + ms;
  }
  const mine = inTurn ? speeds.filter((x) => x.call.turn === lastTurn) : speeds;
  const ms = mine.reduce((s, x) => s + x.ms, 0);
  return {
    ttftMs: mean(mine.flatMap((x) => (x.ttftMs === null ? [] : [x.ttftMs]))),
    tps: ms > 0 ? mine.reduce((s, x) => s + x.call.output, 0) / (ms / 1000) : null,
    modelMs: period.calls > 0 ? period.modelMs : null,
    toolMs,
    toolCalls,
    toolByCategory: byCat,
    calls: period.calls,
    apiRetries: period.apiRetries,
  };
}

function tokenCard(
  t: TokenTotals,
  extra: Pick<TokenCard, "cacheInvalidations" | "costUsd" | "turnCostUsd" | "costSource" | "models">,
): TokenCard {
  return {
    total: totalTokens(t),
    input: t.input,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    output: t.output,
    thinking: t.thinking,
    cacheHitRate: cacheHitRate(t),
    ...extra,
  };
}

// ---- Grok ----

const grokDirs = new Map<string, string>();
const grokCache = new Map<string, { version: string; stats: GrokStats }>();

async function grokStats(sessionId: string): Promise<GrokStats | null> {
  let dir = grokDirs.get(sessionId) ?? null;
  if (!dir) {
    dir = await findGrokSession(sessionId);
    if (!dir) return null;
    grokDirs.set(sessionId, dir);
  }
  const version = await grokSessionVersion(dir);
  const cached = grokCache.get(dir);
  if (cached && cached.version === version) return cached.stats;
  const stats = await readGrokStats(dir);
  grokCache.set(dir, { version, stats });
  return stats;
}

function grokColumn(g: GrokStats, turn: number | null): StatsColumn {
  const loops = g.loops.filter((l) => turn === null || l.turn === turn);
  const tools = g.tools.filter((t) => turn === null || t.turn === turn);
  const byCat: Partial<Record<ToolCategory, number>> = {};
  for (const t of tools) byCat[t.category] = (byCat[t.category] ?? 0) + t.ms;
  const closed = loops.filter((l) => l.endMs !== null);
  return {
    ttftMs: mean(loops.flatMap((l) => (l.firstTokenMs === null ? [] : [l.firstTokenMs - l.startMs]))),
    tps: grokSpeed(g, turn),
    modelMs: closed.length > 0 ? closed.reduce((s, l) => s + (l.endMs! - l.startMs), 0) : null,
    toolMs: tools.reduce((s, t) => s + t.ms, 0),
    toolCalls: tools.length,
    toolByCategory: byCat,
    calls: turn === null ? g.steps : loops.length,
    apiRetries: g.retries.filter((r) => turn === null || r === turn).length,
  };
}

/** Streaming milliseconds (first token -> end of the call) of a turn's calls. */
function streamingMs(g: GrokStats, turn: number): number {
  return g.loops
    .filter((l) => l.turn === turn && l.firstTokenMs !== null && l.endMs !== null)
    .reduce((s, l) => s + (l.endMs! - l.firstTokenMs!), 0);
}

/**
 * Output tokens are only reported per turn, so speed is per turn: output / streaming time.
 * Turns with under 200 ms of streaming or an implausible rate are left out, so an unknown
 * phase name in the event log cannot produce a runaway number.
 */
function grokSpeed(g: GrokStats, turn: number | null): number | null {
  let tokens = 0;
  let ms = 0;
  for (const [t, u] of g.turnUsage) {
    if (turn !== null && t !== turn) continue;
    const s = streamingMs(g, t);
    if (s < 200 || u.output <= 0 || u.output / (s / 1000) > 2_000) continue;
    tokens += u.output;
    ms += s;
  }
  return ms > 0 ? tokens / (ms / 1000) : null;
}

// ---- quota windows ----

// Window sums read every source touched in the window, so cache them briefly.
const WINDOW_CACHE_MS = 30_000;
const windowCache = new Map<string, { at: number; tokens: number }>();

async function windowTokens(provider: ProviderId, rawStart: number | null): Promise<number | null> {
  if (rawStart === null) return null;
  // The reset timestamp jitters by microseconds between readings; key by minute.
  const start = Math.round(rawStart / 60_000) * 60_000;
  const key = `${provider}:${start}`;
  const now = Date.now();
  const hit = windowCache.get(key);
  if (hit && now - hit.at < WINDOW_CACHE_MS) return hit.tokens;
  try {
    const tokens = provider === "claude" ? await tokensSince(start) : await grokTokensSince(start);
    for (const [k, v] of windowCache) if (now - v.at >= WINDOW_CACHE_MS) windowCache.delete(k);
    windowCache.set(key, { at: now, tokens });
    return tokens;
  } catch {
    return null;
  }
}

// ---- service ----

const EMPTY_COLUMN: StatsColumn = {
  ttftMs: null,
  tps: null,
  modelMs: null,
  toolMs: null,
  calls: null,
  toolCalls: null,
  toolByCategory: null,
  apiRetries: null,
};

const EMPTY_TOKENS: TokenCard = {
  total: null,
  input: null,
  cacheRead: null,
  cacheWrite: null,
  output: null,
  thinking: null,
  cacheHitRate: null,
  cacheInvalidations: null,
  costUsd: null,
  turnCostUsd: null,
  costSource: null,
  models: [],
};

export class StatsService {
  private live: LiveTracker;
  private daily: DailyStore;

  constructor(live: LiveTracker, daily: DailyStore) {
    this.live = live;
    this.daily = daily;
  }

  async detail(agentId: string, options: { windows?: boolean } = {}): Promise<SessionDetail> {
    const withWindows = options.windows ?? true;
    const live = await this.live.load(agentId);
    let provider = live.provider;
    let sessionId = live.sessionId;
    if (!provider || !sessionId) {
      const record = await agentRecord(agentId);
      provider ??= record.provider;
      sessionId ??= record.sessionId;
    }
    const base: SessionDetail = {
      agentId,
      provider,
      sessionId,
      turns: null,
      steps: null,
      usage: { quotas: [], fetchedAt: null, contextUsed: live.contextUsed, contextMax: live.contextMax, compactions: null },
      stats: { turn: EMPTY_COLUMN, session: EMPTY_COLUMN, tpsSeries: [], seriesUnit: provider === "grok" ? "turn" : "call" },
      tokens: EMPTY_TOKENS,
      files: null,
      grok: null,
    };
    if (!provider) return base;

    const quota = await readQuota(provider);
    const deltas = live.quotaDelta?.deltas ?? {};
    const deltaResets = live.quotaDelta?.resets;
    const quotas: QuotaRow[] = [];
    for (const w of quota?.windows ?? []) {
      quotas.push({
        key: w.key,
        percent: w.percent,
        resetsAt: w.resetsAt,
        // A delta from a window that has since reset says nothing about the current one.
        // (Deltas saved before reset times were recorded are kept as they were.)
        turnDelta: deltaResets && !sameReset(deltaResets[w.key], w.resetsAt) ? null : (deltas[w.key] ?? null),
        windowTokens: withWindows ? await windowTokens(provider, windowStart(w)) : null,
      });
    }
    base.usage.quotas = quotas;
    base.usage.fetchedAt = quota ? new Date(quota.fetchedAtMs).toISOString() : null;
    if (!sessionId) return base;

    if (provider === "claude") {
      const [stats, rates] = await Promise.all([claudeStats(sessionId).catch(() => null), readRates()]);
      if (!stats) return base;
      const lastTurn = Math.max(stats.turns - 1, 0);
      const waits = live.permissionWaits;
      const speeds = callSpeeds(stats.calls, live.usageMarks);
      return {
        ...base,
        turns: stats.turns,
        steps: stats.steps,
        usage: { ...base.usage, compactions: stats.compactions },
        stats: {
          turn: claudeColumn(stats.turn, stats, true, waits, lastTurn, speeds),
          session: claudeColumn(stats.session, stats, false, waits, lastTurn, speeds),
          tpsSeries: speeds.map((x) => ({
            at: new Date(x.call.lastMs).toISOString(),
            tps: x.tps,
            tokens: x.call.output,
            current: x.call.turn === lastTurn,
          })),
          seriesUnit: "call",
        },
        tokens: tokenCard(stats.session, {
          cacheInvalidations: stats.cacheInvalidations,
          costUsd: costUsd(stats.calls, rates),
          turnCostUsd: costUsd(
            stats.calls.filter((c) => c.turn === lastTurn),
            rates,
          ),
          costSource: "rates",
          models: stats.models,
        }),
        files: filesCard(stats.fileChanges, lastTurn, stats.cwd),
      };
    }

    const g = await grokStats(sessionId).catch(() => null);
    if (!g) return base;
    const series = [...g.turnUsage.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([t, u]) => {
        const tps = grokSpeed(g, t);
        return tps === null ? [] : [{ at: new Date(u.endedMs ?? Date.now()).toISOString(), tps, tokens: u.output, current: t === g.lastTurn }];
      });
    return {
      ...base,
      turns: g.turns,
      steps: g.steps,
      usage: {
        ...base.usage,
        contextUsed: base.usage.contextUsed ?? g.contextUsed,
        contextMax: base.usage.contextMax ?? g.contextMax,
        compactions: g.compactions,
      },
      stats: {
        turn: grokColumn(g, Math.max(g.lastTurn, 0)),
        session: grokColumn(g, null),
        tpsSeries: series,
        seriesUnit: "turn",
      },
      tokens: tokenCard(g.session, {
        cacheInvalidations: null,
        costUsd: g.session.costUsd,
        turnCostUsd: g.turnUsage.get(g.lastTurn)?.costUsd ?? null,
        costSource: g.session.costUsd === null ? null : "provider",
        models: g.models,
      }),
      files: filesCard(g.fileChanges, Math.max(g.lastTurn, 0), g.cwd),
      grok: g.extras,
    };
  }

  async pills(agentIds: string[]): Promise<PillData[]> {
    const out: PillData[] = [];
    for (const agentId of agentIds) {
      try {
        const d = await this.detail(agentId, { windows: false });
        out.push({
          agentId,
          provider: d.provider,
          quotas: d.usage.quotas.map((q) => ({ key: q.key, percent: q.percent })),
          turns: d.turns,
          tps: d.stats.session.tps,
          tpsLive: d.stats.tpsSeries.at(-1)?.tps ?? null,
          totalTokens: d.tokens.total,
          costUsd: d.tokens.costUsd,
          files: d.files?.session ?? null,
        });
      } catch {
        out.push({ agentId, provider: null, quotas: [], turns: null, tps: null, tpsLive: null, totalTokens: null, costUsd: null, files: null });
      }
    }
    return out;
  }

  async heatmap(provider: ProviderId): Promise<Heatmap> {
    return { provider, today: dayKey(Date.now()), days: await this.daily.totals(provider) };
  }
}
