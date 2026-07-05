# 币安二级信号监控台

纯观察向的 Binance 信号监控台，包含四周期 MA100/MA200、综合热度排行、1 小时资金费率、OI、关注池和组合信号。首次运行会同步目标币种，然后按并发 worker、全局权重限速和断点续抓规则缓存 K 线到 MySQL。

## 启动顺序

1. 安装依赖：

```bash
npm install
```

2. 准备环境变量：

```bash
cp .env.example .env
```

3. 启动 MySQL，并执行建表：

```bash
mysql -uroot -p < schema.sql
```

4. 启动服务：

```bash
npm start
```

`npm start` 会同时启动四个独立进程：

| 端口 | 职责 |
| --- | --- |
| `8787` | 页面与公开 API |
| `8788` | 全市场抓取、关注池历史 K 线 |
| `8789` | 统一实时行情 WebSocket/SSE |
| `8790` | 资金费率、OI、热度、解锁、清理、Telegram |

页面仍统一访问 `8787`，但重任务会由 API 转发到对应内部服务端口；热度排行读取集中在 `8790`，避免 API 进程和调度进程重复抓取同一份外部数据。四个服务端口必须互不相同，配置冲突会在启动时直接报错。

默认 `API_HOST=127.0.0.1`，只允许本机访问页面与公开 API。确实需要局域网访问时再改成 `0.0.0.0`，同时设置 `API_MUTATION_TOKEN`；写入、删除、触发扫描、交易分析读取和 Codex 复盘等敏感接口只允许本机请求，或带 `X-API-Mutation-Token` 请求头访问。前端遇到受保护接口返回 403 时会提示输入 token，并保存在当前浏览器本地存储中。

内部服务默认只绑定本机。若确实要把 `SERVICE_HOST` 暴露到非本机地址，必须设置 `INTERNAL_SERVICE_TOKEN`，否则非本机请求会被拒绝。

5. 打开页面：

```text
http://localhost:8787
```

## PM2 后台常驻

当前项目已经拆成 4 个服务，不能再用 `pm2 start 二级监控` 把目录名当作启动脚本。请在项目目录执行：

