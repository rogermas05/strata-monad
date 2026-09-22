import { expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { Manifest } from "./types.ts";
import { checkRpcPair } from "./deployment-check.ts";
const hash = `0x${"ab".repeat(32)}`;
function fixture(chain = 31337, tip = 20n, blockHash = hash) {
  const getBlock = vi.fn(async ({ blockNumber }) => ({
    number: blockNumber,
    timestamp: 1000n,
    hash: blockHash,
  }));
  return {
    client: {
      getChainId: async () => chain,
      getBlockNumber: async () => tip,
      getBlock,
    } as unknown as PublicClient,
    getBlock,
  };
}
const manifest = { chainId: 31337, deployedBlock: "9" } as Manifest;
it("pins a shared block when service and browser tips differ (synthetic RPC fixtures)", async () => {
  const a = fixture(31337, 20n),
    b = fixture(31337, 10n);
  expect((await checkRpcPair(a.client, b.client, manifest)).blockNumber).toBe(
    10n,
  );
  expect(a.getBlock).toHaveBeenCalledWith({ blockNumber: 10n });
  expect(b.getBlock).toHaveBeenCalledWith({ blockNumber: 10n });
  await expect(
    checkRpcPair(
      a.client,
      fixture(31337, 10n, `0x${"AB".repeat(32)}`).client,
      manifest,
    ),
  ).resolves.toHaveProperty("blockNumber", 10n);
});
it("rejects network, deployment-height and canonical-header disagreement before admission", async () => {
  for (const other of [
    fixture(143),
    fixture(31337, 8n),
    fixture(31337, 20n, `0x${"cd".repeat(32)}`),
  ])
    await expect(
      checkRpcPair(fixture().client, other.client, manifest),
    ).rejects.toThrow();
});
