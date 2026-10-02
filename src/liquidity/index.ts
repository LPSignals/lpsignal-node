/**
 * `lpsignal/liquidity` — add and remove concentrated liquidity from your own wallet, on the pools' official position
 * managers (Uniswap v3, PancakeSwap v3, Aerodrome / Velodrome Slipstream): no LPSignal contract, no fee, the position
 * always minted to / collected by your own address. Uses viem (a peer dependency): you pass a PublicClient to read the
 * chain and, to send, your own WalletClient — your keys never reach this SDK.
 *
 *   const pool = (await lps.pool('base', '0x…')).pool;            // tokens, decimals, fee, tick spacing
 *   const plan = await planAddLiquidity(publicClient, pool, { owner, amount0: parseEther('1'), rangeBp: 500 });
 *   await sendPlan(walletClient, publicClient, [...plan.approvals, plan.mint]);
 *
 * Never re-send a mint whose receipt you have not seen: a second one would add the same amounts again (sendPlan
 * throws TxPending with the hash instead of guessing).
 */
import { defineChain, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  CHAIN_ID, COLLECT_ABI, ERC20, isSlipstream, NPM, NPM_READ, otherAmount, planMint, rangeTicks, removeAmounts, removeCall, SLOT0,
  type Call, type LpPool, type MintPlan, type Position,
} from './core.js';

export * from './core.js';

/** a pool as the API returns it (`client.pool(chain, address).pool`) — only these fields are used */
export interface PoolInfo { chain: string; address: string; dex: string; token0: string; token1: string; decimals0: number; decimals1: number; fee: number; tickSpacing: number }

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_DEADLINE_S = 20 * 60;

function lpPool(p: PoolInfo): LpPool {
  if (!NPM[p.chain]?.[p.dex as keyof (typeof NPM)[string]]) throw new Error(`adding liquidity is not supported for ${p.dex} on ${p.chain} (Uniswap v4: use the Uniswap app)`);
  return { chain: p.chain, dex: p.dex, address: p.address as Address, token0: p.token0 as Address, token1: p.token1 as Address, decimals0: p.decimals0, decimals1: p.decimals1, fee: p.fee, tickSpacing: p.tickSpacing };
}

async function assertChain(client: PublicClient, chain: string): Promise<void> {
  const id = await client.getChainId();
  if (id !== CHAIN_ID[chain]) throw new Error(`the client is on chain ${id}, the pool on ${chain} (${CHAIN_ID[chain]})`);
}

export interface AddOptions {
  /** the wallet that pays and receives the position */
  owner: Address;
  /** what to put in, in raw units; give one side and the other is computed for the range at the current price */
  amount0?: bigint; amount1?: bigint;
  /** half-width of the range in basis points of price around the current price (500 = ±5%); 0 = full range */
  rangeBp: number;
  /** the largest price move tolerated before the transaction lands (default 50 = 0.5%) */
  slippageBps?: number;
  /** pay this side in the chain's native coin (it must be the wrapped native token) */
  nativeSide?: 0 | 1 | null;
  /** seconds until the mint expires (default 20 minutes) */
  deadlineS?: number;
}
/** a transaction of a plan, bound to the chain and the account it was planned for (sendPlan checks both) */
export interface PlanCall extends Call { chainId: number; from: Address }
export interface AddPlan extends Omit<MintPlan, 'approvals' | 'mint'> { approvals: PlanCall[]; mint: PlanCall; amount0: bigint; amount1: bigint; deadline: number }
const bind = (c: Call, chain: string, from: Address): PlanCall => ({ ...c, chainId: CHAIN_ID[chain]!, from });

