import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import WebSocket, { type ClientOptions } from 'ws';
import { LPSignalError, type LPSignal } from './client.js';
import type { Signal } from './types.js';

/**
 * Where the stream is: the id of the last signal handled. Persist it to resume after a restart.
 *
 * To make a crash unable to repeat a signal's side effects, keep the id in the same database transaction as those
 * effects (write it inside onSignal) and give the stream a store over that same row. Its save() must only move
 * forward (e.g. `SET last_id = GREATEST(last_id, $1)`): the stream also saves the starting point with it.
 */
export interface LastIdStore {
  load(): Promise<string | null>;
  save(lastId: string): Promise<void>;
}

export class MemoryLastIdStore implements LastIdStore {
  private id: string | null = null;
  async load() { return this.id; }
  async save(lastId: string) { this.id = lastId; }
}

/** A small JSON file, replaced atomically (temp file + rename) so a crash never leaves half a file. */
export class FileLastIdStore implements LastIdStore {
  constructor(readonly path: string) {}
  async load(): Promise<string | null> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const id = (JSON.parse(text) as { lastId?: unknown }).lastId;
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error(`${this.path}: no valid lastId`);
    return id;
  }
  async save(lastId: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ lastId }));
    await rename(tmp, this.path);
  }
}

/** How a signal reached you: REST catch-up after downtime, the stream's own replay, or live. */
export interface SignalMeta { source: 'rest' | 'replay' | 'live' }

export type StreamEvent =
  /** no saved position: starting after the newest signal that exists now */
  | { type: 'anchored'; lastId: string }
  /** missed signals were fetched over REST before connecting */
  | { type: 'caught_up'; delivered: number }
  | { type: 'connecting'; url: string }
  | { type: 'connected' }
  /** the stream's replay finished: everything from here on is live */
  | { type: 'live' }
  | { type: 'disconnected'; code: number; reason: string }
  | { type: 'error'; error: Error }
  /** unrecoverable (bad key, plan without the stream, plan expired): the stream has stopped */
  | { type: 'fatal'; error: Error };

/** The subset of the `ws` WebSocket the stream uses; injectable for tests. */
export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
  ping(): void;
  close(code?: number): void;
  terminate(): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface SignalStreamOptions {
  /** a client with a paid API key */
  client: LPSignal;
  /**
   * Called for each signal in ascending id order, never concurrently. The position is saved only after this returns:
   * if it throws, the connection is dropped and the signal is offered again after reconnecting. A crash between this
   * returning and the position being saved also offers it again after the restart, so delivery is at-least-once:
   * make the handler idempotent on `signal.id`, or keep the position in your own database (see LastIdStore).
   */
  onSignal: (signal: Signal, meta: SignalMeta) => void | Promise<void>;
  onEvent?: (event: StreamEvent) => void;
  /** default: in memory (a restart starts from "now") */
  store?: LastIdStore;
  /** start after this signal id when the store is empty (default: after the newest signal at start) */
  since?: string;
  pingIntervalMs?: number;
  /** give up on a connection that has not opened after this long, default 15 s */
  openTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  socketFactory?: SocketFactory;
  /** extra options for the `ws` client, e.g. `{ agent }` for a proxy */
  wsOptions?: ClientOptions;
}

interface Frame { type?: string; replay?: boolean; signal?: Signal; lastId?: string }

/**
 * Live signals in id order, with no gaps across disconnects, outages and restarts.
 *
 * The server replays the last 24 hours on `?since=<id>`. Before every connection this stream first fetches everything
 * newer than its position over REST, repeating until a pass finds nothing new, so an outage of any length is filled
 * and the socket opens seconds after the last fetch. Anything at or below the position is dropped, so within one
 * running process each signal reaches the handler once; across a crash the last one may be offered again.
 */
export class SignalStream {
  private readonly opts: SignalStreamOptions & Required<Pick<SignalStreamOptions, 'pingIntervalMs' | 'openTimeoutMs' | 'minBackoffMs' | 'maxBackoffMs'>>;
  private readonly store: LastIdStore;
  private readonly socketFactory: SocketFactory;
  private lastId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  private socket: SocketLike | null = null;
  private loopDone: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** the first-run starting point, chosen once and kept until it is saved (a retry must not pick a newer one) */
  private anchor: string | null = null;

