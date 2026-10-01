export const DASH = "—";

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : Math.round(n).toLocaleString("en-US");
}

export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  return ratio === null || ratio === undefined ? DASH : `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : `${Math.round(value)}%`;
}

export function fmtDelta(points: number | null | undefined): string {
  if (points === null || points === undefined) return DASH;
  return `${points >= 0 ? "+" : ""}${Math.round(points)}%`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Prefix for estimated values. */
export function est(text: string): string {
  return text === DASH ? DASH : `~${text}`;
}

export function fmtTps(tps: number | null | undefined): string {
  return tps === null || tps === undefined ? DASH : `~${Math.round(tps)} tok/s`;
}

export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return DASH;
  return usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Local wall-clock time, with the date when it is not today. */
export function fmtClock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return DASH;
  const n = new Date(now);
  const sameDay = t.toDateString() === n.toDateString();
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return sameDay ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
}
