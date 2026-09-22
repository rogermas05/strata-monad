import { z } from "zod";
import {
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { OptionsEngine as engineAbi } from "./generated/contracts.ts";
import type { Manifest } from "./types.ts";
import { assetFor } from "./manifest-assets.ts";

const uint = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine((s) => BigInt(s) < 2n ** 256n, "Value exceeds uint256");
const positive = uint.refine((s) => BigInt(s) > 0n, "Value must be positive");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s))
  .refine((s) => s !== zeroAddress, "Zero address is not allowed");
const signature = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .max(8194)
  .transform((s) => s as Hex);
const common = {
  version: z.literal(1),
  chainId: z.number().int().positive().safe(),
  engine: address,
};
export const recoverySchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("claim"),
      terms: z
        .object({
          seriesId: positive,
          holder: address,
          quantity: positive,
          nonce: uint,
          deadline: positive,
        })
        .strict(),
      signature: signature.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("unwind"),
      terms: z
        .object({
          seriesId: positive,
          writer: address,
          holder: address,
          quantity: positive,
          payment: uint,
          writerNonce: uint,
          holderNonce: uint,
          deadline: positive,
        })
        .strict()
        .refine((t) => t.writer !== t.holder, "Writer and holder must differ"),
      writerSignature: signature.optional(),
      holderSignature: signature.optional(),
    })
    .strict(),
]);
export type RecoveryPacket = z.infer<typeof recoverySchema>;
export interface RecoveryEffect {
  asset: "WMON" | "dUSDC";
  amount: string;
}
export function parseRecovery(
  value: unknown,
  manifest: Manifest,
): RecoveryPacket {
  const p = recoverySchema.parse(value);
  if (
    p.chainId !== manifest.chainId ||
    p.engine.toLowerCase() !== manifest.engine.toLowerCase()
  )
    throw new Error(
      "Authorization belongs to a different chain or options engine",
    );
  if (!manifest.series.some((s) => String(s.id) === p.terms.seriesId))
    throw new Error("Unknown authorization series");
  return p;
}
const claimTypes = {
  Claim: [
    { name: "seriesId", type: "uint256" },
    { name: "holder", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const unwindTypes = {
  Unwind: [
    { name: "seriesId", type: "uint256" },
    { name: "writer", type: "address" },
    { name: "holder", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "payment", type: "uint256" },
    { name: "writerNonce", type: "uint256" },
    { name: "holderNonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export function recoveryTypedData(p: RecoveryPacket) {
  const domain = {
    name: "Strata",
    version: "1",
    chainId: p.chainId,
    verifyingContract: p.engine,
  };
  if (p.type === "claim")
    return {
      domain,
      types: claimTypes,
      primaryType: "Claim" as const,
      message: {
        seriesId: BigInt(p.terms.seriesId),
        holder: p.terms.holder,
        quantity: BigInt(p.terms.quantity),
        nonce: BigInt(p.terms.nonce),
        deadline: BigInt(p.terms.deadline),
      },
    };
  return {
    domain,
    types: unwindTypes,
    primaryType: "Unwind" as const,
    message: {
      seriesId: BigInt(p.terms.seriesId),
      writer: p.terms.writer,
      holder: p.terms.holder,
      quantity: BigInt(p.terms.quantity),
      payment: BigInt(p.terms.payment),
      writerNonce: BigInt(p.terms.writerNonce),
      holderNonce: BigInt(p.terms.holderNonce),
      deadline: BigInt(p.terms.deadline),
    },
  };
}
export function authorizationSigner(
  p: RecoveryPacket,
  account: Address,
): "holder" | "writer" {
  if (account.toLowerCase() === p.terms.holder.toLowerCase()) return "holder";
  if (
    p.type === "unwind" &&
    account.toLowerCase() === p.terms.writer.toLowerCase()
  )
    return "writer";
  throw new Error("This account is not a party to the authorization");
}
export function attachSignature(
  p: RecoveryPacket,
  account: Address,
  sig: Hex,
): RecoveryPacket {
  const role = authorizationSigner(p, account);
  return p.type === "claim"
    ? { ...p, signature: sig }
    : {
        ...p,
        [role === "writer" ? "writerSignature" : "holderSignature"]: sig,
      };
}
export async function checkRecovery(
  client: Pick<PublicClient, "readContract" | "getBlock" | "verifyTypedData">,
  p: RecoveryPacket,
  manifest: Manifest,
  requireSignatures = false,
) {
  parseRecovery(p, manifest);
  const series = manifest.series.find(
    (s) => String(s.id) === p.terms.seriesId,
  )!;
  const block = await client.getBlock();
  if (BigInt(p.terms.deadline) < block.timestamp)
    throw new Error("Authorization expired; prepare new terms");
  if (BigInt(series.expiry) > block.timestamp)
    throw new Error("Recovery is available only after expiry");
  const read = (functionName: string, args: unknown[]) =>
    client.readContract({
      address: p.engine,
      abi: engineAbi as Abi,
      functionName,
      args,
    });
  const [holderNonce, quantity, settlement] = (await Promise.all([
    read("nonces", [p.terms.holder]),
    client.readContract({
      address: series.token,
      abi: engineAbiToken,
      functionName: "balanceOf",
      args: [p.terms.holder],
    }),
    client.readContract({
      address: manifest.oracle,
      abi: oracleAbi,
      functionName: "settlementPrice",
      args: [assetFor(manifest, series).assetId, BigInt(series.expiry)],
    }),
  ])) as [bigint, bigint, bigint];
  if (
    BigInt(p.type === "claim" ? p.terms.nonce : p.terms.holderNonce) !==
    holderNonce
  )
    throw new Error("Holder authorization nonce changed; prepare new terms");
  if (BigInt(p.terms.quantity) > quantity)
    throw new Error(
      "Holder must withdraw enough claims into their wallet first",
    );
  let effect: RecoveryEffect;
  if (p.type === "claim") {
    if (!settlement)
      throw new Error("The expiry reference has not been finalized");
    const payout = (await read("previewPayout", [
      BigInt(p.terms.seriesId),
      BigInt(p.terms.quantity),
      settlement,
    ])) as bigint;
    effect = {
      asset: series.kind === "call" ? "WMON" : "dUSDC",
      amount: payout.toString(),
    };
  } else {
    if (settlement)
      throw new Error(
        "Reference is finalized; use the ordinary claim instead of an unwind",
      );
    const [writerNonce, position] = (await Promise.all([
      read("nonces", [p.terms.writer]),
      read("writers", [BigInt(p.terms.seriesId), p.terms.writer]),
    ])) as [bigint, [bigint, bigint]];
    if (BigInt(p.terms.writerNonce) !== writerNonce)
      throw new Error("Writer authorization nonce changed; prepare new terms");
    if (BigInt(p.terms.quantity) > position[0])
      throw new Error("Writer has insufficient remaining obligation");
    const retained = (await read("requiredCollateral", [
      BigInt(p.terms.seriesId),
      position[0] - BigInt(p.terms.quantity),
    ])) as bigint;
    effect = {
      asset: series.kind === "call" ? "WMON" : "dUSDC",
      amount: (position[1] - retained).toString(),
    };
  }
  const typed = recoveryTypedData(p);
  const signatures: [Address, Hex | undefined][] =
    p.type === "claim"
      ? [[p.terms.holder, p.signature]]
      : [
          [p.terms.writer, p.writerSignature],
          [p.terms.holder, p.holderSignature],
        ];
  for (const [address, signature] of signatures) {
    if (!signature && requireSignatures)
      throw new Error(
        "Every required signature must be present before submission",
      );
    if (
      signature &&
      !(await client.verifyTypedData({ ...typed, address, signature }))
    )
      throw new Error("Signature does not match the displayed terms");
  }
  return effect;
}
const engineAbiToken = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
const oracleAbi = [
  {
    type: "function",
    name: "settlementPrice",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "bytes32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
