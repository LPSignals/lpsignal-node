/**
 * Concentrated-liquidity math and the official position-manager calls (Uniswap v3 / PancakeSwap v3
 * NonfungiblePositionManager, Aerodrome / Velodrome Slipstream) — the same code the lpsignal.app web app runs, kept in
 * step with it. Pure: nothing here signs or sends; recipients are always the caller's own address.
 *
 * Math is the pools' own, in integers: TickMath.getSqrtRatioAtTick, LiquidityAmounts, SqrtPriceMath (rounding as the
 * contracts do), and the Uniswap SDK's slippage rule for the minimum amounts.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';

export type LpDex = 'uniswap_v3' | 'pancake_v3' | 'aerodrome_cl' | 'velodrome_cl';

/** position managers per chain and dex — the ones whose factory created the pools we track (src/chains.ts `npms`) */
export const NPM: Record<string, Partial<Record<LpDex, Address>>> = {
  ethereum: { uniswap_v3: '0xc36442b4a4522e871399cd717abdd847ab11fe88', pancake_v3: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364' },
  bsc: { uniswap_v3: '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613', pancake_v3: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364' },
  base: { uniswap_v3: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', pancake_v3: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', aerodrome_cl: '0x827922686190790b37229fd06084350e74485b72' },
  arbitrum: { uniswap_v3: '0xc36442b4a4522e871399cd717abdd847ab11fe88', pancake_v3: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364' },
  optimism: { uniswap_v3: '0xc36442b4a4522e871399cd717abdd847ab11fe88', velodrome_cl: '0x416b433906b1b72fa758e166e239c43d68dc6f29' },
  polygon: { uniswap_v3: '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  robinhood: { uniswap_v3: '0x73991a25c818bf1f1128deaab1492d45638de0d3' },
};
export const CHAIN_ID: Record<string, number> = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, robinhood: 4663 };
/** the wrapped native coin the position managers wrap msg.value into (their WETH9()) */
export const WRAPPED: Record<string, Address> = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', optimism: '0x4200000000000000000000000000000000000006', polygon: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  robinhood: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
};
export const EXPLORER: Record<string, string> = {
  ethereum: 'https://etherscan.io', base: 'https://basescan.org', arbitrum: 'https://arbiscan.io', optimism: 'https://optimistic.etherscan.io',
  bsc: 'https://bscscan.com', polygon: 'https://polygonscan.com', robinhood: 'https://robinhoodchain.blockscout.com',
};
export const NATIVE_SYMBOL: Record<string, string> = { ethereum: 'ETH', bsc: 'BNB', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', polygon: 'POL', robinhood: 'ETH' };
/** USDT on Ethereum refuses to change a non-zero allowance to another non-zero one: reset it to 0 first */
export const ZERO_FIRST: Record<string, Address[]> = { ethereum: ['0xdac17f958d2ee523a2206206994597c13d831ec7'] };

export const isSlipstream = (dex: string): boolean => dex === 'aerodrome_cl' || dex === 'velodrome_cl';
export function npmOf(chain: string, dex: string): Address | null {
  return (NPM[chain] as Record<string, Address | undefined> | undefined)?.[dex] ?? null;
}

// ---- TickMath (Uniswap v3 core, exact) ----
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_U256 = (1n << 256n) - 1n;

const RATIOS: [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick}`);
  const abs = Math.abs(tick);
  let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, mul] of RATIOS) if (abs & bit) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = MAX_U256 / ratio;
  // Q128.128 → Q64.96, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ---- ranges ----
const LN = Math.log(1.0001);
/** the full range: the extreme ticks rounded inward to the spacing (the widest legal position) */
export function fullRange(tickSpacing: number): [number, number] {
  const s = Math.max(1, tickSpacing);
  return [Math.ceil(MIN_TICK / s) * s, Math.floor(MAX_TICK / s) * s];
}
/** ±rangeBp of price around `tick`, widened outward to the tick grid, always containing the price (0 = full range) — as the backtests */
export function rangeTicks(tick: number, rangeBp: number, tickSpacing: number): [number, number] {
  const s = Math.max(1, tickSpacing);
  const [minT, maxT] = fullRange(s);
  if (rangeBp === 0) return [minT, maxT];
  const r = rangeBp / 1e4;
  let lo = Math.floor((tick - Math.log(1 + r) / LN) / s) * s;
  let hi = Math.ceil((tick + Math.log(1 + r) / LN) / s) * s;
  if (lo > tick) lo = Math.floor(tick / s) * s;
  if (hi <= tick) hi = (Math.floor(tick / s) + 1) * s;
  // (|| 0: no -0 from flooring a small negative)
  return [Math.max(lo, minT) || 0, Math.min(hi, maxT) || 0];
}

// ---- LiquidityAmounts / SqrtPriceMath ----
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => { const p = a * b; return p / d + (p % d === 0n ? 0n : 1n); };
const sort2 = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b]);

function liquidityFor0(sa: bigint, sb: bigint, amount0: bigint): bigint {
  [sa, sb] = sort2(sa, sb);
  return mulDiv(amount0, mulDiv(sa, sb, Q96), sb - sa);
}
function liquidityFor1(sa: bigint, sb: bigint, amount1: bigint): bigint {
  [sa, sb] = sort2(sa, sb);
  return mulDiv(amount1, Q96, sb - sa);
}
/** the liquidity the position manager mints for these desired amounts (LiquidityAmounts.getLiquidityForAmounts) */
export function liquidityForAmounts(sp: bigint, sa: bigint, sb: bigint, amount0: bigint, amount1: bigint): bigint {
  [sa, sb] = sort2(sa, sb);
  if (sp <= sa) return liquidityFor0(sa, sb, amount0);
  if (sp < sb) { const l0 = liquidityFor0(sp, sb, amount0), l1 = liquidityFor1(sa, sp, amount1); return l0 < l1 ? l0 : l1; }
  return liquidityFor1(sa, sb, amount1);
}
function amount0Delta(sa: bigint, sb: bigint, l: bigint, up: boolean): bigint {
  [sa, sb] = sort2(sa, sb);
  const n1 = l << 96n, n2 = sb - sa;
  return up ? (mulDivUp(mulDivUp(n1, n2, sb), 1n, sa)) : mulDiv(n1, n2, sb) / sa;
}
function amount1Delta(sa: bigint, sb: bigint, l: bigint, up: boolean): bigint {
  [sa, sb] = sort2(sa, sb);
  return up ? mulDivUp(l, sb - sa, Q96) : mulDiv(l, sb - sa, Q96);
}
/** the token amounts liquidity `l` takes at price `sp` (rounded up = what a mint pulls; down = what it is worth) */
export function amountsForLiquidity(sp: bigint, sa: bigint, sb: bigint, l: bigint, up: boolean): [bigint, bigint] {
  [sa, sb] = sort2(sa, sb);
  if (sp <= sa) return [amount0Delta(sa, sb, l, up), 0n];
  if (sp < sb) return [amount0Delta(sp, sb, l, up), amount1Delta(sa, sp, l, up)];
  return [0n, amount1Delta(sa, sb, l, up)];
}

/**
 * Given one side's amount, the other side the range needs at the current price (0 when the range takes only one
 * token at this price; null when the given side is not used at all there).
 */
export function otherAmount(side: 0 | 1, amount: bigint, sp: bigint, tickLower: number, tickUpper: number): bigint | null {
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper);
  if (side === 0 && sp >= sb) return null;
  if (side === 1 && sp <= sa) return null;
  if (sp <= sa || sp >= sb) return 0n;
  const l = side === 0 ? liquidityFor0(sp, sb, amount) : liquidityFor1(sa, sp, amount);
  return amountsForLiquidity(sp, sa, sb, l, true)[side === 0 ? 1 : 0];
}

/** which tokens a range takes at this price */
export function sidesUsed(sp: bigint, tickLower: number, tickUpper: number): { token0: boolean; token1: boolean } {
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper);
  return { token0: sp < sb, token1: sp > sa };
}

const BPS = 10_000n;
/** isqrt of a non-negative bigint */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
/** sqrt price after the price moves by `bps` (signed) — the price is the square: sp * sqrt(1 + bps/1e4) */
function movedSqrt(sp: bigint, bps: bigint): bigint {
  const s = (sp * isqrt((BPS + bps) * 10n ** 36n / BPS)) / 10n ** 18n;
  return s < MIN_SQRT_RATIO ? MIN_SQRT_RATIO : s >= MAX_SQRT_RATIO ? MAX_SQRT_RATIO - 1n : s;
}

export interface MintAmounts { liquidity: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint }

/**
 * The amounts to send for these desired amounts, and the minimums under a price move of up to `slippageBps` before the
 * transaction lands. The position manager re-derives the liquidity from the desired amounts AT THE PRICE IT MEETS, so
 * the minimum of each token is what it would actually take at the worse end of the band — token0 at the upper price,
 * token1 at the lower (each is monotonic in the price) — never the liquidity fixed now valued there (that is higher
 * than what a moved price takes, and would revert a move well inside the tolerance).
 */
export function mintAmounts(sp: bigint, tickLower: number, tickUpper: number, desired0: bigint, desired1: bigint, slippageBps: number): MintAmounts {
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper);
  const liquidity = liquidityForAmounts(sp, sa, sb, desired0, desired1);
  const s = BigInt(Math.round(slippageBps));
  if (s < 0n || s >= BPS) throw new RangeError('slippage');
  // what minting `liquidity` pulls at the current price (never more than desired)
  const [use0, use1] = amountsForLiquidity(sp, sa, sb, liquidity, true);
  const amount0Desired = use0 < desired0 ? use0 : desired0, amount1Desired = use1 < desired1 ? use1 : desired1;
  const l = liquidityForAmounts(sp, sa, sb, amount0Desired, amount1Desired);
  // what the manager would take at the band's ends (less token0 when the price rises, less token1 when it falls),
  // rounded down below what it really pulls (it rounds up)
  const up = movedSqrt(sp, s), down = movedSqrt(sp, -s);
  const [min0] = amountsForLiquidity(up, sa, sb, liquidityForAmounts(up, sa, sb, amount0Desired, amount1Desired), false);
  const [, min1] = amountsForLiquidity(down, sa, sb, liquidityForAmounts(down, sa, sb, amount0Desired, amount1Desired), false);
  return { liquidity: l, amount0Desired, amount1Desired, amount0Min: min0 < amount0Desired ? min0 : amount0Desired, amount1Min: min1 < amount1Desired ? min1 : amount1Desired };
}

// ---- calls ----
const MINT_V3 = [{
  type: 'function', name: 'mint', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'fee', type: 'uint24' },
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'amount0Desired', type: 'uint256' }, { name: 'amount1Desired', type: 'uint256' },
    { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' },
    { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ] }],
  outputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
}] as const;
const MINT_SLIPSTREAM = [{
  type: 'function', name: 'mint', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'amount0Desired', type: 'uint256' }, { name: 'amount1Desired', type: 'uint256' },
    { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' },
    { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'sqrtPriceX96', type: 'uint160' },
  ] }],
  outputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
}] as const;
const PERIPHERY = [
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
  { type: 'function', name: 'refundETH', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;
export const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
/** the first two fields of slot0 — the same on Uniswap v3, PancakeSwap v3 and Slipstream (the rest differ) */
export const SLOT0 = [{ type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }] }] as const;

export interface Call { to: Address; data: Hex; value: bigint }
export interface MintInput {
  chain: string; dex: string;
  token0: Address; token1: Address; fee: number; tickSpacing: number;
  tickLower: number; tickUpper: number;
  amounts: MintAmounts;
  recipient: Address; deadline: bigint;
  /** pay this side in the native coin (it must be the wrapped native token): sent as value, the change refunded */
  nativeSide: 0 | 1 | null;
}

/** the mint transaction (with the native coin: multicall(mint, refundETH) carrying the value) */
export function mintCall(m: MintInput): Call {
  const npm = npmOf(m.chain, m.dex);
  if (!npm) throw new Error(`no position manager for ${m.dex} on ${m.chain}`);
  if (!(m.tickLower < m.tickUpper) || m.tickLower % m.tickSpacing !== 0 || m.tickUpper % m.tickSpacing !== 0) throw new Error('range not on the tick grid');
  if (m.nativeSide !== null && (m.nativeSide === 0 ? m.token0 : m.token1).toLowerCase() !== WRAPPED[m.chain]?.toLowerCase()) throw new Error('not the wrapped native token');
  const a = m.amounts;
  const common = {
    token0: m.token0, token1: m.token1, tickLower: m.tickLower, tickUpper: m.tickUpper,
    amount0Desired: a.amount0Desired, amount1Desired: a.amount1Desired, amount0Min: a.amount0Min, amount1Min: a.amount1Min,
    recipient: m.recipient, deadline: m.deadline,
  };
  const mint = isSlipstream(m.dex)
    // sqrtPriceX96 = 0: the pool exists (non-zero would ask the factory to create it, and revert)
    ? encodeFunctionData({ abi: MINT_SLIPSTREAM, functionName: 'mint', args: [{ ...common, tickSpacing: m.tickSpacing, sqrtPriceX96: 0n }] })
    : encodeFunctionData({ abi: MINT_V3, functionName: 'mint', args: [{ ...common, fee: m.fee }] });
  if (m.nativeSide === null) return { to: npm, data: mint, value: 0n };
  const value = m.nativeSide === 0 ? a.amount0Desired : a.amount1Desired;
  const refund = encodeFunctionData({ abi: PERIPHERY, functionName: 'refundETH' });
  return { to: npm, data: encodeFunctionData({ abi: PERIPHERY, functionName: 'multicall', args: [[mint, refund]] }), value };
}

export function approveCall(token: Address, spender: Address, amount: bigint): Call {
  return { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }), value: 0n };
}

/** the approvals a mint needs, given the current allowances (exact amounts, never unlimited) */
export function approvalsNeeded(chain: string, npm: Address, needs: { token: Address; amount: bigint; allowance: bigint }[]): Call[] {
  const out: Call[] = [];
  for (const n of needs) {
    if (n.amount === 0n || n.allowance >= n.amount) continue;
    if (n.allowance > 0n && (ZERO_FIRST[chain] ?? []).includes(n.token.toLowerCase() as Address)) out.push(approveCall(n.token, npm, 0n));
    out.push(approveCall(n.token, npm, n.amount));
  }
  return out;
}

/** token units ⇄ text, exact (no floats) */
export function parseUnits(text: string, decimals: number): bigint | null {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] ?? '');
  if (frac.length > decimals) return null;
  return BigInt((m[1] || '0') + frac.padEnd(decimals, '0'));
}
export function formatUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const neg = v < 0n, a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = a / base, frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int.toString()}${frac ? `.${frac}` : ''}`;
}
/** human price of token0 in token1 at a tick */
export const priceAtTick = (tick: number, decimals0: number, decimals1: number): number => Math.exp(tick * LN) * 10 ** (decimals0 - decimals1);

export interface LpPool { chain: string; dex: string; address: Address; token0: Address; token1: Address; decimals0: number; decimals1: number; fee: number; tickSpacing: number }
export interface MintPlan { tickLower: number; tickUpper: number; amounts: MintAmounts; approvals: Call[]; mint: Call }

/**
 * Everything a mint needs, from the pool's live price and what the user wants to put in: the range (±rangeBp around
 * the price, on the grid), the amounts and minimums, the approvals still missing (for the amounts the user entered,
 * so a re-plan at a fresh price before the mint never needs another one), and the mint itself.
 */
export function planMint(pool: LpPool, slot0: { sqrtPriceX96: bigint; tick: number }, input: {
  rangeBp: number; desired0: bigint; desired1: bigint; slippageBps: number; nativeSide: 0 | 1 | null;
  recipient: Address; deadline: bigint; allowance0: bigint; allowance1: bigint;
}): MintPlan {
  const npm = npmOf(pool.chain, pool.dex);
  if (!npm) throw new Error(`no position manager for ${pool.dex} on ${pool.chain}`);
  const [tickLower, tickUpper] = rangeTicks(slot0.tick, input.rangeBp, pool.tickSpacing);
  const amounts = mintAmounts(slot0.sqrtPriceX96, tickLower, tickUpper, input.desired0, input.desired1, input.slippageBps);
  if (amounts.liquidity === 0n) throw new Error('amount too small');
  const approvals = approvalsNeeded(pool.chain, npm, [
    ...(input.nativeSide === 0 ? [] : [{ token: pool.token0, amount: input.desired0, allowance: input.allowance0 }]),
    ...(input.nativeSide === 1 ? [] : [{ token: pool.token1, amount: input.desired1, allowance: input.allowance1 }]),
  ]);
  const mint = mintCall({ ...pool, tickLower, tickUpper, amounts, recipient: input.recipient, deadline: input.deadline, nativeSide: input.nativeSide });
  return { tickLower, tickUpper, amounts, approvals, mint };
}

// ---- removing liquidity ----
const MAX_U128 = (1n << 128n) - 1n;
/** the position-manager calls for reading and removing a position (the same on Uniswap v3, PancakeSwap v3, Slipstream) */
export const NPM_READ = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  // Uniswap / PancakeSwap: field 4 is the fee; Slipstream: the tick spacing (both fit an int24/uint24 word)
  { type: 'function', name: 'positions', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [
    { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
    { name: 'feeOrSpacing', type: 'int24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
    { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' }, { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
  ] },
] as const;
const NPM_WRITE = [
  { type: 'function', name: 'decreaseLiquidity', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ] }], outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'function', name: 'collect', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' },
  ] }], outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
] as const;
export const COLLECT_ABI = NPM_WRITE;

