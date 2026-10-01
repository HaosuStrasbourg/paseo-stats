// Claude Code transcript (~/.claude/projects/**/*.jsonl) parsing. Read-only.
// Pure functions + node:fs; also run directly by scripts/stats-cli.ts (node type stripping).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolCategory } from "../shared/contracts.shared.ts";
import { claudeProjectRoots, dayKey, paseoHome } from "./env.server.ts";
import { countPatch, lineCount, type FileChange } from "./files.server.ts";

export { dayKey };

type Row = Record<string, any>;

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  thinking: number;
}

export interface Period extends TokenTotals {
  calls: number;
  modelMs: number;
  toolMs: number;
  toolCalls: number;
  toolByCategory: Record<string, number>;
  apiRetries: number;
}

export interface CallRecord extends TokenTotals {
  id: string;
  model: string;
  turn: number;
  startMs: number;
  firstMs: number;
  lastMs: number;
}

export interface ToolSpan {
  id: string;
  name: string;
  category: ToolCategory;
  turn: number;
  startMs: number;
  endMs: number | null;
}

export interface SessionStats {
  turns: number;
  steps: number;
  models: string[];
  lastTurnStartMs: number | null;
  session: Period;
  turn: Period;
  cacheInvalidations: number;
  compactions: number;
  firstMs: number | null;
  lastMs: number | null;
  calls: CallRecord[];
  tools: ToolSpan[];
  fileChanges: FileChange[];
  cwd: string | null;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, thinking: 0 };
}

function emptyPeriod(): Period {
  return { ...emptyTotals(), calls: 0, modelMs: 0, toolMs: 0, toolCalls: 0, toolByCategory: {}, apiRetries: 0 };
}

export function totalTokens(t: TokenTotals): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

