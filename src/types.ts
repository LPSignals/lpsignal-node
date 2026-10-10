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
export type Chain = 'ethereum' | 'bsc' | 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'robinhood' | (string & {});
export type PairClass = 'stable' | 'correlated' | 'volatile';
export type WindowHours = 1 | 24 | 168 | 720;
export type Tier = 'free' | 'basic' | 'pro';
export type SignalKind = 'net_apr' | 'burst' | 'hot_pool' | 'tvl_outflow' | 'depeg' | 'smart_lp';

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
  /** pools list only: the same range's net APR over the last 24h (null = not computed) */
  net24h?: number | null;
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
  /**
   * the last 24h in USD at the latest prices; null = no price yet. fees = an ESTIMATE of the swap fees paid: volume ×
   * the pool's current fee rate, before protocol cuts (dynamic-fee pools: approximate) — not what LPs were paid
   */
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  /** the pool-level 24h APR DEX sites show (estimated 24h fees / TVL x 365; ignores impermanent loss); null for v4 */
  poolApr24h: number | null;
  best: BestRange;
}

export type Order = 'asc' | 'desc';
/** what `pools` can sort by: the best range's figures, the pool's TVL or fee tier */
export type PoolSort = 'netApr' | 'feeApr' | 'ilApr' | 'inRange' | 'emissionApr' | 'tvl' | 'fee' | 'volume24h' | 'fees24h' | 'poolApr';
/** what `signals` can sort by: time (newest first, cursor), return (APR at firing), outcome (realised result) */
export type SignalSort = 'time' | 'return' | 'outcome';
export interface PoolsPage { pools: RankedPool[]; limit: number; offset: number; total: number; sort: PoolSort; order: Order }

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
  /** set when one of your custom rules produced this signal (private to you, never scored); null otherwise */
  rule: { id: string; name: string } | null;
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

/**
 * A short-term opportunity: a very high net APR over the last `windowHours` (1) on real trading (`swaps` in the window).
 * Noisier than `net_apr`; scored on the 24 hours after it fires. Pushed only to accounts subscribed to `burst`.
 * The figures are for the window, whatever its length.
 */
export interface BurstSignal extends SignalBase {
  kind: 'burst';
  tvlUsd: number;
  windowHours: number;
  swaps: number;
  netApr: number;
  feeApr: number;
  ilApr: number;
  inRangeRatio: number;
  /** context, exact values only (null when not exact) */
  net24h: number | null;
  net7d: number | null;
  stakedEmissionApr?: number;
}

/**
 * High yield, high risk: a big pool (TVL $500k+) whose pool-level 24h fee APR — estimated 24h fees / TVL x 365, as DEX
 * sites show it — reached 50%+ and at least twice its own 7-day average. A pool-level figure, not a recommended
 * position (`tickLower`/`tickUpper` are 0), never scored (`outcome` stays null). Impermanent loss can exceed the fees:
 * `bestNet24h` is what the best range netted over the same day (fees − IL; `bestRangeBp` says which), null without a
 * 24h backtest. Pushed only to accounts subscribed to `hot_pool`.
 */
