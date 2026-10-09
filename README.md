# lpsignal (Node.js)

Official Node.js SDK for [LPSignal](https://lpsignal.app): net-of-IL APR signals for concentrated-liquidity pools.
ESM, typed, Node ≥ 20. One runtime dependency (`ws`).

[中文说明](README.zh.md) · Python SDK: [LPSignals/lpsignal-python](https://github.com/LPSignals/lpsignal-python) · [API docs](https://lpsignal.app/docs)

```bash
npm install lpsignal
```

## About LPSignal

LPSignal ranks blue-chip concentrated-liquidity pools (Uniswap v3/v4, PancakeSwap v3, Aerodrome / Velodrome Slipstream)
on Ethereum, BNB Chain, Base, Arbitrum, Optimism and Polygon by **net APR — fees minus impermanent loss** — backtested
for each price range from on-chain fee growth.

- [Live LP signals](https://lpsignal.app/signals) and how each one turned out
- [Smart LP leaderboard](https://lpsignal.app/smart-lps): wallets ranked by what their closed positions earned versus holding
- [Methodology](https://lpsignal.app/methodology): how fees, impermanent loss and range backtests are computed
- [Concentrated-liquidity impermanent loss calculator](https://lpsignal.app/calculator)
- [How LPSignal compares](https://lpsignal.app/compare) with Revert, Metrix, Krystal and DefiLlama Yields
- Best pools by chain: [Ethereum](https://lpsignal.app/chains/ethereum) · [BNB Chain](https://lpsignal.app/chains/bsc) · [Base](https://lpsignal.app/chains/base) · [Arbitrum](https://lpsignal.app/chains/arbitrum) · [Optimism](https://lpsignal.app/chains/optimism) · [Polygon](https://lpsignal.app/chains/polygon)

## REST

```ts
import { LPSignal, LPSignalError } from 'lpsignal';

const lps = new LPSignal({ apiKey: process.env.LPSIGNAL_API_KEY }); // key optional for public endpoints

const { pools } = await lps.pools({ chain: 'base', window: 168, minTvlUsd: 1e6 });
const detail = await lps.pool('base', pools[0].address);          // every (window × range) metric
const bt = await lps.backtest('base', pools[0].address, { rangePct: 5, days: 7 });

try {
  await lps.walletPositions('0x...');
} catch (e) {
  if (e instanceof LPSignalError && e.code === 'pro_required') { /* upgrade */ }
}
```

| Method | Endpoint | Key |
|---|---|---|
| `health()` · `chains()` | `/v1/health` · `/v1/chains` | – |
| `pools({ chain, class, window, minTvlUsd, limit, offset, sort, order })` | `GET /v1/pools` — `sort`: `netApr` (default) · `feeApr` · `ilApr` · `inRange` · `emissionApr` · `tvl` · `fee` · `volume24h` · `fees24h` · `poolApr`; `minPoolApr` (0.3 = 30%); `order`: `desc` (default) · `asc`; the page carries `total`; each pool carries `volume24hUsd`, `fees24hUsd` (an estimate: volume × the current fee rate) `best.net24h` and `poolApr24h` (pool-level 24h APR, as DEX sites show it) | – |
| `iteratePools({ …, sort, order })` | every page, in that order (best effort: none twice; one whose place changes meanwhile may be missed) | – |
| `pool(chain, address)` · `poolHours(chain, address, { hours })` | `GET /v1/pools/:chain/:address[/hours]` | – |
| `backtest(chain, address, { rangePct, days })` | `GET …/backtest` | – |
| `signals({ kind, kinds, source, limit, before, sort, order, offset })` · `signal(id)` | `GET /v1/signals[/:id]` — newest first by `before`; or `sort`: `return` (APR at firing) · `outcome` (realised 7-day result), paged by `offset` with `total` | optional |
| `signalStats({ days })` | `GET /v1/signals/stats` — the public track record | – |
| `iterateSignals({ kind })` | every page, newest first | optional |
| `signalsAfter(id)` | everything newer than `id`, oldest first | optional |
| `smartLps({ windowDays, chain, limit, offset, sort, order })` | `GET /v1/smart-lps` — `sort`: `rank` (default, = pnl rank) · `pnl` · `return` · `capital` · `closes` · `wins` · `apr` · `winRate`; `rank` stays the pnl rank whatever the sort; `total`; each wallet carries `aprVsHold` (annualised vs holding), `winRate`, `avgHoldH` | optional |
| `iterateSmartLps({ …, sort, order })` | every wallet on the board, in that order | optional |
| `walletPositions(owner, { limit, openOffset, openSort, openOrder, closedOffset, closedSort, closedOrder })` | `GET /v1/smart-lps/:owner/positions` — each list pages and sorts on its own (`openSort`: `lastEvent` · `openedAt` · `entryUsd`; `closedSort`: `closedAt` · `openedAt` · `capitalUsd` · `pnlUsd`); `openTotal` / `closedTotal` | Pro |
| `follows()` · `follow(owner)` · `unfollow(owner)` | `/v1/me/follows` | Pro |
| `me()` · `setWebhook(url)` · `deleteWebhook()` · `telegramLink()` | `/v1/me…` | yes |
| `createApiKey({ replace })` | `POST /v1/me/api-key` — replaces the key (or `replace: false`: only if none), returned once | yes |
| `billing({ refresh })` · `checkout(tier)` · `billingPortal()` | `/v1/billing…` | yes |
| `cryptoBilling()` · `createCryptoOrder(tier)` · `cryptoOrder(id)` · `cancelCryptoOrder(id)` | `/v1/billing/crypto…` — prepaid USDT/USDC plans, one month per order (no renewal) | yes |

Errors are `LPSignalError` with `status`, `code` (the API's `error` field), `body` and `requestId`. A `429` on a
GET, PUT or DELETE is retried after its `Retry-After` (`maxRetries`, default 2).

## Stream

```ts
import { LPSignal, SignalStream, FileLastIdStore } from 'lpsignal';

const stream = new SignalStream({
  client: new LPSignal({ apiKey: process.env.LPSIGNAL_API_KEY }), // Basic or Pro
  store: new FileLastIdStore('./lpsignal-state.json'),
  onSignal: async (signal, { source }) => {
    // called once per signal, in id order, never concurrently; source = 'rest' | 'replay' | 'live'
  },
  onEvent: (e) => { if (e.type === 'fatal') console.error(e.error.message); },
});
await stream.start();
// …
await stream.stop();
```

- **First start** with an empty store: begins after the newest signal that exists now (or after `since` if given).
- **Every (re)connect**: first fetches everything after the saved id over REST, repeating until a pass finds
  nothing new, then connects with `?since=<id>`; anything at or below the saved id is dropped. No gap however long
  you were away, and no duplicates while the process runs.
- **Your handler decides progress**: the id is saved only after `onSignal` resolves. If it throws, the connection
  is dropped and the signal is offered again. A crash after the handler but before the save also offers it again
  after the restart: delivery is **at-least-once**, so make the handler idempotent on `signal.id`.
- **No repeats even across crashes**: keep the last id in the same database transaction as your side effects
  (write it inside `onSignal`), and pass a `store` that reads and writes that same row; its `save()` must only move
  forward (e.g. `UPDATE … SET last_id = GREATEST(last_id, $1)`), since the stream also saves the starting point.
- `stop()` waits for the signal being handled; nothing new is handed over after it is called. Don't await `stop()`
  from inside `onSignal` (it would wait for itself). After a `fatal` event, call `stop()` before `start()` again.
- **Fatal** (the stream stops): invalid key (401), a plan without the stream (402), or the plan expiring (4402).
  Everything else (network drops, server restarts, 429 too many connections) reconnects with backoff.

## Webhooks

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from 'lpsignal';

app.post('/lpsignal', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers, process.env.LPSIGNAL_WEBHOOK_SECRET!);
    // deliveries are at-least-once: skip event.deliveryId if already handled
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.status(400).send(e.reason);
    throw e;
  }
});
```

Pass the raw body (a `Buffer` or string), never re-serialised JSON. Deliveries older than 5 minutes are rejected
(`toleranceSec`); every retry is signed afresh.

## Adding and removing liquidity

`lpsignal/liquidity` builds the transactions to add liquidity to a pool (in the range you choose) and to remove it,
on the pools' official position managers — Uniswap v3, PancakeSwap v3, Aerodrome and Velodrome Slipstream. You sign
and send them with your own [viem](https://viem.sh) wallet: your keys never reach the SDK, the position is always minted
to and collected by your own address, and there is no LPSignal contract or fee in between. Uniswap v4 pools are not
supported here (use the Uniswap app). Install viem next to the SDK: `npm i lpsignal viem`.

```js
import { LPSignal } from 'lpsignal';
import { planAddLiquidity, planRemoveLiquidity, positions, sendPlan } from 'lpsignal/liquidity';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const publicClient = createPublicClient({ chain: base, transport: http() });
const wallet = createWalletClient({ account, chain: base, transport: http() });

// the pool's tokens, decimals, fee and tick spacing
const { pool } = await new LPSignal().pool('base', '0x6c561b446416e1a00e8e93e221854d6ea4171372');
// ±5% around the current price, 1 WETH in, paid in ETH; the USDC side is computed
const plan = await planAddLiquidity(publicClient, pool, { owner: account.address, amount0: parseEther('1'), rangeBp: 500, nativeSide: 0 });
await sendPlan(wallet, publicClient, [...plan.approvals, plan.mint]); // exact approvals, then the mint

// later: your positions, then take half of one out (principal + fees, to you)
const [pos] = (await positions(publicClient, 'base', account.address)).filter((p) => p.pool === pool.address);
const half = await planRemoveLiquidity(publicClient, pos, { owner: account.address, shareBps: 5000 });
// finalized: wait until that block is final before taking more from the same position (a reorg could otherwise drop
// this removal while the next one reads the old liquidity, and both land)
const [{ blockNumber }] = await sendPlan(wallet, publicClient, [half.call], { finalized: true });
// the rest: read at a block no older than that removal
const rest = await planRemoveLiquidity(publicClient, pos, { owner: account.address, shareBps: 10000, minBlock: blockNumber });
await sendPlan(wallet, publicClient, [rest.call]);
```

- Minimum amounts follow the Uniswap SDK's rule for a price move of up to `slippageBps` (default 0.5%); transactions
  expire after `deadlineS` (default 20 minutes).
- Every planned call is bound to its chain and owner: `sendPlan` refuses to send it from another account or chain.
- `sendPlan` waits for each receipt. If one is not seen in time it throws `TxPending` with the hash: **do not send the
  same mint or partial removal again until you know what became of it** — a second one would also go through. A
  transaction cancelled or replaced in the wallet throws `TxReplaced` and stops the plan (a speed-up is fine). A send
  that fails without a hash throws `TxUnknown` with the account and the nonce it was sent with: check whether that nonce
  was used first (with a nonce manager or a wallet that picks nonces itself, check its history). Plans of one account
  are sent one after another within a process; do not send from the same account elsewhere at the same time. After a
  `TxUnknown`, `TxPending` or `TxReplaced`, every further send from that account on that chain throws `AccountBlocked` until you have
  checked the transaction and call `unblock(chainId, account)`.
- Minimum amounts are what the position manager would take at the edges of the `slippage` band. With a range narrower
  than that band (e.g. ±0.05% on a stable pair at 0.5% slippage) both minimums can be 0: the mint then has no on-chain
  price bound, but a price pushed outside your range only makes the deposit single-sided (a mint never trades), and
  coming back it converts at prices inside your range — the loss is bounded by the range's width.
- Positions staked in an Aerodrome / Velodrome gauge belong to the gauge and are not listed by `positions`.
- Not financial advice: a range that paid well can lose money if the price leaves it.

## Swapping

`planSwap` swaps one of a pool's tokens for the other (e.g. the side you are short of before adding) through the
[KyberSwap](https://kyberswap.com) aggregator, with **LPSignal's fee: 0.25% of the input (0.05% in stable pools)**,
sent by the aggregator's router to LPSignal's address. The aggregator's answers are checked, never trusted: the quote
must be close to the pool's own on-chain price, and the transaction it builds is decoded — the router, the tokens and
amount, the recipient (your own address), exactly LPSignal's fee and no other, no permit, and a guaranteed minimum out
no lower than your slippage allows — then simulated. The router pays at least `minReturn` or the swap reverts.

```js
import { planSwap, sendPlan } from 'lpsignal/liquidity';
// 0.1 ETH (paid as the native coin) for USDC in the WETH/USDC pool
const swap = await planSwap(publicClient, pool, { owner: account.address, fromSide: 0, fromNative: true, amountIn: parseEther('0.1') });
console.log(swap.quoteOut, swap.minReturn, swap.feeBps);
await sendPlan(wallet, publicClient, [...swap.approvals, swap.swap]); // an exact approval if needed, then the swap
```

- `minOut`: the least the swap must deliver (e.g. what you are short of); refused (`SwapRefused` `moved`) if the quote
  less the slippage no longer covers it. Other refusals: `impact` (the quote is too far under the pool price),
  `quote` / `calldata` (the aggregator's answer did not match), `simulation` (it would revert now).
- Send the plan right away (quotes move; it expires after `deadlineS`, default 10 minutes). A swap's deadline sits in
  calldata nobody can check, so after a `TxUnknown` / `TxPending` find out what became of that very transaction before
  swapping again (`sendPlan` blocks the account meanwhile).
- Uniswap v4 pools are not supported. The aggregator refuses some addresses (e.g. well-known test keys).

## License

MIT
