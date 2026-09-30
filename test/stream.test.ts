import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLastIdStore, LPSignal, MemoryLastIdStore, SignalStream, type Signal, type SignalMeta, type SocketLike, type StreamEvent } from '../src/index.js';

class FakeSocket extends EventEmitter {
  closed: number | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) { super(); }
  ping() { queueMicrotask(() => this.emit('pong')); }
  close(code = 1000) { this.shut(code); }
  terminate() { this.shut(1006); }
  shut(code: number, reason = '') {
    if (this.closed !== null) return;
    this.closed = code;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }
  open() { this.emit('open'); }
  send(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  signal(id: number, replay = false) { this.send({ type: 'signal', ...(replay ? { replay: true } : {}), signal: sig(id) }); }
}

const sig = (id: number) => ({ id: String(id), kind: 'depeg', firedAt: '2026-09-30T00:00:00.000Z' }) as unknown as Signal;

/** a REST API whose signal table is `ids` (newest first on the wire) */
function api(ids: number[]) {
  const table = { ids, sources: [] as (string | null)[] };
  const f = (async (input: URL | string) => {
    const u = new URL(String(input));
    table.sources.push(u.searchParams.get('source'));
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const before = u.searchParams.get('before');
    const rows = [...table.ids].sort((a, b) => b - a).filter((i) => !before || i < Number(before)).slice(0, limit).map(sig);
    return new Response(JSON.stringify({ signals: rows, next: rows.length === limit ? rows.at(-1)!.id : null }));
  }) as typeof fetch;
  return { client: new LPSignal({ apiKey: 'lps_test', baseUrl: 'http://api.test', fetch: f }), table };
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function harness(opts: { ids: number[]; store?: MemoryLastIdStore; since?: string; onSignal?: (s: Signal, m: SignalMeta) => void | Promise<void> }) {
  const { client, table } = api(opts.ids);
  const sockets: FakeSocket[] = [];
  const got: [string, string][] = [];
  const events: StreamEvent[] = [];
  const stream = new SignalStream({
    client,
    store: opts.store ?? new MemoryLastIdStore(),
    ...(opts.since ? { since: opts.since } : {}),
    minBackoffMs: 5,
    maxBackoffMs: 20,
    onSignal: async (s, m) => { await opts.onSignal?.(s, m); got.push([s.id, m.source]); },
    onEvent: (e) => events.push(e),
    socketFactory: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s as unknown as SocketLike; },
  });
  return { stream, sockets, got, events, table };
}

