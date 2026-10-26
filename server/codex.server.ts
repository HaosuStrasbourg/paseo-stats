// Codex rollout JSONL. Read-only: no credentials, configuration or network access.
// New rollouts record each billed response separately; token_count is only a fallback.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { codexSessionRoots, dayKey } from "./env.server.ts";
import { lineCount, type FileChange } from "./files.server.ts";
import type { QuotaSnapshot, QuotaWindow } from "./quota.server.ts";
import { emptyTotals, parseJsonl, totalTokens, type DailyScan, type TokenTotals } from "./transcript.server.ts";

type Row = Record<string, any>;
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export interface CodexCall extends TokenTotals {
  id: string;
  turn: number;
  atMs: number;
}

export interface CodexStats {
  turns: number;
  /** Only explicit response IDs establish the number of model requests. */
  steps: number | null;
  models: string[];
  hasUsage: boolean;
  cacheWriteKnown: boolean;
  session: TokenTotals;
  turn: TokenTotals;
  lastTurn: number;
  lastTurnStartMs: number | null;
  compactions: number;
  contextUsed: number | null;
  contextMax: number | null;
  calls: CodexCall[];
  /** Reported first-token latency per finished turn, not per model request. */
  ttft: { turn: number; ms: number }[];
  fileChanges: FileChange[] | null;
  cwd: string | null;
}

function usageOf(value: unknown): TokenTotals | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Row;
  const allInput = number(u.input_tokens);
  const output = number(u.output_tokens);
  if (allInput === null || output === null) return null;
  const cacheRead = number(u.cached_input_tokens) ?? 0;
  const cacheWrite = number(u.cache_write_input_tokens) ?? 0;
  // Input includes both cache components; reasoning is already included in output.
  if (cacheRead + cacheWrite > allInput) return null;
  return { input: allInput - cacheRead - cacheWrite, cacheRead, cacheWrite, cacheWrite1h: 0,
    output, thinking: number(u.reasoning_output_tokens) ?? 0 };
}

function add(into: TokenTotals, value: TokenTotals): void {
  for (const key of ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "thinking"] as const) into[key] += value[key];
}

function fingerprint(u: TokenTotals): string {
  return [u.input, u.cacheRead, u.cacheWrite, u.output, u.thinking].join(":");
}

function ownRows(rows: Row[]): { rows: Row[]; meta: Row } {
  const meta = rows.find((r) => r.type === "session_meta")?.payload ?? {};
  // Forks can embed another session_meta and old turns. The first meta owns this file;
  // the ordinal marks the first newly appended event, as observed in Codex rollouts.
  const ordinal = number(meta.subagent_history_start_ordinal);
  const start = ordinal !== null && Number.isSafeInteger(ordinal) ? ordinal : 0;
  const id = meta.id ?? meta.session_id;
  return { meta, rows: rows.slice(start).filter((r) => !r.payload?.thread_id || !id || r.payload.thread_id === id) };
}

