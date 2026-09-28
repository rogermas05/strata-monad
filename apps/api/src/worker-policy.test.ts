import { expect, it } from "vitest";
import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { workerAuthorizer } from "./worker-policy.ts";
import type { Manifest } from "../../../packages/core/src/types.ts";
import { OptionsEngine as engine } from "../../../packages/core/src/generated/contracts.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const feed = `0x${"aa".repeat(32)}` as Hex;
const m = {
  engine: addr(1),
  maker: addr(2),
  usdc: addr(3),
  wmon: addr(4),
  oracle: addr(5),
  kuruMargin: addr(6),
  assetId: feed,
  series: [
    { id: 1, asset: "MON", token: addr(7), market: addr(8), expiry: 1000 },
  ],
  assets: [{ key: "MON", assetId: feed, adapter: addr(9) }],
} as Manifest;
const intent = (
  to: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  value = 0n,
) => ({
  id: "test",
  to,
  data: encodeFunctionData({ abi, functionName, args }),
  value,
});
it("worker signing refuses foreign targets, spenders and beneficiaries", async () => {
  const allow = workerAuthorizer(m, "maker");
  const token = parseAbi(["function approve(address,uint256)"]);
  await allow(intent(m.usdc, token, "approve", [m.engine, 1n]));
  await expect(
    allow(intent(m.usdc, token, "approve", [addr(99), 1n])),
  ).rejects.toThrow("spender");
  await expect(
    allow(intent(addr(99), token, "approve", [m.engine, 1n])),
  ).rejects.toThrow("outside");
  await expect(
    allow(intent(m.engine, engine as Abi, "write", [1n, 1n, addr(99)])),
  ).rejects.toThrow("beneficiary");
  await expect(
    allow(intent(m.engine, engine as Abi, "write", [999n, 1n, m.maker])),
  ).rejects.toThrow("series");
  await allow(intent(m.engine, engine as Abi, "redeemLong", [1n, 1n, m.maker]));
});
it("worker custody is maker-owned, zero native value and restricted to admitted tokens", async () => {
  const allow = workerAuthorizer(m, "maker"),
    margin = parseAbi([
      "function deposit(address,address,uint256) payable",
      "function withdraw(uint256,address)",
    ]);
  await allow(intent(m.kuruMargin!, margin, "deposit", [m.maker, m.usdc, 1n]));
  await expect(
    allow(intent(m.kuruMargin!, margin, "deposit", [addr(99), m.usdc, 1n])),
  ).rejects.toThrow("custody");
  await expect(
    allow(intent(m.kuruMargin!, margin, "deposit", [m.maker, m.usdc, 1n], 1n)),
  ).rejects.toThrow("custody");
  await expect(
    allow(intent(m.kuruMargin!, margin, "withdraw", [1n, addr(99)])),
  ).rejects.toThrow("token");
});
it("keeper signing is restricted to listed references, proof limits and a bounded fee", async () => {
  const allow = workerAuthorizer(m, "deployer", addr(10)),
    oracle = parseAbi(["function propose(bytes32,uint64,bytes[]) payable"]);
  await allow(
    intent(addr(9), oracle, "propose", [feed, 1000n, ["0xdeadbeef"]]),
  );
  await expect(
    allow(intent(addr(9), oracle, "propose", [feed, 2000n, ["0xdeadbeef"]])),
  ).rejects.toThrow("reference");
  await expect(
    allow(
      intent(addr(9), oracle, "propose", [
        feed,
        1000n,
        Array(9).fill("0xdeadbeef"),
      ]),
    ),
  ).rejects.toThrow("payload");
  await expect(
    allow(
      intent(
        addr(9),
        oracle,
        "propose",
        [feed, 1000n, ["0xdeadbeef"]],
        10n ** 17n,
      ),
    ),
  ).rejects.toThrow("fee");
});
