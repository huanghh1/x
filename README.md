# 币安二级信号监控台

纯观察向的 Binance 信号监控台，包含四周期 MA100/MA200、综合热度排行、1 小时资金费率、OI、关注池、触发历史和组合信号。首次运行会同步目标币种，然后按并发 worker、全局权重限速和断点续抓规则缓存 K 线到 MySQL。

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
| `8789` | 关注池实时 WebSocket |
| `8790` | 资金费率、OI、热度、解锁、清理、Telegram |

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

## 核心规则

- 目标代币分两类：A 类为 Alpha + 合约 + 无现货；B 类为现货 + 合约。
- K 线周期固定为 `15m -> 1h -> 4h -> 1d`。
- 默认 1 个币种并发抓取，可通过环境变量调整；所有 Binance 请求共享全局 `REQUEST_WEIGHT` 预算。
- K 线默认每页 `limit=499`，在 USD-M Futures `/fapi/v1/klines` 当前计权规则下属于 2 weight 档，单位权重可拿到更多 K 线。
- 遇到 `429` 会等到权重窗口恢复后重试；遇到 `418` 会按封禁退避等待，避免连续冲撞限制。
- 周期抓取和单币种完成后的暂停默认很短，主要依赖权重桶控速。
- 每个周期先检查本地缓存；已覆盖目标窗口则直接跳过，未覆盖则只补齐缺失历史段，入库使用唯一键去重。
- 程序重启后会继续处理 `pending`、`partial`、`failed`、`fetching` 状态的币种。
- 四周期独立计算 MA100/MA200，独立写入 `signal_result`。
- 数据库维护任务每 7 天自动清理一次超出保留窗口的旧 K 线，不在每次抓取时清理。
- 关注池会单独开启 Binance Futures WebSocket 实时层，订阅关注代币的价格和四周期 K 线；价格会轻量落库，K 线按周期节流落库且收盘必落库，全市场均线扫描仍按原规则运行。
- 资金费率结算周期监控默认每小时扫描一次 Binance USDⓈ-M `fundingInfo`，并通过 `premiumIndex` 保存当前资金费率；只有同时存在一级或二级均线警报时才发送组合提醒。
- OI 只有达到 `5分钟 >= 5%` 或 `1小时 >= 10%` 才接入均线组合；阈值可通过 `OPEN_INTEREST_SPIKE_5M_PCT`、`OPEN_INTEREST_SPIKE_1H_PCT` 调整。
- 热度排行严格按 BSC、Base、Solana 分链，排除动态市值前 10、稳定币和 Binance 标记的代币化股票。
- 推特热度使用 token 轮换池与受控后台队列；额度耗尽会轮换 token，供应商全局限频时短暂退避并自动重试，不再把所有 token 一次性标记为长时间冷却。
- 同一代币的多个均线周期在页面合并为一行，达到 3 个周期时统一标记为“多周期信号”。
- 触发历史记录一级均线、热度、资金费率、OI 和复合信号，不记录普通二级预警。
- K 线接口返回数据库实际根数、目标根数和 MA200 可用状态；新上市代币不会伪造缺失历史。
- 每天本机时间 0 点自动审计全部活跃代币的四周期 K 线，缺少历史、存在中间断层或最新数据落后时重新入队补齐。
- 新上线代币会从 Binance 实际可提供的最早 K 线开始抓取；下架代币保留 7 天，期间恢复上线会继续使用原缓存，超过 7 天才删除 K 线。

## K 线保留窗口

| 周期 | 覆盖时间 | 保留根数 |
| --- | ---: | ---: |
| `15m` | 约 2 个月 | 5760 |
| `1h` | 约 6 个月 | 4392 |
| `4h` | 约 2 年 | 4380 |
| `1d` | 约 6 年 | 2190 |

这些值可在 `.env` 里通过 `KLINE_15M_LOOKBACK_DAYS`、`KLINE_15M_RETENTION_LIMIT` 等变量调整。

清理频率默认每 7 天一次，可通过 `KLINE_CLEANUP_INTERVAL_DAYS` 调整；服务会每小时检查一次是否到期。

全量 K 线完整性审计默认每天 0 点执行：

```bash
KLINE_DAILY_AUDIT_HOUR=0
INACTIVE_TOKEN_KLINE_RETENTION_DAYS=7
```

也可以手动触发：

```text
POST /api/kline-audit
```

## 首次回填提速参数

```bash
# 同时处理多少个交易对；本机和 MySQL 正常时 4-8 都可以试
CRAWLER_CONCURRENT_TOKENS=4

# 每分钟最多使用多少 Binance REQUEST_WEIGHT；默认 900，偏保守
BINANCE_REQUEST_WEIGHT_BUDGET_PER_MINUTE=900

# K 线每页条数；499 是 2 weight 档，1000 是 5 weight 档，1500 是 10 weight 档
KLINE_REQUEST_LIMIT=499

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

一级、二级均线警报都不单独发送。Telegram 只推送带一级或二级均线警报的资金费率、OI 暴涨、热度、多周期组合；推特和币安广场以正文链接紧跟代币名，键盘只保留“复制代币”按钮。Bot 导航包含均线排行、热度排行、资金费率、OI 和关注池，不包含触发记录。

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

# 默认每小时扫描一次
FUNDING_INTERVAL_SCAN_MS=3600000

# 首次启动延迟，给数据库和服务预热
FUNDING_INTERVAL_INITIAL_DELAY_MS=10000

# 目标结算周期：1 表示发现变成 1 小时结算就提醒
FUNDING_INTERVAL_TARGET_HOURS=1

# Binance fundingInfo 只返回发生调整的合约；不再出现在快照里时按默认周期回写
FUNDING_INTERVAL_DEFAULT_HOURS=4
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
- `POST /api/funding-interval/check`：手动触发一次资金费率结算周期扫描。
- `GET /api/overview`：统计、分类缓存、当前抓取进度。
- `GET /api/signals?category=A`：A/B 分类信号列表。
- `GET /api/funding-rate-tokens`：当前 1 小时资金费率代币及关联信号。
- `GET /api/io-monitoring`：按 `5m/15m/1h/4h/1d` 和升降序查看 OI。
- `GET /api/trigger-history`：统一触发历史，支持类型筛选和分页。
- `GET /api/watchlist/:symbol/unlock`：关注代币解锁缓存。
