import type {
  Backtest, BillingStatus, Chain, ChainStatus, Follow, Health, Leaderboard, Me, PairClass, PoolDetail, PoolHour,
  PoolsPage, Signal, SignalKind, SignalsPage, TelegramLink, WalletPositions, WebhookRegistration, WindowHours,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.lpsignal.app';

/** A non-2xx answer from the API. `code` is the API's stable `error` field (e.g. `rate_limited`, `pro_required`). */
export class LPSignalError extends Error {
  readonly code: string | null;
  constructor(
    readonly status: number,
    readonly body: unknown,
    /** `x-request-id` of the failed request: include it when contacting support */
    readonly requestId: string | null = null,
  ) {
    const code = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
    super(`LPSignal API ${status}${code ? ` ${code}` : ''}${requestId ? ` (request ${requestId})` : ''}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'LPSignalError';
    this.code = code;
  }
}

export interface LPSignalOptions {
  /** `lps_...`. Optional: public endpoints work without one (opportunity signals then arrive 24h late). */
  apiKey?: string;
  baseUrl?: string;
  /** per-request timeout, default 15 s */
  timeoutMs?: number;
  /** how many times a 429 on a GET/PUT/DELETE is retried after its Retry-After, default 2 (0 = never) */
  maxRetries?: number;
  /** inject a fetch implementation (tests, proxies) */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export interface PoolsQuery {
  chain?: Chain;
  class?: PairClass;
  /** default 168 (7 days) */
  window?: WindowHours;
  minTvlUsd?: number;
  /** 1..100, default 50 */
  limit?: number;
  offset?: number;
}

export interface SignalsQuery {
  kind?: SignalKind;
  /** 1..100, default 50 */
  limit?: number;
  /** only signals with a smaller id (the `next` of the previous page) */
  before?: string;
}

const enc = encodeURIComponent;
const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']);
const MAX_RETRY_WAIT_MS = 60_000;

/** REST client for the LPSignal API. */
export class LPSignal {
  readonly apiKey: string | null;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LPSignalOptions = {}) {
    if (opts.apiKey !== undefined && !opts.apiKey.startsWith('lps_')) throw new Error('LPSignal: apiKey must start with "lps_"');
    this.apiKey = opts.apiKey ?? null;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** The stream URL derived from the base URL (https → wss). */
  get streamUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/v1/stream`;
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = text;
      if (text) { try { parsed = JSON.parse(text); } catch { /* keep the raw text */ } }
      if (res.ok) return (text ? parsed : undefined) as T;
      if (res.status === 429 && IDEMPOTENT.has(method) && attempt < this.maxRetries) {
        const after = Number(res.headers.get('retry-after') ?? (parsed as { retryAfterSec?: unknown })?.retryAfterSec);
        const waitMs = Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 1000);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new LPSignalError(res.status, parsed, res.headers.get('x-request-id'));
    }
  }

  // ── status ───────────────────────────────────────────────────────────────
  health(): Promise<Health> {
    return this.request('GET', '/v1/health');
  }
  /** Scan progress per chain. */
  async chains(): Promise<ChainStatus[]> {
    return (await this.request<{ chains: ChainStatus[] }>('GET', '/v1/chains')).chains;
  }

  // ── pools ────────────────────────────────────────────────────────────────
  /** Active pools ranked by their best range's net APR over `window` hours. */
  pools(query: PoolsQuery = {}): Promise<PoolsPage> {
    return this.request('GET', '/v1/pools', { query: { ...query } });
  }
  /** One pool with every (window, range) metric. `address` is the pool id for Uniswap v4. */
  pool(chain: Chain, address: string): Promise<PoolDetail> {
    return this.request('GET', `/v1/pools/${enc(chain)}/${enc(address)}`);
  }
  /** Hourly aggregates, oldest first (at most 720 hours). */
  async poolHours(chain: Chain, address: string, opts: { hours?: number } = {}): Promise<PoolHour[]> {
    return (await this.request<{ hours: PoolHour[] }>('GET', `/v1/pools/${enc(chain)}/${enc(address)}/hours`, { query: opts })).hours;
  }
  /** Backtest a symmetric range of ±`rangePct`% (0 = full range) over the last `days` (1..30, default 7). */
  backtest(chain: Chain, address: string, opts: { rangePct: number; days?: number }): Promise<Backtest> {
    return this.request('GET', `/v1/pools/${enc(chain)}/${enc(address)}/backtest`, { query: opts });
  }

  // ── signals ──────────────────────────────────────────────────────────────
  /** One page of signals, newest first. Without a paid key, opportunities appear once they are 24h old. */
  signals(query: SignalsQuery = {}): Promise<SignalsPage> {
    return this.request('GET', '/v1/signals', { query: { ...query } });
  }
  signal(id: string): Promise<Signal> {
    return this.request('GET', `/v1/signals/${enc(id)}`);
  }
  /** Every signal matching `query`, newest first, following the `next` cursor page by page. */
  async *iterateSignals(query: Omit<SignalsQuery, 'before'> = {}): AsyncGenerator<Signal> {
    let before: string | undefined;
    for (;;) {
      const page = await this.signals({ ...query, limit: query.limit ?? 100, ...(before ? { before } : {}) });
      for (const s of page.signals) yield s;
      if (!page.next) return;
      before = page.next;
    }
  }
  /**
   * Every signal visible to this key with an id greater than `afterId`, oldest first. This is how a consumer that was
   * offline catches up (the stream itself only replays the last 24 hours).
   */
  async signalsAfter(afterId: string): Promise<Signal[]> {
    const after = BigInt(afterId);
    const newer: Signal[] = [];
    for await (const s of this.iterateSignals()) {
      if (BigInt(s.id) <= after) break;
      newer.push(s);
    }
    return newer.reverse();
  }

  // ── smart LPs ────────────────────────────────────────────────────────────
  /** Wallets ranked by LP pnl versus holding. Without Pro: the top 10 with masked addresses. */
  smartLps(query: { windowDays?: 30 | 90; chain?: Chain; limit?: number } = {}): Promise<Leaderboard> {
    return this.request('GET', '/v1/smart-lps', { query: { ...query } });
  }
  /** A wallet's open and closed positions (Pro). */
  walletPositions(owner: string, opts: { limit?: number } = {}): Promise<WalletPositions> {
    return this.request('GET', `/v1/smart-lps/${enc(owner)}/positions`, { query: opts });
  }
  /** Wallets you follow (Pro). */
  async follows(): Promise<Follow[]> {
    return (await this.request<{ follows: Follow[] }>('GET', '/v1/me/follows')).follows;
  }
  /** Follow a wallet: its new positions of $10k+ become smart_lp signals for you (Pro, up to 50). */
  follow(owner: string): Promise<{ owner: string; following: true }> {
    return this.request('PUT', `/v1/me/follows/${enc(owner)}`);
  }
  async unfollow(owner: string): Promise<void> {
    await this.request('DELETE', `/v1/me/follows/${enc(owner)}`);
  }

  // ── account ──────────────────────────────────────────────────────────────
  me(): Promise<Me> {
    return this.request('GET', '/v1/me');
  }
  /** Set or replace the webhook. The signing secret is returned only here. */
  setWebhook(url: string): Promise<WebhookRegistration> {
    return this.request('PUT', '/v1/me/webhook', { body: { url } });
  }
  async deleteWebhook(): Promise<void> {
    await this.request('DELETE', '/v1/me/webhook');
  }
  /** A one-time code: send `/start <code>` to the LPSignal Telegram bot. */
  telegramLink(): Promise<TelegramLink> {
    return this.request('POST', '/v1/me/telegram-link');
  }

  // ── billing ──────────────────────────────────────────────────────────────
  /** Current plan. `refresh: true` re-reads Stripe first (use it right after a checkout). */
  billing(opts: { refresh?: boolean } = {}): Promise<BillingStatus> {
    return this.request('GET', '/v1/billing', { query: opts.refresh ? { refresh: 1 } : {} });
  }
  /** A Stripe Checkout URL for a monthly plan. */
  checkout(tier: 'basic' | 'pro'): Promise<{ url: string }> {
    return this.request('POST', '/v1/billing/checkout', { body: { tier } });
  }
  /** A Stripe Customer Portal URL (change plan, cancel, invoices). */
  billingPortal(): Promise<{ url: string }> {
    return this.request('POST', '/v1/billing/portal');
  }
}
