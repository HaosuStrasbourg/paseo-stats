// Synthetic fixtures only: never copy private Codex rollout contents into this repository.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexQuotaFromRows, codexTokensSince, computeCodexStats, findCodexSession,
  readCodexStats, scanCodexDaily,
} from "../server/codex.server.ts";
import { totalTokens } from "../server/transcript.server.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 2) + seconds * 1000).toISOString();
const row = (type: string, payload: Record<string, any>, seconds = 0) => ({ type, payload, timestamp: at(seconds) });
const event = (type: string, extra: Record<string, any> = {}, seconds = 0) => row("event_msg", { type, ...extra }, seconds);
const usage = (input = 100, cached = 60, output = 20) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output });
const meta = (id = "test-session", extra: Record<string, any> = {}) => row("session_meta", { id, cwd: "/synthetic", ...extra });
const record = (id: string, u = usage(), turn = "t1", seconds = 2) => row("token_usage_record", {
  response_id: id, thread_id: "test-session", turn_id: turn, usage: u,
}, seconds);

test("explicit response records deduplicate and include a compaction request absent from token_count", () => {
  const rows = [meta(), event("task_started", { turn_id: "t1" }),
    row("turn_context", { turn_id: "t1", model: "test-model" }),
    record("r1"), record("r1"), record("compact", usage(30, 10, 5), "t1", 3),
    row("compacted", { latest_token_usage_record: { response_id: "compact", usage: usage(30, 10, 5) } }, 3),
    event("token_count", { info: { total_token_usage: usage(), last_token_usage: usage(), model_context_window: 200000 } }, 4),
    event("task_complete", { turn_id: "t1", time_to_first_token_ms: 420, duration_ms: 5000 }, 5)];
  const s = computeCodexStats(rows);
  assert.equal(totalTokens(s.session), 155);
  assert.equal(s.session.input, 60);
  assert.equal(s.session.cacheRead, 70);
  assert.equal(s.session.output, 25);
  assert.equal(s.steps, 2);
  assert.equal(s.compactions, 1);
  assert.equal(s.turns, 1);
  assert.equal(s.hasUsage, true);
  assert.equal(s.cacheWriteKnown, true);
  assert.deepEqual(s.models, ["test-model"]);
  assert.deepEqual(s.ttft, [{ turn: 0, ms: 420 }]);
  assert.equal("modelMs" in s, false);
  assert.equal("tps" in s, false);
});

test("fallback token_count ignores duplicate snapshots and handles a reset without adding reasoning twice", () => {
  const count = (u: Record<string, any>, seconds: number) => event("token_count", { info: { total_token_usage: u, last_token_usage: u } }, seconds);
  const rows = [meta(), row("turn_context", { turn_id: "t1", model: "old-model" }), event("user_message"),
    count(usage(), 1), count(usage(), 2), count(usage(200, 120, 40), 3),
    event("user_message", {}, 4), count(usage(50, 10, 10), 5)];
  const s = computeCodexStats(rows);
  assert.equal(totalTokens(s.session), 300);
  assert.equal(totalTokens(s.turn), 60);
  assert.equal(s.session.output, 50);
  assert.equal(s.steps, null);
  assert.equal(s.turns, 2);
  assert.equal(s.calls.length, 3);
});

test("a CLI upgrade preserves the old snapshot prefix before explicit response records begin", () => {
  const rows = [meta(), event("task_started", { turn_id: "t1" }),
    event("token_count", { info: { total_token_usage: usage(), last_token_usage: usage() } }, 1),
    record("new-record", usage(), "t1", 2),
    event("token_count", { info: { total_token_usage: usage(200, 120, 40), last_token_usage: usage() } }, 3)];
  const s = computeCodexStats(rows);
  assert.equal(totalTokens(s.session), 240);
  assert.equal(s.calls.length, 2);
  assert.equal(s.steps, null);
});

test("fork boundary discards copied turns, metadata, files and foreign-thread records", () => {
  const inherited = [meta("test-session", { subagent_history_start_ordinal: 5, forked_from_id: "parent" }),
    meta("parent"), event("task_started", { turn_id: "parent-turn" }),
    event("task_complete", { turn_id: "parent-turn", time_to_first_token_ms: 999 }),
    row("turn_context", { turn_id: "parent-turn", model: "parent-model" })];
  const rows = [...inherited, event("task_started", { turn_id: "child-turn" }),
    row("turn_context", { turn_id: "child-turn", model: "child-model" }),
    record("child", usage(), "child-turn"),
    row("token_usage_record", { response_id: "foreign", thread_id: "parent", usage: usage(9999) })];
  const s = computeCodexStats(rows);
  assert.equal(s.turns, 1);
  assert.equal(s.steps, 1);
  assert.equal(totalTokens(s.session), 120);
  assert.deepEqual(s.models, ["child-model"]);
  assert.deepEqual(s.ttft, []);
});