export interface Position { tokenId: bigint; token0: Address; token1: Address; feeOrSpacing: number; tickLower: number; tickUpper: number; liquidity: bigint }

/** whether a position belongs to this pool (same tokens and fee — Slipstream: tick spacing) */
export function inPool(pos: Position, pool: LpPool): boolean {
  return pos.token0.toLowerCase() === pool.token0.toLowerCase() && pos.token1.toLowerCase() === pool.token1.toLowerCase()
    && pos.feeOrSpacing === (isSlipstream(pool.dex) ? pool.tickSpacing : pool.fee);
}

/**
 * Taking `share` (basis points of the position, 1..10000) out: the liquidity, what it is worth now, and the minimums
 * under a price move of up to `slippageBps` (each token at its worse price, as the Uniswap SDK's burn rule).
 */
export function removeAmounts(sp: bigint, pos: Position, shareBps: number, slippageBps: number): { liquidity: bigint; amount0: bigint; amount1: bigint; amount0Min: bigint; amount1Min: bigint } {
  if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps > 10_000) throw new RangeError('share');
  const s = BigInt(Math.round(slippageBps));
  if (s < 0n || s >= BPS) throw new RangeError('slippage');
  const liquidity = shareBps === 10_000 ? pos.liquidity : (pos.liquidity * BigInt(shareBps)) / BPS;
  const sa = sqrtRatioAtTick(pos.tickLower), sb = sqrtRatioAtTick(pos.tickUpper);
  const [amount0, amount1] = amountsForLiquidity(sp, sa, sb, liquidity, false);
  // a rising price leaves less token0, a falling one less token1
  const [min0] = amountsForLiquidity(movedSqrt(sp, s), sa, sb, liquidity, false);
  const [, min1] = amountsForLiquidity(movedSqrt(sp, -s), sa, sb, liquidity, false);
  return { liquidity, amount0, amount1, amount0Min: min0 < amount0 ? min0 : amount0, amount1Min: min1 < amount1 ? min1 : amount1 };
}

