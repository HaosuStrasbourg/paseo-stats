// Files an agent wrote or edited through its file tools, with lines added/removed.
// Shell-made changes (sed, redirects, scripts) leave no diff in either log and are not counted.
import os from "node:os";
import path from "node:path";
import type { FilesCard, FilesColumn } from "../shared/contracts.shared.ts";

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  turn: number;
}

/** Lines in a text; a trailing newline does not start another line. */
export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Claude's structuredPatch hunks: count "+" and "-" lines. */
export function countPatch(hunks: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (Array.isArray(hunks)) {
    for (const h of hunks) {
      for (const line of Array.isArray(h?.lines) ? h.lines : []) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
  }
  return { added, removed };
}

/**
 * Lines added/removed between two snippets, as a multiset difference of their lines.
 * Exact for replacements and appends; a pure reorder counts as unchanged.
 */
export function diffLines(oldText: string, newText: string): { added: number; removed: number } {
  const split = (t: string) => (t ? (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n") : []);
  const counts = new Map<string, number>();
  for (const l of split(oldText)) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of split(newText)) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else added += 1;
  }
  let removed = 0;
  for (const c of counts.values()) removed += c;
  return { added, removed };
}

function displayPath(p: string, cwd: string | null): string {
  if (cwd && (p === cwd || p.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`))) return path.relative(cwd, p) || p;
  const home = os.homedir();
  return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

function column(changes: FileChange[]): FilesColumn {
  return {
    files: new Set(changes.map((c) => c.path)).size,
    added: changes.reduce((s, c) => s + c.added, 0),
    removed: changes.reduce((s, c) => s + c.removed, 0),
  };
}

export function filesCard(changes: FileChange[], lastTurn: number, cwd: string | null): FilesCard {
  const byPath = new Map<string, { added: number; removed: number; inTurn: boolean }>();
  for (const c of changes) {
    const e = byPath.get(c.path) ?? { added: 0, removed: 0, inTurn: false };
    e.added += c.added;
    e.removed += c.removed;
    e.inTurn ||= c.turn === lastTurn;
    byPath.set(c.path, e);
  }
  return {
    turn: column(changes.filter((c) => c.turn === lastTurn)),
    session: column(changes),
    list: [...byPath.entries()]
      .map(([p, e]) => ({ path: displayPath(p, cwd), added: e.added, removed: e.removed, inTurn: e.inTurn }))
      .sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path)),
  };
}