test("only successful structured file changes count, once per item", () => {
  const change = event("item_completed", { item: { type: "FileChange", id: "f1", status: "completed", changes: {
    "new.ts": { type: "add", content: "one\ntwo\n" },
    "old.ts": { type: "update", unified_diff: "--- old\n+++ new\n@@ -1 +1 @@\n-before\n+after\n+++actual line\n", move_path: null },
  } } });
  const s = computeCodexStats([meta(), event("task_started", { turn_id: "t1" }), change, change,
    event("item_completed", { item: { type: "FileChange", id: "failed", status: "failed", changes: { "failed.ts": { type: "add", content: "ignore" } } } })]);
  assert.deepEqual(s.fileChanges, [
    { path: "/synthetic/new.ts", added: 2, removed: 0, turn: 0 },
    { path: "/synthetic/old.ts", added: 2, removed: 1, turn: 0 },
  ]);
});

test("unknown usage, cache write, file results and unavailable metrics remain distinguishable", () => {
  const empty = computeCodexStats([meta()]);
  assert.equal(empty.hasUsage, false);
  assert.equal(empty.cacheWriteKnown, false);
  assert.equal(empty.fileChanges, null);
  assert.deepEqual(empty.ttft, []);
  const missingWrite = usage();
  delete (missingWrite as Partial<typeof missingWrite>).cache_write_input_tokens;
  assert.equal(computeCodexStats([meta(), record("r", missingWrite)]).cacheWriteKnown, false);
  assert.equal(computeCodexStats([meta(), event("item_completed", { item: { type: "CommandExecution" } }),
    row("response_item", { type: "custom_tool_call", name: "apply_patch" })]).fileChanges, null);
  assert.equal(computeCodexStats([meta(), event("item_completed", { item: { type: "FileChange", status: "completed", changes: { "gone.ts": { type: "delete" } } } })]).fileChanges, null);
  assert.deepEqual(computeCodexStats([meta(), event("item_completed", { item: { type: "CommandExecution" } })]).fileChanges, []);
});

test("quota windows use duration rather than primary/secondary position and preserve 0 percent", () => {
  const rows = [event("token_count", { rate_limits: { limit_id: "codex",
    primary: { used_percent: 0, window_minutes: 10080, resets_at: 1768000000 },
    secondary: { used_percent: 20, window_minutes: 300, resets_at: 1767400000 },
  } }), event("token_count", { rate_limits: { limit_id: "other-provider", primary: { used_percent: 99, window_minutes: 300 } } }, 2)];
  const q = codexQuotaFromRows(rows)!;
  assert.equal(q.windows[0]?.key, "fiveHour");
  assert.equal(q.windows[1]?.key, "sevenDay");
  assert.equal(q.windows[1]?.percent, 0);
  assert.equal(q.windows[1]?.resetsAt, new Date(1768000000 * 1000).toISOString());
  assert.equal(codexQuotaFromRows([event("token_count", { rate_limits: { primary: { used_percent: 1, window_minutes: 60 } } })]), null);
});

test("daily/window scans deduplicate response IDs across files, find sessions and tolerate trailing partial JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-codex-test-"));
  try {
    const first = path.join(root, "rollout-2026-01-02-test-session.jsonl");
    const rows = [meta(), event("task_started", { turn_id: "t1" }), record("shared")];
    await writeFile(first, rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"unfinished":');
    await writeFile(path.join(root, "copy.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    assert.equal(await findCodexSession("test-session", [root]), first);
    assert.equal(await findCodexSession("../secrets", [root]), null);
    assert.equal((await readCodexStats(first)).steps, 1);
    const daily = await scanCodexDaily({ roots: [root] });
    assert.equal(daily.files, 2);
    assert.equal(daily.messages, 1);
    assert.equal(Object.values(daily.days)[0]?.total, 120);
    assert.deepEqual(daily.errors, []);
    assert.equal(await codexTokensSince(Date.parse(at(0)), [root]), 120);
    assert.equal(await codexTokensSince(Date.parse(at(3)), [root]), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
