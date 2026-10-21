import type { ProviderId, QuotaKey, ToolCategory } from "../shared/contracts.shared";

export type Lang = "zh" | "en";

function detect(): Lang {
  try {
    const nav = (globalThis as { navigator?: { language?: string } }).navigator?.language;
    const locale = nav ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "en";
    return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

export const LANG: Lang = detect();

function parts(diff: number) {
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = abs < 3_600_000 ? Math.round(abs / 60_000) : Math.round((abs % 3_600_000) / 60_000);
  return { d, h, m, s: Math.round(abs / 1000) };
}

/** Relative time of an ISO timestamp from now, localized; "—" when unparseable. */
export function relativeTo(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? T.relative(t - Date.now()) : "—";
}

const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", grok: "Grok" };

const zh = {
  pillTitle: { usage: "用量", stats: "会话统计", tokens: "Token", files: "文件改动" },
  pillQuotaShort: { fiveHour: "5h", sevenDay: "7d" } as Record<QuotaKey, string>,
  turnsUnit: (n: string) => `${n} 轮`,
  usageTitle: "用量",
  statsTitle: "会话统计",
  tokensTitle: "Token",
  thisSession: "当前会话",
  loading: "读取中…",
  failed: (msg: string) => `读取失败：${msg}`,
  quotaTitle: { fiveHour: "5 小时额度", sevenDay: "7 天额度" } as Record<QuotaKey, string>,
  quotaUsed: (p: string, d: string) => `已用 ${p} · 本轮 ${d}`,
  resets: (clock: string, rel: string) => `${clock} 重置（${rel}）`,
  resetsUnknown: "重置时间 —",
  windowTokens: (n: string) => `本机 ${n} tok`,
  noQuota: "无额度数据（需要 usage-monitor 插件）",
  compactions: (n: string) => `上下文压缩 ${n} 次`,
  quotaAsOf: (clock: string, rel: string) => `额度数据 ${clock}（${rel}）`,
  quotaAsOfUnknown: "额度数据 —",
  heatmapFooter: (p: ProviderId) => `每日 token · 本机全部 ${PROVIDER_NAME[p]} 会话`,
  weekdays: ["一", "二", "三", "四", "五", "六", "日"],
  weekdayLong: (i: number) => `周${["一", "二", "三", "四", "五", "六", "日"][i]}`,
  month: (m: number) => `${m}月`,
  /** YYYY-MM-DD -> 9/17 */
  shortDate: (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
  less: "少",
  more: "多",
  noData: "无数据",
  colTurn: "本轮",
  colSession: "会话",
  turnsSteps: (t: string, s: string) => `${t} 轮 · ${s} 步`,
  ttft: "首 token 平均 TTFT",
  tps: "输出速度 TPS",
  modelTime: "模型用时",
  modelCalls: "模型调用次数",
  toolTime: "工具调用用时",
  toolCalls: "工具调用次数",
  apiRetries: "API 重试次数",
  category: {
    shell: "命令",
    read: "读文件",
    edit: "编辑",
    search: "搜索",
    web: "网页",
    agent: "子代理",
    mcp: "MCP",
    other: "其他",
  } as Record<ToolCategory, string>,
  chartNow: "当前",
  chartAvg: "均值",
  chartPeak: "峰值",
  chartPerCall: (n: number) => `每次模型调用 · 最近 ${n} 次`,
  chartPerTurn: (n: number) => `每轮 · 最近 ${n} 轮`,
  total: "合计",
  input: "输入（未缓存）",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  output: "输出",
  thinking: "其中思考",
  hitRate: "缓存命中率",
  invalidations: "缓存失效次数",
  costRates: "折算 API 费用（参考）",
  costProvider: (p: ProviderId) => `费用（${PROVIDER_NAME[p]} 计算）`,
  model: "模型",
  turnCost: "本轮费用",
  grokSection: "Grok 会话指标（累计）",
  itl: "token 间隔 中位/p99/最大",
  longPauses: "长停顿",
  failures: "工具失败 · 错误 · 取消 · 重生成",
  recoveries: "死循环自救 · 推理空闲超时",
  pillFiles: (n: string, a: string) => `${n} 文件 · +${a} 行`,
  filesTitle: "文件改动",
  filesChanged: "改动文件",
  linesAdded: "新增行",
  linesRemoved: "删除行",
  filesMore: (n: number) => `还有 ${n} 个文件`,
  filesNone: "本会话还没有通过文件工具改动文件",
  filesNote: "只统计写入/编辑类工具；用命令行改的文件不计",
  times: (n: string) => `${n} 次`,
  withDetail: (a: string, b: string) => `${a}（${b}）`,
  /** Relative time; diff > 0 is in the future. */
  relative: (diff: number) => {
    const { d, h, m, s } = parts(diff);
    const text = d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : m > 0 ? `${m}分钟` : `${s}秒`;
    return diff >= 0 ? `${text}后` : `${text}前`;
  },
};

const en: typeof zh = {
  pillTitle: { usage: "Usage", stats: "Session stats", tokens: "Tokens", files: "Files changed" },
  pillQuotaShort: { fiveHour: "5h", sevenDay: "7d" },
  turnsUnit: (n) => `${n} ${n === "1" ? "turn" : "turns"}`,
  usageTitle: "Usage",
  statsTitle: "Session",
  tokensTitle: "Tokens",
  thisSession: "This session",
  loading: "Loading…",
  failed: (msg) => `Failed: ${msg}`,
  quotaTitle: { fiveHour: "5-hour limit", sevenDay: "7-day limit" },
  quotaUsed: (p, d) => `${p} used · this turn ${d}`,
  resets: (clock, rel) => `resets ${clock} (${rel})`,
  resetsUnknown: "resets —",
  windowTokens: (n) => `here ${n} tok`,
  noQuota: "No quota data (needs the usage-monitor plugin)",
  compactions: (n) => `${n} compactions`,
  quotaAsOf: (clock, rel) => `quota as of ${clock} (${rel})`,
  quotaAsOfUnknown: "quota as of —",
  heatmapFooter: (p) => `Daily ${PROVIDER_NAME[p]} tokens`,
  weekdays: ["M", "T", "W", "T", "F", "S", "S"],
  weekdayLong: (i) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]!,
  month: (m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]!,
  shortDate: (key) =>
    `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`,
  less: "Less",
  more: "More",
  noData: "no data",
  colTurn: "Turn",
  colSession: "Session",
  turnsSteps: (t, s) => `${t} ${t === "1" ? "turn" : "turns"} · ${s} ${s === "1" ? "step" : "steps"}`,
  ttft: "Avg time to first token",
  tps: "Output speed",
  modelTime: "Model time",
  modelCalls: "Model calls",
  toolTime: "Tool time",
  toolCalls: "Tool calls",
  apiRetries: "API retries",
  category: {
    shell: "Shell",
    read: "Read",
    edit: "Edit",
    search: "Search",
    web: "Web",
    agent: "Subagents",
    mcp: "MCP",
    other: "Other",
  },
  chartNow: "Now",
  chartAvg: "Avg",
  chartPeak: "Peak",
  chartPerCall: (n) => `per model call · last ${n}`,
  chartPerTurn: (n) => `per turn · last ${n}`,
  total: "Total",
  input: "Input (uncached)",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  thinking: "of which thinking",
  hitRate: "Cache hit rate",
  invalidations: "Cache invalidations",
  costRates: "API cost (reference)",
  costProvider: (p) => `Cost (reported by ${PROVIDER_NAME[p]})`,
  model: "Model",
  turnCost: "This turn",
  grokSection: "Grok session counters",
  itl: "Token gap p50/p99/max",
  longPauses: "Long pauses",
  failures: "Tool fails · errors · cancels · regens",
  recoveries: "Loop recoveries · idle timeouts",
  pillFiles: (n, a) => `${n} ${n === "1" ? "file" : "files"} · +${a} ${a === "1" ? "line" : "lines"}`,
  filesTitle: "Files changed",
  filesChanged: "Files",
  linesAdded: "Lines added",
  linesRemoved: "Lines removed",
  filesMore: (n) => `${n} more`,
  filesNone: "No files changed through file tools yet",
  filesNote: "Counts write/edit tools only; shell edits are not seen",
  times: (n) => n,
  withDetail: (a, b) => `${a} (${b})`,
  relative: (diff) => {
    const { d, h, m, s } = parts(diff);
    const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
    return diff >= 0 ? `in ${text}` : `${text} ago`;
  },
};

export const T = LANG === "zh" ? zh : en;
