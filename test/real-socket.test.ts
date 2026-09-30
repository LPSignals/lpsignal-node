import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { LPSignal, SignalStream, type StreamEvent } from '../src/index.js';

/** A real HTTP + WebSocket server: REST answers an empty signal table, upgrades follow `plan` in order. */
async function server(plan: (number | 'accept')[]) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ signals: [], next: null }));
  });
  http.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    const step = plan.shift() ?? 'accept';
    if (step === 'accept') {
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'ready' })));
    } else {
      socket.write(`HTTP/1.1 ${step} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const close = async () => { for (const c of wss.clients) c.terminate(); wss.close(); await new Promise((r) => http.close(r)); };
  return { base: `http://127.0.0.1:${port}`, seen, close };
}

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

describe('SignalStream over real sockets', () => {
  it('a refused upgrade (429, 503) is retried, then the stream goes live with the key in the header', async () => {
    const srv = await server([429, 503, 'accept']);
    const events: StreamEvent[] = [];
    const stream = new SignalStream({ client: new LPSignal({ apiKey: 'lps_real', baseUrl: srv.base }), onSignal: () => undefined, onEvent: (e) => events.push(e), minBackoffMs: 5, maxBackoffMs: 10 });
    cleanup.push(() => stream.stop(), srv.close);
    await stream.start();
    await until(() => events.some((e) => e.type === 'live'));
    expect(srv.seen).toHaveLength(3);
    expect(srv.seen.every((s) => s.auth === 'Bearer lps_real' && s.url === '/v1/stream?since=0')).toBe(true);
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { error: Error }).error.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('429'), expect.stringContaining('503')]),
    );
    expect(events.some((e) => e.type === 'fatal')).toBe(false);
  });

  it('a peer that accepts TCP but never answers the upgrade is abandoned and retried', async () => {
    const held: Socket[] = [];
    let connections = 0;
    const tcp = createTcpServer((sock) => { connections++; held.push(sock); }); // reads nothing, answers nothing
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    // REST goes to a separate stub so only the socket hangs
    const rest = createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ signals: [], next: null })); });
    await new Promise<void>((r) => rest.listen(0, '127.0.0.1', r));
    const client = new LPSignal({ apiKey: 'lps_real', baseUrl: `http://127.0.0.1:${(rest.address() as AddressInfo).port}` });
    Object.defineProperty(client, 'streamUrl', { get: () => `ws://127.0.0.1:${port}/v1/stream` });
    const events: StreamEvent[] = [];
    const stream = new SignalStream({ client, onSignal: () => undefined, onEvent: (e) => events.push(e), openTimeoutMs: 100, minBackoffMs: 5 });
    cleanup.push(() => stream.stop(), async () => { held.forEach((x) => x.destroy()); await new Promise((r) => tcp.close(r)); await new Promise((r) => rest.close(r)); });
    await stream.start();
    await until(() => connections >= 2);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('401 is fatal: no retry loop, and stop() returns', async () => {
    const srv = await server([401]);
    const events: StreamEvent[] = [];
    const stream = new SignalStream({ client: new LPSignal({ apiKey: 'lps_bad', baseUrl: srv.base }), onSignal: () => undefined, onEvent: (e) => events.push(e), minBackoffMs: 5 });
    cleanup.push(srv.close);
    await stream.start();
    await until(() => events.some((e) => e.type === 'fatal'));
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.seen).toHaveLength(1);
    await stream.stop();
  });
});