export function cacheHitRate(t: TokenTotals): number | null {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return denom > 0 ? t.cacheRead / denom : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageTotals(usage: Row | undefined): TokenTotals {
  if (!usage) return emptyTotals();
  return {
    input: num(usage.input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheWrite1h: num(usage.cache_creation?.ephemeral_1h_input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.output_tokens_details?.thinking_tokens),
  };
}

function addTotals(into: TokenTotals, t: TokenTotals) {
  into.input += t.input;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
  into.cacheWrite1h += t.cacheWrite1h;
  into.output += t.output;
  into.thinking += t.thinking;
}

export function toolCategory(name: string): ToolCategory {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "shell";
  if (name === "Read" || name === "NotebookRead") return "read";
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return "edit";
  if (name === "Grep" || name === "Glob" || name === "WebSearch" || name === "ToolSearch") return "search";
  if (name === "WebFetch") return "web";
  if (name === "Agent" || name === "Task") return "agent";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

function contentBlocks(row: Row): Row[] {
  const c = row.message?.content;
  return Array.isArray(c) ? c : [];
}

/** A real user prompt: not meta, not a tool result, not a slash-command echo or interrupt marker. */
export function isUserPrompt(row: Row): boolean {
  if (row.type !== "user" || row.isMeta || row.isCompactSummary || row.isSidechain) return false;
  const c = row.message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return false;
    text = c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
    if (!text && !c.some((b) => b?.type === "image")) return false;
  } else return false;
  const t = text.trimStart();
  return !(
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("[Request interrupted")
  );
}

const ts = (row: Row): number => {
  const v = Date.parse(row.timestamp);
  return Number.isFinite(v) ? v : NaN;
};

// Cache invalidation: this call read < 50% of what the previous call left cached
// (its read + write), rewrote >= 50% of it, and that prefix was at least 10k tokens.
export const INVALIDATION_MIN_PREFIX = 10_000;
export const INVALIDATION_RATIO = 0.5;

export function computeSessionStats(rows: Row[]): SessionStats {
  const calls = new Map<string, CallRecord>();
  const tools = new Map<string, ToolSpan>();
  const fileChanges: FileChange[] = [];
  let cwd: string | null = null;
  const retries: { turn: number }[] = [];
  let turn = -1;
  let turns = 0;
  let lastTurnStartMs: number | null = null;
  let anchor = NaN; // latest event before the next model call starts
  let compactions = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const compactBoundaryBeforeCall = new Set<string>();
  let pendingBoundary = false;

  for (const row of rows) {
    if (row.isSidechain) continue;
    const t = ts(row);
    if (!Number.isNaN(t)) {
      if (firstMs === null || t < firstMs) firstMs = t;
      if (lastMs === null || t > lastMs) lastMs = t;
    }
    if (row.type === "system") {
      if (row.subtype === "api_error") {
        retries.push({ turn: Math.max(turn, 0) });
        // Exclude the failed attempt (incl. hung connections) from model time.
        if (!Number.isNaN(t)) anchor = t + num(row.retryInMs);
      } else if (row.subtype === "compact_boundary") {
        compactions += 1;
        pendingBoundary = true;
      }
      continue;
    }
    if (row.type === "user") {
      if (isUserPrompt(row)) {
        turns += 1;
        turn += 1;
        lastTurnStartMs = Number.isNaN(t) ? lastTurnStartMs : t;
      }
      // The session's starting directory; later rows follow the shell's cd.
      if (cwd === null && typeof row.cwd === "string") cwd = row.cwd;
      for (const b of contentBlocks(row)) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          const span = tools.get(b.tool_use_id);
          if (span && span.endMs === null && !Number.isNaN(t)) span.endMs = t;
          // Write/Edit/MultiEdit results carry the file path and a structured patch.
          const r = row.toolUseResult;
          if (!b.is_error && span?.category === "edit" && r && typeof r === "object" && typeof r.filePath === "string") {
            const counts =
              r.type === "create" && typeof r.content === "string"
                ? { added: lineCount(r.content), removed: 0 }
                : countPatch(r.structuredPatch);
            fileChanges.push({ path: r.filePath, ...counts, turn: span.turn });
          }
        }
      }
      if (!Number.isNaN(t)) anchor = t;
      continue;
    }
    if (row.type === "assistant") {
      const msg = row.message ?? {};
      const id: string | undefined = msg.id ?? row.requestId;
      if (!id || msg.model === "<synthetic>") {
        if (!Number.isNaN(t)) anchor = t;
        continue;
      }
      let call = calls.get(id);
      if (!call) {
        call = {
          id,
          model: msg.model ?? "",
          turn: Math.max(turn, 0),
          startMs: Number.isNaN(anchor) ? t : Math.min(anchor, t),
          firstMs: t,
          lastMs: t,
          ...usageTotals(msg.usage),
        };
        calls.set(id, call);
        if (pendingBoundary) compactBoundaryBeforeCall.add(id);
        pendingBoundary = false;
      } else {
        // Same API call is written once per content block with identical usage.
        if (!Number.isNaN(t)) call.lastMs = Math.max(call.lastMs, t);
        const u = usageTotals(msg.usage);
        if (totalTokens(u) > totalTokens(call)) Object.assign(call, u);
      }
      for (const b of contentBlocks(row)) {
        if (b?.type === "tool_use" && typeof b.id === "string" && !tools.has(b.id)) {
          const name = String(b.name ?? "");
          tools.set(b.id, { id: b.id, name, category: toolCategory(name), turn: call.turn, startMs: t, endMs: null });
        }
      }
      if (!Number.isNaN(t)) anchor = t;
    }
  }

  const session = emptyPeriod();
  const current = emptyPeriod();
  const lastTurn = Math.max(turn, 0);
  const callList = [...calls.values()];
  const models = new Map<string, number>();
  for (const c of callList) {
    const ms = Math.max(0, c.lastMs - c.startMs);
    for (const p of c.turn === lastTurn ? [session, current] : [session]) {
      addTotals(p, c);
      p.calls += 1;
      p.modelMs += ms;
    }
    if (c.model) models.set(c.model, (models.get(c.model) ?? 0) + totalTokens(c) + 1);
  }
  const toolList = [...tools.values()];
  for (const s of toolList) {
    if (s.endMs === null) continue;
    const ms = Math.max(0, s.endMs - s.startMs);
    for (const p of s.turn === lastTurn ? [session, current] : [session]) {
      p.toolCalls += 1;
      p.toolMs += ms;
      p.toolByCategory[s.category] = (p.toolByCategory[s.category] ?? 0) + ms;
    }
  }
  for (const r of retries) {
    session.apiRetries += 1;
    if (r.turn === lastTurn) current.apiRetries += 1;
  }

  let cacheInvalidations = 0;
  for (let i = 1; i < callList.length; i++) {
    const prev = callList[i - 1]!;
    const cur = callList[i]!;
    if (compactBoundaryBeforeCall.has(cur.id)) continue;
    const prefix = prev.cacheRead + prev.cacheWrite;
    if (
      prefix >= INVALIDATION_MIN_PREFIX &&
      cur.cacheRead < prefix * INVALIDATION_RATIO &&
      cur.cacheWrite >= prefix * INVALIDATION_RATIO
    ) {
      cacheInvalidations += 1;
    }
  }

  return {
    turns,
    steps: callList.length,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    lastTurnStartMs,
    session,
    turn: current,
    cacheInvalidations,
    compactions,
    firstMs,
    lastMs,
    calls: callList,
    tools: toolList,
    fileChanges,
    cwd,
  };
}

export function parseJsonl(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") rows.push(v);
    } catch {
      // partially written trailing line
    }
  }
  return rows;
}

async function walkJsonl(dir: string, out: string[]) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

export async function listTranscripts(roots = claudeProjectRoots()): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) await walkJsonl(root, out);
  return out;
}