```bash
cd /Users/huangkaiying/Desktop/二级监控
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条带 `sudo` 的系统命令，请继续执行它。之后即使重启电脑，PM2 也会恢复这 4 个服务。

常用维护命令：

```bash
pm2 status
pm2 logs
pm2 restart ecosystem.config.cjs
pm2 stop ecosystem.config.cjs
pm2 delete ecosystem.config.cjs
```

## 项目结构与数据库

前端入口仍是 `public/index.html`、`public/app.js` 和 `public/styles.css`，但页面逻辑已经拆到 `public/js/`：

- `public/js/api.js`：统一 API 请求和 mutation token 处理。
- `public/js/state.js`：前端共享状态。
- `public/js/constants.js`：前端常量。
- `public/js/utils/`：DOM 与格式化工具。
- `public/js/components/`：自定义选择器。
- `public/js/ui/`：跨页面复用的交易对操作按钮和复制逻辑。
- `public/js/chart/`：K 线图表与图表内 Codex 分析。
- `public/js/pages/`：均线信号、热度排行、资金费率、OI 监控、关注池、交易分析、交易总结、运行日志页面模块。
- `public/js/realtime/`：前端实时行情订阅和价格/K 线推送分发。

样式由 `public/styles.css` 汇总拆分后的 `public/styles/` 文件：`base.css`、`workbench.css`、`theme.css`、`monitoring.css`、`trade-journal.css`。

后端数据库入口仍是 `server/db.js`，具体仓库逻辑拆在 `server/db/`：连接和迁移在 `connection.js`，其余按业务分为 signal、K 线、热度、资金费率、OI、关注池、交易历史、交易总结和 Telegram 队列。运行时会自动创建数据库和迁移字段；`schema.sql` 与 `server/db/connection.js` 中的建表结构应保持一致。

后端公开 API 入口仍是 `server/index.js`，但具体路由已拆到 `server/api/`：按 health、crawler、K 线、热度、信号、关注池、资金费/OI、交易分析、交易总结和 App 深链分组，鉴权中间件在 `server/api/middleware/`。

交易分析入口是 `server/tradeAnalysis.js`，交易所读取和归一化逻辑拆到 `server/tradeAnalysis/`：`binanceProvider.js`、`hyperliquidProvider.js` 和共享工具 `shared.js`。

当前数据库共 18 张业务表：`token_list`、`kline_cache`、`kline_availability`、`signal_result`、`maintenance_state`、`hot_rank_seen`、`watchlist`、`hot_ma_signal_alert`、`multi_cycle_history`、`funding_interval_state`、`trade_event_history`、`open_interest_monitor`、`open_interest_sample`、`telegram_alert_queue`、`hot_rank_snapshot`、`token_unlock_cache`、`trade_journal`、`trade_journal_intraday_notes`。

## 核心规则

- 目标代币分两类：A 类为 Alpha + 合约 + 无现货；B 类为现货 + 合约。
- K 线周期固定为 `15m -> 1h -> 4h -> 1d`。
- 默认按 `CRAWLER_CONCURRENT_TOKENS` 并发抓取；所有 Binance 请求共享全局 `REQUEST_WEIGHT` 预算。
- K 线默认每页 `limit=499`，在 USD-M Futures `/fapi/v1/klines` 当前计权规则下属于 2 weight 档，单位权重可拿到更多 K 线。
- 遇到 `429` 会等到权重窗口恢复后重试；遇到 `418` 会按封禁退避等待，避免连续冲撞限制。
- 周期抓取和单币种完成后的暂停默认很短，主要依赖权重桶控速。
- 每个周期先检查本地缓存；已覆盖目标窗口则直接跳过，未覆盖则只补齐缺失历史段，入库使用唯一键去重。
- 程序重启后会继续处理 `pending`、`partial`、`failed`、`fetching` 状态的币种。
- 四周期独立计算 MA100/MA200，独立写入 `signal_result`。
- 数据库维护任务每 7 天自动清理一次超出保留窗口的旧 K 线，不在每次抓取时清理；PM2 运行日志默认每 4 小时清理一次。
- 实时行情统一由 realtime 服务维护 Binance Futures WebSocket，前端各页面通过 SSE 声明所需 `ticker/kline` streams；均线页面信号、关注池全部代币、资金费率页面 1 小时结算代币和 OI 各周期 Top5 会在后端合并去重。价格会轻量落库，K 线按周期节流落库且收盘必落库；crawler 负责历史覆盖、断层修复和全市场兜底追尾。
- 资金费率结算周期监控默认每小时扫描一次 Binance USDⓈ-M `fundingInfo`，并通过 `premiumIndex` 保存当前资金费率；切换为 1 小时结算会发送独立提醒，未确认时每 5 分钟重复提醒，存在一级或二级均线警报时同步纳入组合信号。
- OI 达到 `5分钟 >= 2%`、`1小时 >= 10%`、`4小时 >= 20%` 或 `1天 >= 40%` 会记录暴涨信号；有其他信号时发送组合推送，否则发送 OI 独立暴涨推送。阈值可通过 `OPEN_INTEREST_SPIKE_5M_PCT`、`OPEN_INTEREST_SPIKE_1H_PCT`、`OPEN_INTEREST_SPIKE_4H_PCT`、`OPEN_INTEREST_SPIKE_1D_PCT` 调整。
- 热度排行严格按 BSC、Base、Solana 分链，排除动态市值前 10、稳定币和 Binance 标记的代币化股票。
- 热度排行仅使用币安 Web3 热度源，不再调用推特热度接口。
- 同一代币的多个均线周期在页面合并为一行，达到 3 个周期时统一标记为“多周期信号”。
- K 线接口返回数据库实际根数、目标根数和 MA200 可用状态；新上市代币不会伪造缺失历史。
- 每天本机时间 0 点自动审计全部活跃代币的四周期 K 线，缺少历史、存在中间断层或最新数据落后时重新入队补齐。
- 新上线代币会从 Binance 实际可提供的最早 K 线开始抓取；下架代币保留 7 天，期间恢复上线会继续使用原缓存，超过 7 天才删除 K 线。

## 交易分析接入

页面新增“交易分析”模块，会读取 `.env` / `.env.local` 中的只读交易所配置，按时间窗口汇总净收益、已实现盈亏、手续费成本、资金费、当前持仓和交易流水。缺少配置时，页面会直接显示需要填写的变量名。

需要填写：

```bash
# Binance USD-M Futures：需要只读 USER_DATA 权限
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_FUTURES_BASE_URL=https://fapi.binance.com

