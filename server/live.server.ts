// Live observations that transcripts cannot give: when each model call started streaming
// (for TTFT and TPS), permission waits, context window, and per-turn quota consumption.
// Only available while this plugin listens; state is persisted per agent so a plugin
// reload does not lose it.
//
// Timeline events are not used for timing: the host can deliver a call's reasoning/text in
// one burst at its end, so "first content event" is not when the model started producing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { isProvider, type ProviderId, type QuotaKey } from "../shared/contracts.shared.ts";
import { writeJsonAtomic } from "./daily.server.ts";
import { stateDir } from "./env.server.ts";
import { readQuota, waitForQuotaAfter, windowDelta, type QuotaSnapshot } from "./quota.server.ts";

type PaseoApi = PluginHookContext["paseo"];

const liveDir = () => path.join(stateDir(), "live");
const MAX_MARKS = 2000;

interface Persisted {
  version: 2;
  /** toolUseId -> ms spent waiting for the user to approve */
  permissionWaits: Record<string, number>;
  /** Percentage points the last finished turn consumed, per quota window. */
  quotaDelta: { deltas: Partial<Record<QuotaKey, number | null>>; turnId: string | null } | null;
  /** Quota reading taken when the current turn started (survives a plugin reload mid-turn). */
  quotaBefore: QuotaSnapshot | null;
  /**
   * Receive times (ms) of streaming usage updates. The first one after a request is sent is
   * that call's message_start; pairing them with calls is left to the transcript, which knows
   * when each request went out and when its last block was written.
   */
  usageMarks: number[];
}

interface AgentLive extends Persisted {
  agentId: string;
  /** From the agent snapshot; null until one is seen. */
  provider: ProviderId | null;
  sessionId: string | null;
  loaded: boolean;
  dirty: boolean;
  contextUsed: number | null;
  contextMax: number | null;
  lastStreamUsed: number | null;
  pendingPermissions: Map<string, { ms: number; toolUseId: string | null }>;
  quotaPending: AbortController | null;
  unsubscribeTimeline: (() => void) | null;
}

type AgentSnapshot = Record<string, any>;

export class LiveTracker {
  private agents = new Map<string, AgentLive>();
  private paseo: PaseoApi | null = null;
  private cleanup: (() => void)[] = [];
  private stopped = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  get(agentId: string): AgentLive | undefined {
    return this.agents.get(agentId);
  }

  /** Like get(), but loads persisted state first (e.g. right after a plugin reload). */
  load(agentId: string): Promise<AgentLive> {
    return this.ensure(agentId);
  }

  private async ensure(agentId: string): Promise<AgentLive> {
    let a = this.agents.get(agentId);
    if (!a) {
      a = {
        agentId,
        provider: null,
        sessionId: null,
        version: 2,
        permissionWaits: {},
        quotaDelta: null,
        quotaBefore: null,
        usageMarks: [],
        loaded: false,
        dirty: false,
        contextUsed: null,
        contextMax: null,
        lastStreamUsed: null,
        pendingPermissions: new Map(),
        quotaPending: null,
        unsubscribeTimeline: null,
      };
      this.agents.set(agentId, a);
    }
    if (!a.loaded) {
      a.loaded = true;
      try {
        const raw = JSON.parse(await readFile(path.join(liveDir(), `${agentId}.json`), "utf8"));
        a.permissionWaits = raw?.permissionWaits ?? {};
        a.quotaDelta = raw?.quotaDelta?.deltas ? raw.quotaDelta : null;
        a.quotaBefore = raw?.quotaBefore ?? null;
        a.usageMarks = Array.isArray(raw?.usageMarks) ? raw.usageMarks : [];
      } catch {
        // nothing persisted yet
      }
    }
    return a;
  }

  private async flush() {
    for (const a of this.agents.values()) {
      if (!a.dirty) continue;
      a.dirty = false;
      const data: Persisted = {
        version: 2,
        permissionWaits: a.permissionWaits,
        quotaDelta: a.quotaDelta,
        quotaBefore: a.quotaBefore,
        usageMarks: a.usageMarks,
      };
      await writeJsonAtomic(path.join(liveDir(), `${a.agentId}.json`), data).catch(() => {
        a.dirty = true;
      });
    }
  }

  /** Starts observing agents through the plugin's process-wide API. Idempotent. */
  start(paseo: PaseoApi) {
    if (this.paseo || this.stopped) return;
    this.paseo = paseo;
    this.cleanup.push(paseo.agents.subscribe((update) => this.onAgentUpdate(update as any)));
    paseo.agents
      .list({ subscribe: {} })
      .then((directory) => {
        for (const entry of directory.entries) this.onAgentSnapshot(entry.agent as AgentSnapshot);
        const sub = (directory as any).subscription;
        if (sub?.release) this.cleanup.push(() => void sub.release().catch(() => undefined));
      })
      .catch((error) => console.warn("[paseo-stats] agent list failed", error));
    this.flushTimer = setInterval(() => void this.flush(), 5_000);
  }

