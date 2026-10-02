import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import {
  amountsForLiquidity, approvalsNeeded, formatUnits, fullRange, liquidityForAmounts, MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK,
  mintAmounts, mintCall, otherAmount, parseUnits, rangeTicks, sqrtRatioAtTick, type MintAmounts,
} from '../src/liquidity/index.js';

const Q96 = 2n ** 96n;

describe('TickMath', () => {
  it('matches the contract at the ends and at 0', () => {
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    expect(sqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(sqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow();
    expect(() => sqrtRatioAtTick(1.5)).toThrow();
  });
  it('tracks sqrt(1.0001^tick) x 2^96 everywhere, and increases strictly', () => {
    let prev = 0n;
    for (const t of [-887000, -200720, -50, -1, 1, 50, 60, 200000, 887000]) {
      const v = sqrtRatioAtTick(t);
      expect(v > prev).toBe(true);
      prev = v;
      expect(Number(v) / Number(Q96) / Math.sqrt(1.0001 ** t)).toBeCloseTo(1, 10);
    }
  });
});

describe('ranges', () => {
  it('±bp around the price, widened outward to the grid, containing the price', () => {
    const [lo, hi] = rangeTicks(-200723, 500, 10);
    expect(Math.abs(lo % 10)).toBe(0); expect(Math.abs(hi % 10)).toBe(0);
    expect(lo).toBeLessThanOrEqual(-200723 - 487); // ln(1.05)/ln(1.0001) = 487.9 ticks
    expect(hi).toBeGreaterThanOrEqual(-200723 + 487);
    expect(hi - lo).toBeLessThan(2 * 488 + 20);
    // narrower than one spacing still contains the price
    const [a, b] = rangeTicks(7, 1, 200);
    expect(a).toBe(0); expect(b).toBe(200);
    const [c, d] = rangeTicks(-7, 1, 200);
    expect(c).toBe(-200); expect(d).toBe(0);
    expect(rangeTicks(123, 0, 60)).toEqual(fullRange(60));
    expect(fullRange(60)).toEqual([-887220, 887220]);
  });
});

describe('amounts', () => {
  const sp = sqrtRatioAtTick(-200720), lo = -201210, hi = -200230; // WETH/USDC-like
  it('the other side for an entered amount mints within it (never asks for more than entered)', () => {
    const a0 = 10n ** 18n;
    const a1 = otherAmount(0, a0, sp, lo, hi)!;
    expect(a1 > 0n).toBe(true);
    const m = mintAmounts(sp, lo, hi, a0, a1, 50);
    expect(m.amount0Desired <= a0 && m.amount1Desired <= a1).toBe(true);
    // the entered side is (all but dust) used
    expect(Number(a0 - m.amount0Desired)).toBeLessThan(1e6);
    expect(m.amount0Min <= m.amount0Desired && m.amount1Min <= m.amount1Desired).toBe(true);
    // a 0.5% price move shifts a ±5% range's mix by ~10% (the SDK's rule: liquidity valued at the worse price)
    expect(m.amount0Min > (m.amount0Desired * 75n) / 100n && m.amount0Min < m.amount0Desired).toBe(true);
    expect(m.amount1Min > (m.amount1Desired * 75n) / 100n && m.amount1Min < m.amount1Desired).toBe(true);
    // no slippage allowed: the minimums are (all but rounding) the amounts
    const exact = mintAmounts(sp, lo, hi, a0, a1, 0);
    expect(Number(exact.amount0Desired - exact.amount0Min)).toBeLessThan(1e3);
    // round trip: what that liquidity takes at the price is what we send
    const [u0, u1] = amountsForLiquidity(sp, sqrtRatioAtTick(lo), sqrtRatioAtTick(hi), m.liquidity, true);
    expect(u0 <= m.amount0Desired && u1 <= m.amount1Desired).toBe(true);
  });
  it('out of range: one token only; the other side is not used at all', () => {
    expect(otherAmount(0, 10n ** 18n, sqrtRatioAtTick(-199000), lo, hi)).toBeNull(); // price above: token1 only
    expect(otherAmount(1, 10n ** 6n, sqrtRatioAtTick(-199000), lo, hi)).toBe(0n);
    expect(otherAmount(1, 10n ** 6n, sqrtRatioAtTick(-202000), lo, hi)).toBeNull(); // price below: token0 only
    const m = mintAmounts(sqrtRatioAtTick(-202000), lo, hi, 10n ** 18n, 0n, 50);
    expect(m.amount1Desired).toBe(0n);
    expect(m.liquidity > 0n).toBe(true);
  });
  it('liquidity for amounts is the smaller side in range', () => {
    const sa = sqrtRatioAtTick(lo), sb = sqrtRatioAtTick(hi);
    expect(liquidityForAmounts(sp, sa, sb, 10n ** 18n, 0n)).toBe(0n);
  });
});

const MINT_ABI = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function refundETH() payable',
]);
const SLIP_ABI = parseAbi(['function mint((address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline,uint160 sqrtPriceX96)) payable returns (uint256,uint128,uint256,uint256)']);

