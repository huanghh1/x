# 币安二级信号监控台

纯观察向的 Binance 信号监控台，当前包含四周期 MA100/MA200、综合热度排行、关注池与多周期信号观察。首次运行会同步目标币种，然后按并发 worker + 全局权重限速 + 断点续抓规则缓存 K 线到 MySQL；前端展示统计、抓取状态、热度排行和信号结果。

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

5. 打开页面：

```text
http://localhost:8787
```

## 核心规则

- 目标代币分两类：A 类为 Alpha + 合约 + 无现货；B 类为现货 + 合约。
- K 线周期固定为 `15m -> 1h -> 4h -> 1d`。
- 默认 4 个币种并发抓取，但所有 Binance 请求共享全局 `REQUEST_WEIGHT` 预算，避免超过 IP 限制。
- K 线默认每页 `limit=499`，在 USD-M Futures `/fapi/v1/klines` 当前计权规则下属于 2 weight 档，单位权重可拿到更多 K 线。
- 遇到 `429` 会等到权重窗口恢复后重试；遇到 `418` 会按封禁退避等待，避免连续冲撞限制。
- 周期抓取和单币种完成后的暂停默认很短，主要依赖权重桶控速。
- 每个周期先检查本地缓存；已覆盖目标窗口则直接跳过，未覆盖则只补齐缺失历史段，入库使用唯一键去重。
- 程序重启后会继续处理 `pending`、`partial`、`failed`、`fetching` 状态的币种。
- 四周期独立计算 MA100/MA200，独立写入 `signal_result`。
- 数据库维护任务每 7 天自动清理一次超出保留窗口的旧 K 线，不在每次抓取时清理。
- 关注池会单独开启 Binance Futures WebSocket 实时层，订阅关注代币的价格和四周期 K 线；价格会轻量落库，K 线按周期节流落库且收盘必落库，全市场均线扫描仍按原规则运行。

## K 线保留窗口

| 周期 | 覆盖时间 | 保留根数 |
| --- | ---: | ---: |
| `15m` | 约 2 个月 | 5760 |
| `1h` | 约 6 个月 | 4392 |
| `4h` | 约 2 年 | 4380 |
| `1d` | 约 6 年 | 2190 |

这些值可在 `.env` 里通过 `KLINE_15M_LOOKBACK_DAYS`、`KLINE_15M_RETENTION_LIMIT` 等变量调整。

清理频率默认每 7 天一次，可通过 `KLINE_CLEANUP_INTERVAL_DAYS` 调整；服务会每小时检查一次是否到期。

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

只对一级/二级警报发送，且同一交易对同一周期在等级未变化时不会重复刷屏。

## 接口

- `GET /api/health`：数据库、爬虫、TG 状态。
- `POST /api/bootstrap`：同步目标币种并启动抓取。
- `POST /api/crawl/start`：启动抓取。
- `POST /api/crawl/stop`：暂停抓取。
- `GET /api/overview`：统计、分类缓存、当前抓取进度。
- `GET /api/signals?category=A`：A/B 分类信号列表。
