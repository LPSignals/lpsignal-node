import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent } from './types.js';

export type WebhookFailure = 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' | 'bad_body';

export class WebhookVerificationError extends Error {
  constructor(readonly reason: WebhookFailure) {
    super(`LPSignal webhook rejected: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

/** A Fetch `Headers` object or a plain object such as Node's `req.headers` (any letter case). */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

function header(h: HeadersLike, name: string): string | undefined {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Verify a webhook delivery and return its parsed body.
 *
 * `x-lpsignal-signature` is `sha256=` + hex HMAC-SHA256 of `"<x-lpsignal-timestamp>.<raw body>"`, keyed with the
 * secret returned when the webhook was set. Pass the raw request bytes, before any JSON parsing: re-serialised JSON
 * does not match the signature. Deliveries older than `toleranceSec` (default 300) are rejected as replays; every
 * retry is signed afresh, so a legitimate retry is never too old.
 *
 * Deliveries are at-least-once: skip `deliveryId`s you have already handled.
 */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: HeadersLike,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): WebhookEvent {
  const ts = header(headers, 'x-lpsignal-timestamp');
  const sig = header(headers, 'x-lpsignal-signature');
  if (!ts || !sig || !secret) throw new WebhookVerificationError('missing_headers');
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError('bad_timestamp');
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (opts.toleranceSec ?? 300)) throw new WebhookVerificationError('expired');
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex'));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WebhookVerificationError('bad_signature');
  try {
    return JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('bad_body');
  }
}