describe('calls', () => {
  const amounts: MintAmounts = { liquidity: 1n, amount0Desired: 5n, amount1Desired: 7n, amount0Min: 4n, amount1Min: 6n };
  const me = '0x00000000000000000000000000000000000000AA' as const;
  const WETH = '0x4200000000000000000000000000000000000006' as const, USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
  const base = { chain: 'base', token0: WETH, token1: USDC, fee: 500, tickSpacing: 10, tickLower: -100, tickUpper: 100, amounts, recipient: me, deadline: 99n };

  it('Uniswap v3: mint on the chain\'s position manager, to the wallet itself', () => {
    const c = mintCall({ ...base, dex: 'uniswap_v3', nativeSide: null });
    expect(c.to).toBe('0x03a520b32c04bf3beef7beb72e919cf822ed34f1');
    expect(c.value).toBe(0n);
    const d = decodeFunctionData({ abi: MINT_ABI, data: c.data });
    expect(d.functionName).toBe('mint');
    expect(d.args![0]).toMatchObject({ fee: 500, tickLower: -100, tickUpper: 100, amount0Desired: 5n, amount1Min: 6n, recipient: me, deadline: 99n });
  });
  it('the native coin: multicall(mint, refundETH) carrying exactly that side', () => {
    const c = mintCall({ ...base, dex: 'uniswap_v3', nativeSide: 0 });
    expect(c.value).toBe(5n);
    const d = decodeFunctionData({ abi: MINT_ABI, data: c.data });
    expect(d.functionName).toBe('multicall');
    const [inner] = d.args as [readonly `0x${string}`[]];
    expect(inner.map((x) => decodeFunctionData({ abi: MINT_ABI, data: x }).functionName)).toEqual(['mint', 'refundETH']);
    // only the wrapped native token can be paid in the native coin
    expect(() => mintCall({ ...base, dex: 'uniswap_v3', nativeSide: 1 })).toThrow(/wrapped native/);
  });
  it('Slipstream: tickSpacing instead of the fee, sqrtPriceX96 = 0 (the pool exists)', () => {
    const c = mintCall({ ...base, dex: 'aerodrome_cl', nativeSide: null });
    expect(c.to).toBe('0x827922686190790b37229fd06084350e74485b72');
    const d = decodeFunctionData({ abi: SLIP_ABI, data: c.data });
    expect(d.args![0]).toMatchObject({ tickSpacing: 10, sqrtPriceX96: 0n, recipient: me });
  });
  it('refuses what cannot be minted', () => {
    expect(() => mintCall({ ...base, dex: 'uniswap_v4', nativeSide: null })).toThrow(/no position manager/);
    expect(() => mintCall({ ...base, dex: 'uniswap_v3', tickLower: -95, nativeSide: null })).toThrow(/grid/);
    expect(() => mintCall({ ...base, chain: 'polygon', dex: 'pancake_v3', nativeSide: null })).toThrow(/no position manager/);
  });
  it('approvals: exact amounts, only what is missing; Ethereum USDT is reset to 0 first', () => {
    const npm = '0x00000000000000000000000000000000000000bb' as const;
    const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as const;
    expect(approvalsNeeded('ethereum', npm, [{ token: USDT, amount: 10n, allowance: 10n }, { token: WETH, amount: 0n, allowance: 0n }])).toEqual([]);
    expect(approvalsNeeded('ethereum', npm, [{ token: USDT, amount: 10n, allowance: 0n }])).toHaveLength(1);
    const two = approvalsNeeded('ethereum', npm, [{ token: USDT, amount: 10n, allowance: 3n }]);
    expect(two.map((c) => decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: c.data }).args)).toEqual([[npm, 0n], [npm, 10n]]);
    expect(approvalsNeeded('base', npm, [{ token: WETH, amount: 10n, allowance: 3n }])).toHaveLength(1);
  });
});

