// Locations and local time. Everything honours the same environment variables as the tools
// that own the files (PASEO_HOME, CLAUDE_CONFIG_DIR, GROK_HOME); days follow the host's
// time zone (TZ or the system setting).
import os from "node:os";
import path from "node:path";

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function paseoHome(): string {
  const env = process.env.PASEO_HOME?.trim();
  return env ? path.resolve(expandHome(env)) : path.join(os.homedir(), ".paseo");
}

/** This plugin's own state directory. */
export function stateDir(): string {
  return path.join(paseoHome(), "paseo-stats");
}

/** `<root>/projects` for every Claude config dir (CLAUDE_CONFIG_DIR may list several). */
export function claudeProjectRoots(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const roots = env.length > 0 ? env.map(expandHome) : [path.join(os.homedir(), ".claude")];
  return roots.map((r) => (path.basename(r) === "projects" ? r : path.join(r, "projects")));
}

export function grokSessionsRoot(): string {
  const env = process.env.GROK_HOME?.trim();
  return path.join(env ? expandHome(env) : path.join(os.homedir(), ".grok"), "sessions");
}

/** Codex rollout logs only; no auth or configuration files are read. */
export function codexSessionRoots(): string[] {
  const env = process.env.CODEX_HOME?.trim();
  return [path.join(env ? path.resolve(expandHome(env)) : path.join(os.homedir(), ".codex"), "sessions")];
}

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Local calendar date, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  return dayFormat.format(new Date(ms));
}

/** Start (ms) of the local day `daysAgo` days before the one containing `now`. */
export function startOfLocalDay(now: number, daysAgo = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}