describe('SignalStream', () => {
  it('first run: anchors after the newest signal, then delivers only newer ones, live', async () => {
    const h = harness({ ids: [1, 2, 3] });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    const ws = h.sockets[0]!;
    expect(ws.url).toBe('ws://api.test/v1/stream?since=3');
    expect(ws.headers.authorization).toBe('Bearer lps_test');
    ws.open();
    ws.send({ type: 'ready' });
    ws.signal(3); // at the anchor: not new
    ws.signal(4);
    ws.signal(5);
    await until(() => h.got.length === 2);
    expect(h.got).toEqual([['4', 'live'], ['5', 'live']]);
    expect(h.events).toContainEqual({ type: 'anchored', lastId: '3' });
    expect(h.events).toContainEqual({ type: 'live' });
    expect(h.stream.position).toBe('5');
    await h.stream.stop();
  });

  it('REST anchor and catch-up ask for exactly what the socket delivers (source=subscribed)', async () => {
    const h = harness({ ids: [1, 2, 3] });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    expect(h.table.sources.length).toBeGreaterThan(1);
    expect(h.table.sources.every((x) => x === 'subscribed')).toBe(true);
    await h.stream.stop();
  });

  it('anchors at 0 when there are no signals yet', async () => {
    const h = harness({ ids: [] });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    expect(h.sockets[0]!.url).toMatch(/since=0$/);
    await h.stream.stop();
  });

  it('restart after an outage: catches up over REST first, then drops what the replay repeats', async () => {
    const store = new MemoryLastIdStore();
    await store.save('5');
    const h = harness({ ids: Array.from({ length: 180 }, (_, i) => i + 1), store });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    expect(h.got.map((g) => g[0])).toEqual(Array.from({ length: 175 }, (_, i) => String(i + 6)));
    expect(h.got.every((g) => g[1] === 'rest')).toBe(true);
    const ws = h.sockets[0]!;
    expect(ws.url).toMatch(/since=180$/);
    ws.open();
    ws.signal(179, true);
    ws.signal(180, true);
    ws.signal(181, true);
    ws.send({ type: 'ready' });
    ws.signal(182);
    await until(() => h.got.length === 177);
    expect(h.got.slice(-2)).toEqual([['181', 'replay'], ['182', 'live']]);
    expect(await store.load()).toBe('182');
    await h.stream.stop();
  });

  it('uses `since` only when nothing is stored', async () => {
    const h = harness({ ids: [1, 2, 3, 4], since: '2' });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    expect(h.got).toEqual([['3', 'rest'], ['4', 'rest']]);
    await h.stream.stop();
  });

  it('a failing handler keeps the position: the signal is offered again after reconnecting', async () => {
    let failOnce = true;
    const h = harness({
      ids: [1],
      onSignal: (s) => { if (s.id === '3' && failOnce) { failOnce = false; throw new Error('db down'); } },
    });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    const ws = h.sockets[0]!;
    ws.open();
    ws.send({ type: 'ready' });
    ws.signal(2);
    ws.signal(3); // throws: connection dropped
    ws.signal(4); // must not be delivered past the failed 3
    h.table.ids.push(2, 3, 4);
    await until(() => h.sockets.length === 2);
    expect(ws.closed).toBe(1006);
    expect(h.got).toEqual([['2', 'live'], ['3', 'rest'], ['4', 'rest']]);
    expect(h.sockets[1]!.url).toMatch(/since=4$/);
    expect(h.events.some((e) => e.type === 'error' && e.error.message === 'db down')).toBe(true);
    await h.stream.stop();
  });

  it('reconnects with the last id after 4409 (incomplete replay) and after a network drop', async () => {
    const h = harness({ ids: [10] });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0]!.open();
    h.sockets[0]!.signal(11, true);
    h.sockets[0]!.send({ type: 'replay_truncated', lastId: '11' });
    h.sockets[0]!.shut(4409, 'replay incomplete');
    await until(() => h.sockets.length === 2);
    expect(h.sockets[1]!.url).toMatch(/since=11$/);
    h.sockets[1]!.shut(1006);
    await until(() => h.sockets.length === 3);
    expect(h.sockets[2]!.url).toMatch(/since=11$/);
    await h.stream.stop();
  });

  it('stops for good on 4402 (plan expired), 401 and 402', async () => {
    for (const kill of [
      (ws: FakeSocket) => ws.shut(4402, 'plan expired'),
      (ws: FakeSocket) => { ws.emit('unexpected-response', {}, { statusCode: 401 }); ws.shut(1006); },
      (ws: FakeSocket) => { ws.emit('unexpected-response', {}, { statusCode: 402 }); ws.shut(1006); },
    ]) {
      const h = harness({ ids: [1] });
      await h.stream.start();
      await until(() => h.sockets.length === 1);
      kill(h.sockets[0]!);
      await until(() => h.events.some((e) => e.type === 'fatal'));
      await new Promise((r) => setTimeout(r, 60));
      expect(h.sockets).toHaveLength(1);
      await h.stream.stop();
    }
  });

  it('keeps retrying when too many connections (429) or the server is not ready (503)', async () => {
    const h = harness({ ids: [1] });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0]!.emit('unexpected-response', {}, { statusCode: 429 });
    h.sockets[0]!.shut(1006);
    await until(() => h.sockets.length === 2);
    expect(h.events.some((e) => e.type === 'fatal')).toBe(false);
    await h.stream.stop();
  });

  it('stop() waits for the signal being handled', async () => {
    let release!: () => void;
    const h = harness({ ids: [1], onSignal: () => new Promise<void>((r) => { release = r; }) });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0]!.open();
    h.sockets[0]!.signal(2);
    await until(() => release !== undefined);
    let stopped = false;
    const p = h.stream.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await p;
    expect(h.got).toEqual([['2', 'live']]);
  });

  it('catch-up repeats until nothing is new, so signals created during a long backlog are not left to the socket', async () => {
    const store = new MemoryLastIdStore();
    await store.save('1');
    const h = harness({
      ids: [1, 2, 3],
      store,
      // while the backlog is being handled, more signals are created (as if hours passed)
      onSignal: (s) => { if (s.id === '3' && !h.table.ids.includes(5)) h.table.ids.push(4, 5); },
    });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    expect(h.got).toEqual([['2', 'rest'], ['3', 'rest'], ['4', 'rest'], ['5', 'rest']]);
    expect(h.sockets[0]!.url).toMatch(/since=5$/);
    await h.stream.stop();
  });

  it('concurrent start() calls start one stream', async () => {
    const h = harness({ ids: [1] });
    await Promise.all([h.stream.start(), h.stream.start(), h.stream.start()]);
    await until(() => h.sockets.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sockets).toHaveLength(1);
    await h.stream.stop();
  });

  it('stop() while the saved position is loading cancels the start', async () => {
    let release!: (v: string | null) => void;
    const store = { load: () => new Promise<string | null>((r) => { release = r; }), save: async () => undefined };
    const { client } = api([1]);
    const sockets: FakeSocket[] = [];
    const stream = new SignalStream({ client, store, onSignal: () => undefined, socketFactory: (u, hd) => { const s = new FakeSocket(u, hd); sockets.push(s); return s as unknown as SocketLike; } });
    const started = stream.start();
    const stopped = stream.stop();
    release('1');
    await started;
    await stopped;
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets).toHaveLength(0);
  });

  it('a connection that never opens is abandoned after openTimeoutMs and retried', async () => {
    const { client } = api([1]);
    const sockets: FakeSocket[] = [];
    const events: StreamEvent[] = [];
    const stream = new SignalStream({
      client, onSignal: () => undefined, onEvent: (e) => events.push(e), openTimeoutMs: 20, minBackoffMs: 5,
      // terminate() of this socket emits nothing at all: the stream must not wait for a close event
      socketFactory: (u, hd) => { const s = new FakeSocket(u, hd); s.terminate = () => undefined; sockets.push(s); return s as unknown as SocketLike; },
    });
    await stream.start();
    await until(() => sockets.length === 2);
    expect(events.some((e) => e.type === 'error' && /did not open/.test(e.error.message))).toBe(true);
    await stream.stop();
  });

  it('a failed save keeps the old position: the signal is offered again (at-least-once)', async () => {
    let failSave = true;
    const inner = new MemoryLastIdStore();
    const store = { load: () => inner.load(), save: async (id: string) => { if (id === '2' && failSave) { failSave = false; throw new Error('disk full'); } await inner.save(id); } };
    const h = harness({ ids: [1], store: store as unknown as MemoryLastIdStore });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.table.ids.push(2);
    h.sockets[0]!.open();
    h.sockets[0]!.signal(2);
    await until(() => h.sockets.length === 2);
    expect(h.got).toEqual([['2', 'live'], ['2', 'rest']]);
    expect(await inner.load()).toBe('2');
    await h.stream.stop();
  });

  it('after stop(), frames already received are not handed over', async () => {
    let release!: () => void;
    const h = harness({ ids: [1], onSignal: (s) => (s.id === '2' ? new Promise<void>((r) => { release = r; }) : undefined) });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.sockets[0]!.open();
    h.sockets[0]!.signal(2);
    h.sockets[0]!.signal(3);
    await until(() => release !== undefined);
    const stopped = h.stream.stop();
    release();
    await stopped;
    expect(h.got).toEqual([['2', 'live']]);
    expect(h.stream.position).toBe('2');
  });

  it('first run: nothing is consumed until the starting point is saved, and a retry keeps the same point', async () => {
    let failAnchor = true;
    const inner = new MemoryLastIdStore();
    const store = { load: () => inner.load(), save: async (id: string) => { if (failAnchor) { failAnchor = false; throw new Error('disk full'); } await inner.save(id); } };
    const h = harness({ ids: [1, 2, 3], store: store as unknown as MemoryLastIdStore });
    await h.stream.start();
    // the save failed: no socket yet; meanwhile a newer signal appears
    await until(() => h.events.some((e) => e.type === 'error' && e.error.message === 'disk full'));
    expect(h.sockets).toHaveLength(0);
    h.table.ids.push(4);
    await until(() => h.sockets.length === 1);
    expect(await inner.load()).not.toBeNull();
    expect(h.events).toContainEqual({ type: 'anchored', lastId: '3' }); // not re-picked as 4
    expect(h.got).toEqual([['4', 'rest']]);
    expect(h.sockets[0]!.url).toMatch(/since=4$/);
    await h.stream.stop();
  });

  it('start() during stop() waits for the stop, then starts once; handlers never overlap', async () => {
    let release!: () => void;
    let inFlight = 0, maxInFlight = 0;
    const h = harness({
      ids: [1],
      onSignal: async (s) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        if (s.id === '2') await new Promise<void>((r) => { release = r; });
        inFlight--;
      },
    });
    await h.stream.start();
    await until(() => h.sockets.length === 1);
    h.table.ids.push(2);
    h.sockets[0]!.open();
    h.sockets[0]!.signal(2);
    await until(() => release !== undefined);
    const stopped = h.stream.stop();
    const stopped2 = h.stream.stop();
    const restarted = h.stream.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sockets).toHaveLength(1); // no second stream while the first is stopping
    release();
    await Promise.all([stopped, stopped2, restarted]);
    await until(() => h.sockets.length === 2);
    expect(h.sockets[1]!.url).toMatch(/since=2$/);
    expect(maxInFlight).toBe(1);
    expect(h.got).toEqual([['2', 'live']]);
    await h.stream.stop();
  });

  it('refuses a client without a key', () => {
    expect(() => new SignalStream({ client: new LPSignal(), onSignal: () => undefined })).toThrow(/API key/);
  });

  it('FileLastIdStore round-trips atomically', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lps-')), 'sub', 'state.json');
    const s = new FileLastIdStore(path);
    expect(await s.load()).toBeNull();
    await s.save('42');
    expect(await s.load()).toBe('42');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ lastId: '42' });
  });
});
