// Standalone check: node scripts/stats-cli.ts [claudeSessionId]
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

const sessionId = process.argv[2];
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
