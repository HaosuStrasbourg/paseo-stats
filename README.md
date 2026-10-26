# paseo-stats

A [Paseo](https://paseo.sh) plugin that puts four stat pills above the composer of every Claude Code, Grok and Codex agent. Click a pill for a card with details. It reads local session and quota files, writes its own derived state locally, and never makes a network request.

[中文说明](README.zh-CN.md)

![Pills and cards](images/preview.png)

## What it shows

| Pill | Card |
|---|---|
| `5h 47% · 7d 28%` with a ring for the first window | **Usage**: daily token heatmap (last 16 weeks), quota bars, reset time, quota used by the last turn, tokens spent in each window on this machine, compaction count, age of the quota reading |
| `~145 tok/s · 20 turns` (latest call's speed) | **Session**: output speed per call (curve with current / average / peak), time to first token, model time, tool time by category, model calls, API retries, each for the latest turn and the whole session |
| `114M tok · ~$40.18` | **Tokens**: total, uncached input, cache read / write, output, thinking share, cache hit rate, cache invalidations, cost for the session and the latest turn, model. Grok sessions add output smoothness and stability counters |
| `19 files · +3.3K lines` | **Files changed**: files written or edited and lines added / removed (latest turn and session), most-changed files first |

Values starting with `~` are estimates. `—` means the value could not be measured; the row stays visible. Labels follow the app's language (Chinese for `zh*`, English otherwise).

## Supported agents

| Agent | Session data | Quota |
|---|---|---|
| Claude Code | `~/.claude/projects/**/<session>.jsonl` (`CLAUDE_CONFIG_DIR` honoured, several dirs allowed) | 5-hour and 7-day windows, via usage-monitor |
| Grok CLI (Grok Build) | `~/.grok/sessions/<cwd>/<session>/` — `usage.json`, `events.jsonl`, `signals.json`, `updates.jsonl` (`GROK_HOME` honoured) | SuperGrok weekly pool, via usage-monitor |
| Codex | `~/.codex/sessions/**/*.jsonl` (`CODEX_HOME` honoured) | Local `token_count.rate_limits` snapshots; 5-hour / 7-day windows identified by their duration |

Paseo's live event stream adds what the logs do not have: when each Claude call started streaming (for speed and time to first token), approval waits, and the context window.

## Install

Requires both the Paseo daemon and app to be 0.9 or newer. Previously tested with daemon 0.10.1 and app 0.9.1.

Check `paseo --version`, `paseo status`, and the version of the app you actually connect with. The CLI version alone does not establish the running daemon or app version.

### First installation

Paseo 0.11.2 disables the plugin system by default. If `pluginsEnabled` is unset or false, installing a plugin alone will not make it run. Enabling the system and installing a plugin modify `$PASEO_HOME/config.json` (default: `~/.paseo/config.json`); approve those changes and back up the file first. Plugins run trusted code without a sandbox.

For the default Paseo home, after approval:

```sh
cp -p ~/.paseo/config.json ~/.paseo/config.json.pre-plugins-$(date +%Y%m%d-%H%M%S).bak
paseo daemon config set pluginsEnabled true
```

If you use a custom Paseo home, select that same home for the backup and all Paseo commands. On 0.11.2, `config set` saves the setting and reloads a reachable daemon; if it reports that the setting was not applied, resolve the daemon connection before continuing. Do not start a second daemon based only on a `stopped` result inside a PID-isolated sandbox: repeat the read-only status check on the host first.

### Install and verify

```sh
paseo plugin install https://github.com/HaosuStrasbourg/paseo-stats
# or from a local checkout
paseo plugin install /path/to/paseo-stats
```

With the plugin system enabled, no daemon restart is needed; the pills appear after the app reloads its plugins.

```sh
paseo plugin ls paseo-stats
paseo plugin logs paseo-stats
```

Expect `running`. Then reload the app's plugins and open an unarchived Claude Code, Grok or Codex session in a workspace. The server log should contain `pills requested for … agent(s)`. That message requires a client request; installation or `running` alone does not produce it. Confirm all four pills and their cards in the actual app; a log message does not verify their appearance.

To undo a fresh installation, run `paseo plugin remove paseo-stats`. If the plugin system was previously unset and no other plugins now depend on it, also run `paseo daemon config unset pluginsEnabled` (restore `false` instead if that was the original value). The local checkout is retained. Preserve `$PASEO_HOME/paseo-stats/` if you want to keep heatmap/live history. Only restore the whole config backup after checking for unrelated changes made since the backup.

Fresh-machine check on 2026-10-21: cloning commit `7107b25`, `npm ci`, and `npm run typecheck` passed on Linux with Node 26.8.2. The running daemon and bundled Web App were 0.11.2. After config backup and approval, the plugin system was enabled and the local checkout installed with status `running`. After the Codex update, the plugin reloaded as `running` and logged `pills requested`; an existing Paseo Codex session also resolved successfully through the service. The actual app UI remains unverified. Restricted-sandbox DNS initially blocked GitHub/npm access; the same operations succeeded with approved host network access.

### Quotas (optional)

Quota numbers come from the [usage-monitor](https://github.com/ABorakati/paseo-usage-monitor) plugin's cache (`$PASEO_HOME/usage-limits/last-readings.json`). This plugin only reads that file. Without usage-monitor, Claude/Grok quota rows read "no quota data" and everything else works. Codex reads quota snapshots from its own local session logs and does not need usage-monitor; these snapshots update only when Codex writes a new reading.

The entry is found by its `preset` in `$PASEO_HOME/usage-limits.json`, so the entry name does not matter. Claude works with the stock `claude` preset.

For Grok, the stock `grok` preset reads a legacy monthly endpoint that returns zeros for subscriptions, and cannot read the credential format of Grok CLI 1.0+. Override it in `usage-limits.json`:

```json
"grok": {
  "preset": "grok",
  "refreshIntervalMs": 1800000,
  "source": {
    "kind": "http",
    "url": "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    "method": "GET",
    "headers": { "Authorization": "Bearer ${token}", "X-XAI-Token-Auth": "xai-grok-cli", "Accept": "application/json" }
  },
  "readings": [{
    "kind": "quota", "id": "weekly", "label": "Weekly", "unit": "percent",
    "percentPath": "creditUsagePercent",
    "window": { "label": "Weekly", "resetsAtPath": "config.currentPeriod.end", "durationMs": 604800000 }
  }],
  "credentials": {
    "token": [{
      "kind": "jsonFile",
      "file": "~/.grok/auth.json",
      "path": "[\"<scope key in your auth.json>\"].key",
      "expiresAtPath": "[\"<scope key in your auth.json>\"].expires_at",
      "refreshedBy": "grok"
    }]
  }
}
```

The scope key is the top-level key of `~/.grok/auth.json` (an `https://auth.x.ai::…` string). Grok omits `creditUsagePercent` at 0%; this plugin reads a weekly period without it as 0%.

### Running Grok in Paseo

Grok CLI speaks ACP. Add it as a custom provider in `$PASEO_HOME/config.json`, then run `paseo reload`:

```json
"agents": {
  "providers": {
    "grok": { "extends": "acp", "label": "Grok", "command": ["/home/you/.grok/bin/grok", "agent", "stdio"] }
  }
}
```

## Codex support (0.2.0-beta.1)

Uses Paseo's built-in `codex` provider and its persisted Codex thread ID. No provider configuration or credentials are required by this plugin.

- **Tokens and requests**: prefer `token_usage_record.usage`, deduplicated by `response_id`, including compaction requests. `input_tokens` includes cache reads/writes; `reasoning_output_tokens` is already part of output. Older `token_count` snapshots are a fallback, with repeated readings ignored; their request count stays `—`.
- **Turns and TTFT**: turns follow `task_started` / `turn_id`; TTFT is `task_complete.time_to_first_token_ms`, averaged across completed turns. This is a per-turn measurement, unlike Claude's per-call TTFT.
- **Quota**: only local snapshots are read. `primary` can be a weekly window, so 300 / 10080 minutes determine the labels. A reported 0% remains 0%; unsupported windows are omitted. The card shows the reading time; no background quota request is made.
- **Files**: only successful structured `item_completed.FileChange` events count. Additions use content lines, updates use unified-diff hunks, and deletions require original content. Unsupported or incomplete file evidence displays `—`, not zero changes.
- **History**: forked subagent history before `subagent_history_start_ordinal` is excluded; response IDs are deduplicated across files for heatmaps and window totals.
- **Unavailable**: output speed/curve, model/tool duration, tool counts, retries, cost and cache invalidations show `—` (or no chart data). Missing cache-write measurements also show `—`. Rollout write timestamps are not treated as streaming timestamps.

Compatibility was checked against four historical local Codex rollouts, ten synthetic parsing/service/regression checks, the stats CLI, and an existing Paseo Codex session. Type checking and the host plugin reload passed.

On 2026-10-26, an isolated harness connected the real client components to the real service with synthetic sessions. English and Chinese screenshots covered normal and missing data; token/file values, unknown metrics, heatmap selection, single-line rows and card heights (at most 335px) passed the harness checks and screenshot review. The temporary Playwright-managed Chromium required approved host execution after the execution sandbox blocked startup. Actual Paseo UI, narrow-screen fit and `FilePen` rendering remain unverified; this is a beta, not a claim of full metric parity with Claude/Grok. A pre-existing countdown rounding issue (`1h 60m`) was observed and remains to be fixed.

## How the numbers are computed

- **Turns**: real user prompts (not tool results, slash-command echoes or interrupt markers). **Steps**: model calls, deduplicated by `message.id` (Claude writes one entry per content block).
- **Total tokens**: uncached input + cache read + cache write + output. Grok reports input including cache, so cache is subtracted first. **Cache hit rate**: cache read ÷ (uncached input + cache read + cache write).
- **Cache invalidation** (Claude): the previous call left at least 10k tokens cached, this call read under 50% of it and wrote at least 50% of it again. The first call after a compaction is skipped. Grok has no per-call cache data, so it shows `—`.
- **Output speed** (Claude, per call): output tokens ÷ (last block written − streaming start). The start is the first live usage update after the request went out; if none was seen, or it arrived late (Paseo sometimes delivers a whole call's events at its end), the request time is used, which can only understate the speed. Calls under 200 ms or above 1,000 tok/s are left out.
- **Output speed** (Grok, per turn): Grok reports output tokens per turn only, so speed is turn output ÷ streaming time (first token to end of each call, including reasoning). Turns under 200 ms of streaming or above 2,000 tok/s are left out.
- **Time to first token**: Claude, request sent → streaming start (live only, so earlier history shows `—`); Grok, waiting for model → first token, from `events.jsonl`.
- **Model time** (Claude): per call, from the previous event to its last block, excluding time lost to failed attempts before an API retry. Grok: per call from `events.jsonl`.
- **Tool time**: tool start → result, minus time waiting for approval. Grok's `duration_ms` already excludes it.
- **Cost**: Claude is priced from the LiteLLM rate table that usage-monitor caches locally (reference only; compaction calls are not in the transcript). Grok's own figure from `usage.json`.
- **Quota used by the last turn**: reading after the turn ends minus the reading at turn start. `—` if the window reset or no new reading arrived within 90 s.
- **Tokens in a quota window**: all sessions of that agent on this machine since `reset time − window length`, deduplicated.
- **Files changed**: only successful write/edit tool calls. Claude counts `+`/`-` lines of the structured patch (a new file counts all its lines); Grok compares the before/after text of each diff. Files are counted once per path.
- **Heatmap**: daily totals in the host's time zone, five tiers by rank among days with data. Totals are kept in `$PASEO_HOME/paseo-stats/daily.json` and never lowered, so they survive Claude Code deleting transcripts after 30 days.

## Privacy and request volume

This plugin reads local session/quota files and Paseo's local event stream, without modifying those sources. It writes only its own derived state under `$PASEO_HOME/paseo-stats/`. It sends nothing anywhere. Quota readings are fetched by usage-monitor: one request per provider at the end of each turn, cached 30 minutes, with backoff on HTTP 429.

## Known limits

- Counts this machine only. Quotas are per account, so usage on other devices is not in the "this machine" token figures.
- Shell edits (`sed`, scripts, redirects) and sub-agent work are not counted as file changes.
- Reads internal file formats of usage-monitor, Paseo (`agents/*.json`, as a fallback) and Grok CLI, which may change.
- Live data (speed start, time to first token, approval waits) exists only while the plugin runs.
- The composer may not fit four pills on very narrow screens.

## Development

```sh
npm ci               # lockfile-pinned dev dependencies, for type checking only
npm run typecheck
npm test             # synthetic Codex + service/regression checks, no private data
npm run stats -- <claude-session-id>   # print transcript metrics and daily totals
npm run stats -- codex <codex-thread-id> # Codex session metrics and daily totals
```

Run `npm ci` again if synchronization removed `node_modules`. Use `npm run typecheck`, not `npx tsc`: when TypeScript is missing, `npx tsc` can fetch the unrelated package named `tsc`.

State lives in `$PASEO_HOME/paseo-stats/` (`daily.json`, `live/<agent>.json`).

## License

MIT
