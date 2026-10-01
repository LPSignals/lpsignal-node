import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyWebhook, WebhookVerificationError } from '../src/index.js';

const { vectors } = JSON.parse(readFileSync(new URL('../testdata/webhook-vectors.json', import.meta.url), 'utf8')) as {
  vectors: { secret: string; timestamp: string; body: string; signature: string }[];
};

const hdr = (v: (typeof vectors)[number]) => ({ 'x-lpsignal-timestamp': v.timestamp, 'x-lpsignal-signature': v.signature });
const reason = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as WebhookVerificationError).reason; } };

describe('verifyWebhook', () => {
  it('accepts signatures made by the server (string and bytes, any header case, Headers objects)', () => {
    for (const v of vectors) {
      const now = Number(v.timestamp);
      expect(verifyWebhook(v.body, hdr(v), v.secret, { nowSec: now }).type).toBe('signal');
      expect(verifyWebhook(new TextEncoder().encode(v.body), hdr(v), v.secret, { nowSec: now }).type).toBe('signal');
      expect(verifyWebhook(v.body, { 'X-LPSignal-Timestamp': v.timestamp, 'X-LPSignal-Signature': v.signature }, v.secret, { nowSec: now })).toBeTruthy();
      expect(verifyWebhook(v.body, new Headers(hdr(v)), v.secret, { nowSec: now })).toBeTruthy();
    }
  });

  it('returns the parsed delivery', () => {
    const v = vectors[0]!;
    const e = verifyWebhook(v.body, hdr(v), v.secret, { nowSec: Number(v.timestamp) });
    expect(e.deliveryId).toBe('9001');
    expect(e.signal.id).toBe('4821');
  });

  it('rejects tampering, the wrong secret and a swapped timestamp', () => {
    const v = vectors[0]!;
    const now = Number(v.timestamp);
    expect(reason(() => verifyWebhook(v.body.replace('4821', '4822'), hdr(v), v.secret, { nowSec: now }))).toBe('bad_signature');
    expect(reason(() => verifyWebhook(v.body, hdr(v), 'whsec_wrong', { nowSec: now }))).toBe('bad_signature');
    expect(reason(() => verifyWebhook(v.body, { ...hdr(v), 'x-lpsignal-timestamp': String(now + 1) }, v.secret, { nowSec: now }))).toBe('bad_signature');
    expect(reason(() => verifyWebhook(v.body, { ...hdr(v), 'x-lpsignal-signature': 'sha256=00' }, v.secret, { nowSec: now }))).toBe('bad_signature');
  });

  it('rejects old or future deliveries outside the tolerance', () => {
    const v = vectors[0]!;
    const ts = Number(v.timestamp);
    expect(reason(() => verifyWebhook(v.body, hdr(v), v.secret, { nowSec: ts + 300 }))).toBe('ok');
    expect(reason(() => verifyWebhook(v.body, hdr(v), v.secret, { nowSec: ts + 301 }))).toBe('expired');
    expect(reason(() => verifyWebhook(v.body, hdr(v), v.secret, { nowSec: ts - 301 }))).toBe('expired');
    expect(reason(() => verifyWebhook(v.body, hdr(v), v.secret, { nowSec: ts + 3600, toleranceSec: 3600 }))).toBe('ok');
  });

  it('rejects missing headers, a missing secret and a malformed timestamp', () => {
    const v = vectors[0]!;
    expect(reason(() => verifyWebhook(v.body, {}, v.secret))).toBe('missing_headers');
    expect(reason(() => verifyWebhook(v.body, hdr(v), ''))).toBe('missing_headers');
    expect(reason(() => verifyWebhook(v.body, { ...hdr(v), 'x-lpsignal-timestamp': '1e9' }, v.secret))).toBe('bad_timestamp');
  });
});