/** Main transcript of a session: <root>/<project>/<sessionId>.jsonl */
export async function findSessionTranscript(sessionId: string, roots = claudeProjectRoots()): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  for (const root of roots) {
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const file = path.join(root, p.name, `${sessionId}.jsonl`);
      try {
        if ((await stat(file)).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export async function readSessionStats(file: string): Promise<SessionStats> {
  return computeSessionStats(parseJsonl(await readFile(file, "utf8")));
}

// ---- Daily totals (heatmap) ----

export type DayTotals = TokenTotals & { total: number };

export interface DailyScan {
  days: Record<string, DayTotals>;
  files: number;
  messages: number;
  errors: string[];
}

/**
 * Sums every assistant call per local day across all transcripts (sidechains included),
 * deduplicated globally by message.id. With sinceMs, only files modified since then are
 * read and only days >= dayKey(sinceMs) are returned (those days are complete: any file
 * holding an entry from them was written after sinceMs).
 */
export async function scanDaily(options: { roots?: string[]; sinceMs?: number } = {}): Promise<DailyScan> {
  const files = await listTranscripts(options.roots);
  const minDay = options.sinceMs !== undefined ? dayKey(options.sinceMs) : null;
  const seen = new Map<string, { day: string; totals: TokenTotals }>();
  const errors: string[] = [];
  let read = 0;
  for (const file of files) {
    try {
      if (options.sinceMs !== undefined && (await stat(file)).mtimeMs < options.sinceMs) continue;
      const text = await readFile(file, "utf8");
      read += 1;
      for (const row of parseJsonl(text)) {
        if (row.type !== "assistant") continue;
        const id = row.message?.id ?? row.requestId;
        const t = ts(row);
        if (!id || Number.isNaN(t)) continue;
        const totals = usageTotals(row.message?.usage);
        const prev = seen.get(id);
        if (!prev || totalTokens(totals) > totalTokens(prev.totals)) {
          seen.set(id, { day: prev?.day ?? dayKey(t), totals });
        }
      }
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const days: Record<string, DayTotals> = {};
  for (const { day, totals } of seen.values()) {
    if (minDay && day < minDay) continue;
    const d = (days[day] ??= { ...emptyTotals(), total: 0 });
    addTotals(d, totals);
    d.total = totalTokens(d);
  }
  return { days, files: read, messages: seen.size, errors };
}

// ---- Cost (reference only), from usage-monitor's locally cached LiteLLM rate table ----

export interface ModelRate {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
  cacheWriteLongTtlPerToken?: number;
}

export async function readRates(): Promise<Record<string, ModelRate> | null> {
  try {
    const file = path.join(paseoHome(), "usage-limits", "model-rates.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw.rates === "object" ? raw.rates : null;
  } catch {
    return null;
  }
}

/** Returns null if any call's model has no rate (a partial sum would read as the full cost). */
export function costUsd(calls: CallRecord[], rates: Record<string, ModelRate> | null): number | null {
  if (!rates) return null;
  let sum = 0;
  for (const c of calls) {
    const r = rates[c.model] ?? rates[c.model.replace(/-\d{8}$/, "")];
    if (!r) return null;
    const shortWrite = c.cacheWrite - c.cacheWrite1h;
    sum +=
      c.input * r.inputPerToken +
      c.output * r.outputPerToken +
      c.cacheRead * r.cacheReadPerToken +
      shortWrite * r.cacheWritePerToken +
      c.cacheWrite1h * (r.cacheWriteLongTtlPerToken ?? r.cacheWritePerToken);
  }
  return sum;
}

// ---- Tokens since a point in time (quota windows) ----

interface FileMessages {
  mtimeMs: number;
  size: number;
  msgs: { id: string; ms: number; total: number }[];
}

const fileMessages = new Map<string, FileMessages>();

/**
 * Total tokens of every assistant call on this machine at or after `sinceMs`, deduplicated
 * globally by message.id. Unchanged files are not re-parsed.
 */
export async function tokensSince(sinceMs: number, roots?: string[]): Promise<number> {
  const files = await listTranscripts(roots);
  const best = new Map<string, { ms: number; total: number }>();
  for (const file of files) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < sinceMs) continue;
    let cached = fileMessages.get(file);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      const msgs: FileMessages["msgs"] = [];
      try {
        for (const row of parseJsonl(await readFile(file, "utf8"))) {
          if (row.type !== "assistant") continue;
          const id = row.message?.id ?? row.requestId;
          const t = ts(row);
          if (!id || Number.isNaN(t)) continue;
          msgs.push({ id, ms: t, total: totalTokens(usageTotals(row.message?.usage)) });
        }
      } catch {
        continue;
      }
      cached = { mtimeMs: st.mtimeMs, size: st.size, msgs };
      fileMessages.set(file, cached);
    }
    for (const m of cached.msgs) {
      const prev = best.get(m.id);
      if (!prev || m.total > prev.total) best.set(m.id, { ms: prev?.ms ?? m.ms, total: m.total });
    }
  }
  let sum = 0;
  for (const m of best.values()) if (m.ms >= sinceMs) sum += m.total;
  return sum;
}
