# lpsignal (Node.js)

Official Node.js SDK for [LPSignal](https://lpsignal.app): net-of-IL APR signals for concentrated-liquidity pools.
ESM, typed, Node ≥ 20. One runtime dependency (`ws`).

```bash
npm install lpsignal
```

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
| `pools({ chain, class, window, minTvlUsd, limit, offset, sort, order })` | `GET /v1/pools` — `sort`: `netApr` (default) · `feeApr` · `ilApr` · `inRange` · `emissionApr` · `tvl` · `fee`; `order`: `desc` (default) · `asc`; the page carries `total` | – |
| `iteratePools({ …, sort, order })` | every page, in that order (best effort: none twice; one whose place changes meanwhile may be missed) | – |
| `pool(chain, address)` · `poolHours(chain, address, { hours })` | `GET /v1/pools/:chain/:address[/hours]` | – |
| `backtest(chain, address, { rangePct, days })` | `GET …/backtest` | – |
| `signals({ kind, limit, before })` · `signal(id)` | `GET /v1/signals[/:id]` | optional |
| `signalStats({ days })` | `GET /v1/signals/stats` — the public track record | – |
| `iterateSignals({ kind })` | every page, newest first | optional |
| `signalsAfter(id)` | everything newer than `id`, oldest first | optional |
| `smartLps({ windowDays, chain, limit, offset, sort, order })` | `GET /v1/smart-lps` — `sort`: `rank` (default, = pnl rank) · `pnl` · `return` · `capital` · `closes` · `wins`; `rank` stays the pnl rank whatever the sort; `total` | optional |
| `iterateSmartLps({ …, sort, order })` | every wallet on the board, in that order | optional |
| `walletPositions(owner, { limit, openOffset, openSort, openOrder, closedOffset, closedSort, closedOrder })` | `GET /v1/smart-lps/:owner/positions` — each list pages and sorts on its own (`openSort`: `lastEvent` · `openedAt` · `entryUsd`; `closedSort`: `closedAt` · `openedAt` · `capitalUsd` · `pnlUsd`); `openTotal` / `closedTotal` | Pro |
| `follows()` · `follow(owner)` · `unfollow(owner)` | `/v1/me/follows` | Pro |
| `me()` · `setWebhook(url)` · `deleteWebhook()` · `telegramLink()` | `/v1/me…` | yes |
| `createApiKey({ replace })` | `POST /v1/me/api-key` — replaces the key (or `replace: false`: only if none), returned once | yes |
| `billing({ refresh })` · `checkout(tier)` · `billingPortal()` | `/v1/billing…` | yes |
| `cryptoBilling()` · `createCryptoOrder(tier, months)` · `cryptoOrder(id)` · `cancelCryptoOrder(id)` | `/v1/billing/crypto…` — prepaid USDT/USDC plans | yes |

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

## License

MIT
