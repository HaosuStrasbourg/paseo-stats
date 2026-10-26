// Standalone check: node scripts/stats-cli.ts [claudeSessionId] | codex [sessionId]
// Prints transcript-derived session metrics and per-day totals. Read-only.
import {
  cacheHitRate,
  costUsd,
  findSessionTranscript,
  readRates,
  readSessionStats,
  scanDaily,
  totalTokens,
  type Period,
} from "../server/transcript.server.ts";
import { findCodexSession, readCodexStats, scanCodexDaily } from "../server/codex.server.ts";

const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const fmtN = (n: number) => n.toLocaleString("en-US");

function printPeriod(label: string, p: Period) {
  console.log(`  [${label}]`);
  console.log(`    model calls ${p.calls}  model time ${fmtS(p.modelMs)}  ~tok/s ${p.modelMs ? (p.output / (p.modelMs / 1000)).toFixed(1) : "—"}`);
  console.log(`    tool calls ${p.toolCalls}  tool time ${fmtS(p.toolMs)}  API retries ${p.apiRetries}`);
  console.log(`    by tool ${Object.entries(p.toolByCategory).map(([k, v]) => `${k} ${fmtS(v)}`).join(", ") || "—"}`);
  const hit = cacheHitRate(p);
  console.log(
    `    tokens ${fmtN(totalTokens(p))}  input ${fmtN(p.input)}  cache read ${fmtN(p.cacheRead)}  cache write ${fmtN(p.cacheWrite)}  output ${fmtN(p.output)}  thinking ${fmtN(p.thinking)}  hit rate ${hit === null ? "—" : (hit * 100).toFixed(1) + "%"}`,
  );
}

const provider = process.argv[2] === "codex" ? "codex" : "claude";
const sessionId = process.argv[provider === "codex" ? 3 : 2];
if (provider === "codex") {
  if (sessionId) {
    const file = await findCodexSession(sessionId);
    if (!file) {
      console.error(`Codex rollout not found: ${sessionId}`);
      process.exit(1);
    }
    const s = await readCodexStats(file);
    console.log(`Codex session ${sessionId}`);
    console.log(`  turns ${s.turns}  model requests ${s.steps ?? "—"}  models ${s.models.join(" / ") || "—"}`);
    console.log(`  compactions ${s.compactions}  TTFT samples ${s.ttft.length}`);
    for (const [label, p] of [["session", s.session], ["turn", s.turn]] as const) {
      console.log(`  [${label}] tokens ${s.hasUsage ? fmtN(totalTokens(p)) : "—"}  input ${s.hasUsage ? fmtN(p.input) : "—"}  cache read ${s.hasUsage ? fmtN(p.cacheRead) : "—"}  cache write ${s.cacheWriteKnown ? fmtN(p.cacheWrite) : "—"}  output ${s.hasUsage ? fmtN(p.output) : "—"}  thinking ${s.hasUsage ? fmtN(p.thinking) : "—"}`);
    }
    console.log("  speed / model time / tool time / retries / cost: — (not reliably reported)");
  }
  const daily = await scanCodexDaily();
  console.log(`\nCodex daily totals (${daily.files} files, ${daily.messages} unique usage records, errors ${daily.errors.length})`);
  for (const [day, d] of Object.entries(daily.days).sort()) {
    console.log(`  ${day}  ${fmtN(d.total).padStart(12)}  in ${fmtN(d.input)}  cr ${fmtN(d.cacheRead)}  cw ${fmtN(d.cacheWrite)}  out ${fmtN(d.output)}`);
  }
} else {
if (sessionId) {
  const file = await findSessionTranscript(sessionId);
  if (!file) {
    console.error(`transcript not found: ${sessionId}`);
    process.exit(1);
  }
  const s = await readSessionStats(file);
  const rates = await readRates();
  console.log(`session ${sessionId}\n  ${file}`);
  console.log(`  turns ${s.turns}  steps ${s.steps}  tool calls ${s.tools.length}  models ${s.models.join(" / ") || "—"}`);
  console.log(`  cache invalidations ${s.cacheInvalidations}  compactions ${s.compactions}  cost (reference) $${costUsd(s.calls, rates)?.toFixed(2) ?? "—"}`);
  printPeriod("session", s.session);
  printPeriod("turn", s.turn);
}

const daily = await scanDaily();
console.log(`\ndaily totals (${daily.files} files, ${daily.messages} unique calls${daily.errors.length ? `, errors ${daily.errors.length}` : ""})`);
for (const [day, d] of Object.entries(daily.days).sort()) {
  console.log(`  ${day}  ${fmtN(d.total).padStart(12)}  in ${fmtN(d.input)}  cr ${fmtN(d.cacheRead)}  cw ${fmtN(d.cacheWrite)}  out ${fmtN(d.output)}`);
}
}
