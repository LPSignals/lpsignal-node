import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { checkSwapCall, fetchQuote, requiredMinOut, KYBER_ROUTER, KYBER_ROUTER_ABI, minOutFloor, spotOut, swapFeeBps, SwapRefused, SWAP_FEE_RECEIVER, planSwap, sqrtRatioAtTick, priceAtTick } from '../src/liquidity/index.js';

const PX = priceAtTick(-200000, 18, 6); // USDC per WETH at that tick

/** a real build: 0.01 WETH → USDC on Base, our 25 bps fee, to 0xaa, min 26,886,982 */
const FX = JSON.parse(readFileSync(`${process.cwd()}/test/fixtures/kyber-base-weth-usdc.json`, 'utf8'));
const ME = '0x00000000000000000000000000000000000000aa' as Address;
const WETH = '0x4200000000000000000000000000000000000006' as Address, USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const from = { token: WETH, native: false }, to = { token: USDC, native: false };
const real = { to: KYBER_ROUTER, data: FX.build.data as Hex, value: 0n };
const exp = { from, to, amountIn: 10n ** 16n, account: ME, feeBps: 25, minOut: 26_000_000n };
type Exec = Parameters<typeof encodeFunctionData<typeof KYBER_ROUTER_ABI, 'swap'>>[0]['args'][0];
/** the real call with one part of its description changed */
function tampered(f: (e: Exec) => Exec): { to: Address; data: Hex; value: bigint } {
  const e = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: real.data }).args[0] as Exec;
  return { ...real, data: encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: 'swap', args: [f(e)] }) };
}
const refused = (c: { to: Address; data: Hex; value: bigint }, e = exp) => { try { checkSwapCall(c, e); return null; } catch (x) { return x instanceof SwapRefused ? x.message : `other: ${String(x)}`; } };

describe('swap calldata checks', () => {
  it("a real build passes; its fee is ours (0.25% of the input) and the rest goes to the route", () => {
    expect(refused(real)).toBeNull();
    const d = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: real.data }).args[0].desc;
    expect(d.feeReceivers.map((a) => a.toLowerCase())).toEqual([SWAP_FEE_RECEIVER]);
    expect(SWAP_FEE_RECEIVER).toBe('0x13ac5bf01871ec16a9a5276f1e167da846af6a33');
  });

  it('anything else is refused: router, recipient, fee receiver or amount, flags, permit, tokens, amount, value, split, minimum, function', () => {
    const cases: [string, ReturnType<typeof tampered> | null, string][] = [
      ['router', { ...real, to: '0x0000000000000000000000000000000000000bad' }, 'router'],
      ['recipient', tampered((e) => ({ ...e, desc: { ...e.desc, dstReceiver: '0x0000000000000000000000000000000000000bad' } })), 'recipient'],
      ['fee receiver', tampered((e) => ({ ...e, desc: { ...e.desc, feeReceivers: ['0x0000000000000000000000000000000000000bad'] } })), 'fee'],
      ['fee amount', tampered((e) => ({ ...e, desc: { ...e.desc, feeAmounts: [10n] } })), 'fee'],
      ['a second fee', tampered((e) => ({ ...e, desc: { ...e.desc, feeReceivers: [...e.desc.feeReceivers, ME], feeAmounts: [...e.desc.feeAmounts, 1n] } })), 'fee'],
      ['fee on the output', tampered((e) => ({ ...e, desc: { ...e.desc, flags: 0x2c0n } })), 'flags'],
      ['partial fill', tampered((e) => ({ ...e, desc: { ...e.desc, flags: 0x281n } })), 'flags'],
      ['permit', tampered((e) => ({ ...e, desc: { ...e.desc, permit: '0x1234' } })), 'permit'],
      ['token out', tampered((e) => ({ ...e, desc: { ...e.desc, dstToken: WETH } })), 'tokens'],
      ['amount', tampered((e) => ({ ...e, desc: { ...e.desc, amount: 2n * 10n ** 16n } })), 'amount'],
      ['split', tampered((e) => ({ ...e, desc: { ...e.desc, srcAmounts: [1n] } })), 'split'],
      ['minimum', tampered((e) => ({ ...e, desc: { ...e.desc, minReturnAmount: 1n } })), 'minimum'],
      ['value', { ...real, value: 1n }, 'value'],
      ['another function', { ...real, data: ('0x8af033fb' + real.data.slice(10)) as Hex }, 'undecodable'],
    ];
    for (const [name, c, why] of cases) expect(refused(c!), name).toMatch(new RegExp(`calldata\\): ${why}`));
    // the minimum is judged against what the pool price allows, not the aggregator's own number
    expect(refused(real, { ...exp, minOut: 27_000_000n })).toMatch(/minimum/);
    // a native input must carry exactly the amount as value
    expect(refused(real, { ...exp, from: { token: WETH, native: true } })).toMatch(/tokens/);
  });
});

