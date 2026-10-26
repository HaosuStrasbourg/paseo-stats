// Integration fixtures are synthetic and isolated from all real provider data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readHeatmap, isProvider } from "../shared/contracts.shared.ts";
import { DailyStore } from "../server/daily.server.ts";
import type { LiveTracker } from "../server/live.server.ts";
import { StatsService, callSpeeds } from "../server/service.server.ts";
import { computeSessionStats, totalTokens } from "../server/transcript.server.ts";
import { computeGrokStats } from "../server/grok.server.ts";

test("Codex flows through detail, pills, quota windows and persistent heatmap without inventing metrics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-service-test-"));
  const keys = ["PASEO_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"] as const;
  const original = keys.map((key) => process.env[key]);
  try {
    process.env.PASEO_HOME = path.join(root, "paseo");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
    process.env.GROK_HOME = path.join(root, "grok");
    const sessions = path.join(process.env.CODEX_HOME, "sessions");
    await mkdir(sessions, { recursive: true });
    const now = Date.now() - 10_000;
    const stamp = (seconds: number) => new Date(now + seconds * 1000).toISOString();
    const reset = Math.floor((now + 86400_000) / 1000);
    const rows = [
      { type: "session_meta", payload: { id: "test-codex", cwd: "/fixture" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "turn_context", payload: { turn_id: "t1", model: "fixture-model" } },
      { type: "token_usage_record", payload: { response_id: "first", turn_id: "t1", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 } } },
      { type: "event_msg", payload: { type: "item_completed", item: { id: "file", type: "FileChange", status: "completed", changes: { "new.ts": { type: "add", content: "one\n" } } } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "t1", time_to_first_token_ms: 800 } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
      { type: "token_usage_record", payload: { response_id: "second", turn_id: "t2", usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 10 } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "t2", time_to_first_token_ms: 1000 } },
      { type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 0, window_minutes: 10080, resets_at: reset } } } },
    ].map((r, i) => ({ ...r, timestamp: stamp(i) }));
    await writeFile(path.join(sessions, "rollout-test-codex.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    const live = { load: async () => ({ provider: "codex", sessionId: "test-codex", contextUsed: null,
      contextMax: null, permissionWaits: {}, usageMarks: [], quotaDelta: { deltas: { sevenDay: 9 },
        resets: { sevenDay: new Date((reset - 604800) * 1000).toISOString() } } }) } as unknown as LiveTracker;
    const daily = new DailyStore();
    const service = new StatsService(live, daily);
    const detail = await service.detail("synthetic-agent");
    assert.equal(isProvider("codex"), true);
    assert.ok(readHeatmap);
    assert.equal(detail.provider, "codex");
    assert.equal(detail.turns, 2);
    assert.equal(detail.steps, 2);
    assert.equal(detail.tokens.total, 360);
    assert.equal(detail.tokens.input, 140);
    assert.equal(detail.tokens.cacheRead, 160);
    assert.equal(detail.tokens.cacheWrite, null);
    assert.equal(detail.tokens.output, 60);
    assert.equal(detail.tokens.thinking, 15);
    assert.equal(detail.tokens.cacheHitRate, 160 / 300);
    assert.equal(detail.tokens.costUsd, null);
    assert.equal(detail.tokens.cacheInvalidations, null);
    assert.equal(detail.stats.turn.ttftMs, 1000);
    assert.equal(detail.stats.session.ttftMs, 900);
    assert.equal(detail.stats.turn.calls, 1);
    for (const key of ["tps", "modelMs", "toolMs", "toolCalls", "apiRetries"] as const) assert.equal(detail.stats.session[key], null);
    assert.deepEqual(detail.stats.tpsSeries, []);
    assert.equal(detail.usage.quotas[0]?.key, "sevenDay");
    assert.equal(detail.usage.quotas[0]?.percent, 0);
    assert.equal(detail.usage.quotas[0]?.turnDelta, null);
    assert.equal(detail.usage.quotas[0]?.windowTokens, 360);
    assert.deepEqual(detail.files?.session, { files: 1, added: 1, removed: 0 });
    assert.equal(detail.files?.turn.files, 0);
    const pill = (await service.pills(["synthetic-agent"]))[0]!;
    assert.equal(pill.totalTokens, 360);
    assert.equal(pill.tpsLive, null);
    assert.equal(pill.files?.files, 1);
    await daily.update();
    const heatmap = await service.heatmap("codex");
    assert.equal(Object.values(heatmap.days).reduce((sum, n) => sum + n, 0), 360);
  } finally {
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude and Grok token conventions and Claude speed filtering remain unchanged", () => {
  const start = "2026-01-01T00:00:00Z";
  const end = "2026-01-01T00:00:02Z";
  const claude = computeSessionStats([
    { type: "user", timestamp: start, message: { content: "fixture" } },
    { type: "assistant", timestamp: end, message: { id: "c1", model: "fixture", usage: { input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 20 } } },
  ]);
  assert.equal(totalTokens(claude.session), 120);
  assert.equal(callSpeeds(claude.calls, [])[0]?.tps, 10);
  assert.equal(callSpeeds([{ ...claude.calls[0]!, lastMs: Date.parse(start) + 100 }], []).length, 0);
  const grok = computeGrokStats({ session: { inputTokens: 100, cachedReadTokens: 60, cacheCreationTokens: 30, outputTokens: 20 } }, [], null);
  assert.equal(totalTokens(grok.session), 120);
  assert.equal(grok.session.input, 10);
});
