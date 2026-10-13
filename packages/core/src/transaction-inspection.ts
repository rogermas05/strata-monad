import {
  decodeFunctionData,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Manifest, TransactionRecord } from "./types.ts";
import { expiryOracleAbi } from "./oracle-proof.ts";

/** Derive journal metadata from the chain, never from client-supplied labels. */
export async function inspectTransaction(
  client: PublicClient,
  manifest: Manifest,
  hash: Hex,
  account: Address,
  abis: Abi[],
): Promise<TransactionRecord> {
  if ((await client.getChainId()) !== manifest.chainId)
    throw new Error("RPC chain mismatch");
  const transaction = await client.getTransaction({ hash });
  if (
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    transaction.from.toLowerCase() !== account.toLowerCase() ||
    !transaction.to ||
    (transaction.chainId !== undefined &&
      transaction.chainId !== manifest.chainId)
  )
    throw new Error("Transaction account or chain mismatch");
  const targets = [
    manifest.engine,
    manifest.router,
    manifest.oracle,
    manifest.usdc,
    manifest.wmon,
    manifest.kuruMargin,
    ...manifest.series.flatMap((s) => [s.token, s.market, s.venue]),
    ...(manifest.house
      ? [
          manifest.house.vault,
          manifest.house.strata,
          manifest.house.staking,
          manifest.house.distributor,
        ]
      : []),
  ]
    .filter(Boolean)
    .map((a) => a!.toLowerCase());
  if (!targets.includes(transaction.to.toLowerCase())) {
    if (manifest.oracleMode !== "pyth")
      throw new Error("Transaction target is outside this deployment");
    const verifier = await client.readContract({
      address: manifest.oracle,
      abi: expiryOracleAbi,
      functionName: "pyth",
    });
    if (transaction.to.toLowerCase() !== verifier.toLowerCase())
      throw new Error("Transaction target is outside this deployment");
  }
  let operation = "Contract call";
  if (
    transaction.input === "0x" &&
    transaction.to.toLowerCase() === manifest.wmon.toLowerCase()
  )
    operation = "deposit";
  else
    for (const abi of abis) {
      try {
        operation = decodeFunctionData({
          abi,
          data: transaction.input,
        }).functionName;
        break;
      } catch {
        /* The next admitted interface may recognize this selector. */
      }
    }
  let status: TransactionRecord["status"] = "pending",
    block: string | null = null;
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    status =
      canonical.hash !== receipt.blockHash
        ? "orphaned"
        : receipt.status === "success"
          ? "included"
          : "reverted";
    block = receipt.blockNumber.toString();
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }
  return {
    hash: transaction.hash.toLowerCase() as Hex,
    account: transaction.from,
    target: transaction.to,
    operation,
    status,
    block,
    created: Date.now(),
  };
}
