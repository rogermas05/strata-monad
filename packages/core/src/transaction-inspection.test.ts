import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Manifest } from "./types.ts";
import { inspectTransaction } from "./transaction-inspection.ts";
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = `0x${"aa".repeat(32)}` as Hex,
  blockHash = `0x${"bb".repeat(32)}` as Hex;
const manifest = {
  chainId: 31337,
  engine: address(3),
  oracle: address(5),
  usdc: address(2),
  wmon: address(4),
  router: address(7),
  oracleMode: "demo",
  series: [],
} as unknown as Manifest;
const abi = parseAbi(["function approve(address,uint256) returns (bool)"]);
function fixture(
  change: {
    from?: Address;
    to?: Address;
    chainId?: number;
    pending?: boolean;
    reverted?: boolean;
    orphaned?: boolean;
  } = {},
) {
  return {
    getChainId: async () => change.chainId ?? 31337,
    getTransaction: async () => ({
      hash,
      from: change.from ?? address(1),
      to: change.to ?? address(2),
      chainId: 31337,
      input: encodeFunctionData({
        abi,
        functionName: "approve",
        args: [address(3), 1n],
      }),
    }),
    getTransactionReceipt: async () => {
      if (change.pending) throw new TransactionReceiptNotFoundError({ hash });
      return {
        blockNumber: 20n,
        blockHash,
        status: change.reverted ? "reverted" : "success",
      };
    },
    getBlock: async () => ({ hash: change.orphaned ? hash : blockHash }),
    readContract: async () => address(6),
  } as unknown as PublicClient;
}
describe("chain-derived transaction journal", () => {
  it("derives account, operation and canonical receipt instead of trusting client labels", async () => {
    expect(
      await inspectTransaction(fixture(), manifest, hash, address(1), [abi]),
    ).toMatchObject({
      hash,
      account: address(1),
      target: address(2),
      operation: "approve",
      status: "included",
      block: "20",
    });
    expect(
      (
        await inspectTransaction(
          fixture(),
          manifest,
          `0x${"AA".repeat(32)}` as Hex,
          address(1),
          [abi],
        )
      ).hash,
    ).toBe(hash);
  });
  it("rejects a wrong sender, network or unrelated target", async () => {
    for (const change of [
      { from: address(9) },
      { to: address(9) },
      { chainId: 143 },
    ])
      await expect(
        inspectTransaction(fixture(change), manifest, hash, address(1), [abi]),
      ).rejects.toThrow();
  });
  it("distinguishes pending, reverted and orphaned receipts", async () => {
    for (const [change, status] of [
      [{ pending: true }, "pending"],
      [{ reverted: true }, "reverted"],
      [{ orphaned: true }, "orphaned"],
    ] as const)
      expect(
        (
          await inspectTransaction(
            fixture(change),
            manifest,
            hash,
            address(1),
            [abi],
          )
        ).status,
      ).toBe(status);
  });
  it("admits only the configured Pyth verifier as an additional target", async () => {
    const pyth = { ...manifest, oracleMode: "pyth" as const };
    expect(
      (
        await inspectTransaction(
          fixture({ to: address(6) }),
          pyth,
          hash,
          address(1),
          [abi],
        )
      ).target,
    ).toBe(address(6));
    await expect(
      inspectTransaction(fixture({ to: address(9) }), pyth, hash, address(1), [
        abi,
      ]),
    ).rejects.toThrow("outside");
  });
});
