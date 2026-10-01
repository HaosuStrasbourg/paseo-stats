// Grok Build (Grok CLI) sessions: ~/.grok/sessions/<encoded cwd>/<session id>/. Read-only.
//   usage.json    per-turn and session token/cost totals (what `grok usage <id>` prints)
//   events.jsonl  timestamped loop/phase/tool/permission events, one loop per model call
//   signals.json  counters: compactions, context window
// Grok reports inputTokens *including* cache reads/writes; totals here use the same split
// as Claude (uncached input + cache read + cache write + output).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GrokExtras, ToolCategory } from "../shared/contracts.shared.ts";
import { dayKey, grokSessionsRoot } from "./env.server.ts";
import { diffLines, type FileChange } from "./files.server.ts";
import { parseJsonl, type TokenTotals } from "./transcript.server.ts";

type Row = Record<string, any>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface GrokTotals extends TokenTotals {
  total: number;
  costUsd: number | null;
  modelCalls: number;
}

export interface GrokLoop {
  turn: number;
  startMs: number;
  firstTokenMs: number | null;
  endMs: number | null;
}

export interface GrokTool {
  turn: number;
  name: string;
  category: ToolCategory;
  ms: number;
}

export interface GrokStats {
  turns: number;
  steps: number;
  models: string[];
  session: GrokTotals;
  /** Usage of each finished turn, keyed by 0-based turn index. */
  turnUsage: Map<number, GrokTotals & { endedMs: number | null }>;
  /** 0-based index of the latest turn (running or finished); -1 before the first. */
  lastTurn: number;
  loops: GrokLoop[];
  tools: GrokTool[];
  retries: number[];
  compactions: number | null;
  contextUsed: number | null;
  contextMax: number | null;
  extras: GrokExtras;
  fileChanges: FileChange[];
  cwd: string | null;
}

export function grokToolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (n.includes("terminal") || n.includes("shell") || n.includes("bash") || n.includes("command")) return "shell";
  if (n.includes("read") || n.includes("view") || n === "cat") return "read";
  if (n.includes("edit") || n.includes("write") || n.includes("patch") || n.includes("replace") || n.includes("create_file")) return "edit";
  if (n.includes("search") || n.includes("grep") || n.includes("glob") || n.includes("find") || n.includes("list")) return "search";
  if (n.includes("web") || n.includes("fetch") || n.includes("browse")) return "web";
  if (n.includes("agent") || n.includes("task")) return "agent";
  if (n.includes("__") || n.startsWith("mcp")) return "mcp";
  return "other";
}

function totalsOf(u: Row | undefined): GrokTotals {
  const inputAll = num(u?.inputTokens);
  const cacheRead = num(u?.cachedReadTokens);
  const cacheWrite = num(u?.cacheCreationTokens);
  const input = Math.max(0, inputAll - cacheRead - cacheWrite);
  const output = num(u?.outputTokens);
  return {
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    output,
    thinking: num(u?.reasoningTokens),
    total: input + cacheRead + cacheWrite + output,
    costUsd: typeof u?.costUsdTicks === "number" ? u.costUsdTicks / 1e10 : null,
    modelCalls: num(u?.modelCalls),
  };
}

