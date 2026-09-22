import { afterEach, expect, it, vi } from "vitest";
import type { Hex, TransactionReceipt } from "viem";
import { waitReceipt } from "./receipts.ts";
const hash = `0x${"ab".repeat(32)}` as Hex;
const receipt = {
  transactionHash: hash,
  status: "success",
} as TransactionReceipt;
afterEach(() => vi.useRealTimers());
it("retries missing receipts and transient read failures for the same broadcast hash", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("Not mined"), {
        name: "TransactionReceiptNotFoundError",
      }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error("RPC slow"), { name: "TimeoutError" }),
    )
    .mockResolvedValue(receipt);
  const pending = waitReceipt({ getTransactionReceipt: read }, hash, 2000);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toBe(receipt);
  expect(read.mock.calls).toEqual([[{ hash }], [{ hash }], [{ hash }]]);
});
it("bounds repeated transport failures and preserves the hash for reconciliation", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("RPC down"), { name: "HttpRequestError" }),
    );
  const assertion = expect(
    waitReceipt({ getTransactionReceipt: read }, hash, 1000),
  ).rejects.toThrow(hash);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(read).toHaveBeenCalledTimes(4);
});
it("does not hide invalid requests as temporary node failures", async () => {
  const error = Object.assign(new Error("Invalid params"), {
    name: "InvalidParamsRpcError",
  });
  const read = vi.fn().mockRejectedValue(error);
  await expect(waitReceipt({ getTransactionReceipt: read }, hash)).rejects.toBe(
    error,
  );
  expect(read).toHaveBeenCalledTimes(1);
});
it("waits on the local pending transaction before requesting its receipt", async () => {
  vi.useFakeTimers();
  // Forked nodes forward receipt lookups for pending transactions upstream.
  const pendingTx = vi
    .fn()
    .mockResolvedValueOnce({ hash, blockNumber: null })
    .mockResolvedValueOnce({ hash, blockNumber: null })
    .mockResolvedValue({ hash, blockNumber: 7n });
  const read = vi.fn().mockResolvedValue(receipt);
  const result = waitReceipt(
    { getTransaction: pendingTx, getTransactionReceipt: read },
    hash,
    5000,
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(receipt);
  expect(pendingTx).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledTimes(1);
});
it("falls back to receipt polling when the transaction lookup is unavailable", async () => {
  vi.useFakeTimers();
  const lookup = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("unknown"), { name: "TransactionNotFoundError" }),
    );
  const read = vi.fn().mockResolvedValue(receipt);
  const result = waitReceipt(
    { getTransaction: lookup, getTransactionReceipt: read },
    hash,
    5000,
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe(receipt);
  expect(read).toHaveBeenCalledTimes(1);
});