/** the approvals (exact amounts) and the mint for adding liquidity now, read from the chain */
export async function planAddLiquidity(client: PublicClient, pool: PoolInfo, o: AddOptions): Promise<AddPlan> {
  const lp = lpPool(pool);
  await assertChain(client, lp.chain);
  const npm = NPM[lp.chain]![lp.dex as keyof (typeof NPM)[string]]!;
  const [[sqrtPriceX96, tick], allowance0, allowance1] = await Promise.all([
    client.readContract({ address: lp.address, abi: SLOT0, functionName: 'slot0' }),
    client.readContract({ address: lp.token0, abi: ERC20, functionName: 'allowance', args: [o.owner, npm] }),
    client.readContract({ address: lp.token1, abi: ERC20, functionName: 'allowance', args: [o.owner, npm] }),
  ]);
  let amount0 = o.amount0, amount1 = o.amount1;
  if (amount0 === undefined && amount1 === undefined) throw new Error('give amount0 or amount1');
  const [lo, hi] = rangeTicks(tick, o.rangeBp, lp.tickSpacing);
  if (amount1 === undefined) amount1 = otherAmount(0, amount0!, sqrtPriceX96, lo, hi) ?? 0n;
  if (amount0 === undefined) amount0 = otherAmount(1, amount1, sqrtPriceX96, lo, hi) ?? 0n;
  const deadline = Math.floor(Date.now() / 1000) + (o.deadlineS ?? DEFAULT_DEADLINE_S);
  const plan = planMint(lp, { sqrtPriceX96, tick }, {
    rangeBp: o.rangeBp, desired0: amount0, desired1: amount1, slippageBps: o.slippageBps ?? DEFAULT_SLIPPAGE_BPS, nativeSide: o.nativeSide ?? null,
    recipient: o.owner, deadline: BigInt(deadline), allowance0, allowance1,
  });
  return { ...plan, approvals: plan.approvals.map((c) => bind(c, lp.chain, o.owner)), mint: bind(plan.mint, lp.chain, o.owner), amount0, amount1, deadline };
}

export interface WalletPosition extends Position { chain: string; dex: string; npm: Address; pool: Address }
/** NFTs read per multicall page */
const PAGE = 200;
const FACTORY = [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const GET_POOL_FEE = [{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }] as const;
const GET_POOL_SPACING = [{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'int24' }], outputs: [{ type: 'address' }] }] as const;

/**
 * The wallet's positions on one chain's position managers that still hold liquidity or fees, each with its pool
 * (from the manager's factory). Positions staked in a Slipstream gauge belong to the gauge and are not listed.
 */
export async function positions(client: PublicClient, chain: string, owner: Address): Promise<WalletPosition[]> {
  await assertChain(client, chain);
  const out: WalletPosition[] = [];
  // one snapshot for every read: NFTs moving between pages (ERC721Enumerable swaps the last one into a hole) could
  // otherwise hide a live position or fail the walk
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  for (const [dex, npm] of Object.entries(NPM[chain] ?? {}) as [string, Address][]) {
    const n = await client.readContract({ address: npm, abi: NPM_READ, functionName: 'balanceOf', args: [owner], blockNumber });
    if (n === 0n) continue;
    // every NFT the wallet holds, a page at a time (emptied positions are never burned: they keep their indexes, so
    // stopping at the first N could hide a live position behind them)
    const readPositions = (part: bigint[]) => client.multicall({ contracts: part.map((id) => ({ address: npm, abi: NPM_READ, functionName: 'positions' as const, args: [id] as const })), allowFailure: false, multicallAddress: MULTICALL3, blockNumber });
    const ids: bigint[] = [];
    const raw: Awaited<ReturnType<typeof readPositions>> = [];
    for (let from = 0n; from < n; from += BigInt(PAGE)) {
      const count = Number(n - from < BigInt(PAGE) ? n - from : BigInt(PAGE));
      const part = await client.multicall({
        contracts: Array.from({ length: count }, (_, i) => ({ address: npm, abi: NPM_READ, functionName: 'tokenOfOwnerByIndex' as const, args: [owner, from + BigInt(i)] as const })),
        allowFailure: false, multicallAddress: MULTICALL3, blockNumber,
      });
      ids.push(...part);
      raw.push(...await readPositions(part));
    }
    const live = raw.map((p, i) => ({ id: ids[i]!, p })).filter(({ p }) => p[7] > 0n || p[10] > 0n || p[11] > 0n);
    if (!live.length) continue;
    const factory = await client.readContract({ address: npm, abi: FACTORY, functionName: 'factory', blockNumber });
    const pools = await client.multicall({
      contracts: live.map(({ p }) => (isSlipstream(dex)
        ? { address: factory, abi: GET_POOL_SPACING, functionName: 'getPool' as const, args: [p[2], p[3], p[4]] as const }
        : { address: factory, abi: GET_POOL_FEE, functionName: 'getPool' as const, args: [p[2], p[3], p[4]] as const })),
      allowFailure: false, multicallAddress: MULTICALL3, blockNumber,
    });
    live.forEach(({ id, p }, i) => out.push({
      chain, dex, npm, pool: (pools[i] as string).toLowerCase() as Address,
      tokenId: id, token0: p[2], token1: p[3], feeOrSpacing: p[4], tickLower: p[5], tickUpper: p[6], liquidity: p[7],
    }));
  }
  return out;
}