  stop() {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const a of this.agents.values()) {
      a.unsubscribeTimeline?.();
      a.quotaPending?.abort();
    }
    for (const fn of this.cleanup) fn();
    return this.flush();
  }

  private onAgentUpdate(update: { kind?: string; agent?: AgentSnapshot; agentId?: string }) {
    if (update.kind === "remove" && update.agentId) {
      this.agents.get(update.agentId)?.unsubscribeTimeline?.();
      return;
    }
    if (update.agent) this.onAgentSnapshot(update.agent);
  }

  private onAgentSnapshot(agent: AgentSnapshot) {
    if (!isProvider(agent?.provider) || typeof agent.id !== "string") return;
    // Stamp before any await so the mark is the receive time.
    const receivedAt = Date.now();
    void this.ensure(agent.id).then((a) => {
      a.provider = agent.provider;
      const sessionId = agent.persistence?.sessionId;
      if (typeof sessionId === "string" && sessionId) a.sessionId = sessionId;
      if (agent.archivedAt) {
        a.unsubscribeTimeline?.();
        a.unsubscribeTimeline = null;
        return;
      }
      // Only attach to sessions the daemon already has loaded, so observing never loads one.
      if (!a.unsubscribeTimeline && ["running", "idle", "initializing"].includes(agent.status)) {
        this.subscribeTimeline(a);
      }
      this.onUsage(a, agent.lastUsage, receivedAt);
    });
  }

  private onUsage(a: AgentLive, usage: Record<string, any> | null | undefined, receivedAt: number) {
    if (!usage) return;
    const used = typeof usage.contextWindowUsedTokens === "number" ? usage.contextWindowUsedTokens : null;
    if (used !== null) a.contextUsed = used;
    if (typeof usage.contextWindowMaxTokens === "number") a.contextMax = usage.contextWindowMaxTokens;
    // Streaming usage events carry only context fields; turn results also carry inputTokens.
    if (used === null || "inputTokens" in usage || used === a.lastStreamUsed) return;
    a.lastStreamUsed = used;
    a.usageMarks.push(receivedAt);
    if (a.usageMarks.length > MAX_MARKS) a.usageMarks.splice(0, a.usageMarks.length - MAX_MARKS);
    a.dirty = true;
  }

  /** The timeline stream is only needed for permission request/resolution timestamps. */
  private subscribeTimeline(a: AgentLive) {
    if (!this.paseo) return;
    try {
      const unsubscribe = this.paseo.agents.ref(a.agentId).timeline.subscribe((message: any) => {
        const event = message?.event;
        if (!event) return;
        if (event.type === "error") {
          a.unsubscribeTimeline = null;
          return;
        }
        const ms = Date.parse(message.timestamp);
        this.onStreamEvent(a, event, Number.isFinite(ms) ? ms : Date.now());
      });
      a.unsubscribeTimeline = () => unsubscribe();
      (unsubscribe as any).ready?.catch?.(() => {
        a.unsubscribeTimeline = null;
      });
    } catch (error) {
      console.warn("[paseo-stats] timeline subscribe failed", a.agentId, error);
    }
  }

  private onStreamEvent(a: AgentLive, event: Record<string, any>, ms: number) {
    if (event.type === "permission_requested") {
      const req = event.request ?? {};
      if (typeof req.id === "string") {
        const toolUseId = typeof req.metadata?.toolUseId === "string" ? req.metadata.toolUseId : null;
        a.pendingPermissions.set(req.id, { ms, toolUseId });
      }
    } else if (event.type === "permission_resolved") {
      const pending = a.pendingPermissions.get(event.requestId);
      a.pendingPermissions.delete(event.requestId);
      if (pending?.toolUseId) {
        a.permissionWaits[pending.toolUseId] = (a.permissionWaits[pending.toolUseId] ?? 0) + Math.max(0, ms - pending.ms);
        a.dirty = true;
      }
    }
  }

  // ---- lifecycle hooks: quota bookkeeping ----

  async onTurnStarted(agentId: string, provider: ProviderId) {
    const a = await this.ensure(agentId);
    a.provider = provider;
    if (!a.unsubscribeTimeline) this.subscribeTimeline(a);
    a.quotaPending?.abort();
    a.quotaPending = null;
    a.quotaBefore = await readQuota(provider);
    a.dirty = true;
  }

  async onTurnEnded(agentId: string, provider: ProviderId, turnId: string | null, canceled: boolean) {
    const a = await this.ensure(agentId);
    const before = a.quotaBefore;
    a.quotaBefore = null;
    a.quotaDelta = { deltas: {}, turnId };
    a.dirty = true;
    // usage-monitor refreshes on non-canceled turn ends only.
    if (canceled || !before) return;
    const endedAt = Date.now();
    const controller = new AbortController();
    a.quotaPending = controller;
    const after = await waitForQuotaAfter(provider, endedAt - 1_000, controller.signal);
    if (controller.signal.aborted || !after) return;
    a.quotaPending = null;
    const deltas: Partial<Record<QuotaKey, number | null>> = {};
    for (const w of after.windows) deltas[w.key] = windowDelta(before.windows.find((b) => b.key === w.key), w);
    a.quotaDelta = { deltas, turnId };
    a.dirty = true;
  }
}