# Hyperliquid：只需要钱包地址，查询成交和资金费
HYPERLIQUID_WALLET_ADDRESS=
HYPERLIQUID_INFO_BASE_URL=https://api.hyperliquid.xyz/info
# 可选：HIP-3 / builder-deployed perp dex，多个用英文逗号分隔，例如 xyz
HYPERLIQUID_PERP_DEXS=

TRADE_ANALYSIS_DEFAULT_LOOKBACK_DAYS=90
TRADE_ANALYSIS_EVENT_LIMIT=5000
TRADE_POSITION_PREFETCH_ENABLED=true
TRADE_POSITION_PREFETCH_MS=60000
TRADE_POSITION_PREFETCH_INITIAL_DELAY_MS=2000
TRADE_POSITION_CACHE_MS=300000
CODEX_CLI_PATH=/Applications/Codex.app/Contents/Resources/codex
TRADE_ANALYSIS_CODEX_TIMEOUT_MS=180000
TRADE_ANALYSIS_CODEX_EVENT_LIMIT=80
TOKEN_ANALYSIS_CODEX_KLINE_LIMIT=360
```

当前接口：

- `GET /api/trade-analysis?start=<ISO>&end=<ISO>&symbol=<BTCUSDT>`：返回连接状态、当前持仓、交易所汇总、币种汇总和最多 `TRADE_ANALYSIS_EVENT_LIMIT` 条费用/盈亏流水；本机或 `API_MUTATION_TOKEN` 保护。
- API 服务会按 `TRADE_POSITION_PREFETCH_MS` 在后台预抓取当前持仓；交易分析页面先展示数据库历史和后台缓存仓位，再同步最新交易流水。
- `POST /api/trade-analysis/codex`：按全部交易记录、交易组、选中币种或指定时间段生成 Codex 复盘；本机或 `API_MUTATION_TOKEN` 保护。
- `POST /api/token-analysis/codex`：按图表里的代币和周期，把 K 线、MA100/MA200、数据质量和页面上下文交给 Codex 做代币分析；本机或 `API_MUTATION_TOKEN` 保护。
- Binance 使用 USD-M Futures `/fapi/v1/income`、`/fapi/v1/userTrades`、`/fapi/v1/fundingRate` 和 `/fapi/v3/positionRisk`。
- Hyperliquid 使用 Info endpoint 的 `userFillsByTime`、`userFunding` 和 `clearinghouseState`；HIP-3 / builder-deployed perp 持仓需要在 `HYPERLIQUID_PERP_DEXS` 配置对应 dex。

## K 线保留窗口

| 周期 | 覆盖时间 | 保留根数 |
| --- | ---: | ---: |
| `15m` | 约 2 个月 | 5760 |
| `1h` | 约 6 个月 | 4392 |
| `4h` | 约 2 年 | 4380 |
| `1d` | 约 6 年 | 2190 |

这些值可在 `.env` 里通过 `KLINE_15M_LOOKBACK_DAYS`、`KLINE_15M_RETENTION_LIMIT` 等变量调整。

K 线清理频率默认每 7 天一次，可通过 `KLINE_CLEANUP_INTERVAL_DAYS` 调整；服务会每小时检查一次是否到期。

热榜快照/出现记录、已完成 Telegram 队列、OI 当前快照、非关注池解锁缓存默认保留 7 天，可通过 `HOT_RANK_RETENTION_DAYS` 和 `IO_RETENTION_DAYS` 调整。

PM2 的 `monitor-*-error.log` 和 `monitor-*-out.log` 默认每 4 小时截断一次。可通过 `RUNTIME_LOG_CLEANUP_INTERVAL_HOURS` 调整清理间隔，`RECORD_CLEANUP_INTERVAL_HOURS` 仍作为兼容回退。

全量 K 线完整性审计默认每天 0 点执行：

```bash
RECORD_CLEANUP_INTERVAL_HOURS=4
RUNTIME_LOG_CLEANUP_INTERVAL_HOURS=4
KLINE_DAILY_AUDIT_HOUR=0
INACTIVE_TOKEN_KLINE_RETENTION_DAYS=7
HOT_RANK_RETENTION_DAYS=7
IO_RETENTION_DAYS=7
```

也可以手动触发：

```text
POST /api/kline-audit
```

## 查看 crawler 和 K 线补齐进度

PM2 里的 crawler 进程名是 `monitor-crawler`。查看运行日志：

```bash
pm2 logs monitor-crawler --lines 100
```

只查看最近 100 行、不持续跟随：

```bash
pm2 logs monitor-crawler --lines 100 --nostream
```

查看当前抓取队列状态和正在处理的代币：

```bash
curl -s http://127.0.0.1:8787/api/overview | jq '.overview.totals, .overview.currentFetch, .crawler.lastAction'
```

其中 `overview.totals.pendingTokens` 表示 `token_list.fetch_status` 还没有变成 `completed` 的活跃代币数量，适合看 crawler 队列还剩多少。

快速查看最新 K 线是否追上：

```bash
curl -s http://127.0.0.1:8787/api/kline-tail-health | jq '{targetTokenCount, targetIntervalCount, tokens:(.targets | map(.symbol) | unique | .[0:20])}'
```

手动触发一轮快速追最新 K 线：

```bash
curl -X POST http://127.0.0.1:8787/api/kline-tails
```

查看完整 K 线完整性缺口：

```bash
curl -s http://127.0.0.1:8787/api/kline-health | jq '{deficientTokenCount, deficientIntervalCount, tokens:(.deficient | map(.symbol) | unique)}'
```

其中 `targetTokenCount` 适合日常判断最新行情是否落后；`deficientTokenCount` 表示仍有 K 线需要补齐的代币数量，`deficientIntervalCount` 表示这些代币合计还有多少个周期存在缺口。完整检查会扫描更多 K 线，适合排查历史中间缺口。

## 首次回填提速参数

```bash
# 同时处理多少个交易对；本机和 MySQL 正常时 4-8 都可以试
CRAWLER_CONCURRENT_TOKENS=4