/** what collecting now would pay (fees owed, incl. those accrued since the last update) */
export async function uncollectedFees(client: PublicClient, pos: WalletPosition, owner: Address): Promise<[bigint, bigint]> {
  const MAX = (1n << 128n) - 1n;
  const { result } = await client.simulateContract({ address: pos.npm, abi: COLLECT_ABI, functionName: 'collect', args: [{ tokenId: pos.tokenId, recipient: owner, amount0Max: MAX, amount1Max: MAX }], account: owner });
  return result as [bigint, bigint];
}

export interface RemoveOptions {
  owner: Address;
  /** basis points of the position to take out (10000 = all); 0 = collect the fees only */
  shareBps: number;
  slippageBps?: number;
  deadlineS?: number;
  /**
   * the block of your previous removal from this position (sendPlan's result): the position is read at a block at
   * least this new, else StaleRead — a lagging RPC must never return the liquidity from before it (a repeated partial
   * removal would take the original share again)
   */
  minBlock?: bigint;
}
/** the RPC is behind a block this plan must see */
export class StaleRead extends Error {
  constructor(readonly head: bigint, readonly minBlock: bigint) { super(`the RPC is at block ${head}, behind ${minBlock}: try again shortly`); }
}
export interface RemovePlan { call: PlanCall; liquidity: bigint; amount0: bigint; amount1: bigint; amount0Min: bigint; amount1Min: bigint; deadline: number }

/**
 * One transaction: decrease `shareBps` of what the position holds NOW (read from the chain) and collect it all —
 * principal and fees — to the owner. A repeated partial removal would take that share again: send it once.
 */
export async function planRemoveLiquidity(client: PublicClient, pos: WalletPosition, o: RemoveOptions): Promise<RemovePlan> {
  await assertChain(client, pos.chain);
  const OWNER_OF = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] }] as const;
  // one explicit block for every read, no older than the caller's last removal
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  if (o.minBlock !== undefined && blockNumber < o.minBlock) throw new StaleRead(blockNumber, o.minBlock);
  const [now, holder, [sqrtPriceX96]] = await Promise.all([
    client.readContract({ address: pos.npm, abi: NPM_READ, functionName: 'positions', args: [pos.tokenId], blockNumber }),
    client.readContract({ address: pos.npm, abi: OWNER_OF, functionName: 'ownerOf', args: [pos.tokenId], blockNumber }),
    client.readContract({ address: pos.pool, abi: SLOT0, functionName: 'slot0', blockNumber }),
  ]);
  if (holder.toLowerCase() !== o.owner.toLowerCase()) throw new Error(`position ${pos.tokenId} is held by ${holder}, not ${o.owner}`);
  const live = { ...pos, liquidity: now[7] };
  const deadline = Math.floor(Date.now() / 1000) + (o.deadlineS ?? DEFAULT_DEADLINE_S);
  const a = o.shareBps === 0 || live.liquidity === 0n
    ? { liquidity: 0n, amount0: 0n, amount1: 0n, amount0Min: 0n, amount1Min: 0n }
    : removeAmounts(sqrtPriceX96, live, o.shareBps, o.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  return { ...a, deadline, call: bind(removeCall(pos.chain, pos.dex, pos.tokenId, a, o.owner, BigInt(deadline)), pos.chain, o.owner) };
}

/** a transaction was sent but its receipt was not seen in time: it may still land — do not send it again blindly */
export class TxPending extends Error {
  constructor(readonly hash: Hex, cause?: unknown) { super(`transaction ${hash} sent, its outcome not confirmed yet: check it before sending again`, cause === undefined ? undefined : { cause }); }
}
/** a transaction that landed and reverted */
export class TxReverted extends Error {
  constructor(readonly hash: Hex) { super(`transaction ${hash} reverted`); }
}
/**
 * the wallet failed while sending, without saying whether the transaction went out (no hash): it may have been
 * broadcast. Check whether `nonce` of `from` was used (your wallet's history, or the account's nonce on chain) before
 * sending anything again.
 */