describe('units', () => {
  it('parse and format exactly', () => {
    expect(parseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnits('.25', 6)).toBe(250_000n);
    expect(parseUnits('1.0000001', 6)).toBeNull();
    expect(parseUnits('abc', 6)).toBeNull();
    expect(parseUnits('', 6)).toBeNull();
    expect(formatUnits(1_234_567n, 6)).toBe('1.234567');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(123n, 18, 4)).toBe('0');
  });
});


describe('removing liquidity', () => {
  const sp = sqrtRatioAtTick(-200720);
  const pos = { tokenId: 7n, token0: '0x4200000000000000000000000000000000000006' as const, token1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const, feeOrSpacing: 500, tickLower: -201210, tickUpper: -200230, liquidity: 10n ** 18n };
  it('a share of the position, worth its amounts now, with minimums under the price move', async () => {
    const { removeAmounts } = await import('../src/liquidity/index.js');
    const all = removeAmounts(sp, pos, 10_000, 50), half = removeAmounts(sp, pos, 5_000, 50);
    expect(all.liquidity).toBe(pos.liquidity);
    expect(half.liquidity).toBe(pos.liquidity / 2n);
    expect(all.amount0 > 0n && all.amount1 > 0n).toBe(true);
    expect(all.amount0Min < all.amount0 && all.amount1Min < all.amount1).toBe(true);
    expect(all.amount0Min > (all.amount0 * 85n) / 100n && all.amount1Min > (all.amount1 * 85n) / 100n).toBe(true);
    // no move allowed: the minimums are the amounts
    const exact = removeAmounts(sp, pos, 10_000, 0);
    expect([exact.amount0Min, exact.amount1Min]).toEqual([exact.amount0, exact.amount1]);
    expect(() => removeAmounts(sp, pos, 0, 50)).toThrow();
    expect(() => removeAmounts(sp, pos, 10_001, 50)).toThrow();
  });
  it('one transaction: decreaseLiquidity then collect everything to the wallet; fees only = collect alone', async () => {
    const { removeCall, inPool } = await import('../src/liquidity/index.js');
    const ABI = parseAbi([
      'function multicall(bytes[])',
      'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))',
      'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))',
    ]);
    const me = '0x00000000000000000000000000000000000000aa' as const;
    const c = removeCall('base', 'uniswap_v3', 7n, { liquidity: 5n, amount0Min: 1n, amount1Min: 2n }, me, 99n);
    expect(c.to).toBe('0x03a520b32c04bf3beef7beb72e919cf822ed34f1');
    expect(c.value).toBe(0n);
    const [dec, col] = (decodeFunctionData({ abi: ABI, data: c.data }).args as [`0x${string}`[]])[0].map((d) => decodeFunctionData({ abi: ABI, data: d }));
    expect(dec!.args![0]).toEqual({ tokenId: 7n, liquidity: 5n, amount0Min: 1n, amount1Min: 2n, deadline: 99n });
    expect(col!.functionName).toBe('collect');
    expect((col!.args![0] as { recipient: string; amount0Max: bigint }).recipient.toLowerCase()).toBe(me);
    expect((col!.args![0] as { amount0Max: bigint }).amount0Max).toBe((1n << 128n) - 1n);
    const fees = removeCall('base', 'aerodrome_cl', 7n, { liquidity: 0n, amount0Min: 0n, amount1Min: 0n }, me, 99n);
    expect(decodeFunctionData({ abi: ABI, data: fees.data }).functionName).toBe('collect');
    expect(fees.to).toBe('0x827922686190790b37229fd06084350e74485b72');
    // a position belongs to a pool by tokens and fee (Slipstream: tick spacing)
    const pool = { chain: 'base', dex: 'uniswap_v3', address: '0xp' as `0x${string}`, token0: pos.token0, token1: pos.token1, decimals0: 18, decimals1: 6, fee: 500, tickSpacing: 10 };
    expect(inPool(pos, pool)).toBe(true);
    expect(inPool({ ...pos, feeOrSpacing: 3000 }, pool)).toBe(false);
    expect(inPool({ ...pos, feeOrSpacing: 10 }, { ...pool, dex: 'aerodrome_cl' })).toBe(true);
  });
});