export interface HotPoolSignal extends SignalBase {
  kind: 'hot_pool';
  tvlUsd: number;
  poolApr24h: number;
  poolApr7d: number;
  volume24hUsd: number;
  fees24hUsd: number;
  bestNet24h: number | null;
  bestRangeBp: number | null;
  risk: 'high';
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

export type Signal = NetAprSignal | BurstSignal | HotPoolSignal | TvlOutflowSignal | DepegSignal | SmartLpSignal;

export interface SignalsPage {
  signals: Signal[];
  /** pass as `before` for the next (older) page; null on the last page (and always when sorted) */
  next: string | null;
  /** sorted by return / outcome only */
  total?: number;
  offset?: number;
  sort?: SignalSort;
  order?: Order;
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
  /** annualised return vs holding over the capital × time deployed; null = no close with a known opening */
  aprVsHold: number | null;
  /** closes with a positive pnl / closes */
  winRate: number;
  /** capital-weighted hours a position was held */
  avgHoldH: number | null;
}

export interface Leaderboard {
  windowDays: 30 | 90;
  /** false = top 10 with masked addresses (not Pro) */
  full: boolean;
  wallets: LeaderboardWallet[];
  /** wallets on the board for this caller (non-Pro: at most 10) */
  total: number;
  limit: number;
  offset: number;
  sort: BoardSort;
  order: Order;
}
/** what `smartLps` can sort by; `rank` (the pnl rank) stays the wallet's rank whatever the sort */
export type BoardSort = 'rank' | 'pnl' | 'return' | 'capital' | 'closes' | 'wins' | 'apr' | 'winRate';

interface PositionPool { chain: Chain; pool: string; pair: string; dex: string; fee: number }

export interface OpenPosition extends PositionPool {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  openedAt: string | null;
  staked: boolean;
  entryUsd: number | null;
  /** the pool's tick now (its latest hourly close): in range when tickLower <= poolTick < tickUpper; null = unknown */
  poolTick: number | null;
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

export interface WalletPositions {
  owner: string;
  open: OpenPosition[];
  closed: ClosedPosition[];
  openTotal: number;
  closedTotal: number;
  limit: number;
  openOffset: number;
  closedOffset: number;
}
export type OpenSort = 'lastEvent' | 'openedAt' | 'entryUsd';
export type ClosedSort = 'closedAt' | 'openedAt' | 'capitalUsd' | 'pnlUsd';

export interface Me {
  id: string;
  tier: Tier;
  paid: boolean;
  telegramLinked: boolean;
  webhookUrl: string | null;
  /** the wallet the account signs in with on lpsignal.app (null for API-key-only accounts) */
  walletAddress: string | null;
  hasApiKey: boolean;
  /**
   * kinds of global signal pushed to this account (Telegram, webhook, WebSocket without `kinds`): the core events
   * net_apr, tvl_outflow, depeg, smart_lp by default; burst and hot_pool only when added. Custom-rule matches always arrive.
   */
  subscriptions: SignalKind[];
}

/** Custom alert rules (Basic: 3, Pro: 20). Thresholds are fractions: 0.15 = 15%. */
export type RuleKind = 'net_apr' | 'depeg' | 'tvl_outflow';
interface RuleCommon {
  /** 1..60 characters */
  name: string;
  /** default true */
  enabled?: boolean;
  /** only these chains; empty/omitted = all */
  chains?: Chain[];
  /** only these pool types; empty/omitted = all (depeg: stable and correlated only) */
  pairClasses?: PairClass[];
  /** only these pools, "<chain>:<address>" (up to 50); empty/omitted = all */
  pools?: string[];
  /** ≥ 100,000; default 1,000,000 */
  minTvlUsd?: number;
  /** quiet period per pool after the rule fires, 24..720; default 24 */
  cooldownHours?: number;
}
export interface NetAprRuleInput extends RuleCommon {
  kind: 'net_apr';
  minNet7d: number;
  /** default = minNet7d */
  minNet24h?: number;
  /** default 0.8 */
  minInRange7d?: number;
}
export interface DepegRuleInput extends RuleCommon {
  kind: 'depeg';
  /** 0.001..0.5 */
  minDeviation: number;
}
export interface TvlOutflowRuleInput extends RuleCommon {
  kind: 'tvl_outflow';
  /** 0.05..0.95 */
  minDrop: number;
  /** 1..24, default 3 */
  windowHours?: number;
}
export type RuleInput = NetAprRuleInput | DepegRuleInput | TvlOutflowRuleInput;
/** A stored rule: every default filled in. */
export type Rule = Required<RuleInput> & {
  id: string;
  /** enabled and within the plan's rule limit: it runs every hour */
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
export interface RulesPage {
  rules: Rule[];
  /** rules this plan may have (0 on the free plan) */
  limit: number;
  /** matches per account per 24 hours */
  dailyCap: number;
  matchesToday: number;
}

/** Track record of one opportunity kind (signals with a known outcome) over the last `days`. */
export interface SignalStats {
  days: number;
  /** net_apr (scored on the 7 days after firing) or burst (the 24 hours after) */
  kind: 'net_apr' | 'burst';
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
  /** `until`: when access ends (the period end, or the grace end while a renewal is unpaid); `cancelAtPeriodEnd`: the
   *  subscription behind `tier`/`until` ends then instead of renewing (auto-renewal off in the billing portal) */
  stripe: { tier: string | null; until: string | null; status: string | null; cancelAtPeriodEnd: boolean; invoiceUnpaidSince: string | null; syncedAt: string | null };
  onSale: { basic: boolean; pro: boolean };
}

/** The body of a webhook delivery. */
export interface WebhookEvent {
  type: 'signal';
  /** unique per delivery: deliveries are at-least-once, so skip ids already handled */
  deliveryId: string;
  signal: Signal;
}

/** new orders are one month; 3 and 12 appear only on orders placed before 2026-10-10 */
export type CryptoMonths = 1 | 3 | 12;

/** One prepaid plan period bought with a USDT/USDC deposit (GET/POST /v1/billing/crypto/orders…). */
export interface CryptoOrder {
  id: string;
  tier: 'basic' | 'pro';
  months: CryptoMonths;
  listCents: number;
  /** upgrade credit from unused crypto Basic time, taken off the price */
  creditCents: number;
  /** what to pay, in cents */
  cents: number;
  /** credit the price could not absorb, as extra Pro days */
  bonusDays: number;
  /** the EXACT amount to send (6 decimals): its last digits identify the order */
  amount: string;
  address: string;
  networks: string[];
  coins: string[];
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
  createdAt: string;
  /** send before this; never send for a cancelled or expired order */
  expiresAt: string;
  /** a payment sent in time still counts if it is credited before this (or later, if Binance held it) */
  graceUntil: string;
  paidTx: string | null;
  paidToken: string | null;
  /** the plan end this payment granted */
  grantedUntil: string | null;
}

/** GET /v1/billing/crypto */
export interface CryptoBilling {
  available: boolean;
  coins: string[];
  networks: string[];
  blockedBy: 'stripe_subscription_active' | null;
  basicUntil: string | null;
  proUntil: string | null;
  quotes: { tier: 'basic' | 'pro'; months: CryptoMonths; listCents: number | null; creditCents: number; cents: number | null; bonusDays: number; unavailable: string | null }[];
  order: CryptoOrder | null;
}
