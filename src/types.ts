/**
 * Response shapes of the LPSignal API (https://api.lpsignal.app/v1).
 *
 * Conventions:
 * - APRs and ratios are fractions: 0.345 = 34.5%.
 * - `ilApr` / `il7d` are the loss versus holding the two tokens, so they are ≤ 0, and `netApr = feeApr + ilApr`.
 * - `fee` is in hundredths of a basis point: 500 = the 0.05% fee tier.
 * - `rangeBp` is the range half-width in basis points of price: 500 = ±5%, 0 = full range.
 * - Ids and 256-bit values are strings; timestamps are ISO 8601 strings in UTC.
 */

/** Chains scanned today. The API may add more, so any string is accepted. */
export type Chain = 'ethereum' | 'bsc' | 'base' | 'arbitrum' | 'optimism' | 'polygon' | (string & {});
export type PairClass = 'stable' | 'correlated' | 'volatile';
export type WindowHours = 24 | 168 | 720;
export type Tier = 'free' | 'basic' | 'pro';
export type SignalKind = 'net_apr' | 'tvl_outflow' | 'depeg' | 'smart_lp';

export interface Health { ok: boolean }

export interface ChainStatus {
  chain: Chain;
  /** last block scanned */
  block: string;
  blockTs: string;
  /** the first block this deployment scanned: history before it is not available */
  firstBlockTs: string;
  /** seconds between now and the last block scanned; chains more than 2h behind fire no signals */
  lagSec: number;
  activePools: number;
}

export interface BestRange {
  windowHours: WindowHours;
  rangeBp: number;
  tickLower: number;
  tickUpper: number;
  /** fees measured from on-chain fee growth (only exact metrics fire signals) */
  exact: boolean;
  feeApr: number;
  ilApr: number;
  netApr: number;
  inRangeRatio: number;
  /** Slipstream: gauge emissions if staked instead (fees forgone, not backtested); 0 = not applicable */
  stakedEmissionApr: number;
  asOf: string;
}

export interface RankedPool {
  chain: Chain;
  /** 20-byte pool address, or the 32-byte pool id for Uniswap v4 */
  address: string;
  dex: string;
  /** "SYMBOL0/SYMBOL1" */
  pair: string;
  fee: number;
  pairClass: PairClass;
  /** v4 pools: liquidity within ±2% of price, since v4 has no per-pool balances */
  tvlUsd: number;
  tvlAt: string | null;
  best: BestRange;
}

export interface PoolsPage { pools: RankedPool[]; limit: number; offset: number }

