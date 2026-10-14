import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { parseUnits, type Address, type Hex } from "viem";
import {
  abi,
  client,
  manifest,
  refresh,
  current,
  readiness,
  portfolio,
  send,
  serialized,
  engineAbi,
  wallet,
  tokenAbi,
  routerAbi,
  oracleAbi,
  kuruAbi,
  marginAbi,
  max,
  workerErrors,
  recordWorkerError,
  transactions,
  recordTransaction,
  localSigning,
  safeDiagnostic,
  makerEnabled,
  makerConfig,
  workersPaused,
  setWorkersPaused,
  rewindReadModel,
  root,
  json,
  setMakerConfig,
  setMakerEnabled,
  assetSessionOpen,
  secondsUntilOpen,
  publishControlledPrice,
  finalizeElapsed,
  serverless,
  publicWorkers,
  reloadCloudReadModel,
  workerSignerStatus,
} from "./runtime.ts";
import {
  manifestAssets,
  assetFor,
} from "../../../packages/core/src/manifest-assets.ts";
import {
  oracleServiceStatus,
  prepareFromProvider,
  inspectProof,
  archivedProof,
  archiveProof,
} from "./oracle-service.ts";
import {
  oracleProofSchema,
  expiryOracleAbi,
} from "../../../packages/core/src/oracle-proof.ts";
import { pythAbi } from "../../../packages/core/src/pyth.ts";
import { inspectTransaction } from "../../../packages/core/src/transaction-inspection.ts";
import { runMakerCycle, drainMakerQuotes } from "./maker-worker.ts";
import {
  houseAccount,
  rewardsAccount,
  vaultAbi,
  stakingAbi,
  distributorAbi,
  strataAbi,
} from "./house.ts";
import { runHouseCycle } from "./house-worker.ts";
import {
  houseActions,
  houseSteps,
  isHouseAction,
} from "../../../packages/core/src/house-actions.ts";
import { startWorkers, resetWorkerState } from "./workers.ts";
import { makerConfigSchema } from "./maker-config.ts";
import {
  parseRecovery,
  recoverySchema,
  recoveryTypedData,
  checkRecovery,
  attachSignature,
  authorizationSigner,
} from "../../../packages/core/src/recovery.ts";
import { quoteDepth } from "../../../packages/core/src/valuation.ts";
import { requiresLiveMarket } from "../../../packages/core/src/readiness.ts";
import type { MakerConfig } from "../../../packages/core/src/index.ts";
export const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 16384,
});
const startedAt = Date.now();
await app.register(cors, {
  origin: [
    `http://localhost:${process.env.WEB_PORT ?? 5173}`,
    `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
  ],
});
await app.register(websocket);
const local = localSigning;
try {
  if ((await client.getChainId()) !== manifest.chainId)
    throw new Error("Manifest chain mismatch");
} catch (error) {
  throw new Error(safeDiagnostic(error));
}
const connections = new Set<{ send: (data: string) => void }>();
app.get("/api/live", { websocket: true }, (socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
});
app.get("/api/health", (_, reply) => {
  const service = readiness();
  if (service.status !== "ready") reply.code(503);
  return {
    ok: service.status === "ready",
    service,
    chainId: manifest.chainId,
    mode: manifest.mode,
    serverSigningEnabled: local,
    publicWorkersEnabled: publicWorkers,
    workerSigners: workerSignerStatus(),
    startedAt,
    workersSuspended: workersPaused,
    localCheckpoint:
      local && checkpoint
        ? { id: checkpoint.id, block: checkpoint.block.toString() }
        : null,
  };
});
app.get("/api/transactions/:address", async (request, reply) => {
  const a = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .safeParse((request.params as { address: string }).address);
  if (!a.success) return reply.code(400).send({ error: "Invalid address" });
  return transactions(a.data as Address);
});
let journalReads = 0;
app.post("/api/transactions", async (request, reply) => {
  const input = z
    .object({
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    })
    .strict()
    .safeParse(request.body);
  if (!input.success)
    return reply
      .code(400)
      .send({ error: "Provide a transaction hash and its sender." });
  if (journalReads >= 4)
    return reply
      .code(503)
      .send({ error: "Transaction verification is busy; retry shortly." });
  journalReads++;
  try {
    const record = await inspectTransaction(
      client,
      manifest,
      input.data.hash as Hex,
      input.data.account as Address,
      [
        engineAbi,
        routerAbi,
        tokenAbi,
        abi("WrappedMON"),
        oracleAbi,
        expiryOracleAbi,
        pythAbi,
        kuruAbi,
        marginAbi,
        abi("DemoOrderBook"),
        ...(manifest.house
          ? [vaultAbi, stakingAbi, distributorAbi, strataAbi]
          : []),
      ],
    );
    await recordTransaction(record);
    return record;
  } catch {
    return reply.code(400).send({
      error:
        "Transaction cannot be verified for this account and deployment. Retry after it is visible onchain.",
    });
  } finally {
    journalReads--;
  }
});
app.get("/api/snapshot", async () => {
  const cached = current();
  if (!cached || Date.now() - cached.service.lastSuccessfulRefreshAt > 3000) {
    try {
      return await refresh();
    } catch {
      if (!current()) throw new Error("No confirmed state available");
    }
  }
  return current();
});
app.get("/api/portfolio/:address", async (request, reply) => {
  const a = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .safeParse((request.params as { address: string }).address);
  if (!a.success) return reply.code(400).send({ error: "Invalid address" });
  return portfolio(a.data as Address);
});
const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
app.get("/api/house/:address", async (request, reply) => {
  if (!manifest.house)
    return reply.code(404).send({ error: "No house vault in this deployment" });
  const a = addressParam.safeParse(
    (request.params as { address: string }).address,
  );
  if (!a.success) return reply.code(400).send({ error: "Invalid address" });
  return houseAccount(a.data as Address);
});
app.get("/api/rewards/:address", async (request, reply) => {
  if (!manifest.house)
    return reply.code(404).send({ error: "No house vault in this deployment" });
  const a = addressParam.safeParse(
    (request.params as { address: string }).address,
  );
  if (!a.success) return reply.code(400).send({ error: "Invalid address" });
  return rewardsAccount(a.data as Address, current() ?? (await refresh()));
});
app.get("/api/oracle", () => oracleServiceStatus());
const oracleRequest = z
  .object({
    kind: z.enum(["settlement", "live"]),
    expiry: z.number().int().nonnegative().safe().optional(),
    account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();
app.post("/api/oracle/prepare", async (request, reply) => {
  const input = oracleRequest.safeParse(request.body);
  if (!input.success)
    return reply
      .code(400)
      .send({ error: "Choose a proof kind, listed expiry and wallet address" });
  try {
    return await prepareFromProvider(
      input.data.kind,
      input.data.expiry,
      input.data.account as Address,
    );
  } catch (error) {
    return reply.code(503).send({
      error: safeDiagnostic(error),
    });
  }
});
app.post(
  "/api/oracle/inspect",
  { bodyLimit: 160000 },
  async (request, reply) => {
    const input = z
      .object({
        proof: oracleProofSchema,
        account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      })
      .strict()
      .safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "Invalid or oversized proof package" });
    try {
      return await inspectProof(
        input.data.proof,
        input.data.account as Address,
      );
    } catch (error) {
      return reply.code(400).send({
        error:
          "Proof checks failed against the current deployment. Check the network, expiry, observation and reviewed fee; prepare a fresh package if needed.",
      });
    }
  },
);
app.get("/api/oracle/archive/:kind/:expiry/:hash", async (request, reply) => {
  const input = z
    .object({
      kind: z.enum(["settlement", "live"]),
      expiry: z.string().regex(/^(live|0|[1-9]\d{0,15})$/),
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .safeParse(request.params);
  if (!input.success)
    return reply.code(400).send({ error: "Invalid archive key" });
  try {
    return await archivedProof(
      input.data.kind,
      input.data.expiry === "live" ? null : Number(input.data.expiry),
      input.data.hash as Hex,
    );
  } catch {
    return reply.code(404).send({
      error: "No matching proof archive is available for this deployment",
    });
  }
});
app.get("/api/recovery/:address", async (request, reply) => {
  const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .safeParse((request.params as { address: string }).address);
  if (!address.success)
    return reply.code(400).send({ error: "Invalid address" });
  const [nonce, usdcAllowance] = (await Promise.all([
    client.readContract({
      address: manifest.engine,
      abi: engineAbi,
      functionName: "nonces",
      args: [address.data],
    }),
    client.readContract({
      address: manifest.usdc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [address.data, manifest.engine],
    }),
  ])) as [bigint, bigint];
  return { nonce: nonce.toString(), usdcAllowance: usdcAllowance.toString() };
});
app.post("/api/recovery/sign", async (request, reply) => {
  if (!local)
    return reply
      .code(403)
      .send({ error: "Connect a wallet to sign an authorization on testnet" });
  try {
    return await serialized(async () => {
      const packet = parseRecovery(request.body, manifest);
      authorizationSigner(packet, manifest.demoUser);
      await checkRecovery(client, packet, manifest);
      const data = recoveryTypedData(packet);
      const signer = wallet(manifest.demoUser);
      const signature =
        data.primaryType === "Claim"
          ? await signer.signTypedData(data)
          : await signer.signTypedData(data);
      const signed = attachSignature(packet, manifest.demoUser, signature);
      await checkRecovery(client, signed, manifest);
      return signed;
    });
  } catch (e) {
    return reply.code(400).send({ error: safeDiagnostic(e) });
  }
});
app.post("/api/recovery/inspect", async (request, reply) => {
  try {
    const packet = parseRecovery(request.body, manifest);
    return await checkRecovery(client, packet, manifest);
  } catch (e) {
    return reply.code(400).send({
      error:
        e instanceof Error ? e.message : "Authorization could not be inspected",
    });
  }
});
const actionSchema = z
  .object({
    action: z.enum([
      "trade",
      "write",
      "close",
      "redeem",
      "settle-writer",
      "place",
      "cancel",
      "withdraw",
      "faucet",
      "wrap",
      "unwrap",
      "finalize",
      "submit-recovery",
      "revoke-authorizations",
      "submit-oracle-proof",
      "approve-recovery",
      ...houseActions,
    ]),
    marketId: z.number().int().positive().optional(),
    quantity: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/)
      .optional(),
    price: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .optional(),
    isBuy: z.boolean().optional(),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/)
      .optional(),
    stake: z.boolean().optional(),
    orderId: z.string().regex(/^\d+$/).optional(),
    packet: recoverySchema.optional(),
    proof: oracleProofSchema.optional(),
    legs: z
      .array(
        z.object({
          marketId: z.number().int().positive(),
          isBuy: z.boolean(),
          quantity: z.string(),
          premiumLimit: z.string(),
        }),
      )
      .max(4)
      .optional(),
  })
  .strict();
app.post("/api/actions", { bodyLimit: 160000 }, async (request, reply) => {
  if (!local)
    return reply.code(403).send({
      error:
        "Server-side transactions are disabled on this service. Connect a wallet to submit your own transactions.",
    });
  const parsed = actionSchema.safeParse(request.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: "Invalid action", details: parsed.error.issues });
  const hashes: Hex[] = [];
  try {
    return await serialized(async () => {
      const a = parsed.data,
        user = manifest.demoUser,
        snap = await refresh().catch((error) => {
          if (requiresLiveMarket(a.action)) throw error;
          return current();
        }),
        m =
          snap?.markets.find((x) => x.id === a.marketId) ??
          manifest.series
            .map((series) => ({ ...series, bid: null, ask: null }))
            .find((series) => series.id === a.marketId);
      if (requiresLiveMarket(a.action) && !snap?.service.newExposureAllowed)
        throw new Error(snap?.service.reason ?? "Live market unavailable");
      if (requiresLiveMarket(a.action) && m && m.expiry <= snap!.timestamp)
        throw new Error("Expired market does not accept new orders");
      const qty = parseUnits(a.quantity ?? "0", 18);
      if (qty < 0n) throw new Error("Invalid quantity");
      async function approve(token: Address, spender: Address, amount: bigint) {
        const allowance = (await client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "allowance",
          args: [user, spender],
        })) as bigint;
        if (allowance < amount)
          hashes.push(
            await send(user, token, tokenAbi, "approve", [spender, amount]),
          );
      }
      if (isHouseAction(a.action)) {
        // The server serves its own published proof; clients cannot supply one here.
        const claim =
          a.action === "rewards-claim"
            ? ((await rewardsAccount(user, snap ?? (await refresh()))).claim ??
              undefined)
            : undefined;
        for (const step of houseSteps(
          manifest,
          { action: a.action, amount: a.amount, stake: a.stake, claim },
          user,
        ))
          if (step.kind === "approve")
            await approve(step.token, step.spender, step.amount);
          else
            hashes.push(
              await send(
                user,
                step.address,
                step.abi,
                step.functionName,
                step.args,
              ),
            );
      } else if (a.action === "submit-oracle-proof") {
        if (!a.proof) throw new Error("Missing reviewed oracle proof");
        const checked = await inspectProof(a.proof, user);
        await archiveProof(checked);
        hashes.push(
          await send(
            user,
            checked.kind === "settlement" ? checked.oracle : checked.verifier,
            checked.kind === "settlement" ? expiryOracleAbi : pythAbi,
            checked.kind === "settlement"
              ? (checked.action ?? "finalize")
              : "updatePriceFeeds",
            checked.kind === "settlement"
              ? [
                  checked.feed,
                  BigInt(checked.expiry!),
                  checked.action === "finalize" ? [] : checked.updates,
                ]
              : [checked.updates],
            BigInt(checked.maxFee),
          ),
        );
      } else if (a.action === "revoke-authorizations") {
        hashes.push(
          await send(
            user,
            manifest.engine,
            engineAbi,
            "invalidateAuthorizations",
          ),
        );
      } else if (a.action === "approve-recovery") {
        if (!a.packet) throw new Error("Missing recovery authorization");
        const packet = parseRecovery(a.packet, manifest);
        if (
          packet.type !== "unwind" ||
          packet.terms.writer.toLowerCase() !== user.toLowerCase()
        )
          throw new Error("Only the writer can approve the unwind payment");
        await checkRecovery(client, packet, manifest);
        await approve(
          manifest.usdc,
          manifest.engine,
          BigInt(packet.terms.payment),
        );
      } else if (a.action === "submit-recovery") {
        if (!a.packet) throw new Error("Missing recovery authorization");
        const packet = parseRecovery(a.packet, manifest);
        await checkRecovery(client, packet, manifest, true);
        const t = packet.terms;
        hashes.push(
          await send(
            user,
            manifest.engine,
            engineAbi,
            packet.type === "claim"
              ? "redeemWithSignature"
              : "unwindUnresolved",
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
          ),
        );
      } else if (a.action === "faucet") {
        hashes.push(await send(user, manifest.usdc, abi("DemoUSDC"), "faucet"));
      } else if (a.action === "wrap") {
        if (qty <= 0n || qty > 1000n * 10n ** 18n)
          throw new Error("Invalid wrap amount");
        hashes.push(
          await send(
            user,
            manifest.wmon,
            abi("WrappedMON"),
            "deposit",
            [],
            qty,
          ),
        );
      } else if (a.action === "unwrap") {
        if (qty <= 0n) throw new Error("Invalid unwrap amount");
        hashes.push(
          await send(user, manifest.wmon, abi("WrappedMON"), "withdraw", [qty]),
        );
      } else if (a.action === "trade") {
        const input =
          a.legs ??
          (m
            ? [
                {
                  marketId: m.id,
                  isBuy: a.isBuy ?? true,
                  quantity: a.quantity ?? "0",
                  premiumLimit: a.price ?? "0",
                },
              ]
            : []);
        if (input.length === 0 || input.length > 4)
          throw new Error("Choose 1–4 strategy legs");
        let funding = 0n,
          minCredit = 0n;
        const legs = [];
        for (const l of input) {
          const market = snap!.markets.find((x) => x.id === l.marketId);
          if (!market) throw new Error("Unknown market");
          if (!market.active)
            throw new Error("Expired market does not accept new orders");
          const q = parseUnits(l.quantity, 18),
            p = parseUnits(l.premiumLimit, 6);
          if (q <= 0n || q % 10n ** 15n !== 0n || p < 0n)
            throw new Error("Use positive quantities in 0.001 MON lots");
          if (
            !quoteDepth(l.isBuy ? market.asks : market.bids, Number(q) / 1e18)
              .complete
          )
            throw new Error(
              "Insufficient executable depth; no approval or order submitted",
            );
          legs.push({
            seriesId: BigInt(l.marketId),
            isBuy: l.isBuy,
            quantity: q,
            premiumLimit: p,
          });
          if (l.isBuy) funding += p;
          else minCredit += p;
        }
        for (const leg of legs)
          if (!leg.isBuy)
            await approve(
              manifest.series.find(
                (market) => market.id === Number(leg.seriesId),
              )!.token,
              manifest.router,
              leg.quantity,
            );
        await approve(manifest.usdc, manifest.router, funding);
        hashes.push(
          await send(user, manifest.router, routerAbi, "execute", [
            legs,
            funding,
            funding,
            funding === 0n ? minCredit : 0n,
            snap!.timestamp + 120,
          ]),
        );
      } else {
        if (!m) throw new Error("Unknown market");
        if (a.action === "write") {
          if (qty <= 0n) throw new Error("Enter a quantity");
          const asset = m.kind === "call" ? manifest.wmon : manifest.usdc;
          const needed = (await client.readContract({
            address: manifest.engine,
            abi: engineAbi,
            functionName: "requiredCollateral",
            args: [BigInt(m.id), qty],
          })) as bigint;
          await approve(asset, manifest.engine, needed);
          hashes.push(
            await send(user, manifest.engine, engineAbi, "write", [
              BigInt(m.id),
              qty,
              user,
            ]),
          );
        } else if (a.action === "close")
          hashes.push(
            await send(user, manifest.engine, engineAbi, "closeWrite", [
              BigInt(m.id),
              qty,
            ]),
          );
        else if (a.action === "redeem")
          hashes.push(
            await send(user, manifest.engine, engineAbi, "redeemLong", [
              BigInt(m.id),
              qty,
              user,
            ]),
          );
        else if (a.action === "settle-writer")
          hashes.push(
            await send(user, manifest.engine, engineAbi, "settleWriter", [
              BigInt(m.id),
              user,
            ]),
          );
        else if (a.action === "finalize")
          hashes.push(
            await send(user, manifest.oracle, oracleAbi, "finalize", [
              assetFor(manifest, m).assetId,
              m.expiry,
              [],
            ]),
          );
        else if (a.action === "cancel") {
          if (!a.orderId) throw new Error("Missing order");
          hashes.push(
            await send(
              user,
              m.market,
              manifest.venueMode === "kuru" ? kuruAbi : abi("DemoOrderBook"),
              manifest.venueMode === "kuru" ? "batchCancelOrders" : "cancel",
              manifest.venueMode === "kuru"
                ? [[BigInt(a.orderId)]]
                : [BigInt(a.orderId)],
            ),
          );
          // Return the caller's free venue funds to their wallet after cancellation.
          if (manifest.kuruMargin)
            for (const token of [m.token, manifest.usdc]) {
              const free = (await client.readContract({
                address: manifest.kuruMargin,
                abi: marginAbi,
                functionName: "getBalance",
                args: [user, token],
              })) as bigint;
              if (free > 0n)
                hashes.push(
                  await send(user, manifest.kuruMargin, marginAbi, "withdraw", [
                    free,
                    token,
                  ]),
                );
            }
        } else if (a.action === "withdraw") {
          if (!manifest.kuruMargin)
            throw new Error("No venue custody in this development book");
          for (const token of [m.token, manifest.usdc]) {
            const free = (await client.readContract({
              address: manifest.kuruMargin,
              abi: marginAbi,
              functionName: "getBalance",
              args: [user, token],
            })) as bigint;
            if (free > 0n)
              hashes.push(
                await send(user, manifest.kuruMargin, marginAbi, "withdraw", [
                  free,
                  token,
                ]),
              );
          }
        } else if (a.action === "place") {
          const p = parseUnits(a.price ?? "0", 6),
            isBuy = a.isBuy ?? true;
          if (
            qty <= 0n ||
            p <= 0n ||
            p > 4294967295n ||
            qty % 10n ** 15n !== 0n ||
            qty / 10n ** 15n > 1000000000n
          )
            throw new Error(
              "Use a positive price and quantities in 0.001 MON lots",
            );
          if (
            (isBuy && m.ask !== null && Number(p) / 1e6 >= m.ask) ||
            (!isBuy && m.bid !== null && Number(p) / 1e6 <= m.bid)
          )
            throw new Error(
              "Post-only order would cross the book. Choose a resting price.",
            );
          const token = isBuy ? manifest.usdc : m.token,
            amount = isBuy ? (qty * p + 10n ** 18n - 1n) / 10n ** 18n : qty;
          const spender = manifest.kuruMargin ?? m.market;
          await approve(token, spender, amount);
          if (manifest.kuruMargin) {
            hashes.push(
              await send(user, manifest.kuruMargin, marginAbi, "deposit", [
                user,
                token,
                amount,
              ]),
            );
            if (qty % 10n ** 15n !== 0n)
              throw new Error("Minimum lot is 0.001 MON");
            hashes.push(
              await send(
                user,
                m.market,
                kuruAbi,
                isBuy ? "addBuyOrder" : "addSellOrder",
                [Number(p), qty / 10n ** 15n, true],
              ),
            );
          } else
            hashes.push(
              await send(user, m.market, abi("DemoOrderBook"), "place", [
                isBuy,
                p,
                qty,
              ]),
            );
        }
      }
      try {
        await refresh();
        return {
          hashes,
          status: "included",
          readModelUpdated: true,
          portfolio: await portfolio(user),
        };
      } catch {
        // Inclusion is final for this response even if indexing or valuation is unavailable.
        return { hashes, status: "included", readModelUpdated: false };
      }
    });
  } catch (error) {
    const submitted = (error as { transactionHash?: Hex }).transactionHash;
    if (submitted && !hashes.includes(submitted)) hashes.push(submitted);
    return reply.code(400).send({
      error: safeDiagnostic(error),
      hashes,
      status: hashes.length ? "partial" : "failed",
    });
  }
});
let checkpoint:
  | {
      id: Hex;
      block: bigint;
      hash: Hex;
      makerEnabled: boolean;
      makerConfig: MakerConfig;
    }
  | undefined;
const checkpointPath = `${root}.runtime/checkpoint-${manifest.engine.toLowerCase()}.json`;
if (local && existsSync(checkpointPath)) {
  const stored = z
    .object({
      id: z.string().regex(/^0x[0-9a-f]+$/),
      block: z.string().regex(/^\d+$/),
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      makerEnabled: z.boolean(),
      makerConfig: makerConfigSchema,
    })
    .parse(JSON.parse(readFileSync(checkpointPath, "utf8")));
  checkpoint = {
    ...stored,
    id: stored.id as Hex,
    hash: stored.hash as Hex,
    block: BigInt(stored.block),
  };
  setWorkersPaused(true);
}
app.post("/api/demo/checkpoint", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  const p = z
    .discriminatedUnion("operation", [
      z.object({ operation: z.literal("begin") }).strict(),
      z
        .object({
          operation: z.literal("restore"),
          id: z.string().regex(/^0x[0-9a-f]+$/),
        })
        .strict(),
    ])
    .safeParse(request.body);
  if (!p.success)
    return reply.code(400).send({ error: "Invalid checkpoint operation" });
  return serialized(async () => {
    if (p.data.operation === "begin") {
      if (checkpoint)
        return reply
          .code(409)
          .send({ error: "A local checkpoint is already active" });
      setWorkersPaused(true);
      try {
        await refresh();
        const block = await client.getBlock();
        const id = (await client.request({
          method: "evm_snapshot" as never,
        })) as Hex;
        checkpoint = {
          id,
          block: block.number,
          hash: block.hash!,
          makerEnabled,
          makerConfig: { ...makerConfig },
        };
        writeFileSync(checkpointPath, json(checkpoint));
        return { id, block: block.number.toString() };
      } catch (e) {
        setWorkersPaused(false);
        throw e;
      }
    }
    if (!checkpoint || p.data.id !== checkpoint.id)
      return reply
        .code(409)
        .send({ error: "Checkpoint does not match the active session" });
    await refresh();
    const restored = await client.request({
      method: "evm_revert" as never,
      params: [checkpoint.id] as never,
    });
    if (!restored) throw new Error("Chain refused checkpoint restore");
    rewindReadModel(checkpoint.block, checkpoint.hash);
    setMakerEnabled(checkpoint.makerEnabled);
    setMakerConfig(checkpoint.makerConfig);
    resetWorkerState();
    checkpoint = undefined;
    unlinkSync(checkpointPath);
    setWorkersPaused(false);
    return refresh();
  });
});
app.post("/api/demo/advance", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  const parsed = z
    .object({
      seconds: z.number().int().min(0).max(31536000).default(0),
      /** Legacy: controlled MON price. */
      price: z.number().positive().max(10).optional(),
      /** Controlled prices by asset key, e.g. { SPY: 652.1 }. */
      prices: z
        .record(z.string().max(12), z.number().positive().max(1e9))
        .optional(),
      /** Also move to this asset's next session open when it is closed. */
      openAsset: z.string().max(12).optional(),
      publish: z.boolean().default(true),
      finalize: z.boolean().default(true),
    })
    .refine(
      (v) => v.seconds > 0 || v.openAsset,
      "Advance needs seconds or openAsset",
    )
    .safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "Invalid scenario" });
  const assets = manifestAssets(manifest);
  const requested = { ...parsed.data.prices };
  if (parsed.data.price !== undefined) requested.MON ??= parsed.data.price;
  if (Object.keys(requested).some((key) => !assets.some((a) => a.key === key)))
    return reply.code(400).send({ error: "Unknown asset in scenario" });
  try {
    return await serialized(async () => {
      let seconds = parsed.data.seconds;
      if (parsed.data.openAsset) {
        const asset = assets.find((a) => a.key === parsed.data.openAsset);
        if (!asset) throw new Error("Unknown asset in scenario");
        const now = Number((await client.getBlock()).timestamp);
        const wait = secondsUntilOpen(asset, now + seconds);
        seconds += wait ? wait + 1 : 0;
      }
      await client.request({
        method: "evm_increaseTime" as never,
        params: [seconds] as never,
      });
      await client.request({ method: "evm_mine" as never });
      if (parsed.data.publish) {
        const timestamp = Number((await client.getBlock()).timestamp);
        for (const asset of assets) {
          const explicit = requested[asset.key];
          const open = assetSessionOpen(asset, timestamp);
          if (explicit !== undefined && !open)
            throw new Error(`${asset.key} market is closed at chain time`);
          if (!open) continue;
          const price =
            explicit ??
            (current()?.underlyings?.[asset.key]?.spot || asset.reference);
          if (price > 0) await publishControlledPrice(asset.key, price);
        }
      }
      if (parsed.data.finalize) await finalizeElapsed(manifest.demoUser);
      return refresh();
    });
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
app.post("/api/demo/maker", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  const p = z.object({ enabled: z.boolean() }).safeParse(request.body);
  if (!p.success) return reply.code(400).send({ error: "Invalid control" });
  return serialized(async () => {
    setMakerEnabled(p.data.enabled);
    await refresh();
    return {
      enabled: makerEnabled,
      note: "Controls quoting updates; existing orders remain funded and cancellable.",
    };
  });
});
app.post("/api/demo/maker-halt", async (_, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  return serialized(async () => {
    setMakerEnabled(false);
    try {
      const snapshot = await refresh();
      const hashes = await drainMakerQuotes(snapshot);
      try {
        return {
          hashes,
          status: "halted",
          readModelUpdated: true,
          snapshot: await refresh(),
        };
      } catch {
        return { hashes, status: "halted", readModelUpdated: false };
      }
    } catch (error) {
      recordWorkerError(
        "Maker halt incomplete; inspect the maker's journal and custody balances before retrying.",
      );
      return reply.code(400).send({
        error:
          "Maker updates are paused. Cancellations or withdrawals may be incomplete; review balances before retrying.",
        hashes: (error as { hashes?: Hex[] }).hashes ?? [],
        status: "partial",
      });
    }
  });
});
app.post("/api/demo/maker-cycle", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  const input = z
    .object({
      marketIds: z.array(z.number().int().positive()).min(1).max(4).optional(),
    })
    .strict()
    .safeParse(request.body ?? {});
  if (
    !input.success ||
    input.data.marketIds?.some(
      (id) => !manifest.series.some((market) => market.id === id),
    )
  )
    return reply.code(400).send({ error: "Choose up to four known markets" });
  return serialized(() =>
    runMakerCycle({
      allowDuringCheckpoint: true,
      marketIds: input.data.marketIds,
    }),
  );
});
app.post("/api/demo/house-cycle", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  if (!manifest.house)
    return reply.code(404).send({ error: "No house vault in this deployment" });
  const input = z
    .object({
      marketIds: z.array(z.number().int().positive()).min(1).max(4).optional(),
    })
    .strict()
    .safeParse(request.body ?? {});
  if (!input.success)
    return reply.code(400).send({ error: "Choose up to four known markets" });
  try {
    return await serialized(async () => {
      const hash = await runHouseCycle({ marketIds: input.data.marketIds });
      return { hash: hash ?? null, house: (await refresh()).house };
    });
  } catch (error) {
    return reply.code(400).send({ error: safeDiagnostic(error) });
  }
});
app.post("/api/demo/maker-config", async (request, reply) => {
  if (!local) return reply.code(403).send({ error: "Local only" });
  const p = makerConfigSchema.safeParse(request.body);
  if (!p.success)
    return reply.code(400).send({ error: "Invalid maker risk settings" });
  return serialized(async () => {
    setMakerConfig(p.data);
    return refresh();
  });
});
app.setErrorHandler((error, request, reply) => {
  app.log.error({ error: safeDiagnostic(error) });
  const status = (error as { statusCode?: number }).statusCode;
  reply.code(status && status >= 400 && status < 500 ? status : 500).send({
    error:
      status === 413
        ? "Request exceeds the supported size."
        : status && status >= 400 && status < 500
          ? "Invalid request."
          : "Service operation failed; check protocol status.",
  });
});
if (serverless) await reloadCloudReadModel();
await refresh().catch(() =>
  recordWorkerError("Initial confirmed market refresh unavailable; retrying."),
);
if (!serverless)
  setInterval(() => {
    void refresh()
      .then((s) => {
        for (const socket of connections)
          socket.send(
            JSON.stringify({ block: s.block, timestamp: s.timestamp }),
          );
      })
      .catch((e) => {
        recordWorkerError(String(e));
        app.log.error({ error: safeDiagnostic(e) });
      });
  }, 3000).unref();
if (!serverless && (local || publicWorkers)) startWorkers();
if (!serverless)
  await app.listen({
    port: Number(process.env.API_PORT ?? 3001),
    host: "127.0.0.1",
  });
