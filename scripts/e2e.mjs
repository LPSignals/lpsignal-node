#!/usr/bin/env node
/**
 * End-to-end check of the SDK against a running LPSignal API. Read-only by default, so it is safe against production:
 *
 *   LPSIGNAL_BASE_URL=https://api.lpsignal.app [LPSIGNAL_API_KEY=lps_...] npm run e2e
 *
 * Optional:
 *   E2E_WRITE=1               also exercise write endpoints (webhook, Telegram link, follows, rules) — test/PPE accounts only
 *   E2E_EXPECT_SIGNAL_SEC=60  wait this long for one live signal on the stream (something must fire meanwhile)
 *   LPSIGNAL_FREE_API_KEY=... a free-plan key: the stream must refuse it
 * Needs `npm run build` first (it imports ../dist).
 */
import { LPSignal, LPSignalError, SignalStream } from '../dist/index.js';

const BASE = process.env.LPSIGNAL_BASE_URL;
if (!BASE) { console.error('set LPSIGNAL_BASE_URL'); process.exit(2); }
const KEY = process.env.LPSIGNAL_API_KEY || undefined;
const FREE_KEY = process.env.LPSIGNAL_FREE_API_KEY || undefined;
const WRITE = process.env.E2E_WRITE === '1';
const EXPECT_SIGNAL_SEC = Number(process.env.E2E_EXPECT_SIGNAL_SEC ?? 0);

const anon = new LPSignal({ baseUrl: BASE });
const authed = KEY ? new LPSignal({ baseUrl: BASE, apiKey: KEY }) : null;
let passed = 0, failed = 0, skipped = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    if (note === 'skip') { skipped++; console.log(`skip ${name}`); return; }
    passed++; console.log(`ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) { failed++; console.log(`FAIL ${name}: ${e?.message ?? e}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`SDK E2E against ${BASE} (${KEY ? 'with key' : 'anonymous'}${WRITE ? ', writes on' : ', read-only'})`);

await check('health', async () => expect((await anon.health()).ok === true, 'not ok'));
await check('chains', async () => {
  const cs = await anon.chains();
  expect(Array.isArray(cs), 'not an array');
  for (const c of cs) expect(typeof c.block === 'string' && typeof c.lagSec === 'number', `bad row ${JSON.stringify(c)}`);
  return cs.map((c) => `${c.chain} lag ${c.lagSec}s`).join(', ') || 'no chains yet';
});

let top = null;
await check('pools: ranked by net APR, bounded', async () => {
  // a young deployment has no 7-day metrics yet: fall back to the 24h window
  let page = await anon.pools({ limit: 5 });
  if (!page.pools.length) page = await anon.pools({ limit: 5, window: 24 });
  expect(page.pools.length <= 5, 'limit ignored');
  const nets = page.pools.map((p) => p.best.netApr);
  expect(nets.every((n, i) => i === 0 || nets[i - 1] >= n), 'not sorted');
  top = page.pools[0] ?? null;
  return `${page.pools.length} pools${top ? `, top ${top.pair} ${(top.best.netApr * 100).toFixed(1)}%` : ''}`;
});
await check('pool detail, hours, backtest', async () => {
  if (!top) return 'skip';
  const d = await anon.pool(top.chain, top.address);
  expect(d.pool.address === top.address && d.metrics.length > 0, 'detail mismatch');
  const hours = await anon.poolHours(top.chain, top.address, { hours: 24 });
  expect(Array.isArray(hours) && hours.every((h, i) => i === 0 || hours[i - 1].hour < h.hour), 'hours not ascending');
  try {
    const bt = await anon.backtest(top.chain, top.address, { rangePct: 5, days: 1 });
    expect(Math.abs(bt.netApr - (bt.feeApr + bt.ilApr)) < 1e-9, 'netApr != feeApr + ilApr');
    expect(bt.ilApr <= 1e-12, 'ilApr should be <= 0');
    return `${d.metrics.length} metrics, ${hours.length} hours, backtest ±5% 1d net ${(bt.netApr * 100).toFixed(1)}%`;
  } catch (e) {
    if (e instanceof LPSignalError && ['window_not_covered', 'no_price_data'].includes(e.code)) return `backtest: ${e.code}`;
    throw e;
  }
});
await check('unknown pool → LPSignalError 404 pool_not_found', async () => {
  const e = await anon.pool('base', '0x' + '0'.repeat(40)).catch((x) => x);
  expect(e instanceof LPSignalError && e.status === 404 && e.code === 'pool_not_found', `got ${e}`);
});
await check('invalid query → LPSignalError 400 invalid_request', async () => {
  const e = await anon.pools({ limit: 1000 }).catch((x) => x);
  expect(e instanceof LPSignalError && e.status === 400 && e.code === 'invalid_request', `got ${e}`);
});

