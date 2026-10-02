/**
 * Swapping one pool token for the other (e.g. to top up an add) through the KyberSwap aggregator, with LPSignal's fee:
 * `swapFeeBps` of the input, sent by the router to SWAP_FEE_RECEIVER — the same code the lpsignal.app web app runs,
 * kept in step with it. Your own wallet sends it; nothing of LPSignal's holds funds.
 *
 * The aggregator's answers are never trusted as they come: the quote must be within `maxImpactBps` of the pool's own
 * price (read on chain), and the calldata is decoded and checked before the wallet is asked — the router, `swap()`
 * only, tokens, amount, the recipient = the wallet, our fee and no other, the exact flags, no permit, and a minimum out
 * no lower than the pool price allows. The router itself pays the recipient at least that minimum or reverts.
 */
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';
import type { Call } from './core.js';

export const KYBER_ROUTER: Address = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
export const SWAP_FEE_RECEIVER: Address = '0x13ac5bf01871ec16a9a5276f1e167da846af6a33';
/** the aggregator's name for a chain's native coin */
export const KYBER_NATIVE: Address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'lpsignal';
/** what a build from our quotes carries: _FEE_IN_BPS (0x80) + the base flag (0x200); fee on the output (0x40), partial
 * fills (0x01) or burning/claiming (0x04/0x08/0x10) would change what the user signs: refused */
const FLAGS = 0x280n;
const BPS = 10_000n;

/** our fee: 0.05% between stablecoins, else 0.25% (of the input) */
export const swapFeeBps = (pairClass: string): number => (pairClass === 'stable' ? 5 : 25);
/** how far the quote may fall short of the pool's own price (pool fees, route costs, impact) before it is refused */
export const maxImpactBps = (pairClass: string): number => (pairClass === 'stable' ? 50 : pairClass === 'correlated' ? 100 : 300);

export class SwapRefused extends Error {
  constructor(public readonly reason: 'impact' | 'quote' | 'calldata' | 'simulation' | 'moved', detail: string) { super(`swap refused (${reason}): ${detail}`); }
}

export interface SwapSide { token: Address; native: boolean }
const kyberToken = (s: SwapSide) => (s.native ? KYBER_NATIVE : s.token.toLowerCase() as Address);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface Quote { summary: Record<string, unknown>; amountIn: bigint; amountOut: bigint }