/** collect everything owed (fees + what was decreased) to the wallet — the same call simulated shows the uncollected fees */
export function collectCall(chain: string, dex: string, tokenId: bigint, recipient: Address): Call {
  const npm = npmOf(chain, dex);
  if (!npm) throw new Error(`no position manager for ${dex} on ${chain}`);
  return { to: npm, data: encodeFunctionData({ abi: NPM_WRITE, functionName: 'collect', args: [{ tokenId, recipient, amount0Max: MAX_U128, amount1Max: MAX_U128 }] }), value: 0n };
}

/**
 * One transaction: decrease the liquidity (with minimums and a deadline), then collect it all — principal and fees —
 * to the wallet itself. `liquidity` 0 = fees only (collect).
 */
export function removeCall(chain: string, dex: string, tokenId: bigint, amounts: { liquidity: bigint; amount0Min: bigint; amount1Min: bigint }, recipient: Address, deadline: bigint): Call {
  const collect = collectCall(chain, dex, tokenId, recipient);
  if (amounts.liquidity === 0n) return collect;
  const decrease = encodeFunctionData({ abi: NPM_WRITE, functionName: 'decreaseLiquidity', args: [{ tokenId, liquidity: amounts.liquidity, amount0Min: amounts.amount0Min, amount1Min: amounts.amount1Min, deadline }] });
  return { to: collect.to, data: encodeFunctionData({ abi: NPM_WRITE, functionName: 'multicall', args: [[decrease, collect.data]] }), value: 0n };
}