describe('mint minimums never revert a move inside the tolerance', () => {
  it('at every price within ±slippage, what the manager takes (re-derived from the desired amounts) is >= the minimums', async () => {
    const { mintAmounts, liquidityForAmounts, amountsForLiquidity, sqrtRatioAtTick, otherAmount } = await import('../src/liquidity/index.js');
    for (const [tick, lo, hi] of [[-200720, -201210, -200230], [-200720, -200760, -200680], [0, -10, 10], [-200720, -887270, 887270]] as const) {
      const sp = sqrtRatioAtTick(tick), sa = sqrtRatioAtTick(lo), sb = sqrtRatioAtTick(hi);
      const d0 = 10n ** 18n, d1 = otherAmount(0, d0, sp, lo, hi)!;
      for (const slip of [10, 50, 100]) {
        const m = mintAmounts(sp, lo, hi, d0, d1, slip);
        // prices across the band (in basis points of price; the sqrt moves by half)
        for (let bps = -slip + 1; bps < slip; bps += Math.max(1, Math.floor(slip / 7))) {
          const sp2 = (sp * BigInt(Math.round(Math.sqrt(1 + bps / 1e4) * 1e12))) / 10n ** 12n;
          if (sp2 <= sa || sp2 >= sb) continue;
          const l2 = liquidityForAmounts(sp2, sa, sb, m.amount0Desired, m.amount1Desired);
          const [u0, u1] = amountsForLiquidity(sp2, sa, sb, l2, true);
          expect(u0 >= m.amount0Min && u1 >= m.amount1Min, `tick ${tick} [${lo},${hi}] slip ${slip} move ${bps}bp: ${u0} >= ${m.amount0Min}, ${u1} >= ${m.amount1Min}`).toBe(true);
        }
        // and still a real protection: a move well beyond the band is caught
        const far = (sp * 1_100n) / 1_000n; // +21% price
        if (far < sb) {
          const lf = liquidityForAmounts(far, sa, sb, m.amount0Desired, m.amount1Desired);
          const [f0] = amountsForLiquidity(far, sa, sb, lf, true);
          expect(f0 < m.amount0Min).toBe(true);
        }
      }
    }
  });
});

describe('reading the wallet positions', () => {
  it('walks every NFT a page at a time (emptied positions keep their indexes: a live one past the first page is found)', async () => {
    const npm = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
    const blocks = new Set<bigint | undefined>();
    const client = {
      getChainId: async () => 8453,
      getBlockNumber: async () => 100n,
      readContract: async (a: { functionName: string; address: string; blockNumber?: bigint }) => blocks.add(a.blockNumber) && (a.functionName === 'balanceOf' ? (a.address.toLowerCase() === npm ? 450n : 0n) : '0x' + 'fa'.repeat(20)),
      multicall: async (a: { blockNumber?: bigint; contracts: { functionName: string; args: readonly unknown[] }[] }) => blocks.add(a.blockNumber) && a.contracts.map((c) => {
        if (c.functionName === 'tokenOfOwnerByIndex') return c.args[1] as bigint;
        if (c.functionName === 'positions') { const id = c.args[0] as bigint; return [0n, '0x0', '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), 500, -10, 10, id === 449n ? 7n : 0n, 0n, 0n, 0n, 0n]; }
        return '0x' + '33'.repeat(20);
      }),
    };
    const got = await (await import('../src/liquidity/index.js')).positions(client as never, 'base', '0x00000000000000000000000000000000000000aa');
    expect(got.map((p: { tokenId: bigint }) => p.tokenId)).toEqual([449n]);
    expect([...blocks]).toEqual([100n]); // every read at one block: a single snapshot
  });
});