# 关注池全量历史修复并发；默认跟随 CRAWLER_CONCURRENT_TOKENS，并受 MySQL 连接数和 8 的上限保护
WATCHLIST_MARKET_CONCURRENCY=4

# 每分钟最多使用多少 Binance REQUEST_WEIGHT；默认 1800，低于 USD-M Futures 常见 2400/min 上限
BINANCE_REQUEST_WEIGHT_BUDGET_PER_MINUTE=1800

# 历史补齐 K 线每页条数；499 是 2 weight 档，1000 是 5 weight 档，1500 是 10 weight 档
KLINE_REQUEST_LIMIT=499

# 普通增量补最新 K 线每页条数；50 是 1 weight 档，适合每轮只补少量 K 线
KLINE_INCREMENTAL_REQUEST_LIMIT=50

# 每轮增量开始前先快速补最新尾部 K 线，避免历史补洞挡住最新行情
KLINE_TAIL_REFRESH_ENABLED=true
KLINE_TAIL_REFRESH_LIMIT=2500
KLINE_TAIL_REFRESH_REQUEST_LIMIT=20

# OI 当前值会全量采样；历史补齐接口官方限制为 1000 requests/5min/IP，按该预算分轮补齐基线
OPEN_INTEREST_SCAN_MS=180000
OPEN_INTEREST_REQUEST_LIMIT_PER_5M=900

