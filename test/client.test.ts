import { describe, expect, it } from 'vitest';
import { LPSignal, LPSignalError } from '../src/index.js';

type Call = { method: string; url: URL; headers: Record<string, string>; body: string | undefined };

function fakeFetch(handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(c);
    const r = handler(c);
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text || null, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { f, calls };
}

const sig = (id: number) => ({ id: String(id), kind: 'tvl_outflow', firedAt: '2026-09-30T00:00:00.000Z' });

describe('LPSignal client', () => {
  it('sends the key as a bearer token and encodes the query, skipping undefined', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { pools: [], limit: 5, offset: 0 } }));
    const c = new LPSignal({ apiKey: 'lps_abc', baseUrl: 'http://api.test/', fetch: f });
    await c.pools({ chain: 'base', window: 24, limit: 5, class: undefined });
    expect(calls[0]!.url.toString()).toBe('http://api.test/v1/pools?chain=base&window=24&limit=5');
    expect(calls[0]!.headers.authorization).toBe('Bearer lps_abc');
  });

  it('works without a key and sends no authorization header', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { signals: [], next: null } }));
    await new LPSignal({ baseUrl: 'http://api.test', fetch: f }).signals({ kind: 'depeg' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.url.search).toBe('?kind=depeg');
  });

  it('rejects a key that is not an LPSignal key', () => {
    expect(() => new LPSignal({ apiKey: 'sk_live_x' })).toThrow(/lps_/);
  });

  it('url-encodes path parts (v4 pool ids, owners)', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { hours: [] } }));
    const c = new LPSignal({ baseUrl: 'http://api.test', fetch: f });
    await c.poolHours('ethereum', '0xab/../cd', { hours: 24 });
    expect(calls[0]!.url.pathname).toBe('/v1/pools/ethereum/0xab%2F..%2Fcd/hours');
  });

  it('unwraps chains, hours and follows', async () => {
    const { f } = fakeFetch((c) => ({ body: c.url.pathname === '/v1/chains' ? { chains: [{ chain: 'base' }] } : { follows: [{ owner: '0x1' }] } }));
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f });
    expect(await c.chains()).toEqual([{ chain: 'base' }]);
    expect(await c.follows()).toEqual([{ owner: '0x1' }]);
  });

  it('turns an error body into LPSignalError with code and request id', async () => {
    const { f } = fakeFetch(() => ({ status: 403, body: { error: 'pro_required' }, headers: { 'x-request-id': 'req-1' } }));
    const err = await new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f }).walletPositions('0x1').catch((e) => e);
    expect(err).toBeInstanceOf(LPSignalError);
    expect(err).toMatchObject({ status: 403, code: 'pro_required', requestId: 'req-1' });
  });

  it('retries a 429 on GET after Retry-After, but never a POST', async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => (++n === 1 ? { status: 429, body: { error: 'rate_limited', retryAfterSec: 0.01 }, headers: { 'retry-after': '0.01' } } : { body: { ok: true } }));
    const c = new LPSignal({ baseUrl: 'http://api.test', fetch: f });
    expect(await c.health()).toEqual({ ok: true });
    expect(calls).toHaveLength(2);

    const post = fakeFetch(() => ({ status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '0.01' } }));
    const err = await new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: post.f }).telegramLink().catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(post.calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '0.01' } }));
    const err = await new LPSignal({ baseUrl: 'http://api.test', fetch: f, maxRetries: 1 }).chains().catch((e) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });

  it('signal stats and API key creation', async () => {
    const { f, calls } = fakeFetch((c) => ({ body: c.url.pathname.endsWith('/stats') ? { days: 90, scored: 3 } : { apiKey: 'lps_new' } }));
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f });
    expect(await c.signalStats({ days: 90 })).toMatchObject({ scored: 3 });
    expect(await c.createApiKey()).toEqual({ apiKey: 'lps_new' });
    expect(calls[0]!.url.toString()).toBe('http://api.test/v1/signals/stats?days=90');
    expect(calls[1]!).toMatchObject({ method: 'POST' });
    expect(calls[1]!.url.pathname).toBe('/v1/me/api-key');
    expect(calls[1]!.body).toBeUndefined();
    await c.createApiKey({ replace: false });
    expect(calls[2]!.body).toBe('{"replace":false}');
  });

  it('custom rules, subscriptions, kinds and source filters, per-kind stats', async () => {
    const { f, calls } = fakeFetch((c) => (c.method === 'DELETE' ? { status: 204 } : { body: { id: '7' } }));
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f });
    await c.rules();
    await c.createRule({ kind: 'net_apr', name: 'wide', minNet7d: 0.15, chains: ['base'] });
    await c.updateRule('7', { kind: 'depeg', name: 'peg', minDeviation: 0.003, enabled: false });
    await c.deleteRule('7');
    await c.setSubscriptions(['net_apr', 'burst']);
    await c.signals({ source: 'rules', limit: 5 });
    await c.signals({ kinds: ['burst', 'depeg'] });
    await c.signalStats({ kind: 'burst' });
    expect(calls.map((x) => `${x.method} ${x.url.pathname}${decodeURIComponent(x.url.search)}`)).toEqual([
      'GET /v1/me/rules', 'POST /v1/me/rules', 'PUT /v1/me/rules/7', 'DELETE /v1/me/rules/7', 'PUT /v1/me/subscriptions', 'GET /v1/signals?source=rules&limit=5',
      'GET /v1/signals?kinds=burst,depeg', 'GET /v1/signals/stats?kind=burst',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ kind: 'net_apr', name: 'wide', minNet7d: 0.15, chains: ['base'] });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ kind: 'depeg', name: 'peg', minDeviation: 0.003, enabled: false });
    expect(calls[4]!.body).toBe('{"kinds":["net_apr","burst"]}');
  });

  it('crypto billing: overview, order, status, cancel', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { id: '9', status: 'pending' } }));
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f });
    await c.cryptoBilling();
    await c.createCryptoOrder('pro', 12);
    await c.cryptoOrder('9');
    await c.cancelCryptoOrder('9');
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(['GET /v1/billing/crypto', 'POST /v1/billing/crypto/orders', 'GET /v1/billing/crypto/orders/9', 'POST /v1/billing/crypto/orders/9/cancel']);
    expect(calls[1]!.body).toBe('{"tier":"pro","months":12}');
  });

  it('billing refresh and checkout bodies', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { url: 'https://checkout' } }));
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: f });
    await c.billing({ refresh: true });
    await c.checkout('pro');
    expect(calls[0]!.url.search).toBe('?refresh=1');
    expect(calls[1]!).toMatchObject({ method: 'POST', body: '{"tier":"pro"}' });
    expect(calls[1]!.headers['content-type']).toBe('application/json');
  });

  describe('paging', () => {
    // ids 1..250, newest first, pages of `limit`
    const all = Array.from({ length: 250 }, (_, i) => sig(250 - i));
    const pager = fakeFetch((c) => {
      const limit = Number(c.url.searchParams.get('limit') ?? 50);
      const before = c.url.searchParams.get('before');
      const rows = all.filter((s) => !before || Number(s.id) < Number(before)).slice(0, limit);
      return { body: { signals: rows, next: rows.length === limit ? rows.at(-1)!.id : null } };
    });
    const c = new LPSignal({ apiKey: 'lps_k', baseUrl: 'http://api.test', fetch: pager.f });

    it('iterateSignals walks every page newest first', async () => {
      const ids: string[] = [];
      for await (const s of c.iterateSignals()) ids.push(s.id);
      expect(ids).toHaveLength(250);
      expect(ids[0]).toBe('250');
      expect(ids.at(-1)).toBe('1');
    });

    it('signalsAfter returns only newer signals, oldest first, and stops paging early', async () => {
      pager.calls.length = 0;
      const got = await c.signalsAfter('120');
      expect(got.map((s) => s.id)).toEqual(Array.from({ length: 130 }, (_, i) => String(121 + i)));
      expect(pager.calls).toHaveLength(2); // 250..151, 150..51 — never the last page
    });

    it('signalsAfter the newest id is empty', async () => {
      expect(await c.signalsAfter('250')).toEqual([]);
    });
  });

  it('derives the stream url', () => {
    expect(new LPSignal({ baseUrl: 'https://api.lpsignal.app' }).streamUrl).toBe('wss://api.lpsignal.app/v1/stream');
    expect(new LPSignal({ baseUrl: 'http://127.0.0.1:8080/' }).streamUrl).toBe('ws://127.0.0.1:8080/v1/stream');
  });
});