/** Only structured, completed file changes count. Unknown deletion sizes stay unknown. */
function fileChangesOf(item: Row, turn: number, cwd: string | null): FileChange[] | null {
  if (item.status !== "completed") return [];
  if (!item.changes || typeof item.changes !== "object" || Array.isArray(item.changes)) return null;
  const out: FileChange[] = [];
  for (const [file, value] of Object.entries<Row>(item.changes)) {
    if (!value || typeof value !== "object") return null;
    let added = 0;
    let removed = 0;
    if (value.type === "add" && typeof value.content === "string") added = lineCount(value.content);
    else if (value.type === "delete" && typeof value.content === "string") removed = lineCount(value.content);
    else if (value.type === "update" && typeof value.unified_diff === "string") {
      // Only count inside hunks; do not confuse +++/--- file headers with content.
      let inHunk = false;
      for (const line of value.unified_diff.split("\n")) {
        if (line.startsWith("@@")) { inHunk = true; continue; }
        if (!inHunk) continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
      if (!inHunk && value.unified_diff.trim()) return null;
    } else return null;
    const target = typeof value.move_path === "string" ? value.move_path : file;
    out.push({ path: cwd ? path.resolve(cwd, target) : target, added, removed, turn });
  }
  return out;
}

export function computeCodexStats(inputRows: Row[]): CodexStats {
  const { rows, meta } = ownRows(inputRows);
  const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
  const firstRecord = rows.findIndex((r) => r.type === "token_usage_record" && typeof r.payload?.response_id === "string" && usageOf(r.payload.usage));
  const explicit = firstRecord >= 0;
  const hasTaskStarts = rows.some((r) => r.type === "event_msg" && r.payload?.type === "task_started");
  const hasUserEvents = rows.some((r) => r.type === "event_msg" && r.payload?.type === "user_message");
  const hasCompacted = rows.some((r) => r.type === "compacted");
  const turnIds = new Map<string, number>();
  const calls = new Map<string, CodexCall>();
  const knownWrites = new Map<string, boolean>();
  const models = new Set<string>();
  const ttft = new Map<number, number>();
  const fileChanges: FileChange[] = [];
  const seenFiles = new Set<string>();
  let filesKnown = rows.some((r) => r.type === "event_msg" && r.payload?.type === "item_completed");
  let unknownFiles = false;
  let directPatch = false;
  let structuredPatch = false;
  let lastTurn = -1;
  let lastTurnStartMs: number | null = null;
  let compactions = 0;
  let contextUsed: number | null = null;
  let contextMax = number(meta.context_window);
  let previousUsage: TokenTotals | null = null;
  let previousFingerprint: string | null = null;
  let hasFallbackUsage = false;

  const startTurn = (id: unknown, ms: number) => {
    if (typeof id === "string" && turnIds.has(id)) { lastTurn = turnIds.get(id)!; return; }
    lastTurn += 1;
    if (typeof id === "string") turnIds.set(id, lastTurn);
    lastTurnStartMs = Number.isFinite(ms) ? ms : null;
  };

  for (const [index, row] of rows.entries()) {
    const p = row.payload ?? {};
    const ms = Date.parse(row.timestamp);
    if (row.type === "turn_context") {
      if (typeof p.model === "string") models.add(p.model);
      if (typeof p.turn_id === "string" && !hasTaskStarts && !hasUserEvents) startTurn(p.turn_id, ms);
    }
    if (row.type === "compacted") compactions += 1;
    if (row.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call") && p.name === "apply_patch") directPatch = true;
    if (row.type === "event_msg") {
      if (p.type === "task_started") {
        startTurn(p.turn_id, ms);
        contextMax = number(p.model_context_window) ?? contextMax;
      } else if (p.type === "user_message" && !hasTaskStarts) {
        // Old logs repeat the same user message as a response_item: count this stream only.
        startTurn(undefined, ms);
      } else if (p.type === "task_complete") {
        const t = typeof p.turn_id === "string" ? turnIds.get(p.turn_id) : lastTurn;
        const latency = number(p.time_to_first_token_ms);
        if (t !== undefined && t >= 0 && latency !== null) ttft.set(t, latency);
      } else if (p.type === "context_compacted" && !hasCompacted) compactions += 1;
      else if (p.type === "item_completed" && p.item?.type === "FileChange") {
        structuredPatch = true;
        const id = p.item.id;
        if (typeof id === "string" && seenFiles.has(id)) continue;
        if (typeof id === "string") seenFiles.add(id);
        const changes = fileChangesOf(p.item, Math.max(lastTurn, 0), cwd);
        if (changes === null) unknownFiles = true;
        else fileChanges.push(...changes);
      }
      if (p.type === "token_count" && p.info) {
        contextMax = number(p.info.model_context_window) ?? contextMax;
        contextUsed = number(p.info.last_token_usage?.total_tokens) ?? contextUsed;
      }
    }

    // A CLI upgrade may append records to an older snapshot-only rollout. Retain the
    // historical prefix, then prefer records (including compaction) from the upgrade on.
    if (explicit && index >= firstRecord) {
      if (row.type !== "token_usage_record" || typeof p.response_id !== "string") continue;
      const usage = usageOf(p.usage);
      if (!usage || !Number.isFinite(ms)) continue;
      const id = `response:${p.response_id}`;
      if (calls.has(id)) continue;
      const turn = typeof p.turn_id === "string" ? (turnIds.get(p.turn_id) ?? Math.max(lastTurn, 0)) : Math.max(lastTurn, 0);
      calls.set(id, { id, turn, atMs: ms, ...usage });
      knownWrites.set(id, number(p.usage.cache_write_input_tokens) !== null);
    } else if (row.type === "event_msg" && p.type === "token_count" && p.info) {
      const cumulative = usageOf(p.info.total_token_usage);
      const last = usageOf(p.info.last_token_usage);
      if (!cumulative || !last || !Number.isFinite(ms)) continue;
      const signature = fingerprint(cumulative);
      if (signature === previousFingerprint) continue;
      let usage = last;
      if (previousUsage) {
        const delta = emptyTotals();
        for (const key of Object.keys(delta) as (keyof TokenTotals)[]) delta[key] = cumulative[key] - previousUsage[key];
        if (Object.values(delta).every((n) => n >= 0)) usage = delta;
      }
      previousUsage = cumulative;
      previousFingerprint = signature;
      // A compacted context size can be reported with zero input/output: it is not usage.
      if (totalTokens(usage) === 0) continue;
      const id = `snapshot:${row.timestamp}:${signature}`;
      calls.set(id, { id, turn: Math.max(lastTurn, 0), atMs: ms, ...usage });
      knownWrites.set(id, number(p.info.last_token_usage.cache_write_input_tokens) !== null);
      hasFallbackUsage = true;
    }
  }

  if (directPatch && !structuredPatch) filesKnown = false;
  const session = emptyTotals();
  const turn = emptyTotals();
  for (const call of calls.values()) {
    add(session, call);
    if (call.turn === Math.max(lastTurn, 0)) add(turn, call);
  }
  return { turns: lastTurn + 1, steps: explicit && !hasFallbackUsage ? calls.size : null, models: [...models],
    hasUsage: calls.size > 0, cacheWriteKnown: calls.size > 0 && [...knownWrites.values()].every(Boolean),
    session, turn, lastTurn, lastTurnStartMs, compactions, contextUsed, contextMax,
    calls: [...calls.values()], ttft: [...ttft].map(([turn, ms]) => ({ turn, ms })),
    fileChanges: filesKnown && !unknownFiles ? fileChanges : null, cwd };
}

async function listCodexSessions(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  }
  for (const root of roots) await walk(root);
  return files;
}

export async function findCodexSession(sessionId: string, roots = codexSessionRoots()): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  return (await listCodexSessions(roots)).find((file) => path.basename(file) === `${sessionId}.jsonl` || path.basename(file).endsWith(`-${sessionId}.jsonl`)) ?? null;
}