export class TxUnknown extends Error {
  /** `nonce` null = the account's nonce manager chose it: check the wallet's history */
  constructor(readonly from: Address, readonly nonce: number | null, cause: unknown) {
    super(`sending from ${from} failed with an unknown outcome (${nonce === null ? 'nonce chosen by your nonce manager' : `nonce ${nonce}`}): check whether it went out before sending again`, { cause });
  }
}

/**
 * After a send of unknown outcome (TxUnknown, TxPending) or one replaced in the wallet (TxReplaced) nothing more is sent from that account on that chain in this
 * process until you have checked what became of it and call `unblock` — a queued plan would otherwise read the same
 * nonce and replace or duplicate it.
 */
export class AccountBlocked extends Error {
  constructor(readonly chainId: number, readonly account: Address, readonly reason: Error) { super(`sending from ${account} on chain ${chainId} is blocked after an unknown outcome (${reason.message}); check it, then call unblock(${chainId}, '${account}')`); }
}
const blocked = new Map<string, Error>();
const keyOf = (chainId: number, account: string) => `${chainId}:${account.toLowerCase()}`;
/** you checked the transaction that made sending from this account unsafe: sending may go on */
export function unblock(chainId: number, account: Address): void { blocked.delete(keyOf(chainId, account)); }

/** plans of one account on one chain run one after another in this process (they would race for the same nonce) */
const accountQueues = new Map<string, Promise<unknown>>();
function inQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (accountQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  accountQueues.set(key, tail);
  void tail.then(() => { if (accountQueues.get(key) === tail) accountQueues.delete(key); });
  return run;
}
/** a transaction cancelled or replaced by a different one in the wallet: the plan stops (a speed-up is fine) */
export class TxReplaced extends Error {
  constructor(readonly hash: Hex, readonly reason: 'cancelled' | 'replaced', readonly replacement: Hex) { super(`transaction ${hash} was ${reason} by ${replacement}: the plan stopped`); }
}

export interface SendOptions {
  /** how long to wait for each receipt (default 3 min); then TxPending */
  timeoutMs?: number;
  /**
   * also wait until each transaction's block is finalized and still canonical before the next one / returning
   * (recommended before another PARTIAL removal from the same position: a reorg could otherwise drop the first one
   * while the second reads the old liquidity, and both land)
   */
  finalized?: boolean;
}

/** any failure here (RPC error, receipt gone after a reorg, timeout) is TxPending with the hash: never a bare error */
/** the user declined in the wallet (EIP-1193 4001 anywhere in the cause chain) */
function declined(e: unknown): boolean {
  for (let x = e as { code?: number; name?: string; cause?: unknown } | undefined, i = 0; x && i < 6; x = x.cause as typeof x, i++) {
    if (x.code === 4001 || x.name === 'UserRejectedRequestError') return true;
  }
  return false;
}

async function waitFinal(client: PublicClient, block: bigint, hash: Hex, timeoutMs = 60 * 60_000, requireSuccess = true): Promise<void> {
  const until = Date.now() + timeoutMs;
  try {
    for (;;) {
      const fin = await client.getBlock({ blockTag: 'finalized' });
      if (fin.number >= block) {
        const rc = await client.getTransactionReceipt({ hash });
        if (rc.blockNumber !== block || (await client.getBlock({ blockNumber: block })).hash !== rc.blockHash) throw new TxPending(hash); // reorged: unknown again
        // re-executed after a reorg it may have failed this time: only a final, canonical SUCCESS counts
        if (requireSuccess && rc.status !== 'success') throw new TxReverted(hash);
        return;
      }
      if (Date.now() > until) throw new TxPending(hash);
      await new Promise((r) => setTimeout(r, 6_000));
    }
  } catch (e) {
    throw e instanceof TxPending || e instanceof TxReverted ? e : new TxPending(hash, e);
  }
}

/**
 * Sends a plan's calls in order from your wallet, each after the previous one's receipt (approvals before the mint).
 * Every call must be for the chain and the account the wallet is on (refused otherwise). Returns each one's hash and
 * block (pass the last block as `minBlock` to your next removal from the same position). Throws TxReverted, TxReplaced
 * (cancelled or replaced in the wallet; a speed-up of the same call is accepted), or TxPending if a receipt is not seen.
 */
