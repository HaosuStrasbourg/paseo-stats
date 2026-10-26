# paseo-stats

一个 [Paseo](https://paseo.sh) 插件：在每个 Claude Code、Grok 和 Codex 会话的输入框上方显示四个统计胶囊，点开是详情卡片。读取本地会话和额度文件，将自己的派生状态保存在本地，不发任何网络请求。

[English](README.md)

![胶囊和卡片](images/preview.zh-CN.png)

## 显示什么

| 胶囊 | 卡片 |
|---|---|
| `5h 47% · 7d 28%`，圆环表示第一个额度窗口 | **用量**：每日 token 热力图（最近 16 周）、额度进度条、重置时间、上一轮消耗的额度、本机在各窗口内用掉的 token、上下文压缩次数、额度数据时间 |
| `~145 tok/s · 20 轮`（最近一次调用的速度） | **会话统计**：每次调用的输出速度曲线（当前 / 均值 / 峰值）、首 token 时间、模型用时、按类型拆分的工具用时、模型调用次数、API 重试次数，分"本轮"和"会话"两列 |
| `114M tok · ~$40.18` | **Token**：合计、输入（未缓存）、缓存读 / 写、输出、思考占比、缓存命中率、缓存失效次数、会话和本轮费用、模型。Grok 会话另有输出流畅度和稳定性指标 |
| `19 文件 · +3.3K 行` | **文件改动**：通过文件工具写入或编辑的文件数、新增 / 删除行数（本轮和会话），按改动量列出文件 |

带 `~` 的是估算值。测不到的显示 `—`，该行不隐藏。界面语言跟随应用语言：`zh*` 显示中文，其他显示英文。

## 支持的 agent

| Agent | 会话数据 | 额度 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/<会话>.jsonl`（支持 `CLAUDE_CONFIG_DIR`，可配多个目录） | 5 小时和 7 天窗口，经 usage-monitor |
| Grok CLI（Grok Build） | `~/.grok/sessions/<目录>/<会话>/` 下的 `usage.json`、`events.jsonl`、`signals.json`、`updates.jsonl`（支持 `GROK_HOME`） | SuperGrok 每周额度池，经 usage-monitor |
| Codex | `~/.codex/sessions/**/*.jsonl`（支持 `CODEX_HOME`） | 本地 `token_count.rate_limits` 快照，按窗口时长识别 5 小时 / 7 天额度 |

Paseo 的实时事件补充日志里没有的信息：Claude 每次调用开始吐字的时刻（用于速度和首 token 时间）、等待批准的时间、上下文用量。

## 安装

Paseo daemon 和应用均需 0.9 及以上。此前已在 daemon 0.10.1、应用 0.9.1 上验证。

分别检查 `paseo --version`、`paseo status` 和实际连接的应用版本。CLI 版本不能单独证明正在运行的 daemon 或应用版本。

### 首次安装前

Paseo 0.11.2 默认关闭插件系统。`pluginsEnabled` 未设置或为 false 时，仅安装插件不能让插件运行。开启插件系统和安装插件都会修改 `$PASEO_HOME/config.json`（默认是 `~/.paseo/config.json`）；先确认这些变更并备份配置。插件以受信任代码运行，不受沙箱隔离。

使用默认 Paseo 目录时，经确认后执行：

```sh
cp -p ~/.paseo/config.json ~/.paseo/config.json.pre-plugins-$(date +%Y%m%d-%H%M%S).bak
paseo daemon config set pluginsEnabled true
```

若使用自定义 Paseo 目录，备份和所有 Paseo 命令必须选中同一个目录。0.11.2 的 `config set` 会保存配置并重新加载可连接的 daemon；若报告配置未应用，先解决 daemon 连接问题再继续。PID 隔离的沙箱可能误报 daemon 为 `stopped`，应先在宿主只读复查状态，不要据此启动第二个 daemon。

### 安装与验收

```sh
paseo plugin install https://github.com/HaosuStrasbourg/paseo-stats
# 或从本地目录安装
paseo plugin install /path/to/paseo-stats
```

插件系统已开启时，不用重启 daemon，应用重新加载插件后胶囊就会出现。

```sh
paseo plugin ls paseo-stats
paseo plugin logs paseo-stats
```

预期状态为 `running`。然后让应用重新加载插件，打开一个属于工作区、未归档的 Claude Code、Grok 或 Codex 会话。服务端日志应出现 `pills requested for … agent(s)`。该日志需要客户端实际发起请求；仅安装成功或状态为 `running` 不会产生它。最后在实际应用里确认四个胶囊及卡片，日志不能证明界面效果。

回退首次安装：执行 `paseo plugin remove paseo-stats`。如果插件总开关原先未设置，且没有其他插件依赖它，再执行 `paseo daemon config unset pluginsEnabled`；原值为 false 则恢复 false。本地源码目录会保留。需要保留热力图和实时历史时，不要删除 `$PASEO_HOME/paseo-stats/`。恢复整份配置备份前，先确认备份后没有其他配置变更。

2026-10-21 新机器验证记录：Linux、Node 26.8.2 下，从 GitHub 克隆提交 `7107b25`、`npm ci`、`npm run typecheck` 均通过；运行中的 daemon 和附带 Web App 均为 0.11.2。经批准并备份配置后，已开启插件系统、本地安装成功，状态为 `running`；Codex 更新后重新加载仍为 `running`，日志已出现 `pills requested`，现有 Paseo Codex 会话也已通过服务汇总核对；实际应用界面仍未验证。沙箱 DNS 最初阻止 GitHub/npm 访问，经批准使用宿主网络后成功。

### 额度（可选）

额度数据读自 [usage-monitor](https://github.com/ABorakati/paseo-usage-monitor) 插件的缓存（`$PASEO_HOME/usage-limits/last-readings.json`），本插件只读这个文件。没装 usage-monitor 时，Claude/Grok 的额度一栏显示"无额度数据"，其他功能不受影响。Codex 直接读取自己的本地会话额度快照，不依赖 usage-monitor；快照仅在 Codex 写入新读数时更新。

插件按 `preset` 在 `$PASEO_HOME/usage-limits.json` 里找条目，条目叫什么名字都可以。Claude 用默认的 `claude` 预设即可。

Grok 默认的 `grok` 预设请求的是旧的月度接口（订阅用户返回 0），也读不了 Grok CLI 1.0 以上的凭据格式。需要在 `usage-limits.json` 里覆盖：

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
      "path": "[\"<auth.json 里的授权范围键名>\"].key",
      "expiresAtPath": "[\"<auth.json 里的授权范围键名>\"].expires_at",
      "refreshedBy": "grok"
    }]
  }
}
```

授权范围键名是 `~/.grok/auth.json` 的顶层键（形如 `https://auth.x.ai::…`）。用量为 0% 时 Grok 不返回 `creditUsagePercent`，本插件在确认处于有效周期时按 0% 显示。

### 在 Paseo 里运行 Grok

Grok CLI 支持 ACP 协议。在 `$PASEO_HOME/config.json` 里加一个自定义 provider，然后执行 `paseo reload`：

```json
"agents": {
  "providers": {
    "grok": { "extends": "acp", "label": "Grok", "command": ["/home/you/.grok/bin/grok", "agent", "stdio"] }
  }
}
```

## Codex 支持（0.2.0-beta.1）

使用 Paseo 自带的 `codex` provider 和已持久化的 Codex thread ID。本插件不需要新增 provider 配置，也不读取凭据。

- **Token 和请求数**：优先读取 `token_usage_record.usage`，按 `response_id` 去重，包含压缩请求。`input_tokens` 包含缓存读写，`reasoning_output_tokens` 已含在输出中。旧版 `token_count` 快照作为兜底，重复读数不累加；旧快照无法证明请求数，显示 `—`。
- **轮次和 TTFT**：按 `task_started` / `turn_id` 划分轮次；TTFT 使用 `task_complete.time_to_first_token_ms`，会话值按已完成轮次平均。Codex 是每轮首 token 时间，与 Claude 的每次调用口径不同。
- **额度**：只读本地快照。`primary` 也可能是周窗口，因此按 300 / 10080 分钟识别标签。0% 保留为 0%，不支持的窗口不显示。卡片显示读数时间，插件不主动请求额度。
- **文件**：仅统计成功的结构化 `item_completed.FileChange`。新建文件按正文行数、更新按 unified diff 的 hunk 计数，删除需有原始内容。缺少可靠证据时显示 `—`，不冒充零改动。
- **历史**：排除 fork 子代理中 `subagent_history_start_ordinal` 之前复制的父会话历史；热力图和额度窗口合计跨文件按 response ID 去重。
- **暂不可测**：输出速度及曲线、模型/工具耗时、工具次数、重试、费用和缓存失效显示 `—`（曲线显示无数据）。缺少缓存写入字段时同样显示 `—`。不把日志写入时间当成流式输出时间。

已用 4 份本机历史 Codex 日志、10 项合成解析/服务整合/回归检查、统计 CLI 和现有 Paseo Codex 会话核对兼容性；类型检查和宿主插件重载通过。

2026-10-26，独立测试页使用合成会话连接真实客户端组件与真实服务端，完成正常数据、缺失数据两种状态的中英文截图。Token/文件数值、未知值、热力图选择、明细单行和卡片高度（最高 335px）通过测试页检查及截图复核。临时 Playwright 配套 Chromium 在执行沙箱内启动被阻止，经批准改在宿主运行。实际 Paseo 界面、窄屏布局和 `FilePen` 显示仍未验证；此版本为 beta，尚未达到 Claude/Grok 的全部指标覆盖。另发现已有倒计时取整问题（显示“1小时60分”），保留为后续修复项。

## 指标口径

- **轮数**：真实的用户消息（不含工具结果、斜杠命令回显、中断标记）。**步数**：模型调用次数，按 `message.id` 去重（Claude 每个内容块写一条记录）。
- **总 token**：未缓存输入 + 缓存读 + 缓存写 + 输出。Grok 的输入包含缓存，先扣掉。**缓存命中率**：缓存读 ÷（未缓存输入 + 缓存读 + 缓存写）。
- **缓存失效**（Claude）：上一次调用留下的缓存 ≥ 1 万 token，本次读到的不足一半、重新写入不少于一半。压缩后的第一次调用不算。Grok 没有单次调用的缓存数据，显示 `—`。
- **输出速度**（Claude，按调用）：输出 token ÷（最后一个内容块写入 − 开始吐字）。开始时刻取请求发出后收到的第一次实时用量更新；没收到或来得太晚（Paseo 有时会在调用结束时一次性推送全部事件）就用请求发出时刻，这样只会低估。不足 200 毫秒或超过 1,000 tok/s 的调用不计。
- **输出速度**（Grok，按轮）：Grok 只按轮记录输出 token，速度 = 本轮输出 ÷ 流式输出时长（每次调用从首 token 到结束，含推理阶段）。流式时长不足 200 毫秒或超过 2,000 tok/s 的轮不计。
- **首 token 时间**：Claude 是请求发出 → 开始吐字（只有插件运行期间有数据，之前的历史显示 `—`）；Grok 是开始等待模型 → 首 token，取自 `events.jsonl`。
- **模型用时**（Claude）：每次调用从上一个事件到最后一个内容块，剔除 API 重试前失败尝试耗费的时间。Grok 按 `events.jsonl` 逐次计算。
- **工具用时**：工具开始 → 返回结果，扣除等待批准的时间。Grok 的 `duration_ms` 本身已不含等待。
- **费用**：Claude 按 usage-monitor 本地缓存的 LiteLLM 价格表折算，仅供参考（压缩那次调用不在会话记录里，不计入）。Grok 用 `usage.json` 里它自己算的值。
- **上一轮消耗的额度**：本轮结束后的读数 − 本轮开始时的读数。窗口重置过、或 90 秒内没等到新读数时显示 `—`。
- **额度窗口内的 token**：本机该 agent 所有会话在"重置时间 − 窗口长度"之后的 token，去重后合计。
- **文件改动**：只算执行成功的写入、编辑类工具。Claude 数结构化差异里的 `+` / `-` 行（新建文件按全部行数计）；Grok 比较每次修改前后的文本。同一文件按路径只算一个。
- **热力图**：按本机时区分天，在有数据的天里按排名分 5 档。每日合计存在 `$PASEO_HOME/paseo-stats/daily.json`，只增不减，Claude Code 30 天后删除会话记录也不受影响。

## 隐私与请求频率

本插件读取本地会话、额度文件和 Paseo 本地事件流，不修改这些源数据；仅在 `$PASEO_HOME/paseo-stats/` 写入自己的派生状态，不向任何地方发送数据。额度由 usage-monitor 获取：每轮结束时每个 provider 请求一次，缓存 30 分钟，遇到 HTTP 429 会自动退避。

## 已知限制

- 只统计本机。额度按账号计算，其他设备上的用量不会出现在"本机"的 token 数里。
- 用命令行改的文件（`sed`、脚本、重定向）和子代理的改动，不计入文件改动。
- 依赖 usage-monitor、Paseo（`agents/*.json`，仅作兜底）和 Grok CLI 的内部文件格式，它们升级时可能变化。
- 实时数据（开始吐字时刻、首 token 时间、批准等待）只有插件运行期间才有。
- 屏幕很窄时，输入框上方可能放不下四个胶囊。

## 开发

```sh
npm ci               # 按 lockfile 安装开发依赖，仅用于类型检查
npm run typecheck
npm test             # Codex 合成测试、服务整合及回归检查，不含私人数据
npm run stats -- <claude-会话ID>   # 打印会话记录统计和每日合计
npm run stats -- codex <codex-thread-id> # Codex 会话统计和每日合计
```

目录重新同步导致 `node_modules` 丢失后，先重新运行 `npm ci`。类型检查使用 `npm run typecheck`，不要用 `npx tsc`：TypeScript 缺失时，后者可能下载无关的同名 `tsc` 包。

插件状态存放在 `$PASEO_HOME/paseo-stats/`（`daily.json`、`live/<agent>.json`）。

## 许可证

MIT
