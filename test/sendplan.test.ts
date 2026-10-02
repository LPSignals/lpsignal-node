import { describe, expect, it, vi } from 'vitest';
import { AccountBlocked, sendPlan, TxPending, TxReplaced, TxReverted, TxUnknown, unblock, type PlanCall } from '../src/liquidity/index.js';
import { afterEach } from 'vitest';
afterEach(() => { unblock(8453, '0x00000000000000000000000000000000000000aa'); });

const A = '0x00000000000000000000000000000000000000aa' as const, B = '0x00000000000000000000000000000000000000bb' as const;
const call = (extra: Partial<PlanCall> = {}): PlanCall => ({ to: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', data: '0x01', value: 0n, chainId: 8453, from: A, ...extra });
const H1 = `0x${'1'.repeat(64)}` as const, H2 = `0x${'2'.repeat(64)}` as const;

function fakes(o: { walletChain?: number; clientChain?: number; account?: `0x${string}`; replaced?: 'repriced' | 'cancelled' | 'replaced'; status?: 'success' | 'reverted'; none?: boolean } = {}) {
  const sendTransaction = vi.fn(async () => H1);
  const wallet = { account: { address: o.account ?? A }, chain: null, getChainId: async () => o.walletChain ?? 8453, sendTransaction } as never;
  const client = {
    getChainId: async () => o.clientChain ?? 8453,
    getTransactionCount: async () => 5,
    waitForTransactionReceipt: async (a: { onReplaced?: (x: unknown) => void }) => {
      if (o.none) throw new Error('timeout');
      if (o.replaced) a.onReplaced?.({ reason: o.replaced, transaction: { hash: H2 } });
      return { status: o.status ?? 'success', transactionHash: o.replaced ? H2 : H1, blockNumber: 7n };
    },
  } as never;
  return { wallet, client, sendTransaction };
}

describe('sendPlan', () => {
  it('sends in order and returns the actual receipts', async () => {
    const f = fakes();
    expect(await sendPlan(f.wallet, f.client, [call(), call()])).toEqual([{ hash: H1, blockNumber: 7n }, { hash: H1, blockNumber: 7n }]);
    expect(f.sendTransaction).toHaveBeenCalledTimes(2);
  });
  it('refuses a call planned for another chain or another account (nothing sent)', async () => {
    for (const f of [fakes({ walletChain: 10, clientChain: 10 }), fakes({ clientChain: 10 }), fakes({ account: B })]) {
      await expect(sendPlan(f.wallet, f.client, [call()])).rejects.toThrow(/planned for|is for chain/);
      expect(f.sendTransaction).not.toHaveBeenCalled();
    }
  });
  it('a cancel or another transaction in its place stops the plan; a speed-up of the same call counts (its hash)', async () => {
    for (const reason of ['cancelled', 'replaced'] as const) {
      const f = fakes({ replaced: reason });
      const err = await sendPlan(f.wallet, f.client, [call(), call()]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TxReplaced);
      expect(f.sendTransaction).toHaveBeenCalledTimes(1); // the next call is never sent
      // and nothing more goes out from that account until it was checked
      await expect(sendPlan(f.wallet, f.client, [call()])).rejects.toBeInstanceOf(AccountBlocked);
      unblock(8453, A);
    }
    const sped = fakes({ replaced: 'repriced' });
    expect(await sendPlan(sped.wallet, sped.client, [call()])).toEqual([{ hash: H2, blockNumber: 7n }]);
  });
  it('a revert or an unseen receipt stops it too', async () => {
    const r = fakes({ status: 'reverted' });
    await expect(sendPlan(r.wallet, r.client, [call(), call()])).rejects.toBeInstanceOf(TxReverted);
    expect(r.sendTransaction).toHaveBeenCalledTimes(1);
    const p = fakes({ none: true });
    await expect(sendPlan(p.wallet, p.client, [call()])).rejects.toBeInstanceOf(TxPending);
  });

  it('the send itself carries the planned chain (viem then checks the wallet is on it and signs with it)', async () => {
    const f = fakes();
    await sendPlan(f.wallet, f.client, [call()]);
    expect((f.sendTransaction.mock.calls[0] as unknown as [{ chain: { id: number } }])[0].chain.id).toBe(8453);
  });
  it('finality: any RPC failure after the receipt is TxPending carrying the hash (never a bare error that invites a resend)', async () => {
    const f = fakes();
    (f.client as unknown as { getBlock: () => Promise<never> }).getBlock = async () => { throw new Error('connection reset'); };
    const err = await sendPlan(f.wallet, f.client, [call()], { finalized: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxPending);
    expect((err as TxPending).hash).toBe(H1);
  });

  it('finality: a transaction that succeeded, then re-ran and failed after a reorg, is TxReverted and stops the plan', async () => {
    const f = fakes();
    const c = f.client as unknown as Record<string, unknown>;
    c.getBlock = async (a: { blockTag?: string }) => (a.blockTag ? { number: 9n } : { hash: '0xbb' });
    c.getTransactionReceipt = async () => ({ blockNumber: 7n, blockHash: '0xbb', status: 'reverted' });
    const err = await sendPlan(f.wallet, f.client, [call(), call()], { finalized: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxReverted);
    expect(f.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('finalized: the final receipt decides even when the first one reverted (it may re-run and succeed after a reorg)', async () => {
    const f = fakes({ status: 'reverted' });
    const c = f.client as unknown as Record<string, unknown>;
    c.getBlock = async (a: { blockTag?: string }) => (a.blockTag ? { number: 9n } : { hash: '0xbb' });
    c.getTransactionReceipt = async () => ({ blockNumber: 7n, blockHash: '0xbb', status: 'success' });
    expect(await sendPlan(f.wallet, f.client, [call()], { finalized: true })).toEqual([{ hash: H1, blockNumber: 7n }]);
    c.getBlock = async () => { throw new Error('rpc down'); };
    await expect(sendPlan(fakes({ status: 'reverted' }).wallet, f.client, [call()], { finalized: true })).rejects.toBeInstanceOf(TxPending);
  });
  it('a send that fails without a hash (not a decline) is TxUnknown with the account and nonce; a decline is passed through', async () => {
    const f = fakes();
    f.sendTransaction.mockRejectedValueOnce(new Error('socket hang up'));
    const err = await sendPlan(f.wallet, f.client, [call(), call()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxUnknown);
    expect([(err as TxUnknown).from, (err as TxUnknown).nonce]).toEqual([A, 5]);
    expect((f.sendTransaction.mock.calls[0] as unknown as [{ nonce: number }])[0].nonce).toBe(5); // sent with that very nonce
    expect(f.sendTransaction).toHaveBeenCalledTimes(1);
    f.sendTransaction.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }));
    const no = await sendPlan(f.wallet, f.client, [call()]).catch((e: unknown) => e);
    expect(no).not.toBeInstanceOf(TxUnknown);
  });

  it('plans of one account run one after another (never two sends racing for the same nonce)', async () => {
    let n = 5;
    const f = fakes();
    (f.client as unknown as Record<string, unknown>).getTransactionCount = async () => n;
    const seen: number[] = [];
    f.sendTransaction.mockImplementation(async (tx: { nonce: number }) => { seen.push(tx.nonce); await new Promise((r) => setTimeout(r, 20)); n++; return H1; });
    await Promise.all([sendPlan(f.wallet, f.client, [call()]), sendPlan(f.wallet, f.client, [call()])]);
    expect(seen).toEqual([5, 6]);
  });
  it("an account with a nonce manager keeps it (no nonce forced); TxUnknown then names none", async () => {
    const f = fakes();
    (f.wallet as unknown as { account: Record<string, unknown> }).account.nonceManager = {};
    f.sendTransaction.mockRejectedValueOnce(new Error('socket hang up'));
    const err = await sendPlan(f.wallet, f.client, [call()]).catch((e: unknown) => e);
    expect((f.sendTransaction.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('nonce');
    expect((err as TxUnknown).nonce).toBeNull();
  });

  it('after an unknown outcome nothing more is sent from that account (queued plans included) until unblock()', async () => {
    const f = fakes();
    f.sendTransaction.mockRejectedValueOnce(new Error('socket hang up'));
    const [a, b] = await Promise.all([sendPlan(f.wallet, f.client, [call()]).catch((e: unknown) => e), sendPlan(f.wallet, f.client, [call()]).catch((e: unknown) => e)]);
    expect(a).toBeInstanceOf(TxUnknown);
    expect(b).toBeInstanceOf(AccountBlocked);
    expect(f.sendTransaction).toHaveBeenCalledTimes(1);
    unblock(8453, A);
    expect(await sendPlan(f.wallet, f.client, [call()])).toHaveLength(1);
  });

  it('finalized: a cancel/replacement must be final before TxReplaced (a reorg could drop it and let the original run)', async () => {
    const f = fakes({ replaced: 'cancelled' });
    (f.client as unknown as Record<string, unknown>).getBlock = async () => { throw new Error('rpc down'); };
    const err = await sendPlan(f.wallet, f.client, [call()], { finalized: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxPending); // not confirmed final: unknown, and the account blocked
    await expect(sendPlan(f.wallet, f.client, [call()])).rejects.toBeInstanceOf(AccountBlocked);
  });
});