async function readJson(file: string): Promise<Row | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Session directory, found under any encoded-cwd folder. */
export async function findGrokSession(sessionId: string, root = grokSessionsRoot()): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  let cwds;
  try {
    cwds = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const c of cwds) {
    if (!c.isDirectory()) continue;
    const dir = path.join(root, c.name, sessionId);
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * File edits from the ACP update stream: each completed tool_call_update carries
 * `{ type: "diff", path, oldText, newText }` content. Turns are delimited by user messages.
 */
export function grokFileChanges(updates: Row[]): FileChange[] {
  const out: FileChange[] = [];
  let turn = -1;
  let inUser = false;
  for (const row of updates) {
    const u = row?.params?.update;
    if (!u || typeof u !== "object") continue;
    if (u.sessionUpdate === "user_message_chunk") {
      if (!inUser) turn += 1;
      inUser = true;
      continue;
    }
    inUser = false;
    if (u.sessionUpdate !== "tool_call_update" || u.status !== "completed" || !Array.isArray(u.content)) continue;
    for (const c of u.content) {
      if (c?.type !== "diff" || typeof c.path !== "string") continue;
      const counts = diffLines(typeof c.oldText === "string" ? c.oldText : "", typeof c.newText === "string" ? c.newText : "");
      out.push({ path: c.path, ...counts, turn: Math.max(turn, 0) });
    }
  }
  return out;
}

export function computeGrokStats(usage: Row | null, events: Row[], signals: Row | null, updates: Row[] = []): GrokStats {
  const turnUsage = new Map<number, GrokTotals & { endedMs: number | null }>();
  for (const t of Array.isArray(usage?.turns) ? usage!.turns : []) {
    if (typeof t?.turnNumber !== "number") continue;
    const endedMs = Date.parse(t.endedAt);
    turnUsage.set(t.turnNumber - 1, { ...totalsOf(t), endedMs: Number.isFinite(endedMs) ? endedMs : null });
  }

  const loops: GrokLoop[] = [];
  const tools: GrokTool[] = [];
  const retries: number[] = [];
  let turn = -1;
  let open: GrokLoop | null = null;
  const close = (ms: number) => {
    if (open && open.endMs === null) open.endMs = ms;
    open = null;
  };
  for (const e of events) {
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    switch (e.type) {
      case "turn_started":
        close(ms);
        turn = typeof e.turn_number === "number" ? e.turn_number : turn + 1;
        break;
      case "turn_ended":
      case "loop_started":
        close(ms);
        break;
      case "phase_changed":
        if (e.phase === "waiting_for_model") {
          if (!open) {
            open = { turn: Math.max(turn, 0), startMs: ms, firstTokenMs: null, endMs: null };
            loops.push(open);
          }
        } else if (!String(e.phase).startsWith("streaming")) {
          // streaming_text / streaming_reasoning keep the call open; anything else ends it.
          close(ms);
        }
        break;
      case "first_token":
        if (open && open.firstTokenMs === null) open.firstTokenMs = ms;
        break;
      case "tool_completed": {
        // duration_ms is execution only: the approval wait (permission_resolved.wait_ms) is
        // already excluded, e.g. started->completed 7.9 s with duration_ms 96 and wait_ms 7840.
        const name = String(e.tool_name ?? "");
        tools.push({ turn: Math.max(turn, 0), name, category: grokToolCategory(name), ms: num(e.duration_ms) });
        break;
      }
      default:
        if (typeof e.type === "string" && /retry/i.test(e.type)) retries.push(Math.max(turn, 0));
    }
  }

  const session = totalsOf(usage?.session);
  const modelUsage = usage?.session?.modelUsage;
  const models =
    modelUsage && typeof modelUsage === "object"
      ? Object.keys(modelUsage)
      : typeof usage?.session?.primaryModelId === "string"
        ? [usage.session.primaryModelId]
        : [];
  const lastTurn = Math.max(turn, turnUsage.size > 0 ? Math.max(...turnUsage.keys()) : -1);
  // A running turn is not in usage.json yet; count its loops on top.
  const runningLoops = turnUsage.has(lastTurn) ? 0 : loops.filter((l) => l.turn === lastTurn).length;
  return {
    turns: Math.max(num(usage?.session?.turnCount), lastTurn + 1),
    steps: session.modelCalls + runningLoops,
    models,
    session,
    turnUsage,
    lastTurn,
    loops,
    tools,
    retries,
    extras: extrasOf(signals),
    fileChanges: grokFileChanges(updates),
    cwd: null,
    compactions: typeof signals?.compactionCount === "number" ? signals.compactionCount : null,
    contextUsed: typeof signals?.contextTokensUsed === "number" ? signals.contextTokensUsed : null,
    contextMax: typeof signals?.contextWindowTokens === "number" ? signals.contextWindowTokens : null,
  };
}

function extrasOf(s: Row | null): GrokExtras {
  const n = (k: string) => (typeof s?.[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : null);
  // Inter-token latency stats are 0 when no samples were taken.
  const itl = (k: string) => ((n("itlSampleCount") ?? 0) > 0 ? n(k) : null);
  return {
    itlP50Ms: itl("itlP50Ms"),
    itlP99Ms: itl("itlP99Ms"),
    itlMaxMs: itl("itlMaxMs"),
    longPauses: n("longPausesCount"),
    toolFailures: n("toolFailureCount"),
    errors: n("errorCount"),
    cancellations: n("cancellationCount"),
    regenerations: n("regenerationCount"),
    doomLoopRecoveries: n("doomLoopRecoveryAttempts"),
    idleTimeouts: n("inferenceIdleTimeouts"),
  };
}

export async function readGrokStats(dir: string): Promise<GrokStats> {
  const [usage, signals, events, updates] = await Promise.all([
    readJson(path.join(dir, "usage.json")),
    readJson(path.join(dir, "signals.json")),
    readFile(path.join(dir, "events.jsonl"), "utf8").then(parseJsonl, () => []),
    readFile(path.join(dir, "updates.jsonl"), "utf8").then(parseJsonl, () => []),
  ]);
  const stats = computeGrokStats(usage, events, signals, updates);
  // Sessions live under a folder named after the URL-encoded working directory.
  try {
    stats.cwd = decodeURIComponent(path.basename(path.dirname(dir)));
  } catch {
    stats.cwd = null;
  }
  return stats;
}

/** mtime of the files the stats depend on, for cache invalidation. */
export async function grokSessionVersion(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const f of ["usage.json", "events.jsonl", "signals.json", "updates.jsonl"]) {
    try {
      const st = await stat(path.join(dir, f));
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

// ---- Per-turn usage across all sessions (heatmap, quota windows) ----

interface TurnRecord {
  key: string;
  endedMs: number;
  totals: GrokTotals;
}

const turnCache = new Map<string, { mtimeMs: number; turns: TurnRecord[] }>();

/**
 * Every finished turn of every Grok session on this machine. Forked or resumed sessions
 * carry their parent's turns, so turns are deduplicated by (end time, turn number, total).
 */
export async function allGrokTurns(root = grokSessionsRoot()): Promise<TurnRecord[]> {
  const seen = new Map<string, TurnRecord>();
  let cwds;
  try {
    cwds = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const c of cwds) {
    if (!c.isDirectory()) continue;
    let sessions;
    try {
      sessions = await readdir(path.join(root, c.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const file = path.join(root, c.name, s.name, "usage.json");
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      let cached = turnCache.get(file);
      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        const usage = await readJson(file);
        const turns: TurnRecord[] = [];
        for (const t of Array.isArray(usage?.turns) ? usage!.turns : []) {
          const endedMs = Date.parse(t?.endedAt);
          if (!Number.isFinite(endedMs)) continue;
          const totals = totalsOf(t);
          turns.push({ key: `${t.endedAt}|${t.turnNumber}|${totals.total}`, endedMs, totals });
        }
        cached = { mtimeMs: st.mtimeMs, turns };
        turnCache.set(file, cached);
      }
      for (const t of cached.turns) seen.set(t.key, t);
    }
  }
  return [...seen.values()];
}

export async function grokDaily(sinceMs?: number): Promise<Record<string, TokenTotals & { total: number }>> {
  const days: Record<string, TokenTotals & { total: number }> = {};
  const minDay = sinceMs !== undefined ? dayKey(sinceMs) : null;
  for (const t of await allGrokTurns()) {
    const day = dayKey(t.endedMs);
    if (minDay && day < minDay) continue;
    const d = (days[day] ??= { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, thinking: 0, total: 0 });
    d.input += t.totals.input;
    d.cacheRead += t.totals.cacheRead;
    d.cacheWrite += t.totals.cacheWrite;
    d.output += t.totals.output;
    d.thinking += t.totals.thinking;
    d.total += t.totals.total;
  }
  return days;
}

export async function grokTokensSince(sinceMs: number): Promise<number> {
  let sum = 0;
  for (const t of await allGrokTurns()) if (t.endedMs >= sinceMs) sum += t.totals.total;
  return sum;
}