const reader = authed ?? anon;
let newest = [];
await check('signals: page, by id, paging, signalsAfter', async () => {
  const page = await reader.signals({ limit: 3 });
  newest = page.signals;
  if (!newest.length) return 'no signals yet';
  const ids = newest.map((s) => BigInt(s.id));
  expect(ids.every((id, i) => i === 0 || ids[i - 1] > id), 'not newest first');
  const one = await reader.signal(newest[0].id);
  expect(one.id === newest[0].id && one.kind === newest[0].kind, 'signal(id) mismatch');
  let n = 0;
  for await (const s of reader.iterateSignals({ limit: 2 })) { if (++n >= 6) break; expect(typeof s.id === 'string', 'bad id'); }
  if (newest.length >= 2) {
    const after = await reader.signalsAfter(newest[1].id);
    expect(after.length >= 1 && after.at(-1).id >= newest[0].id && BigInt(after[0].id) > BigInt(newest[1].id), 'signalsAfter wrong');
  }
  const kinds = new Set(page.signals.map((s) => s.kind));
  return `newest #${newest[0].id}, kinds ${[...kinds].join('/')}`;
});
await check('signal stats (public track record)', async () => {
  const st = await anon.signalStats({ days: 30 });
  expect(typeof st.scored === 'number' && st.positive <= st.scored && Array.isArray(st.points), 'bad shape');
  return `${st.scored} scored, ${st.inexact} inexact`;
});
await check('smart LP leaderboard', async () => {
  const lb = await reader.smartLps({ windowDays: 30 });
  expect(Array.isArray(lb.wallets) && typeof lb.full === 'boolean', 'bad shape');
  return `${lb.wallets.length} wallets, full=${lb.full}`;
});

if (authed) {
  let me = null;
  await check('me + billing', async () => {
    me = await authed.me();
    const b = await authed.billing();
    expect(me.tier === b.tier, `me.tier ${me.tier} != billing.tier ${b.tier}`);
    return `tier ${me.tier}, paid ${me.paid}`;
  });
  await check('Pro gate', async () => {
    if (!me) return 'skip';
    if (me.tier === 'pro') { const f = await authed.follows(); expect(Array.isArray(f), 'follows'); return `${f.length} follows`; }
    const e = await authed.walletPositions('0x' + '1'.repeat(40)).catch((x) => x);
    expect(e instanceof LPSignalError && e.status === 403 && e.code === 'pro_required', `got ${e}`);
  });

  await check('stream: catches up over REST from `since`, then goes live', async () => {
    if (!me?.paid) return 'skip';
    if (newest.length < 3) return 'skip';
    const got = [];
    const events = [];
    const stream = new SignalStream({ client: authed, since: newest[2].id, onSignal: (s, m) => { got.push([s.id, m.source]); }, onEvent: (e) => events.push(e) });
    await stream.start();
    const t0 = Date.now();
    while (!events.some((e) => e.type === 'live' || e.type === 'fatal') && Date.now() - t0 < 15_000) await sleep(50);
    const live = events.some((e) => e.type === 'live');
    let liveNote = '';
    if (live && EXPECT_SIGNAL_SEC > 0) {
      const before = got.length;
      while (!got.slice(before).some((g) => g[1] === 'live') && Date.now() - t0 < EXPECT_SIGNAL_SEC * 1000) await sleep(100);
      const l = got.slice(before).find((g) => g[1] === 'live');
      expect(l, `no live signal within ${EXPECT_SIGNAL_SEC}s`);
      liveNote = `, live #${l[0]}`;
    }
    await stream.stop();
    expect(live, `never went live: ${JSON.stringify(events.filter((e) => e.type !== 'connecting').map((e) => e.type === 'error' || e.type === 'fatal' ? `${e.type}:${e.error.message}` : e.type))}`);
    const rest = got.filter((g) => g[1] === 'rest').map((g) => g[0]);
    expect(rest.length >= 2 && rest.includes(newest[0].id) && rest.includes(newest[1].id), `catch-up missed signals: ${JSON.stringify(got)}`);
    const ids = got.map((g) => BigInt(g[0]));
    expect(ids.every((id, i) => i === 0 || ids[i - 1] < id), 'not strictly ascending');
    return `${rest.length} via REST${liveNote}`;
  });
}

