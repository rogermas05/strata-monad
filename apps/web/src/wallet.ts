import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
  parseUnits,
} from "viem";
import { waitReceipt } from "../../../packages/core/src/receipts.ts";
import { saveTransaction, registerTransaction } from "./transaction-journal.ts";
import {
  recheckOracleProof,
  expiryOracleAbi,
} from "../../../packages/core/src/oracle-proof.ts";
import { pythAbi } from "../../../packages/core/src/pyth.ts";
import { quoteDepth } from "../../../packages/core/src/valuation.ts";
import { requiresLiveMarket } from "../../../packages/core/src/readiness.ts";
import {
  assetFor,
  manifestAssets,
} from "../../../packages/core/src/manifest-assets.ts";
import type { Snapshot } from "../../../packages/core/src/index.ts";
import {
  houseSteps,
  isHouseAction,
} from "../../../packages/core/src/house-actions.ts";
import { api } from "./api.ts";
import type { Action } from "./context.ts";
import {
  parseRecovery,
  checkRecovery,
  authorizationSigner,
  recoveryTypedData,
  attachSignature,
  type RecoveryPacket,
} from "../../../packages/core/src/recovery.ts";

export async function authorizeRecovery(
  snapshot: Snapshot,
  account: Address,
  input: RecoveryPacket,
) {
  const packet = parseRecovery(input, snapshot.manifest);
  authorizationSigner(packet, account);
  const { publicClient, wallet } = await walletClients(snapshot, account);
  await checkRecovery(publicClient, packet, snapshot.manifest);
  const data = recoveryTypedData(packet);
  const signature =
    data.primaryType === "Claim"
      ? await wallet.signTypedData(data)
      : await wallet.signTypedData(data);
  const signed = attachSignature(packet, account, signature);
  await checkRecovery(publicClient, signed, snapshot.manifest);
  return signed;
}
import { OptionsEngine as engine } from "../../../packages/core/src/generated/contracts.ts";
import { StrategyRouter as router } from "../../../packages/core/src/generated/contracts.ts";
import { OptionToken as token } from "../../../packages/core/src/generated/contracts.ts";
import { DemoOracle as oracle } from "../../../packages/core/src/generated/contracts.ts";
import { DemoUSDC as usd } from "../../../packages/core/src/generated/contracts.ts";
import { WrappedMON as wrapped } from "../../../packages/core/src/generated/contracts.ts";
import { DemoOrderBook as book } from "../../../packages/core/src/generated/contracts.ts";
import { parseAbi } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider & {
      on?: (event: string, listener: (value: any) => void) => void;
      removeListener?: (event: string, listener: (value: any) => void) => void;
    };
  }
}
const marginAbi = parseAbi([
  "function deposit(address,address,uint256) payable",
  "function withdraw(uint256,address)",
  "function getBalance(address,address) view returns (uint256)",
]);
const kuruAbi = parseAbi([
  "function addBuyOrder(uint32,uint96,bool)",
  "function addSellOrder(uint32,uint96,bool)",
  "function batchCancelOrders(uint40[])",
]);
export async function connectWallet(): Promise<Address> {
  if (!window.ethereum)
    throw new Error(
      "No browser wallet found. Install an EVM wallet or use the funded local demo account.",
    );
  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as Address[];
  if (!accounts[0]) throw new Error("Wallet did not provide an account");
  return accounts[0];
}
async function walletClients(snapshot: Snapshot, account: Address) {
  const provider = window.ethereum;
  if (!provider) throw new Error("Wallet disconnected");
  const m = snapshot.manifest;
  const chain = defineChain({
    id: m.chainId,
    name: m.mode === "testnet" ? "Monad Testnet" : "Strata local Monad fork",
    nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [m.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    pollingInterval: 500,
    transport: http(m.rpcUrl),
  });
  const wallet = createWalletClient({
    account,
    chain,
    transport: custom(provider),
  });
  if ((await wallet.getChainId()) !== m.chainId) {
    try {
      await wallet.switchChain({ id: m.chainId });
    } catch (error) {
      if (
        (error as { code?: number }).code !== 4902 &&
        !(error as { message?: string }).message?.includes("4902")
      )
        throw new Error(
          `Switch your wallet to chain ${m.chainId} before trading.`,
        );
      await wallet.addChain({ chain });
      await wallet.switchChain({ id: m.chainId });
    }
  }
  if (
    (await wallet.getChainId()) !== m.chainId ||
    (await publicClient.getChainId()) !== m.chainId
  )
    throw new Error("Wallet or RPC network does not match the deployment");
  return { publicClient, wallet };
}
export async function signAction(
  snapshot: Snapshot,
  account: Address,
  action: Action,
  onStep: (message: string, hash?: Hex) => void,
) {
  const { publicClient, wallet } = await walletClients(snapshot, account);
  const m = snapshot.manifest;
  const hashes: Hex[] = [];
  /** Checks every underlying the transaction touches against its own live age. */
  async function requireLivePrice(seriesIds: number[] = []) {
    const block = await publicClient.getBlock();
    const age = (await publicClient.readContract({
      address: m.engine,
      abi: engine as Abi,
      functionName: "maxPriceAge",
      blockNumber: block.number,
    })) as bigint;
    const series = m.series.filter((s) => seriesIds.includes(s.id));
    const assets = series.length
      ? [...new Set(series.map((s) => assetFor(m, s)))]
      : manifestAssets(m).slice(0, 1);
    for (const asset of assets) {
      const [value, published] = (await publicClient.readContract({
        address: m.oracle,
        abi: oracle as Abi,
        functionName: "livePrice",
        args: [asset.assetId],
        blockNumber: block.number,
      })) as [bigint, bigint];
      const limit = BigInt(Math.min(Number(age), asset.maxLiveAge));
      if (
        value <= 0n ||
        published > block.timestamp ||
        block.timestamp - published > limit
      )
        throw new Error(
          asset.policy === "pyth-latest-before-close"
            ? `The ${asset.key} market is closed. New orders resume when its session opens.`
            : "The oracle price is unavailable or stale. Refresh before placing a new order.",
        );
    }
    return block;
  }
  function seriesIdsFor(address: Address, fn: string, args: unknown[]) {
    const target = address.toLowerCase();
    const venue = m.series.filter(
      (s) =>
        s.market.toLowerCase() === target || s.venue.toLowerCase() === target,
    );
    if (venue.length) return venue.map((s) => s.id);
    if (target === m.engine.toLowerCase() && fn === "write")
      return [Number(args[0] as bigint)];
    if (target === m.router.toLowerCase() && fn === "execute")
      return ((args[0] as { seriesId: bigint }[]) ?? []).map((l) =>
        Number(l.seriesId),
      );
    return [];
  }
  async function send(
    address: Address,
    abi: Abi,
    fn: string,
    args: unknown[] = [],
    value = 0n,
  ) {
    if (
      ["execute", "write", "addBuyOrder", "addSellOrder", "place"].includes(fn)
    ) {
      const block = await requireLivePrice(seriesIdsFor(address, fn, args));
      const selected = m.series.find(
        (series) => series.market.toLowerCase() === address.toLowerCase(),
      );
      if (selected && BigInt(selected.expiry) <= block.timestamp)
        throw new Error("Expired market does not accept new orders");
    }
    onStep(`Confirm ${fn} in your wallet`);
    const simulation = await publicClient.simulateContract({
      address,
      abi,
      functionName: fn,
      args,
      value,
      account,
    });
    const hash = await wallet.writeContract(simulation.request);
    hashes.push(hash);
    const record = {
      hash,
      account,
      target: address,
      operation: fn,
      status: "pending" as const,
      block: null,
      created: Date.now(),
    };
    saveTransaction(m, record);
    void registerTransaction(m, record);
    onStep(`Waiting for ${fn} inclusion`, hash);
    const receipt = await waitReceipt(publicClient, hash, 120000);
    const included = {
      ...record,
      status:
        receipt.status === "success"
          ? ("included" as const)
          : ("reverted" as const),
      block: receipt.blockNumber.toString(),
    };
    saveTransaction(m, included);
    void registerTransaction(m, included);
    if (receipt.status !== "success")
      throw new Error(`Transaction reverted: ${hash}`);
  }
  async function approve(address: Address, spender: Address, amount: bigint) {
    if (amount === 0n) return;
    const allowance = (await publicClient.readContract({
      address,
      abi: token as Abi,
      functionName: "allowance",
      args: [account, spender],
    })) as bigint;
    if (allowance < amount)
      await send(address, token as Abi, "approve", [spender, amount]);
  }
  async function withdraw(marketToken: Address) {
    if (!m.kuruMargin)
      throw new Error("This venue does not have separate margin custody");
    for (const address of [marketToken, m.usdc]) {
      const free = (await publicClient.readContract({
        address: m.kuruMargin,
        abi: marginAbi,
        functionName: "getBalance",
        args: [account, address],
      })) as bigint;
      if (free > 0n)
        await send(m.kuruMargin, marginAbi, "withdraw", [free, address]);
    }
  }
  const q = parseUnits(action.quantity ?? "0", 18),
    market = snapshot.markets.find((s) => s.id === action.marketId);
  try {
    if (requiresLiveMarket(action.action)) {
      if (!snapshot.service.newExposureAllowed)
        throw new Error(snapshot.service.reason ?? "Live market unavailable");
      const block = await requireLivePrice(
        action.legs?.map((l) => l.marketId) ?? (market ? [market.id] : []),
      );
      if (market && BigInt(market.expiry) <= block.timestamp)
        throw new Error("Expired market does not accept new orders");
    }
    if (isHouseAction(action.action)) {
      const claim =
        action.action === "rewards-claim"
          ? ((await api.rewards(account)).claim ?? undefined)
          : undefined;
      for (const step of houseSteps(
        m,
        {
          action: action.action,
          amount: action.amount,
          stake: action.stake,
          claim,
        },
        account,
      ))
        if (step.kind === "approve")
          await approve(step.token, step.spender, step.amount);
        else await send(step.address, step.abi, step.functionName, step.args);
    } else if (action.action === "submit-oracle-proof") {
      if (!action.proof) throw new Error("Missing reviewed oracle proof");
      const proof = await recheckOracleProof(
        publicClient,
        m,
        action.proof,
        account,
      );
      await send(
        proof.kind === "settlement" ? proof.oracle : proof.verifier,
        proof.kind === "settlement" ? expiryOracleAbi : pythAbi,
        proof.kind === "settlement"
          ? (proof.action ?? "finalize")
          : "updatePriceFeeds",
        proof.kind === "settlement"
          ? [
              proof.feed,
              BigInt(proof.expiry!),
              proof.action === "finalize" ? [] : proof.updates,
            ]
          : [proof.updates],
        BigInt(proof.maxFee),
      );
    } else if (action.action === "revoke-authorizations")
      await send(m.engine, engine as Abi, "invalidateAuthorizations");
    else if (action.action === "approve-recovery") {
      if (!action.packet) throw new Error("Missing recovery authorization");
      const packet = parseRecovery(action.packet, m);
      if (
        packet.type !== "unwind" ||
        packet.terms.writer.toLowerCase() !== account.toLowerCase()
      )
        throw new Error("Only the writer can approve the unwind payment");
      await checkRecovery(publicClient, packet, m);
      await approve(m.usdc, m.engine, BigInt(packet.terms.payment));
    } else if (action.action === "submit-recovery") {
      if (!action.packet) throw new Error("Missing recovery authorization");
      const packet = parseRecovery(action.packet, m);
      await checkRecovery(publicClient, packet, m, true);
      const t = packet.terms;
      await send(
        m.engine,
        engine as Abi,
        packet.type === "claim" ? "redeemWithSignature" : "unwindUnresolved",
        packet.type === "claim"
          ? [
              BigInt(t.seriesId),
              t.holder,
              BigInt(t.quantity),
              BigInt(t.deadline),
              packet.signature,
            ]
          : [
              recoveryTypedData(packet).message,
              packet.writerSignature,
              packet.holderSignature,
            ],
      );
    } else if (action.action === "faucet")
      await send(m.usdc, usd as Abi, "faucet");
    else if (action.action === "wrap") {
      if (q <= 0n) throw new Error("Enter a positive amount");
      await send(m.wmon, wrapped as Abi, "deposit", [], q);
    } else if (action.action === "unwrap")
      await send(m.wmon, wrapped as Abi, "withdraw", [q]);
    else if (action.action === "trade") {
      const input =
        action.legs ??
        (market
          ? [
              {
                marketId: market.id,
                isBuy: action.isBuy ?? true,
                quantity: action.quantity ?? "0",
                premiumLimit: action.price ?? "0",
              },
            ]
          : []);
      if (!input.length || input.length > 4) throw new Error("Choose 1–4 legs");
      let funding = 0n,
        credit = 0n;
      const legs = [];
      for (const l of input) {
        const s = snapshot.markets.find((s) => s.id === l.marketId);
        if (!s) throw new Error("Unknown market");
        if (!s.active)
          throw new Error("Expired market does not accept new orders");
        const quantity = parseUnits(l.quantity, 18),
          premiumLimit = parseUnits(l.premiumLimit, 6);
        if (quantity <= 0n || quantity % 10n ** 15n !== 0n || premiumLimit < 0n)
          throw new Error("Use positive quantities in 0.001 MON lots");
        if (
          !quoteDepth(l.isBuy ? s.asks : s.bids, Number(quantity) / 1e18)
            .complete
        )
          throw new Error(
            "Insufficient executable depth; no approval or order submitted",
          );
        legs.push({
          seriesId: BigInt(s.id),
          isBuy: l.isBuy,
          quantity,
          premiumLimit,
        });
        if (l.isBuy) funding += premiumLimit;
        else credit += premiumLimit;
      }
      for (const leg of legs)
        if (!leg.isBuy)
          await approve(
            m.series.find((market) => market.id === Number(leg.seriesId))!
              .token,
            m.router,
            leg.quantity,
          );
      await approve(m.usdc, m.router, funding);
      const block = await publicClient.getBlock();
      await send(m.router, router as Abi, "execute", [
        legs,
        funding,
        funding,
        funding === 0n ? credit : 0n,
        Number(block.timestamp) + 120,
      ]);
    } else {
      if (!market) throw new Error("Unknown market");
      const id = BigInt(market.id);
      if (action.action === "write") {
        const backing = (await publicClient.readContract({
          address: m.engine,
          abi: engine as Abi,
          functionName: "requiredCollateral",
          args: [id, q],
        })) as bigint;
        await approve(
          market.kind === "call" ? m.wmon : m.usdc,
          m.engine,
          backing,
        );
        await send(m.engine, engine as Abi, "write", [id, q, account]);
      } else if (action.action === "close")
        await send(m.engine, engine as Abi, "closeWrite", [id, q]);
      else if (action.action === "redeem")
        await send(m.engine, engine as Abi, "redeemLong", [id, q, account]);
      else if (action.action === "settle-writer")
        await send(m.engine, engine as Abi, "settleWriter", [id, account]);
      else if (action.action === "finalize") {
        if (m.oracleMode !== "demo")
          throw new Error(
            "Pyth finalization requires a signed historical update through the keeper",
          );
        await send(m.oracle, oracle as Abi, "finalize", [
          assetFor(m, market).assetId,
          market.expiry,
          [],
        ]);
      } else if (action.action === "cancel") {
        if (!action.orderId) throw new Error("Missing order id");
        await send(
          market.market,
          m.venueMode === "kuru" ? kuruAbi : (book as Abi),
          m.venueMode === "kuru" ? "batchCancelOrders" : "cancel",
          m.venueMode === "kuru"
            ? [[BigInt(action.orderId)]]
            : [BigInt(action.orderId)],
        );
        if (m.kuruMargin) await withdraw(market.token);
      } else if (action.action === "withdraw") await withdraw(market.token);
      else if (action.action === "place") {
        const price = parseUnits(action.price ?? "0", 6),
          isBuy = action.isBuy ?? true;
        if (
          q <= 0n ||
          q % 10n ** 15n !== 0n ||
          price <= 0n ||
          price > 4294967295n
        )
          throw new Error(
            "Use a positive price and quantities in 0.001 MON lots",
          );
        if (
          (isBuy && market.ask !== null && Number(price) / 1e6 >= market.ask) ||
          (!isBuy && market.bid !== null && Number(price) / 1e6 <= market.bid)
        )
          throw new Error(
            "Post-only order would cross the book. Choose a resting price.",
          );
        const address = isBuy ? m.usdc : market.token,
          amount = isBuy ? (q * price + 10n ** 18n - 1n) / 10n ** 18n : q;
        await approve(address, m.kuruMargin ?? market.market, amount);
        if (m.kuruMargin) {
          await send(m.kuruMargin, marginAbi, "deposit", [
            account,
            address,
            amount,
          ]);
          await send(
            market.market,
            kuruAbi,
            isBuy ? "addBuyOrder" : "addSellOrder",
            [Number(price), q / 10n ** 15n, true],
          );
        } else
          await send(market.market, book as Abi, "place", [isBuy, price, q]);
      } else throw new Error("Unsupported action");
    }
    return { hashes, status: "included" };
  } catch (error) {
    if (hashes.length)
      throw Object.assign(
        new Error(
          `${error instanceof Error ? error.message : "Transaction failed"}\n${hashes.length} earlier transaction(s) were submitted. Check wallet receipts and Portfolio venue balances before retrying.`,
        ),
        { hashes },
      );
    throw error;
  }
}
