// Per-day token totals for the heatmap, per provider, persisted by this plugin because
// Claude Code deletes transcripts after 30 days. Days that the sources no longer fully cover
// are never lowered.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderId } from "../shared/contracts.shared.ts";
import { dayKey, startOfLocalDay, stateDir } from "./env.server.ts";
import { grokDaily } from "./grok.server.ts";
import { scanCodexDaily } from "./codex.server.ts";
import { scanDaily, type DayTotals } from "./transcript.server.ts";

const dailyFile = () => path.join(stateDir(), "daily.json");

interface DailyFile {
  version: 2;
  updatedAt: string;
  backfilledAt: Partial<Record<ProviderId, string>>;
  days: Partial<Record<ProviderId, Record<string, DayTotals>>>;
}

export async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1));
  await rename(tmp, file);
}

/** Days for one provider since `sinceMs` (all when undefined), and whether the scan was complete. */
async function scan(provider: ProviderId, sinceMs?: number): Promise<{ days: Record<string, DayTotals>; complete: boolean }> {
  if (provider === "claude") {
    const r = await scanDaily(sinceMs === undefined ? {} : { sinceMs });
    return { days: r.days, complete: r.errors.length === 0 };
  }
  if (provider === "codex") {
    const r = await scanCodexDaily(sinceMs === undefined ? {} : { sinceMs });
    return { days: r.days, complete: r.errors.length === 0 };
  }
  return { days: await grokDaily(sinceMs), complete: true };
}

export class DailyStore {
  private data: DailyFile = { version: 2, updatedAt: "", backfilledAt: {}, days: {} };
  private loaded = false;
  private running: Promise<void> | null = null;
  private again = false;

  private async load() {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(dailyFile(), "utf8"));
      if (raw?.version === 2 && raw.days && typeof raw.days === "object") this.data = raw;
      else if (raw?.version === 1 && raw.days && typeof raw.days === "object") {
        // v1 held Claude only.
        this.data.days.claude = raw.days;
        if (raw.backfilledAt) this.data.backfilledAt.claude = raw.backfilledAt;
      }
    } catch {
      // first run
    }
    this.loaded = true;
  }

  /** Full scan per provider on first run, incremental (sources touched since yesterday) afterwards. */
  update(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.load();
        const now = Date.now();
        const since = startOfLocalDay(now, 1);
        const windowStart = dayKey(since);
        for (const provider of ["claude", "grok", "codex"] as const) {
          const full = !this.data.backfilledAt[provider];
          const result = await scan(provider, full ? undefined : since);
          const stored = (this.data.days[provider] ??= {});
          for (const [day, totals] of Object.entries(result.days)) {
            const prev = stored[day];
            // Days in the window are complete in this scan; older ones may be partially deleted.
            if (day >= windowStart || !prev || totals.total > prev.total) stored[day] = totals;
          }
          if (full && result.complete) this.data.backfilledAt[provider] = new Date(now).toISOString();
        }
        this.data.updatedAt = new Date(now).toISOString();
        await writeJsonAtomic(dailyFile(), this.data);
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async totals(provider: ProviderId): Promise<Record<string, number>> {
    await this.load();
    const out: Record<string, number> = {};
    for (const [day, d] of Object.entries(this.data.days[provider] ?? {})) out[day] = d.total;
    return out;
  }
}