export interface Pool {
  id: string;
  chain: Chain;
  address: string;
  status: string;
  reason: string;
  dex: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  fee: number;
  tickSpacing: number;
  lpShare0: number;
  lpShare1: number;
  pairClass: PairClass;
  gauge: string;
  tvlUsd: number;
  tvlAt: string | null;
  paramsAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PoolMetric {
  poolId: string;
  windowHours: WindowHours;
  rangeBp: number;
  feeApr: number;
  ilApr: number;
  netApr: number;
  inRangeRatio: number;
  emissionApr: number;
  tickLower: number;
  tickUpper: number;
  exact: boolean;
  asOf: string;
  createdAt: string;
  updatedAt: string;
}

export interface PoolDetail { pool: Pool; metrics: PoolMetric[] }

export interface PoolHour {
  /** start of the hour */
  hour: string;
  swaps: number;
  /** raw token units (not decimal-adjusted) */
  volume0: number;
  volume1: number;
  /** fees earned per unit of in-range liquidity during the hour, raw token units */
  fee0PerL: number;
  fee1PerL: number;
  openTick: number;
  closeTick: number;
  minTick: number;
  maxTick: number;
  /** uint128 liquidity, as a decimal string */
  closeLiquidity: string;
  /** fees come from on-chain fee growth rather than a Swap-log estimate */
  feeExact: boolean;
}

export interface Backtest {
  chain: Chain;
  address: string;
  rangeBp: number;
  days: number;
  asOf: string;
  feeApr: number;
  ilApr: number;
  netApr: number;
  inRangeRatio: number;
  /** fees of hours that straddled a range edge: the true fee APR lies in [feeApr, feeApr + uncertainFeeApr] */
  uncertainFeeApr: number;
  startTick: number;
  endTick: number;
  tickLower: number;
  tickUpper: number;
  feesExact: boolean;
  exact: boolean;
}

export interface SignalOutcome {
  /** done = exact 7-day result; inexact = fees could not be attributed precisely (not a result) */
  status: 'done' | 'inexact';
  netApr: number | null;
  feeApr: number | null;
  ilApr: number | null;
  evaluatedAt: string;
}

interface SignalBase {
  /** increasing; resume streams and paging from it */
  id: string;
  firedAt: string;
  chain: Chain;
  dex: string;
  pool: string;
  pair: string;
  fee: number;
  pairClass: PairClass;
  rangeBp: number;
  entryTick: number;
  tickLower: number;
  tickUpper: number;
  /** only opportunities are scored; null until 7 days have passed (and always null for other kinds) */
  outcome: SignalOutcome | null;
}

/** An opportunity: the recommended position is `tickLower..tickUpper`. */
export interface NetAprSignal extends SignalBase {
  kind: 'net_apr';
  tvlUsd: number;
  net24h: number;
  net7d: number;
  /** null until the pool has 30 days of history */
  net30d: number | null;
  fee7d: number;
  il7d: number;
  inRange7d: number;
  stakedEmissionApr?: number;
}

/** Liquidity fell by `drop` within `windowHours`, valued at current prices. */
export interface TvlOutflowSignal extends SignalBase {
  kind: 'tvl_outflow';
  tvlBeforeUsd: number;
  tvlNowUsd: number;
  drop: number;
  windowHours: number;
}

/** token0 trades `deviation` away from its 7-day median against token1. */
export interface DepegSignal extends SignalBase {
  kind: 'depeg';
  deviation: number;
  severe: boolean;
  medianTick: number;
  tick: number;
}

/** A top-ranked or followed wallet opened a position (Pro). */
export interface SmartLpSignal extends SignalBase {
  kind: 'smart_lp';
  owner: string;
  tokenId: string;
  entryUsd: number;
  top: boolean;
  rank: number | null;
  wallet30d: { positions: number; pnlUsd: number; returnPct: number } | null;
}

export type Signal = NetAprSignal | TvlOutflowSignal | DepegSignal | SmartLpSignal;

export interface SignalsPage {
  signals: Signal[];
  /** pass as `before` for the next (older) page; null on the last page */
  next: string | null;
}

export interface LeaderboardWallet {
  rank: number;
  /** masked (0x1234…abcd) unless the caller is on Pro */
  owner: string;
  positions: number;
  wins: number;
  capitalUsd: number;
  /** LP result minus simply holding the deposited tokens */
  pnlUsd: number;
  returnPct: number;
  chains: Chain[];
}

export interface Leaderboard {
  windowDays: 30 | 90;
  /** false = top 10 with masked addresses (not Pro) */
  full: boolean;
  wallets: LeaderboardWallet[];
}

interface PositionPool { chain: Chain; pool: string; pair: string; dex: string; fee: number }

export interface OpenPosition extends PositionPool {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  openedAt: string | null;
  staked: boolean;
  entryUsd: number | null;
}

export interface ClosedPosition extends PositionPool {
  tokenId: string;
  lifecycle: number;
  tickLower: number;
  tickUpper: number;
  openedAt: string | null;
  closedAt: string;
  /** false = funded by several holders, staked, or first seen mid-life: not counted in rankings */
  scoreable: boolean;
  capitalUsd: number | null;
  pnlUsd: number | null;
}

export interface WalletPositions { owner: string; open: OpenPosition[]; closed: ClosedPosition[] }

export interface Me {
  id: string;
  tier: Tier;
  paid: boolean;
  telegramLinked: boolean;
  webhookUrl: string | null;
  /** the wallet the account signs in with on lpsignal.app (null for API-key-only accounts) */
  walletAddress: string | null;
  hasApiKey: boolean;
}

/** Track record of opportunity signals with a known 7-day outcome, over the last `days`. */
export interface SignalStats {
  days: number;
  /** exact outcomes (the only ones in the numbers below) */
  scored: number;
  /** evaluated without exact fees: never counted as a result */
  inexact: number;
  positive: number;
  medianRealizedNetApr: number | null;
  medianSignalNetApr: number | null;
  worst: { id: string; pair: string; chain: Chain; netApr: number } | null;
  /** at-signal vs realized net APR of the most recent (up to 500) scored signals */
  points: { id: string; signalNetApr: number; realizedNetApr: number }[];
}

export interface WebhookRegistration {
  url: string;
  /** shown only here: store it to verify deliveries */
  secret: string;
}

export interface TelegramLink { code: string; instruction: string }

export interface Follow { owner: string; since: string }

export interface BillingStatus {
  tier: Tier;
  manual: { tier: string; until: string | null };
  stripe: { tier: string | null; until: string | null; status: string | null; invoiceUnpaidSince: string | null; syncedAt: string | null };
  onSale: { basic: boolean; pro: boolean };
}

/** The body of a webhook delivery. */
export interface WebhookEvent {
  type: 'signal';
  /** unique per delivery: deliveries are at-least-once, so skip ids already handled */
  deliveryId: string;
  signal: Signal;
}