describe('swap pricing', () => {
  it('spot out at the pool price, after our fee; the floor takes off the impact allowed and the slippage', () => {
    // WETH/USDC at tick -200000 (decimals 18/6)
    const sp = sqrtRatioAtTick(-200000);
    const out = spotOut(sp, true, 10n ** 18n, 25);
    expect(Number(out) / 1e6).toBeCloseTo(PX * 0.9975, 2);
    const back = spotOut(sp, false, BigInt(Math.round(PX * 1e6)), 0);
    expect(Number(back) / 1e18).toBeCloseTo(1, 3);
    expect(minOutFloor(1_000_000n, 300, 50)).toBe(965_150n);
    expect([swapFeeBps('stable'), swapFeeBps('correlated'), swapFeeBps('volatile')]).toEqual([5, 25, 25]);
  });

});

describe('the minimum a build must promise', () => {
  it("the highest of: pool floor, the shortfall, the quote less the user's slippage (0.01% for the build's rounding)", () => {
    // (the review's case, in 1e6 units) spot 102, quote 102, need 100, slippage 0.5%: at least ≈101.48, not 100
    expect(requiredMinOut({ spot: 102_000_000n, impactBps: 300, slippageBps: 50, need: 100_000_000n, quoteOut: 102_000_000n })).toBe(101_479_800n);
    expect(requiredMinOut({ spot: 102_000_000n, impactBps: 300, slippageBps: 50, need: 101_600_000n, quoteOut: 102_000_000n })).toBe(101_600_000n);
    expect(requiredMinOut({ spot: 110_000_000n, impactBps: 50, slippageBps: 50, need: 1n, quoteOut: 100_000_000n })).toBe(108_902_750n);
    // a real build (quote 27,022,094 → built 27,022,093, minimum 26,886,982 at 0.5%) passes
    expect(requiredMinOut({ spot: 0n, impactBps: 300, slippageBps: 50, need: 0n, quoteOut: 27_022_094n }) <= 26_886_982n).toBe(true);
  });
});

describe('quotes', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const answer = (patch: (s: Record<string, unknown>) => void) => {
    const d = JSON.parse(JSON.stringify(FX.route));
    patch(d.routeSummary);
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      expect(String(u)).toMatch(/^https:\/\/aggregator-api\.kyberswap\.com\/base\/api\/v1\/routes\?/);
      const q = new URL(String(u)).searchParams;
      expect([q.get('feeAmount'), q.get('isInBps'), q.get('chargeFeeBy'), q.get('feeReceiver'), q.get('excludeRFQSources')]).toEqual(['25', 'true', 'currency_in', SWAP_FEE_RECEIVER, 'true']);
      expect((init?.headers as Record<string, string>)['x-client-id']).toBe('lpsignal');
      return new Response(JSON.stringify({ code: 0, message: 'successfully', data: d }));
    }));
  };
  it('the route must echo what was asked: tokens, amount and our fee', async () => {
    answer(() => {});
    expect((await fetchQuote('base', from, to, 10n ** 16n, 25)).amountOut).toBe(BigInt(FX.route.routeSummary.amountOut));
    answer((s) => { (s.extraFee as Record<string, unknown>).feeReceiver = '0x0000000000000000000000000000000000000bad'; });
    await expect(fetchQuote('base', from, to, 10n ** 16n, 25)).rejects.toThrow(/quote/);
    answer((s) => { s.amountIn = '1'; });
    await expect(fetchQuote('base', from, to, 10n ** 16n, 25)).rejects.toThrow(/quote/);
    answer((s) => { s.tokenOut = WETH; });
    await expect(fetchQuote('base', from, to, 10n ** 16n, 25)).rejects.toThrow(/quote/);
  });
});

