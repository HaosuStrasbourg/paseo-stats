import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type ProviderId = "claude" | "grok" | "codex";
export const PROVIDERS: readonly ProviderId[] = ["claude", "grok", "codex"];

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** Claude has a 5-hour and a 7-day window; SuperGrok (Grok Build) has a weekly pool. */
export type QuotaKey = "fiveHour" | "sevenDay";

export interface QuotaRow {
  key: QuotaKey;
  percent: number | null;
  resetsAt: string | null;
  /** Percentage points consumed by the last finished turn; null when unknown. */
  turnDelta: number | null;
  /** Tokens of this provider's sessions on this machine since the window started. */
  windowTokens: number | null;
}

export interface UsageCard {
  /** Empty when no quota source is available for the provider. */
  quotas: QuotaRow[];
  fetchedAt: string | null;
  contextUsed: number | null;
  contextMax: number | null;
  compactions: number | null;
}

/** Tool time categories; labels are localized on the client. */
export type ToolCategory = "shell" | "read" | "edit" | "search" | "web" | "agent" | "mcp" | "other";

export interface StatsColumn {
  ttftMs: number | null;
  tps: number | null;
  modelMs: number | null;
  toolMs: number | null;
  calls: number | null;
  toolCalls: number | null;
  toolByCategory: Partial<Record<ToolCategory, number>> | null;
  apiRetries: number | null;
}

export interface TpsPoint {
  at: string;
  tps: number;
  tokens: number;
  /** Belongs to the latest turn. */
  current: boolean;
}

export interface StatsCard {
  turn: StatsColumn;
  session: StatsColumn;
  /** Oldest first. One point per model call (Claude) or per turn (Grok). */
  tpsSeries: TpsPoint[];
  seriesUnit: "call" | "turn";
}

export interface TokenCard {
  total: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  thinking: number | null;
  cacheHitRate: number | null;
  cacheInvalidations: number | null;
  costUsd: number | null;
  /** Cost of the latest turn, same source as costUsd. */
  turnCostUsd: number | null;
  /** "rates": priced from a public rate table (reference); "provider": reported by the agent. */
  costSource: "rates" | "provider" | null;
  models: string[];
}

export interface Heatmap {
  provider: ProviderId;
  /** Local date of "now" on the daemon host, YYYY-MM-DD. */
  today: string;
  days: Record<string, number>;
}

export interface FilesColumn {
  files: number;
  added: number;
  removed: number;
}

/** Files written or edited through the agent's file tools (shell edits are not visible). */
export interface FilesCard {
  turn: FilesColumn;
  session: FilesColumn;
  /** Every file touched this session, most-changed first. */
  list: { path: string; added: number; removed: number; inTurn: boolean }[];
}

/** Session counters only Grok records (signals.json); null fields were not reported. */
export interface GrokExtras {
  itlP50Ms: number | null;
  itlP99Ms: number | null;
  itlMaxMs: number | null;
  longPauses: number | null;
  toolFailures: number | null;
  errors: number | null;
  cancellations: number | null;
  regenerations: number | null;
  doomLoopRecoveries: number | null;
  idleTimeouts: number | null;
}

export interface SessionDetail {
  agentId: string;
  provider: ProviderId | null;
  sessionId: string | null;
  turns: number | null;
  steps: number | null;
  usage: UsageCard;
  stats: StatsCard;
  tokens: TokenCard;
  files: FilesCard | null;
  grok: GrokExtras | null;
}

export interface PillData {
  agentId: string;
  provider: ProviderId | null;
  quotas: { key: QuotaKey; percent: number | null }[];
  turns: number | null;
  /** Session average. */
  tps: number | null;
  /** Most recent point of the speed series. */
  tpsLive: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  files: FilesColumn | null;
}

export const readPills = defineRpc({
  name: "paseo-stats.pills",
  input: z.object({ agentIds: z.array(z.string()).max(200) }),
  output: z.custom<{ pills: PillData[] }>(() => true),
});

export const readDetail = defineRpc({
  name: "paseo-stats.detail",
  input: z.object({ agentId: z.string() }),
  output: z.custom<SessionDetail>(() => true),
});

export const readHeatmap = defineRpc({
  name: "paseo-stats.heatmap",
  input: z.object({ provider: z.enum(["claude", "grok", "codex"]) }),
  output: z.custom<Heatmap>(() => true),
});
