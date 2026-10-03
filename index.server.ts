import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isProvider, readDetail, readHeatmap, readPills } from "./shared/contracts.shared.ts";
import { DailyStore } from "./server/daily.server.ts";
import { LiveTracker } from "./server/live.server.ts";
import { StatsService } from "./server/service.server.ts";

export default function contribute(server: PluginServerContext) {
  const live = new LiveTracker();
  const daily = new DailyStore();
  const service = new StatsService(live, daily);

  const refreshDaily = () =>
    void daily.update().catch((error) => console.warn("[paseo-stats] daily update failed", error));
  refreshDaily();
  // Keeps "today" rolling over even when no turn ends.
  const hourly = setInterval(refreshDaily, 60 * 60_000);

  let lastPillAgents = "";
  server.handle(readPills, (input, context) => {
    live.start(context.paseo);
    const key = [...input.agentIds].sort().join(",");
    if (key !== lastPillAgents) {
      lastPillAgents = key;
      console.log(`[paseo-stats] pills requested for ${input.agentIds.length} agent(s)`);
    }
    return service.pills(input.agentIds).then((pills) => ({ pills }));
  });
  server.handle(readDetail, (input, context) => {
    live.start(context.paseo);
    return service.detail(input.agentId);
  });
  server.handle(readHeatmap, (input) => service.heatmap(input.provider));

  const offStarted = server.on("agent.turn_started", (event, context) => {
    live.start(context.paseo);
    const provider = event.agent.provider;
    if (!isProvider(provider)) return;
    void live.onTurnStarted(event.agent.id, provider);
  });
  const offEnded = server.on("agent.turn_ended", (event, context) => {
    live.start(context.paseo);
    const provider = event.agent.provider;
    if (!isProvider(provider)) return;
    // Not awaited: waiting for usage-monitor's quota reading can take a while.
    void live.onTurnEnded(event.agent.id, provider, event.turnId, event.outcome.kind === "canceled");
    refreshDaily();
  });

  return () => {
    clearInterval(hourly);
    offStarted();
    offEnded();
    return live.stop();
  };
}