  constructor(options: SignalStreamOptions) {
    if (!options.client.apiKey) throw new Error('SignalStream: the client needs an API key (the stream is for paid plans)');
    if (options.since !== undefined && !/^\d+$/.test(options.since)) throw new Error('SignalStream: since must be a signal id');
    this.opts = { pingIntervalMs: 30_000, openTimeoutMs: 15_000, minBackoffMs: 1_000, maxBackoffMs: 30_000, ...options };
    this.store = options.store ?? new MemoryLastIdStore();
    this.socketFactory = options.socketFactory
      ?? ((url, headers) => new WebSocket(url, {
        handshakeTimeout: this.opts.openTimeoutMs,
        ...options.wsOptions,
        headers: { ...options.wsOptions?.headers, ...headers },
      }) as unknown as SocketLike);
  }

  /** Id of the last signal handed to onSignal (null before the first connection). */
  get position(): string | null { return this.lastId; }

  /**
   * Loads the saved position and starts in the background; call stop() to end. Calling it while running is a no-op;
   * during a stop() it starts once the stop has finished. After a `fatal` event, call stop() before starting again.
   */
  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    // claimed synchronously: concurrent calls share one start, and a stop() during load() cancels it
    this.starting ??= (async () => {
      this.running = true;
      try {
        const saved = await this.store.load();
        if (!this.running) return;
        this.lastId = saved ?? this.opts.since ?? null;
        this.loopDone = this.loop();
      } catch (e) {
        this.running = false;
        this.starting = null;
        throw e;
      }
    })();
    return this.starting;
  }

  /**
   * Closes the socket and waits for the signal being handled (if any). The stream can be started again.
   * Don't await it from inside onSignal: it would wait for itself.
   */
  stop(): Promise<void> {
    // every caller waits for the same, complete shutdown
    this.stopping ??= (async () => {
      this.running = false;
      this.socket?.close(1000);
      this.wake?.();
      await this.starting?.catch(() => undefined);
      await this.loopDone;
      await this.queue;
      this.starting = null;
      this.loopDone = null;
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private emit(e: StreamEvent) {
    try { this.opts.onEvent?.(e); } catch { /* a listener must not break the stream */ }
  }

  private fatal(error: Error) {
    this.running = false;
    this.emit({ type: 'fatal', error });
  }

  private async loop(): Promise<void> {
    let backoff = this.opts.minBackoffMs;
    while (this.running) {
      let healthy = false;
      try {
        await this.catchUp();
        if (this.running) healthy = await this.connectOnce();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof LPSignalError && err.status === 401) this.fatal(err);
        else this.emit({ type: 'error', error: err });
      }
      if (!this.running) break;
      backoff = healthy ? this.opts.minBackoffMs : Math.min(backoff * 2, this.opts.maxBackoffMs);
      await new Promise<void>((r) => { const t = setTimeout(r, backoff); this.wake = () => { clearTimeout(t); r(); }; });
      this.wake = null;
    }
  }

  /** Establish a position (first run) or fetch everything after it over REST. */
  private async catchUp(): Promise<void> {
    if (this.lastId === null) {
      // nothing is consumed until the starting point is saved: a restart must resume from this same point
      this.anchor ??= (await this.opts.client.signals({ limit: 1, source: 'subscribed' })).signals[0]?.id ?? '0';
      await this.store.save(this.anchor);
      this.lastId = this.anchor;
      this.emit({ type: 'anchored', lastId: this.lastId });
    }
    // repeat until a pass finds nothing: a long backlog can take longer than the server's 24h replay window, and
    // whatever was created meanwhile must come from REST too, or the socket would skip it
    let delivered = 0;
    for (;;) {
      // exactly what the socket would deliver (your rule matches; global opportunities only while the defaults are on)
      const batch = await this.opts.client.signalsAfter(this.lastId, { source: 'subscribed' });
      if (!batch.length || !this.running) break;
      for (const s of batch) {
        if (!this.running) return;
        if (await this.deliver(s, 'rest')) delivered++;
      }
    }
    if (delivered) this.emit({ type: 'caught_up', delivered });
  }

  /** One connection's life. Resolves when it closes; true when it went live. */
  private connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = `${this.opts.client.streamUrl}?since=${this.lastId}`;
      this.emit({ type: 'connecting', url });
      let ws: SocketLike;
      try {
        ws = this.socketFactory(url, { authorization: `Bearer ${this.opts.client.apiKey}` });
      } catch (e) {
        this.emit({ type: 'error', error: e as Error });
        resolve(false);
        return;
      }
      this.socket = ws;
      const conn = { failed: false, live: false, opened: false, done: false };
      let alive = true;
      let pinger: NodeJS.Timeout | null = null;
      const finish = () => {
        if (conn.done) return;
        conn.done = true;
        clearTimeout(opener);
        if (pinger) clearInterval(pinger);
        if (this.socket === ws) this.socket = null;
        // let this connection's queued frames finish before the next connection starts
        void this.queue.then(() => resolve(conn.live && !conn.failed));
      };
      // a peer that accepts TCP but never answers the upgrade must not stall the stream
      const opener = setTimeout(() => {
        if (conn.opened) return;
        this.emit({ type: 'error', error: new Error(`stream did not open within ${this.opts.openTimeoutMs} ms`) });
        try { ws.terminate(); } catch { /* already gone */ }
        finish();
      }, this.opts.openTimeoutMs);

      ws.on('unexpected-response', (_req, res) => {
        const code = res?.statusCode ?? 0;
        if (code === 401) this.fatal(new Error('stream refused (401): the API key is invalid or was replaced'));
        else if (code === 402) this.fatal(new Error('stream refused (402): the plan does not include the stream'));
        else this.emit({ type: 'error', error: new Error(`stream refused (${code})${code === 429 ? ': too many connections for this key' : ''}`) });
        try { ws.terminate(); } catch { /* already gone */ }
      });
      ws.on('open', () => {
        conn.opened = true;
        clearTimeout(opener);
        if (!this.running) { ws.close(1000); return; }
        this.emit({ type: 'connected' });
        pinger = setInterval(() => {
          // a half-open TCP connection is only found by asking
          if (!alive) { ws.terminate(); return; }
          alive = false;
          try { ws.ping(); } catch { /* close follows */ }
        }, this.opts.pingIntervalMs);
      });
      ws.on('pong', () => { alive = true; });
      ws.on('message', (raw) => {
        alive = true;
        let frame: Frame;
        try { frame = JSON.parse(raw.toString()) as Frame; } catch { return; }
        this.queue = this.queue
          .then(async () => {
            if (conn.failed) return;
            if (frame.type === 'signal' && frame.signal) await this.deliver(frame.signal, frame.replay ? 'replay' : 'live');
            else if (frame.type === 'ready') { conn.live = true; this.emit({ type: 'live' }); }
            // replay_truncated / replay_failed: the server closes with 4409 next; the reconnect resumes from lastId
          })
          .catch((err: unknown) => {
            // keep the position and reconnect: the signal is offered again
            conn.failed = true;
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            try { ws.terminate(); } catch { /* already gone */ }
          });
      });
      ws.on('error', (err) => this.emit({ type: 'error', error: err }));
      ws.on('close', (code, reason) => {
        if (conn.done) return;
        this.emit({ type: 'disconnected', code, reason: reason?.toString() ?? '' });
        if (code === 4402) this.fatal(new Error('stream closed (4402): the plan no longer includes the stream'));
        finish();
      });
    });
  }

  /** true when the signal was new and handed to onSignal */
  private async deliver(s: Signal, source: SignalMeta['source']): Promise<boolean> {
    // after stop(), nothing new reaches the handler (frames already queued are dropped, not delivered)
    if (!this.running) return false;
    if (this.lastId !== null && BigInt(s.id) <= BigInt(this.lastId)) return false;
    await this.opts.onSignal(s, { source });
    // the in-memory position follows the saved one: a failed save offers the signal again
    await this.store.save(s.id);
    this.lastId = s.id;
    return true;
  }
}
