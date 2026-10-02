import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type {
  Manifest,
  TransactionRecord,
} from "../../../packages/core/src/types.ts";
import { request } from "./api.ts";
import {
  savedTransactions,
  retrySavedTransactions,
} from "./transaction-journal.ts";
import { AddressText, Badge, Empty } from "./ui.tsx";
function operationLabel(record: TransactionRecord, manifest: Manifest) {
  if (record.operation === "deposit")
    return record.target.toLowerCase() === manifest.wmon.toLowerCase()
      ? "Wrap MON"
      : "Venue deposit";
  if (record.operation === "withdraw")
    return record.target.toLowerCase() === manifest.wmon.toLowerCase()
      ? "Unwrap MON"
      : "Venue withdrawal";
  return (
    (
      {
        approve: "Token approval",
        execute: "Execute strategy",
        write: "Issue contracts",
        closeWrite: "Burn and release collateral",
        redeemLong: "Claim option payout",
        settleWriter: "Recover writer collateral",
        finalize: "Finalize expiry",
        updatePriceFeeds: "Update live reference",
        publish: "Publish controlled reference",
        addBuyOrder: "Place bid",
        addSellOrder: "Place ask",
        batchCancelOrders: "Cancel orders",
        batchCancelOrdersNoRevert: "Cancel orders",
        invalidateAuthorizations: "Revoke authorizations",
        redeemWithSignature: "Relay expiry claim",
        unwindUnresolved: "Agreed expiry unwind",
      } as Record<string, string>
    )[record.operation] ?? "Contract transaction"
  );
}

export function TransactionHistory({
  manifest,
  account,
}: {
  manifest: Manifest;
  account: Address;
}) {
  const { data, isError, isPending } = useQuery({
    queryKey: ["transactions", manifest.chainId, manifest.engine, account],
    queryFn: async () => {
      const records = await request<TransactionRecord[]>(
        `/transactions/${account}`,
      );
      void retrySavedTransactions(manifest, account);
      return records;
    },
    refetchInterval: 5000,
  });
  const records = new Map(
    savedTransactions(manifest, account).map((r) => [
      r.hash.toLowerCase(),
      { ...r, source: "Browser receipt" },
    ]),
  );
  for (const record of data ?? [])
    records.set(record.hash.toLowerCase(), {
      ...record,
      source: isError ? "Cached chain check" : "Chain checked",
    });
  const rows = [...records.values()].sort((a, b) => b.created - a.created);
  return (
    <>
      <p className="transaction-note">
        {isError
          ? "Chain verification is unavailable. Saved browser records remain visible and will be retried when the service recovers."
          : isPending
            ? "Loading chain records. Saved browser submissions are shown while verification is pending."
            : "Included means a mined receipt, not irreversible finality. Reorganized receipts are marked orphaned. Tracking never resubmits a transaction."}
      </p>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Status</th>
                <th>Target</th>
                <th>Block</th>
                <th>Submitted</th>
                <th>Verification</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hash}>
                  <td title={r.operation}>{operationLabel(r, manifest)}</td>
                  <td>
                    <Badge
                      tone={
                        r.status === "included"
                          ? "green"
                          : r.status === "reverted" || r.status === "orphaned"
                            ? "red"
                            : "amber"
                      }
                    >
                      {r.status}
                    </Badge>
                  </td>
                  <td>
                    <AddressText value={r.target} />
                  </td>
                  <td>{r.block ?? "—"}</td>
                  <td>{new Date(r.created).toLocaleString()}</td>
                  <td>
                    {r.source === "Browser receipt" && r.status === "pending"
                      ? "Browser submission"
                      : r.source}
                  </td>
                  <td>
                    <AddressText value={r.hash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No recorded transactions">
          Wallet submissions and local demo actions appear here with their
          individual receipts.
        </Empty>
      )}
    </>
  );
}
