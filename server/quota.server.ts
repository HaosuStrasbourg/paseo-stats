// Quota readings written by the usage-monitor plugin. We only read its files and never
// request anything ourselves. Its formats are internal to that plugin, so every field is
// looked up defensively and readings are matched by id, never by array position.
//
// The entry is found by preset in usage-limits.json, so a renamed or second entry still
// works: the first enabled entry whose preset matches the provider wins.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderId, QuotaKey } from "../shared/contracts.shared.ts";
import { paseoHome } from "./env.server.ts";

export interface QuotaWindow {
  key: QuotaKey;
  percent: number;
  resetsAt: string | null;
  durationMs: number | null;
}

export interface QuotaSnapshot {
  fetchedAtMs: number;
  windows: QuotaWindow[];
}

/** usage-monitor reading id -> our key, per provider (display order). */
const READINGS: Record<ProviderId, { id: string; key: QuotaKey }[]> = {
  claude: [
    { id: "session", key: "fiveHour" },
    { id: "weekly", key: "sevenDay" },
  ],
  // Needs the entry's source pointed at `/v1/billing?format=credits` (see README).
  grok: [{ id: "weekly", key: "sevenDay" }],
};

const PRESETS: Record<ProviderId, string> = { claude: "claude", grok: "grok" };

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function entryIdFor(provider: ProviderId): Promise<string> {
  const config = await readJson(path.join(paseoHome(), "usage-limits.json"));
  if (config && typeof config === "object") {
    for (const [id, entry] of Object.entries<any>(config)) {
      if (entry?.preset === PRESETS[provider] && entry?.enabled !== false) return id;
    }
  }
  return PRESETS[provider];
}

function readWindow(provider: ProviderId, readings: unknown, id: string, key: QuotaKey): QuotaWindow | null {
  if (!Array.isArray(readings)) return null;
  const r = readings.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === id) as
    | Record<string, any>
    | undefined;
  if (!r) return null;
  let percent: number | null = typeof r.percent === "number" && Number.isFinite(r.percent) ? r.percent : null;
  if (percent === null && typeof r.used === "number" && typeof r.limit === "number" && r.limit > 0) {
    percent = (r.used / r.limit) * 100;
  }
  const resetsAt = typeof r.window?.resetsAt === "string" ? r.window.resetsAt : null;
  // Grok omits creditUsagePercent at 0%; a confirmed weekly period without it means none used.
  if (percent === null && provider === "grok" && resetsAt !== null) percent = 0;
  if (percent === null) return null;
  const durationMs = typeof r.window?.durationMs === "number" && r.window.durationMs > 0 ? r.window.durationMs : null;
  return { key, percent, resetsAt, durationMs };
}

export async function readQuota(provider: ProviderId): Promise<QuotaSnapshot | null> {
  const [entryId, raw] = await Promise.all([
    entryIdFor(provider),
    readJson(path.join(paseoHome(), "usage-limits", "last-readings.json")),
  ]);
  const p = raw?.providers?.[entryId];
  const fetchedAtMs = Date.parse(p?.fetchedAt);
  if (!p || !Number.isFinite(fetchedAtMs)) return null;
  const windows = READINGS[provider]
    .map(({ id, key }) => readWindow(provider, p.readings, id, key))
    .filter((w): w is QuotaWindow => w !== null);
  return windows.length > 0 ? { fetchedAtMs, windows } : null;
}

/** Same window if reset times agree to the minute (the API's reset timestamp jitters by microseconds). */
export function sameReset(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 60_000;
}

function sameWindow(a: QuotaWindow, b: QuotaWindow): boolean {
  return sameReset(a.resetsAt, b.resetsAt);
}

const DEFAULT_DURATION: Partial<Record<QuotaKey, number>> = { fiveHour: 5 * 3_600_000, sevenDay: 7 * 86_400_000 };

/** Start of the quota window (reset time minus window length); null when unknown. */
export function windowStart(w: QuotaWindow | null | undefined): number | null {
  if (!w?.resetsAt) return null;
  const reset = Date.parse(w.resetsAt);
  const duration = w.durationMs ?? DEFAULT_DURATION[w.key];
  if (!Number.isFinite(reset) || duration === undefined) return null;
  return reset - duration;
}

export function windowDelta(before: QuotaWindow | null | undefined, after: QuotaWindow | null | undefined): number | null {
  if (!before || !after || !sameWindow(before, after)) return null;
  const delta = after.percent - before.percent;
  // A drop means the window reset in between.
  return delta < 0 ? null : delta;
}

/** Polls usage-monitor's cache until it holds a reading fetched after `afterMs`. */
export async function waitForQuotaAfter(
  provider: ProviderId,
  afterMs: number,
  signal: AbortSignal,
  timeoutMs = 90_000,
): Promise<QuotaSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const q = await readQuota(provider);
    if (q && q.fetchedAtMs >= afterMs) return q;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}
