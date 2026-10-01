# lpsignal（Node.js）

[LPSignal](https://lpsignal.app) 的官方 Node.js SDK。LPSignal 为蓝筹集中流动性池（Uniswap v3/v4、PancakeSwap v3、
Aerodrome / Velodrome Slipstream）提供扣除无常损失后的净 APR 信号，覆盖 Ethereum、BNB Chain、Base、Arbitrum、
Optimism 和 Polygon。

[English](README.md) · Python 版：[LPSignals/lpsignal-python](https://github.com/LPSignals/lpsignal-python) · [API 文档](https://lpsignal.app/docs)

```bash
npm install lpsignal
```

它提供：

- **REST API**：按净 APR 排序的池子、各区间指标、小时级历史、区间回测、信号及其 7 天后的实际结果、Smart LP
  排行榜、账户信息、Webhook 与 Telegram 设置、付费链接。
- **不漏信号的实时流**。服务端 WebSocket 重连时只补最近 24 小时；SDK 在每次连接前还会用 REST 拉取你最后一条信号之后
  的全部信号，所以停机多久都能补齐。信号按 id 顺序到达，进程运行期间每条只给一次。把最后一条 id 存下来（自带文件
  存储），重启后从断点继续；如果恰好在 handler 处理完、还没存盘时崩溃，这一条会再给一次，所以 handler 要按
  `signal.id` 做幂等。
- **Webhook 验签**：校验 `x-lpsignal-signature` 的 HMAC 和时间戳，返回解析后的内容。

## 快速开始

```ts
import { LPSignal, SignalStream, FileLastIdStore } from 'lpsignal';

const lps = new LPSignal({ apiKey: process.env.LPSIGNAL_API_KEY });

const { pools } = await lps.pools({ chain: 'base', class: 'volatile', limit: 10 });
for (const p of pools) console.log(p.pair, p.dex, `${(p.best.netApr * 100).toFixed(1)}%`, `±${p.best.rangeBp / 100}%`);

const stream = new SignalStream({
  client: lps,
  store: new FileLastIdStore('./lpsignal-state.json'),
  onSignal: async (signal) => {
    if (signal.kind === 'net_apr') console.log(`开仓 ${signal.pair} ticks ${signal.tickLower}..${signal.tickUpper}`);
  },
});
await stream.start();
```

## 单位约定

- APR 和比例都是小数：`0.345` 表示 34.5%。
- `ilApr` / `il7d` 是相对"直接持有两个币"的损失，所以**为 0 或负数**，`netApr = feeApr + ilApr`。
- `fee` 的单位是百分之一个基点：`500` 即 0.05% 费率档。
- `rangeBp` 是区间半宽，单位为价格的基点：`500` 即 ±5%，`0` 即全区间。实际要开的仓位是 `tickLower..tickUpper`，
  已按池子的 tick spacing 对齐。
- id 一律是字符串（可能超过 2^53），时间是 UTC 的 ISO 8601 字符串。

## 套餐

公开接口不需要 key，但机会信号要满 24 小时后才能看到。实时流、Webhook 和实时机会信号需要 Basic 或 Pro；Smart LP
信号和钱包持仓需要 Pro。套餐和完整 API 文档见 [lpsignal.app](https://lpsignal.app)。

## 推送哪些信号

信号流、webhook 和 Telegram 推送你订阅的类型：核心事件 `net_apr`、`tvl_outflow`、`depeg`、`smart_lp` 默认开启。
短时机会（`burst`：最近 1 小时净 APR 很高且有真实成交）需要添加后才推送——`setSubscriptions([...])`，或只对某个信号流
`new SignalStream({ ..., kinds: ['burst'] })`。

## 自定义规则

Basic（3 条规则）和 Pro（20 条规则）可以设置自己的阈值。命中只推送给你（信号流、webhook、Telegram），并带有
`signal.rule = { id, name }`。阈值和其他字段一样用小数表示。

```ts
await lps.createRule({ kind: 'net_apr', name: 'Base, 15%+', minNet7d: 0.15, chains: ['base'] });
await lps.createRule({ kind: 'depeg', name: 'early depeg', minDeviation: 0.003 });
await lps.setSubscriptions(['net_apr', 'burst', 'depeg']); // 推送哪些类型（规则命中总会推送）
```

## 开发

```bash
npm install && npm test                 # 单元测试
```

用 [`testdata/webhook-vectors.json`](testdata/webhook-vectors.json) 校验 webhook 签名，这份向量是用
LPSignal 服务端自己的签名函数生成的（Node 与 Python 两个仓库共用同一份）。

对运行中的 API 做端到端测试（默认只读；`E2E_WRITE=1` 会调用写接口，只能用测试账号）：

```bash
npm run build && LPSIGNAL_BASE_URL=https://api.lpsignal.app LPSIGNAL_API_KEY=lps_... npm run e2e
```

## 许可证

[MIT](LICENSE)