# 资金费率待提醒发送并发；默认 2，并受 Telegram 风险、scheduler MySQL 连接数和 3 的上限保护
FUNDING_ALERT_CONCURRENCY=2

# 关注池解锁日期刷新并发；默认 2，并受 scheduler MySQL 连接数和 5 的上限保护
TOKEN_UNLOCK_CONCURRENCY=2

# 交易分析里 Binance fundingRate 补充查询并发；仅用于资金费率展示增强，默认 3，上限 5
TRADE_ANALYSIS_FUNDING_RATE_CONCURRENCY=3

# 单个 USD-M Futures WebSocket 连接最多 1024 streams；每个实时币约 5 个 streams
REALTIME_STREAM_LIMIT=900
REALTIME_KLINE_TOKEN_LIMIT=180

# 数据库连接池；建议至少比并发 worker 多 2-4
MYSQL_CONNECTION_LIMIT=8

# 多久没有更新的 fetching 会被视为上次中断并重新排队
STALE_FETCHING_AFTER_MS=300000
```

## Telegram 警报

`.env` 中配置：

```bash
TELEGRAM_ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=你的bot token
TELEGRAM_CHAT_ID=你的chat id
```

一级、二级均线警报都不单独发送。Telegram 推送带一级或二级均线警报的资金费率、OI 暴涨、热度、多周期组合；OI 暴涨没有组合信号时发送独立暴涨推送；资金费率 1 小时结算另有独立确认提醒。推特搜索和币安广场以正文链接紧跟代币名，键盘提供“复制代币”和主要菜单导航。Bot 导航包含均线排行、多周期、热度排行、资金费率、OI 和关注池。

Telegram 请求默认重试 4 次，并对超时、TLS 断连、`429` 和 `5xx` 做指数退避。Bot 回调会先立即确认按钮，再执行查询。
菜单查询默认缓存 30 秒，并在后台定时预热；缓存过期时会先返回最近一次结果再刷新，避免均线和 OI 按钮反复触发全量聚合。

```bash
TELEGRAM_MENU_CACHE_MS=30000
TELEGRAM_MENU_STALE_MS=300000
TELEGRAM_MENU_WARM_INTERVAL_MS=60000
```

资金费率结算周期提醒也复用同一套 Telegram 配置。相关参数：

```bash
# 是否启用资金费率结算周期监控
FUNDING_INTERVAL_MONITOR_ENABLED=true

# 默认每 5 分钟扫描一次
FUNDING_INTERVAL_SCAN_MS=300000

# 待确认提醒轮询间隔；真正重复发送时间由上次发送后 5 分钟控制
FUNDING_INTERVAL_ALERT_POLL_MS=60000

# 首次启动延迟，给数据库和服务预热
FUNDING_INTERVAL_INITIAL_DELAY_MS=10000

# 目标结算周期：1 表示发现变成 1 小时结算就提醒
FUNDING_INTERVAL_TARGET_HOURS=1

# Binance fundingInfo 只返回发生调整的合约；不再出现在快照里时按默认周期回写
FUNDING_INTERVAL_DEFAULT_HOURS=4