export async function sendPlan(wallet: WalletClient, client: PublicClient, calls: PlanCall[], opts: SendOptions = {}): Promise<{ hash: Hex; blockNumber: bigint }[]> {
  if (!wallet.account) throw new Error('the wallet client needs an account');
  const account = wallet.account;
  const chainId = calls[0]?.chainId ?? 0, key = keyOf(chainId, account.address);
  return inQueue(key, async () => {
    const why = blocked.get(key);
    if (why) throw new AccountBlocked(chainId, account.address, why);
    try {
      return await sendQueued(wallet, client, calls, opts);
    } catch (e) {
      // an outcome the caller must look at before anything else goes out from this account
      if (e instanceof TxUnknown || e instanceof TxPending || e instanceof TxReplaced) blocked.set(key, e);
      throw e;
    }
  });
}

async function sendQueued(wallet: WalletClient, client: PublicClient, calls: PlanCall[], opts: SendOptions): Promise<{ hash: Hex; blockNumber: bigint }[]> {
  if (!wallet.account) throw new Error('the wallet client needs an account');
  const sent: { hash: Hex; blockNumber: bigint }[] = [];
  for (const c of calls) {
    const [walletChain, clientChain] = await Promise.all([wallet.getChainId(), client.getChainId()]);
    if (walletChain !== c.chainId || clientChain !== c.chainId) throw new Error(`the call is for chain ${c.chainId}; the wallet is on ${walletChain}, the public client on ${clientChain}`);
    if (wallet.account.address.toLowerCase() !== c.from.toLowerCase()) throw new Error(`the call was planned for ${c.from}, the wallet is ${wallet.account.address}`);
    // the send itself carries the planned chain: viem checks the wallet is on it and signs/sends with that chainId
    const chain = wallet.chain?.id === c.chainId ? wallet.chain : defineChain({ id: c.chainId, name: `chain ${c.chainId}`, nativeCurrency: { name: 'native', symbol: 'native', decimals: 18 }, rpcUrls: { default: { http: [] } } });
    // the nonce: the account's own nonce manager, if it has one (never overridden); otherwise the account's next one,
    // pinned in the transaction so TxUnknown names the one it used (plans of an account are queued, see inQueue)
    const managed = 'nonceManager' in wallet.account && !!(wallet.account as { nonceManager?: unknown }).nonceManager;
    const nonce = managed ? null : await client.getTransactionCount({ address: c.from, blockTag: 'pending' });
    let hash: Hex;
    try {
      hash = await wallet.sendTransaction({ account: wallet.account, chain, to: c.to, data: c.data, value: c.value, ...(nonce === null ? {} : { nonce }) });
    } catch (e) {
      if (declined(e)) throw e; // declined in the wallet: certainly not sent
      throw new TxUnknown(c.from, nonce, e);
    }
    let replaced: { reason: 'cancelled' | 'replaced'; hash: Hex } | null = null;
    const rc = await client.waitForTransactionReceipt({
      hash, timeout: opts.timeoutMs ?? 180_000,
      // a speed-up (same call, new fee) counts; a cancel or another transaction in its place stops the plan
      onReplaced: (x) => { if (x.reason !== 'repriced') replaced = { reason: x.reason, hash: x.transaction.hash }; },
    }).catch(() => null);
    // finalized: the final canonical receipt decides (a first revert may re-run and succeed after a reorg, and the
    // other way round): a resend on a first, unfinal outcome could double the operation
    if (opts.finalized && rc && !replaced) {
      await waitFinal(client, rc.blockNumber, rc.transactionHash);
      sent.push({ hash: rc.transactionHash, blockNumber: rc.blockNumber });
      continue;
    }
    if (replaced && rc && opts.finalized) {
      // the replacement must be final too: a reorg dropping a cancel could let the original run after all
      await waitFinal(client, rc.blockNumber, rc.transactionHash, undefined, false);
    }
    if (replaced) throw new TxReplaced(hash, (replaced as { reason: 'cancelled' | 'replaced' }).reason, (replaced as { hash: Hex }).hash);
    if (!rc) throw new TxPending(hash);
    if (rc.status !== 'success') throw new TxReverted(rc.transactionHash);
    sent.push({ hash: rc.transactionHash, blockNumber: rc.blockNumber });
  }
  return sent;
}
