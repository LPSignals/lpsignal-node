/**
 * lpsignal/liquidity against the real position managers, on local forks of each chain (anvil forked from a public RPC).
 * Opt-in: LP_FORK=1 npx vitest run test/liquidity.fork.test.ts (needs Foundry's anvil). Only the public API is used:
 * planAddLiquidity → sendPlan → positions → planRemoveLiquidity (half, then the rest) → sendPlan.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, publicActions, walletActions, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ERC20, planAddLiquidity, planRemoveLiquidity, positions, sendPlan, TxUnknown, unblock, uncollectedFees, WRAPPED, type PoolInfo } from '../src/liquidity/index.js';

const RUN = process.env.LP_FORK === '1';
const FORK: Record<string, string> = {
  base: 'https://base-rpc.publicnode.com', optimism: 'https://optimism-rpc.publicnode.com', bsc: 'https://bsc-rpc.publicnode.com',
  ethereum: 'https://ethereum-rpc.publicnode.com', polygon: 'https://polygon-bor-rpc.publicnode.com', arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
};
const me = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const anvils: ChildProcess[] = [];
afterAll(() => { for (const a of anvils) a.kill(); });
let port = 18_700;

async function fork(chain: string) {
  const p = port++;
  anvils.push(spawn('anvil', ['--fork-url', FORK[chain]!, '--port', String(p), '--silent', '--no-rate-limit'], { stdio: 'ignore' }));
  const url = `http://127.0.0.1:${p}`;
  const test = createTestClient({ mode: 'anvil', transport: http(url, { timeout: 60_000 }) }).extend(publicActions).extend(walletActions);
  for (let i = 0; ; i++) { try { await test.getChainId(); break; } catch { if (i > 120) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 500)); } }
  const id = await test.getChainId();
  const chainDef = { id, name: chain, nativeCurrency: { name: 'n', symbol: 'n', decimals: 18 }, rpcUrls: { default: { http: [url] } } };
  return { test, pub: createPublicClient({ chain: chainDef, transport: http(url, { timeout: 60_000 }) }) as PublicClient, wallet: createWalletClient({ account: me, chain: chainDef, transport: http(url, { timeout: 60_000 }) }) };
}

const CASES: { chain: string; pool: string; rangeBp: number; native?: boolean }[] = [
  { chain: 'base', pool: '0x6c561b446416e1a00e8e93e221854d6ea4171372', rangeBp: 500, native: true }, // Uniswap v3
  { chain: 'base', pool: '0x70acdf2ad0bf2402c957154f944c19ef4e1cbae1', rangeBp: 500 }, // Aerodrome Slipstream
  { chain: 'base', pool: '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3', rangeBp: 0 }, // PancakeSwap v3, full range
  { chain: 'optimism', pool: '0x478946bcd4a5a22b316470f5486fafb928c0ba25', rangeBp: 500 }, // Velodrome Slipstream
  { chain: 'bsc', pool: '0x4f31fa980a675570939b737ebdde0471a4be40eb', rangeBp: 5 }, // PancakeSwap v3 stable
  { chain: 'ethereum', pool: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36', rangeBp: 500 }, // WETH/USDT
  { chain: 'polygon', pool: '0x50eaedb835021e4a108b7290636d62e9765cc6d7', rangeBp: 500 },
  { chain: 'arbitrum', pool: '0xc6962004f452be9203591991d15f6b388e09e8d0', rangeBp: 500, native: true },
];

describe.skipIf(!RUN)('lpsignal/liquidity on forks of the real position managers', () => {
  it.each(CASES)('$chain $pool ±$rangeBp bp', async (c) => {
    const info = (await (await fetch(`https://lpsignal.app/v1/pools/${c.chain}/${c.pool}`)).json() as { pool: PoolInfo }).pool;
    const { test, pub, wallet } = await fork(c.chain);
    const bal = (t: string) => pub.readContract({ address: t as Address, abi: ERC20, functionName: 'balanceOf', args: [me.address] });
    // fund the wallet from the pool's own balances (1/2000 of each)
    await test.impersonateAccount({ address: c.pool as Address });
    await test.setBalance({ address: c.pool as Address, value: 10n ** 18n });
    for (const t of [info.token0, info.token1]) {
      const amount = (await pub.readContract({ address: t as Address, abi: ERC20, functionName: 'balanceOf', args: [c.pool as Address] })) / 2000n;
      await pub.waitForTransactionReceipt({ hash: await test.writeContract({ account: c.pool as Address, chain: null, address: t as Address, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [me.address, amount] }) });
    }
    await test.stopImpersonatingAccount({ address: c.pool as Address });
    const nativeSide = c.native ? (info.token0.toLowerCase() === WRAPPED[c.chain] ? 0 : 1) : null;
    // half the funded token0 in; the SDK computes token1 (or the other way when token1 is short)
    let plan = await planAddLiquidity(pub, info, { owner: me.address, amount0: (await bal(info.token0)) / 2n, rangeBp: c.rangeBp, nativeSide, deadlineS: 10 ** 7 });
    if (plan.amount1 > await bal(info.token1)) plan = await planAddLiquidity(pub, info, { owner: me.address, amount1: (await bal(info.token1)) / 2n, rangeBp: c.rangeBp, nativeSide, deadlineS: 10 ** 7 });
    const hashes = await sendPlan(wallet, pub, [...plan.approvals, plan.mint]);
    expect(hashes).toHaveLength(plan.approvals.length + 1);

    const mine = (await positions(pub, c.chain, me.address)).filter((p) => p.pool === c.pool.toLowerCase());
    expect(mine).toHaveLength(1);
    const pos = mine[0]!;
    expect([pos.tickLower, pos.tickUpper]).toEqual([plan.tickLower, plan.tickUpper]);
    expect(pos.liquidity).toBeGreaterThan(0n);
    expect((await uncollectedFees(pub, pos, me.address)).length).toBe(2);

    const half = await planRemoveLiquidity(pub, pos, { owner: me.address, shareBps: 5_000, deadlineS: 10 ** 7 });
    expect(half.liquidity).toBe(pos.liquidity / 2n);
    const b0 = await bal(info.token0), b1 = await bal(info.token1);
    const [done] = await sendPlan(wallet, pub, [half.call]);
    expect((await bal(info.token0)) - b0 >= half.amount0Min && (await bal(info.token1)) - b1 >= half.amount1Min).toBe(true);
    // a node behind that removal is refused
    await expect(planRemoveLiquidity(pub, pos, { owner: me.address, shareBps: 10_000, minBlock: done!.blockNumber + 1000n })).rejects.toThrow(/behind/);
    // the rest: read again from the chain at a block no older than that removal
    const rest = await planRemoveLiquidity(pub, pos, { owner: me.address, shareBps: 10_000, deadlineS: 10 ** 7, minBlock: done!.blockNumber });
    expect(rest.liquidity).toBe(pos.liquidity - half.liquidity);
    await sendPlan(wallet, pub, [rest.call]);
    expect((await positions(pub, c.chain, me.address)).some((p) => p.tokenId === pos.tokenId)).toBe(false);
    // a position held by someone else is refused
    await expect(planRemoveLiquidity(pub, pos, { owner: '0x00000000000000000000000000000000000000aa', shareBps: 10_000 })).rejects.toThrow(/held by/);
  }, 300_000);
});

describe.skipIf(!RUN)('planSwap on a fork through the real aggregator route (LPSignal fee)', () => {
  it('Base WETH/USDC: native ETH in, then WETH in (approval + swap in one plan): at least the minimum arrives, our fee exactly', async () => {
    // a proxy if the environment has one (local anvil bypasses it via no_proxy)
    if (process.env.https_proxy) {
      const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
      setGlobalDispatcher(new EnvHttpProxyAgent());
    }
    const { planSwap, SWAP_FEE_RECEIVER } = await import('../src/liquidity/index.js');
    const { generatePrivateKey } = await import('viem/accounts');
    const info = (await (await fetch('https://lpsignal.app/v1/pools/base/0x6c561b446416e1a00e8e93e221854d6ea4171372')).json() as { pool: PoolInfo }).pool;
    const { test, pub } = await fork('base');
    // a fresh account: the aggregator refuses anvil's well-known default ones
    const owner = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ account: owner, chain: pub.chain!, transport: http((pub.transport as { url: string }).url, { timeout: 60_000 }) });
    await test.setBalance({ address: owner.address, value: 10n ** 21n });
    const WETH9 = parseAbi(['function deposit() payable']);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: info.token0 as Address, abi: WETH9, functionName: 'deposit', value: 10n ** 17n }) });
    const feeBal = async (native: boolean) => (native ? pub.getBalance({ address: SWAP_FEE_RECEIVER }) : pub.readContract({ address: info.token0 as Address, abi: ERC20, functionName: 'balanceOf', args: [SWAP_FEE_RECEIVER] }));
    for (const native of [true, false]) {
      const amountIn = 10n ** 17n;
      // re-planned on a failure: a fork freezes market makers' pools some routes go through
      let done = false;
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        const plan = await planSwap(pub, info, { owner: owner.address, fromSide: 0, fromNative: native, amountIn });
        expect(plan.approvals.length).toBe(native ? 0 : 1);
        const [fee0, usdc0] = await Promise.all([feeBal(native), pub.readContract({ address: info.token1 as Address, abi: ERC20, functionName: 'balanceOf', args: [owner.address] })]);
        try {
          await sendPlan(wallet, pub, [...plan.approvals, plan.swap]);
        } catch (e) {
          // (TxReverted on a frozen pool: the account is not blocked by a revert — re-plan; a gas estimate that reverted
          // is TxUnknown — certainly not sent here: unblock and re-plan, as a user would)
          if (e instanceof TxUnknown && /revert/i.test(String((e as { cause?: unknown }).cause))) { unblock(8453, owner.address); continue; }
          if (!String(e).includes('reverted')) throw e;
          continue;
        }
        const [fee1, usdc1] = await Promise.all([feeBal(native), pub.readContract({ address: info.token1 as Address, abi: ERC20, functionName: 'balanceOf', args: [owner.address] })]);
        expect(fee1 - fee0).toBe((amountIn * 25n) / 10_000n);
        expect(usdc1 - usdc0 >= plan.minReturn).toBe(true);
        done = true;
      }
      expect(done, native ? 'native' : 'weth').toBe(true);
    }
  }, 300_000);
});