describe('planSwap', () => {
  const POOL = { chain: 'base', address: '0x6c561b446416e1a00e8e93e221854d6ea4171372', dex: 'uniswap_v3', token0: WETH, token1: USDC, decimals0: 18, decimals1: 6, fee: 3000, tickSpacing: 60, pairClass: 'volatile' };
  const TICK = -200000;
  let rate = 998n, looser = 0, allowance = 0n, simulate: 'ok' | 'revert' = 'ok';
  const client = {
    getChainId: async () => 8453,
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'slot0' ? [sqrtRatioAtTick(TICK), TICK] : allowance),
    call: async () => { if (simulate === 'revert') throw new Error('execution reverted'); return { data: '0x' }; },
  } as never;
  const kyber = vi.fn(async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'successfully', data }));
    if (url.pathname === '/base/api/v1/routes') {
      const q = url.searchParams, amountIn = BigInt(q.get('amountIn')!), tokenIn = q.get('tokenIn')!;
      const out = (spotOut(sqrtRatioAtTick(TICK), tokenIn !== USDC, amountIn, Number(q.get('feeAmount'))) * rate) / 1000n;
      return ok({ routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', routeSummary: { tokenIn, tokenOut: q.get('tokenOut'), amountIn: String(amountIn), amountOut: String(out),
        extraFee: { feeAmount: q.get('feeAmount'), chargeFeeBy: q.get('chargeFeeBy'), isInBps: q.get('isInBps') === 'true', feeReceiver: q.get('feeReceiver') } } });
    }
    const b = JSON.parse(String(init!.body)) as { routeSummary: Record<string, string> & { extraFee: { feeAmount: string } }; recipient: Address; slippageTolerance: number };
    const s = b.routeSummary, amount = BigInt(s.amountIn!), fee = BigInt(s.extraFee.feeAmount), native = s.tokenIn === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const data = encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: 'swap', args: [{ callTarget: '0x8F10B468b06c6FD214B65F87778827F7D113f996', approveTarget: '0x0000000000000000000000000000000000000000', targetData: '0x', clientData: '0x',
      desc: { srcToken: s.tokenIn as Address, dstToken: s.tokenOut as Address, srcReceivers: native ? [] : ['0xdf033790907c60c9B81aE355F76F74f52F92114A'], srcAmounts: native ? [] : [amount - (amount * fee) / 10_000n],
        feeReceivers: [SWAP_FEE_RECEIVER], feeAmounts: [fee], dstReceiver: b.recipient, amount, minReturnAmount: (BigInt(s.amountOut!) * BigInt(10_000 - b.slippageTolerance - looser)) / 10_000n, flags: 0x280n, permit: '0x' } }] });
    return ok({ routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', data, transactionValue: native ? String(amount) : '0', amountOut: s.amountOut });
  });
  beforeEach(() => { rate = 998n; looser = 0; allowance = 0n; simulate = 'ok'; vi.stubGlobal('fetch', kyber); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('native coin in: no approval, simulated, bound to the chain and the owner; the router guarantees at least the minimum', async () => {
    const p = await planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n });
    expect(p.approvals).toEqual([]);
    expect([p.simulated, p.feeBps, p.swap.chainId, p.swap.from, p.swap.to.toLowerCase(), p.swap.value]).toEqual([true, 25, 8453, ME, KYBER_ROUTER, 10n ** 17n]);
    const desc = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: p.swap.data }).args[0].desc;
    expect([desc.dstReceiver.toLowerCase(), desc.minReturnAmount]).toEqual([ME, p.minReturn]);
    expect(p.minReturn >= (p.quoteOut * 9_949n) / 10_000n).toBe(true);
  });

  it('a token in: an exact approval of the router first (not simulated before it lands); a stable pool pays 0.05%', async () => {
    const p = await planSwap(client, { ...POOL, pairClass: 'stable' }, { owner: ME, fromSide: 1, amountIn: 1_000_000_000n, slippageBps: 10 });
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]!.to.toLowerCase()).toBe(USDC);
    expect(decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: p.approvals[0]!.data }).args).toEqual([expect.stringMatching(/^0x6131b5fae19ea4f9d964eac0408e4408b66337b5$/i), 1_000_000_000n]);
    expect([p.simulated, p.feeBps]).toEqual([false, 5]);
  });

  it('refused: a quote too far under the pool price, one that no longer covers minOut, a build looser than the slippage, a failing simulation', async () => {
    rate = 900n;
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n })).rejects.toThrow(/impact/);
    rate = 998n;
    const need = spotOut(sqrtRatioAtTick(TICK), true, 10n ** 17n, 25);
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n, minOut: need })).rejects.toThrow(/moved/);
    looser = 20;
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n })).rejects.toThrow(/calldata\): minimum/);
    looser = 0; simulate = 'revert';
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n })).rejects.toThrow(/simulation/);
  });

  it('refuses a slippage that would take the minimum out to nothing (or is not an integer), before asking anyone', async () => {
    kyber.mockClear();
    for (const slippageBps of [10_000, 20_000, -1, 0.5, Number.NaN]) {
      await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n, slippageBps })).rejects.toThrow(/slippageBps/);
    }
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n, minOut: -1n })).rejects.toThrow(/minOut/);
    expect(kyber).not.toHaveBeenCalled();
    // 0 and 9999 are allowed
    expect((await planSwap(client, POOL, { owner: ME, fromSide: 0, fromNative: true, amountIn: 10n ** 17n, slippageBps: 0 })).minReturn > 0n).toBe(true);
  });

  it('refuses what it cannot do: Uniswap v4, the native coin on a side that is not the wrapped token, another chain', async () => {
    await expect(planSwap(client, { ...POOL, dex: 'uniswap_v4' }, { owner: ME, fromSide: 0, amountIn: 1n })).rejects.toThrow(/v4/);
    await expect(planSwap(client, POOL, { owner: ME, fromSide: 1, fromNative: true, amountIn: 1n })).rejects.toThrow(/wrapped native/);
    await expect(planSwap({ ...(client as object), getChainId: async () => 1 } as never, POOL, { owner: ME, fromSide: 0, amountIn: 1n })).rejects.toThrow(/chain/);
  });
});
