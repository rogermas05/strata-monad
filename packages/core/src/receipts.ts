import type { Hex, TransactionReceipt } from "viem";

/** Poll receipts directly: works with automining and chains without a new-block subscription. */
export async function waitReceipt(
  client: {
    getTransactionReceipt: (args: { hash: Hex }) => Promise<TransactionReceipt>;
    getTransaction?: (args: {
      hash: Hex;
    }) => Promise<{ blockNumber: bigint | null }>;
  },
  hash: Hex,
  timeout = 120000,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Forked nodes forward receipt lookups for pending transactions to their
    // upstream RPC, which can stall. A locally pending transaction is answered
    // without that round trip, so wait for inclusion before asking for a receipt.
    if (client.getTransaction) {
      const pending = await client
        .getTransaction({ hash })
        .then((tx) => tx.blockNumber === null)
        .catch(() => false);
      if (pending) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
    }
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (
        ![
          "TransactionReceiptNotFoundError",
          "TimeoutError",
          "HttpRequestError",
          "WebSocketRequestError",
          "SocketClosedError",
          "LimitExceededRpcError",
          "InternalRpcError",
        ].includes((error as { name?: string }).name ?? "")
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Receipt not found before timeout. Transaction ${hash} may still be pending; check its receipt before retrying.`,
  );
}