if (FREE_KEY) {
  await check('stream refuses a free key (fatal, no retry loop)', async () => {
    const events = [];
    const s = new SignalStream({ client: new LPSignal({ baseUrl: BASE, apiKey: FREE_KEY }), since: '0', onSignal: () => undefined, onEvent: (e) => events.push(e) });
    await s.start();
    const t0 = Date.now();
    while (!events.some((e) => e.type === 'fatal') && Date.now() - t0 < 10_000) await sleep(50);
    await s.stop();
    const f = events.find((e) => e.type === 'fatal');
    expect(f && /402/.test(f.error.message), `expected 402 fatal, got ${JSON.stringify(events.map((e) => e.type))}`);
    return f.error.message;
  });
}

if (authed && WRITE) {
  await check('write: webhook set / read back / delete', async () => {
    const reg = await authed.setWebhook('https://example.com/lpsignal-sdk-e2e');
    expect(reg.secret.startsWith('whsec_'), 'no secret');
    expect((await authed.me()).webhookUrl === reg.url, 'not stored');
    await authed.deleteWebhook();
    expect((await authed.me()).webhookUrl === null, 'not deleted');
  });
  await check('write: webhook rejects a private address', async () => {
    const e = await authed.setWebhook('https://127.0.0.1/x').catch((x) => x);
    expect(e instanceof LPSignalError && e.status === 400 && e.code === 'invalid_webhook_url', `got ${e}`);
  });
  await check('write: telegram link code', async () => {
    const t = await authed.telegramLink();
    expect(typeof t.code === 'string' && t.code.length >= 12, 'no code');
  });
  await check('write: custom rule create / update / delete, subscriptions (paid)', async () => {
    const me = await authed.me();
    if (!me.paid) return 'skip';
    const page = await authed.rules();
    if (page.rules.length >= page.limit) return 'skip';
    const r = await authed.createRule({ kind: 'net_apr', name: 'sdk e2e', minNet7d: 0.15, chains: ['base'] });
    try {
      expect(r.minNet24h === 0.15 && r.cooldownHours === 24 && r.active === true, `create ${JSON.stringify(r)}`);
      const u = await authed.updateRule(r.id, { kind: 'depeg', name: 'sdk e2e peg', minDeviation: 0.003, enabled: false });
      expect(u.kind === 'depeg' && u.active === false, 'update');
    } finally {
      // never leave a test rule behind (it would use up the plan's slots on the next run)
      await authed.deleteRule(r.id).catch((e) => { if (!(e instanceof LPSignalError && e.status === 404)) throw new Error(`cleanup: rule ${r.id} not deleted: ${e}`); });
    }
    expect(!(await authed.rules()).rules.some((x) => x.id === r.id), 'still listed');
    const e = await authed.createRule({ kind: 'net_apr', name: 'x', minNet7d: 0.1, minTvlUsd: 10 }).catch((x) => x);
    // a regression that accepts it must not leave the rule behind either
    if (!(e instanceof Error)) await authed.deleteRule(e.id).catch(() => undefined);
    expect(e instanceof LPSignalError && e.status === 400, 'TVL floor not enforced');
    const before = me.subscriptions;
    try {
      const set = await authed.setSubscriptions(['depeg', 'burst']);
      expect(JSON.stringify(set.subscriptions) === '["burst","depeg"]', `set ${JSON.stringify(set)}`);
    } finally {
      // restore even when the response was lost or wrong
      await authed.setSubscriptions(before);
    }
    expect(JSON.stringify((await authed.me()).subscriptions) === JSON.stringify(before), 'subscriptions not restored');
    const st = await authed.signalStats({ kind: 'burst' });
    expect(st.kind === 'burst', 'burst stats');
    const mine = await authed.signals({ source: 'rules', limit: 20 });
    expect(mine.signals.every((s) => s.rule !== null), 'source=rules returned a global signal');
  });
  await check('write: follow / unfollow (Pro)', async () => {
    const me = await authed.me();
    if (me.tier !== 'pro') return 'skip';
    const owner = '0x' + 'e2'.repeat(20);
    expect((await authed.follow(owner)).following === true, 'follow');
    expect((await authed.follows()).some((f) => f.owner === owner), 'not listed');
    await authed.unfollow(owner);
    expect(!(await authed.follows()).some((f) => f.owner === owner), 'still listed');
  });
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
