import {
  decodeFunctionData,
  toFunctionSelector,
  type Abi,
  type Address,
} from "viem";
import type { Manifest } from "../../../packages/core/src/types.ts";
import { manifestAssets } from "../../../packages/core/src/manifest-assets.ts";
import type { SignerIntent } from "../../../scripts/lib/managed-signer.ts";
import { OptionsEngine as engine } from "../../../packages/core/src/generated/contracts.ts";
import { OptionToken as token } from "../../../packages/core/src/generated/contracts.ts";
import { WrappedMON as wrapped } from "../../../packages/core/src/generated/contracts.ts";
import { DemoUSDC as usdc } from "../../../packages/core/src/generated/contracts.ts";
import {
  HouseVault as vault,
  StrataDistributor as distributor,
} from "../../../packages/core/src/generated/contracts.ts";
import { parseAbi } from "viem";

const margin = parseAbi([
  "function deposit(address,address,uint256) payable",
  "function withdraw(uint256,address)",
]);
const book = parseAbi([
  "function batchCancelOrdersNoRevert(uint40[])",
  "function batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)",
]);
const oracle = parseAbi([
  "function updatePriceFeeds(bytes[]) payable",
  "function propose(bytes32,uint64,bytes[]) payable",
  "function finalize(bytes32,uint64,bytes[]) payable",
]);

/** Exact deployment/role targets, methods, beneficiaries and approval spenders. */
export function workerAuthorizer(
  manifest: Manifest,
  role: "deployer" | "maker",
  verifier?: Address,
) {
  const targets = new Map<string, { abi: Abi; names: string[] }>();
  const add = (address: Address, abi: Abi, names: string[]) =>
    targets.set(address.toLowerCase(), { abi, names });
  if (role === "maker") {
    add(manifest.engine, engine as Abi, [
      "write",
      "closeWrite",
      "redeemLong",
      "settleWriter",
    ]);
    add(manifest.usdc, usdc as Abi, ["approve", "faucet"]);
    add(manifest.wmon, wrapped as Abi, ["approve", "deposit"]);
    if (manifest.kuruMargin)
      add(manifest.kuruMargin, margin, ["deposit", "withdraw"]);
    for (const s of manifest.series) {
      add(s.token, token as Abi, ["approve"]);
      add(s.market, book, ["batchUpdate", "batchCancelOrdersNoRevert"]);
    }
    if (manifest.house) {
      add(manifest.house.vault, vault as Abi, [
        "write",
        "closeWrite",
        "depositToVenue",
        "withdrawFromVenue",
        "updateQuotes",
        "cancelQuotes",
        "roll",
      ]);
      add(manifest.house.distributor, distributor as Abi, ["publish"]);
    }
  } else {
    if (verifier) add(verifier, oracle, ["updatePriceFeeds"]);
    for (const a of manifestAssets(manifest))
      add(a.adapter, oracle, ["propose", "finalize"]);
  }
  const same = (a: unknown, b: string) =>
    typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  return async (intent: SignerIntent) => {
    const allowed = intent.to && targets.get(intent.to.toLowerCase());
    if (!allowed) throw new Error(`${role} target is outside the deployment`);
    const decoded = decodeFunctionData({ abi: allowed.abi, data: intent.data });
    if (!allowed.names.includes(decoded.functionName))
      throw new Error(`${role} method is not permitted`);
    const args = (decoded.args ?? []) as readonly unknown[];
    const value = intent.value ?? 0n;
    if (value && decoded.functionName !== "deposit" && role === "maker")
      throw new Error("Maker call cannot transfer native value");
    const listed = (id: unknown) =>
      manifest.series.some((s) => BigInt(s.id) === id);
    const admittedToken = (t: unknown) =>
      [manifest.usdc, ...manifest.series.map((s) => s.token)].some((a) =>
        same(t, a),
      );
    if (
      role === "maker" &&
      manifest.house &&
      same(intent.to, manifest.house.vault)
    ) {
      // The vault itself enforces operator scope; this keeps the key on the listed shelf.
      if (value) throw new Error("Vault calls cannot transfer native value");
      if (
        ["write", "closeWrite"].includes(decoded.functionName) &&
        !listed(args[0])
      )
        throw new Error("Vault series is outside the deployment");
      if (
        ["depositToVenue", "withdrawFromVenue"].includes(
          decoded.functionName,
        ) &&
        !admittedToken(args[0])
      )
        throw new Error("Vault venue token is outside the deployment");
      if (
        ["updateQuotes", "cancelQuotes"].includes(decoded.functionName) &&
        !manifest.series.some((s) => same(args[0], s.market))
      )
        throw new Error("Vault book is outside the deployment");
      if (
        decoded.functionName === "roll" &&
        !(args[0] as readonly bigint[]).every(listed)
      )
        throw new Error("Vault epoch series is outside the deployment");
    } else if (
      role === "maker" &&
      manifest.house &&
      same(intent.to, manifest.house.distributor)
    ) {
      if (value) throw new Error("Reward publication cannot transfer value");
    } else if (role === "maker") {
      if (
        decoded.functionName === "approve" &&
        ![manifest.engine, manifest.kuruMargin].some(
          (s) => s && same(args[0], s),
        )
      )
        throw new Error("Approval spender is outside the deployment");
      if (
        decoded.functionName === "deposit" &&
        same(intent.to, manifest.kuruMargin ?? "")
      ) {
        if (
          value ||
          !same(args[0], manifest.maker) ||
          ![manifest.usdc, ...manifest.series.map((s) => s.token)].some((t) =>
            same(args[1], t),
          )
        )
          throw new Error(
            "Maker custody deposit has an invalid beneficiary, token or native value",
          );
      }
      if (
        ["write", "redeemLong"].includes(decoded.functionName) &&
        !same(args[2], manifest.maker)
      )
        throw new Error("Maker engine beneficiary changed");
      if (
        decoded.functionName === "settleWriter" &&
        !same(args[1], manifest.maker)
      )
        throw new Error("Maker writer changed");
      if (
        ["write", "closeWrite", "redeemLong", "settleWriter"].includes(
          decoded.functionName,
        ) &&
        !manifest.series.some((s) => BigInt(s.id) === args[0])
      )
        throw new Error("Maker series is outside the deployment");
      if (
        decoded.functionName === "withdraw" &&
        ![manifest.usdc, ...manifest.series.map((s) => s.token)].some((t) =>
          same(args[1], t),
        )
      )
        throw new Error("Maker withdrawal token is outside the deployment");
      if (decoded.functionName === "batchUpdate" && args[5] !== true)
        throw new Error("Maker orders must be post-only");
    } else {
      if (value > 10n ** 16n)
        throw new Error("Oracle fee exceeds the keeper budget");
      if (
        decoded.functionName !== "updatePriceFeeds" &&
        !manifest.series.some(
          (s) =>
            same(
              manifestAssets(manifest).find((a) => a.key === s.asset)
                ?.assetId ?? manifest.assetId,
              String(args[0]),
            ) && BigInt(s.expiry) === args[1],
        )
      )
        throw new Error("Keeper reference is outside the listed shelf");
      const updates = args[
        decoded.functionName === "updatePriceFeeds" ? 0 : 2
      ] as string[];
      if (
        !Array.isArray(updates) ||
        updates.length > 8 ||
        updates.reduce((n, u) => n + (u.length - 2) / 2, 0) > 65536
      )
        throw new Error("Keeper payload exceeds its bounds");
    }
  };
}