const cache = new Map<string, { version: string; stats: CodexStats; quota: QuotaSnapshot | null }>();

/** Select only the Codex account's supported windows; primary is not always five hours. */
export function codexQuotaFromRows(inputRows: Row[]): QuotaSnapshot | null {
  let latest: QuotaSnapshot | null = null;
  for (const row of ownRows(inputRows).rows) {
    const p = row.payload;
    if (row.type !== "event_msg" || p?.type !== "token_count") continue;
    const limits = p.rate_limits;
    if (!limits || typeof limits !== "object" || (limits.limit_id && limits.limit_id !== "codex")) continue;
    const fetchedAtMs = Date.parse(row.timestamp);
    if (!Number.isFinite(fetchedAtMs) || (latest && latest.fetchedAtMs > fetchedAtMs)) continue;
    const windows: QuotaWindow[] = [];
    for (const raw of [limits.primary, limits.secondary]) {
      const minutes = number(raw?.window_minutes);
      const percent = number(raw?.used_percent);
      const reset = number(raw?.resets_at);
      if ((minutes !== 300 && minutes !== 10080) || percent === null) continue;
      const key = minutes === 300 ? "fiveHour" : "sevenDay";
      const resetMs = reset === null ? NaN : reset * 1000;
      windows.push({ key, percent, durationMs: minutes * 60_000,
        resetsAt: Number.isFinite(resetMs) && resetMs <= 8.64e15 ? new Date(resetMs).toISOString() : null });
    }
    if (windows.length) latest = { fetchedAtMs, windows: windows.sort((a, b) => a.durationMs! - b.durationMs!) };
  }
  return latest;
}

async function readCached(file: string) {
  const st = await stat(file);
  const version = `${st.mtimeMs}:${st.size}`;
  const existing = cache.get(file);
  if (existing?.version === version) return existing;
  const rows = parseJsonl(await readFile(file, "utf8"));
  const entry = { version, stats: computeCodexStats(rows), quota: codexQuotaFromRows(rows) };
  cache.set(file, entry);
  return entry;
}

export async function readCodexStats(file: string): Promise<CodexStats> {
  return (await readCached(file)).stats;
}

async function allCalls(roots: string[]): Promise<{ calls: CodexCall[]; files: number; errors: string[] }> {
  const seen = new Map<string, CodexCall>();
  const errors: string[] = [];
  let files = 0;
  for (const file of await listCodexSessions(roots)) {
    try {
      for (const call of (await readCached(file)).stats.calls) if (!seen.has(call.id)) seen.set(call.id, call);
      files += 1;
    } catch {
      errors.push(`${path.basename(file)}: unreadable session`);
    }
  }
  return { calls: [...seen.values()], files, errors };
}

export async function scanCodexDaily(options: { roots?: string[]; sinceMs?: number } = {}): Promise<DailyScan> {
  const result = await allCalls(options.roots ?? codexSessionRoots());
  const days: DailyScan["days"] = {};
  const minDay = options.sinceMs === undefined ? null : dayKey(options.sinceMs);
  for (const call of result.calls) {
    const day = dayKey(call.atMs);
    if (minDay && day < minDay) continue;
    const total = days[day] ??= { ...emptyTotals(), total: 0 };
    add(total, call);
    total.total = totalTokens(total);
  }
  return { days, files: result.files, messages: result.calls.length, errors: result.errors };
}

export async function codexTokensSince(sinceMs: number, roots = codexSessionRoots()): Promise<number> {
  return (await allCalls(roots)).calls.filter((call) => call.atMs >= sinceMs).reduce((sum, call) => sum + totalTokens(call), 0);
}

export async function readCodexQuota(roots = codexSessionRoots()): Promise<QuotaSnapshot | null> {
  let latest: QuotaSnapshot | null = null;
  for (const file of await listCodexSessions(roots)) {
    try {
      const quota = (await readCached(file)).quota;
      if (quota && (!latest || quota.fetchedAtMs > latest.fetchedAtMs)) latest = quota;
    } catch { /* A deleted or partially written session cannot prevent other readings. */ }
  }
  return latest;
}