# 关注池价格提醒冷却；价格在阈值附近反复穿越时避免刷屏，设为 0 可关闭
WATCHLIST_ALERT_COOLDOWN_MS=600000
```

关注池下次解锁日期默认先通过 Binance Alpha 核对项目身份，再读取已核验的项目官方
X/代币经济学资料。明确的 cliff 或领取节点显示日期；只有线性释放区间、但官方未公布
精确批次日期时，显示“官方未公布精确日期”。

```bash
TOKEN_UNLOCK_PROVIDER=official
```

也可切换到 Mobula metadata：

```bash
TOKEN_UNLOCK_PROVIDER=mobula
MOBULA_API_KEY=你的API密钥
```

系统不会根据非官方讨论生成猜测日期。

## 接口

- `GET /api/health`：数据库及四个服务状态。
- `POST /api/bootstrap`：同步目标币种并启动抓取。
- `POST /api/crawl/start`：启动抓取。
- `POST /api/crawl/stop`：暂停抓取。
- `POST /api/kline-audit`：立即盘点全部活跃代币并把缺失 K 线重新入队。
- `POST /api/kline-tails`：手动触发一轮最新尾部 K 线补齐。
- `GET /api/kline-health`：完整 K 线完整性检查。
- `GET /api/kline-tail-health`：最新尾部 K 线追赶状态。
- `POST /api/funding-interval/check`：手动触发一次资金费率结算周期扫描。
- `POST /api/open-interest/check`：手动触发一次 OI 扫描。
- `GET /api/overview`：统计、分类缓存、当前抓取进度。
- `GET /api/signals?category=A`：旧版 A/B 分类信号列表。
- `GET /api/signals?categories=A,B&levels=LEVEL1,LEVEL2&intervals=15m,1h,4h,1d&page=1&pageSize=20`：页面使用的分页组合信号列表。
- `GET /api/hot-ma-signals`：Telegram/接口用的热门均线信号分页。
- `GET /api/multi-history`：多周期历史记录。
- `GET /api/klines`：读取某个交易对某周期的数据库 K 线，必要时会请求 crawler 补齐。
- `GET /api/hot-rank`：综合热度排行。
- `GET /api/funding-rate-tokens`：当前 1 小时资金费率代币及关联信号。
- `GET /api/oi-monitoring`、`GET /api/io-monitoring`：按 `5m/15m/1h/4h/1d`、分页和升降序查看 OI；后者保留兼容。
- `GET /api/watchlist`：关注池列表。
- `GET /api/watchlist/events`：关注池实时事件流。
- `POST /api/watchlist`：新增或更新关注项；本机或 `API_MUTATION_TOKEN` 保护。
- `DELETE /api/watchlist/:symbol`：删除关注项；本机或 `API_MUTATION_TOKEN` 保护。
- `POST /api/watchlist/unlock/refresh`：刷新关注池解锁日期；本机或 `API_MUTATION_TOKEN` 保护。
- `GET /api/trade-analysis`：交易分析快照或同步结果；本机或 `API_MUTATION_TOKEN` 保护。
- `POST /api/trade-analysis/codex`：生成交易复盘；本机或 `API_MUTATION_TOKEN` 保护。
- `POST /api/token-analysis/codex`：生成图表代币分析；本机或 `API_MUTATION_TOKEN` 保护。
- `GET /api/trade-journal`、`GET /api/trade-journal/:id`：读取交易总结；本机或 `API_MUTATION_TOKEN` 保护。
- `POST /api/trade-journal`、`PUT /api/trade-journal/:id`、`POST /api/trade-journal/:id/intraday-notes`、`DELETE /api/trade-journal/:id`：写入交易总结；本机或 `API_MUTATION_TOKEN` 保护。
- `GET /api/runtime-logs`：读取 PM2 和服务运行日志；本机或 `API_MUTATION_TOKEN` 保护。
- `DELETE /api/runtime-logs`：清理运行日志；本机或 `API_MUTATION_TOKEN` 保护。
- `GET /api/watchlist/:symbol/unlock`：关注代币解锁缓存。
- `GET /open/binance`、`GET /open/tradingview`：移动端 App 深链跳转页。