async function call(url: string, init: RequestInit = {}): Promise<{ code: number; message?: string; data?: Record<string, unknown> }> {
  const res = await fetch(url, { ...init, headers: { 'x-client-id': CLIENT_ID, ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(15_000) });
  return res.json() as Promise<{ code: number; message?: string; data?: Record<string, unknown> }>;
}

/** the best route for `amountIn` with our fee in it (its echo checked: tokens, amount, fee, router) */
export async function fetchQuote(chain: string, from: SwapSide, to: SwapSide, amountIn: bigint, feeBps: number): Promise<Quote> {
  const q = new URLSearchParams({
    tokenIn: kyberToken(from), tokenOut: kyberToken(to), amountIn: amountIn.toString(),
    feeAmount: String(feeBps), isInBps: 'true', chargeFeeBy: 'currency_in', feeReceiver: SWAP_FEE_RECEIVER,
    // market makers' signed quotes expire within seconds: a wallet confirmation could outlast them (a revert, gas lost)
    excludeRFQSources: 'true',
  });
  const r = await call(`${API}/${chain}/api/v1/routes?${q}`);
  const s = r.data?.routeSummary as Record<string, unknown> | undefined;
  if (r.code !== 0 || !s) throw new SwapRefused('quote', r.message ?? 'no route');
  const fee = s.extraFee as Record<string, unknown> | undefined;
  if (!same(String(s.tokenIn), kyberToken(from)) || !same(String(s.tokenOut), kyberToken(to)) || BigInt(String(s.amountIn)) !== amountIn
    || String(fee?.feeAmount) !== String(feeBps) || fee?.chargeFeeBy !== 'currency_in' || fee?.isInBps !== true || !same(String(fee?.feeReceiver), SWAP_FEE_RECEIVER)
    || !same(String(r.data!.routerAddress), KYBER_ROUTER)) throw new SwapRefused('quote', 'the route does not match the request');
  return { summary: s, amountIn, amountOut: BigInt(String(s.amountOut)) };
}

/** the swap transaction for a quote (to be checked with checkSwapCall before sending) */
export async function buildSwap(chain: string, q: Quote, account: Address, slippageBps: number, deadline: number): Promise<Call> {
  const r = await call(`${API}/${chain}/api/v1/route/build`, {
    method: 'POST', body: JSON.stringify({ routeSummary: q.summary, sender: account, recipient: account, slippageTolerance: slippageBps, deadline, source: CLIENT_ID }),
  });
  const d = r.data;
  if (r.code !== 0 || !d || typeof d.data !== 'string') throw new SwapRefused('quote', r.message ?? 'no calldata');
  return { to: getAddress(String(d.routerAddress)), data: d.data as Hex, value: BigInt(String(d.transactionValue ?? '0')) };
}

/** what `amountIn` buys at the pool's own price, after our fee (raw units; sqrtPriceX96 = √(token1/token0)) */
export function spotOut(sqrtPriceX96: bigint, inIsToken0: boolean, amountIn: bigint, feeBps: number): bigint {
  const net = (amountIn * (BPS - BigInt(feeBps))) / BPS;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return inIsToken0 ? (net * p2) >> 192n : (net << 192n) / p2;
}

/** the least a swap may promise: the pool price, less the impact allowed, less the slippage */
export const minOutFloor = (spot: bigint, impactBps: number, slippageBps: number): bigint =>
  (((spot * (BPS - BigInt(impactBps))) / BPS) * (BPS - BigInt(slippageBps))) / BPS;

/**
 * The minimum a built swap must promise: no lower than the pool-price floor, the shortfall it is for (`need`), or the
 * quote less the user's slippage — with 0.01% for the build's rounding (it re-reads the route, a unit or so under).
 */
export function requiredMinOut(o: { spot: bigint; impactBps: number; slippageBps: number; need: bigint; quoteOut: bigint }): bigint {
  const quoteMin = (o.quoteOut * (BPS - BigInt(o.slippageBps) - 1n)) / BPS;
  return [minOutFloor(o.spot, o.impactBps, o.slippageBps), o.need, quoteMin].reduce((a, b) => (a > b ? a : b));
}

const ROUTER_ABI = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);
export { ROUTER_ABI as KYBER_ROUTER_ABI };

/** throws SwapRefused unless the call is exactly the swap meant: see the module comment */
export function checkSwapCall(c: Call, exp: { from: SwapSide; to: SwapSide; amountIn: bigint; account: Address; feeBps: number; minOut: bigint }): void {
  const bad = (what: string): never => { throw new SwapRefused('calldata', what); };
  if (!same(c.to, KYBER_ROUTER)) bad('router');
  let desc;
  try {
    const d = decodeFunctionData({ abi: ROUTER_ABI, data: c.data });
    if (d.functionName !== 'swap') bad('function');
    desc = d.args[0].desc;
  } catch (e) {
    if (e instanceof SwapRefused) throw e;
    return bad('undecodable');
  }
  if (!same(desc.srcToken, kyberToken(exp.from)) || !same(desc.dstToken, kyberToken(exp.to))) bad('tokens');
  if (desc.amount !== exp.amountIn) bad('amount');
  if (c.value !== (exp.from.native ? exp.amountIn : 0n)) bad('value');
  if (!same(desc.dstReceiver, exp.account)) bad('recipient');
  if (desc.feeReceivers.length !== 1 || !same(desc.feeReceivers[0]!, SWAP_FEE_RECEIVER) || desc.feeAmounts.length !== 1 || desc.feeAmounts[0] !== BigInt(exp.feeBps)) bad('fee');
  if (desc.flags !== FLAGS) bad('flags');
  if (desc.permit !== '0x') bad('permit');
  // a token input: the router hands the executor the amount less our fee, no more (native: carried as value)
  if (!exp.from.native && desc.srcAmounts.reduce((a, b) => a + b, 0n) !== exp.amountIn - (exp.amountIn * BigInt(exp.feeBps)) / BPS) bad('split');
  if (desc.minReturnAmount < exp.minOut || desc.minReturnAmount === 0n) bad('minimum');
}
