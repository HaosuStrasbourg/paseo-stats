import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { isProvider, readPills, type PillData } from "../shared/contracts.shared";
import { DASH, est, fmtPercent, fmtTokens, fmtUsd } from "../shared/format.shared";
import { T } from "./i18n.client";
import { FilesCardContent, StatsCardContent, TokenCardContent, UsageCardContent } from "./cards.client";
import { Ring } from "./meter.client";

// Latest pill data per agent, read by the ring icon (the label is published through the
// registration because the host renders it as plain text).
const pillData = new Map<string, PillData>();
const listeners = new Set<() => void>();

function publish(pills: PillData[]) {
  for (const p of pills) pillData.set(p.agentId, p);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function UsageRingIcon(props: PluginButtonIconProps) {
  const agentId = props.context === "agent" ? props.agentId : null;
  const percent = useSyncExternalStore(subscribe, () =>
    agentId ? (pillData.get(agentId)?.quotas[0]?.percent ?? null) : null,
  );
  return <Ring percent={percent} size={props.size} theme={props.theme} />;
}

function labels(p: PillData | undefined): [string, string, string, string] {
  // The host truncates labels at roughly 8 CJK characters' width, so keep them terse.
  const live = p?.tpsLive;
  const quotas =
    p && p.quotas.length > 0
      ? p.quotas.map((q) => `${T.pillQuotaShort[q.key]} ${fmtPercent(q.percent)}`).join(" · ")
      : p?.provider === "grok"
        ? `${T.pillQuotaShort.sevenDay} ${DASH}`
        : `5h ${DASH} · 7d ${DASH}`;
  // Claude's cost is priced from a rate table (estimate); Grok reports its own.
  const cost = p?.provider === "grok" ? fmtUsd(p.costUsd) : est(fmtUsd(p?.costUsd));
  return [
    quotas,
    `${live === null || live === undefined ? DASH : `~${Math.round(live)}`} tok/s · ${T.turnsUnit(String(p?.turns ?? DASH))}`,
    `${fmtTokens(p?.totalTokens)} tok · ${cost}`,
    T.pillFiles(String(p?.files?.files ?? DASH), p?.files ? fmtTokens(p.files.added) : DASH),
  ];
}

interface TrackedAgent {
  workspaceId: string;
  status: string;
}

interface Registration {
  workspaceId: string;
  handles: PluginButtonRegistration[];
  labels: string[];
}

type AgentSnapshot = { id: string; provider?: string; workspaceId?: string | null; status?: string; archivedAt?: string | null };

export function contributePills(client: PluginClientContext): () => void {
  const tracked = new Map<string, TrackedAgent>();
  const registrations = new Map<string, Registration>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const followUps = new Set<ReturnType<typeof setTimeout>>();

  function sync() {
    for (const [agentId, reg] of registrations) {
      const t = tracked.get(agentId);
      if (!t || t.workspaceId !== reg.workspaceId || reg.handles.length !== labels(undefined).length) {
        for (const h of reg.handles) h.remove();
        registrations.delete(agentId);
      }
    }
    for (const [agentId, t] of tracked) {
      const current = labels(pillData.get(agentId));
      const reg = registrations.get(agentId);
      if (reg) {
        current.forEach((label, i) => {
          if (reg.labels[i] !== label) {
            reg.handles[i]!.update({ label });
            reg.labels[i] = label;
          }
        });
        continue;
      }
      const base = { workspaceId: t.workspaceId, agentId };
      const handles = [
        client.addComposerPill({
          ...base,
          id: "usage",
          button: { title: T.pillTitle.usage, label: current[0], icon: UsageRingIcon, behavior: { kind: "popover", Content: UsageCardContent } },
        }),
        client.addComposerPill({
          ...base,
          id: "stats",
          button: { title: T.pillTitle.stats, label: current[1], icon: "Activity", behavior: { kind: "popover", Content: StatsCardContent } },
        }),
        client.addComposerPill({
          ...base,
          id: "tokens",
          button: { title: T.pillTitle.tokens, label: current[2], icon: "Database", behavior: { kind: "popover", Content: TokenCardContent } },
        }),
        client.addComposerPill({
          ...base,
          id: "files",
          button: { title: T.pillTitle.files, label: current[3], icon: "FilePen", behavior: { kind: "popover", Content: FilesCardContent } },
        }),
      ];
      registrations.set(agentId, { workspaceId: t.workspaceId, handles, labels: [...current] });
    }
  }

  async function refresh() {
    const agentIds = [...tracked.keys()];
    if (agentIds.length > 0) {
      const { pills } = await client.rpc(readPills, { agentIds });
      if (stopped) return;
      publish(pills);
    }
    sync();
  }

  function refreshSoon(delayMs: number) {
    const t = setTimeout(() => {
      followUps.delete(t);
      refresh().catch(() => undefined);
    }, delayMs);
    followUps.add(t);
  }

  function track(agent: AgentSnapshot): boolean {
    if (!isProvider(agent.provider) || agent.archivedAt || !agent.workspaceId) {
      return tracked.delete(agent.id);
    }
    const prev = tracked.get(agent.id);
    const status = agent.status ?? "";
    tracked.set(agent.id, { workspaceId: agent.workspaceId, status });
    if (prev && prev.status === "running" && status !== "running") {
      // Turn ended: transcript is final now; the quota reading lands a little later.
      refreshSoon(1_500);
      refreshSoon(15_000);
      refreshSoon(45_000);
    }
    return !prev || prev.workspaceId !== agent.workspaceId;
  }

  function onUpdate(update: { kind?: string; agentId?: string; agent?: AgentSnapshot }) {
    if (update.kind === "remove" && update.agentId) {
      if (tracked.delete(update.agentId)) sync();
      return;
    }
    if (update.agent && track(update.agent)) refresh().catch(() => sync());
  }

  const lifetime = new AbortController();
  let release: (() => void) | undefined;
  const paseo = client.paseo as any;
  if (typeof paseo.observeEvents === "function") {
    paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then((directory: any) => {
        const handle = directory.subscription;
        if (stopped) return void handle?.release?.().catch(() => undefined);
        release = () => void handle?.release?.().catch(() => undefined);
        for (const e of directory.entries ?? []) track(e.agent);
        refresh().catch(() => sync());
        handle?.subscribe({
          snapshot(snapshot: any) {
            const present = new Set((snapshot.entries ?? []).map((e: any) => e.agent.id));
            for (const id of tracked.keys()) if (!present.has(id)) tracked.delete(id);
            for (const e of snapshot.entries ?? []) track(e.agent);
            refresh().catch(() => sync());
          },
          update(message: any) {
            if (message?.type === "agent_update") onUpdate(message.payload);
          },
        });
      })
      .catch((error: unknown) => console.warn("[paseo-stats] agent observation failed", error));
  } else {
    release = paseo.agents.subscribe(onUpdate);
    paseo.agents
      .list()
      .then((directory: any) => {
        for (const e of directory.entries ?? []) track(e.agent);
        return refresh();
      })
      .catch(() => undefined);
  }

  // Poll faster while any tracked agent is mid-turn.
  function schedule() {
    const running = [...tracked.values()].some((t) => t.status === "running");
    timer = setTimeout(() => {
      refresh()
        .catch(() => undefined)
        .finally(() => {
          if (!stopped) schedule();
        });
    }, running ? 5_000 : 30_000);
  }
  schedule();

  return () => {
    stopped = true;
    lifetime.abort();
    if (timer) clearTimeout(timer);
    for (const t of followUps) clearTimeout(t);
    release?.();
    for (const reg of registrations.values()) for (const h of reg.handles) h.remove();
    registrations.clear();
  };
}
