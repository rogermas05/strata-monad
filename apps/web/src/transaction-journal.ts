import type {
  Manifest,
  TransactionRecord,
} from "../../../packages/core/src/types.ts";
import type { Address } from "viem";
type SavedRecord = TransactionRecord & { registered?: boolean };
const fallback = new Map<string, SavedRecord[]>();
const retrying = new Map<string, Promise<void>>();
function key(manifest: Manifest, account: Address) {
  return `strata-transactions:${manifest.chainId}:${manifest.engine.toLowerCase()}:${account.toLowerCase()}`;
}
export function savedTransactions(
  manifest: Manifest,
  account: Address,
): SavedRecord[] {
  const storageKey = key(manifest, account);
  if (fallback.has(storageKey)) return fallback.get(storageKey)!;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(value))
      return value
        .filter(
          (r) =>
            r &&
            /^0x[0-9a-fA-F]{64}$/.test(r.hash) &&
            /^0x[0-9a-fA-F]{40}$/.test(r.target) &&
            typeof r.account === "string" &&
            r.account.toLowerCase() === account.toLowerCase() &&
            typeof r.operation === "string" &&
            r.operation.length <= 64 &&
            Number.isFinite(r.created) &&
            [
              "pending",
              "included",
              "reverted",
              "unconfirmed",
              "orphaned",
            ].includes(r.status) &&
            (r.block === null ||
              (typeof r.block === "string" && /^\d+$/.test(r.block))),
        )
        .slice(0, 100);
  } catch {
    /* Browser storage may be disabled or full. Keep an in-memory record. */
  }
  return [];
}
export function saveTransaction(manifest: Manifest, record: SavedRecord) {
  const records = savedTransactions(manifest, record.account);
  const previous = records.find(
    (r) => r.hash.toLowerCase() === record.hash.toLowerCase(),
  );
  const next = [
    { ...previous, ...record, created: previous?.created ?? record.created },
    ...records.filter(
      (r) => r.hash.toLowerCase() !== record.hash.toLowerCase(),
    ),
  ].slice(0, 100);
  const storageKey = key(manifest, record.account);
  fallback.set(storageKey, next);
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    /* A storage error never turns a broadcast transaction into a failed action. */
  }
}
export async function registerTransaction(
  manifest: Manifest,
  record: SavedRecord,
) {
  try {
    const response = await fetch("/api/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: record.hash, account: record.account }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const verified: TransactionRecord = await response.json();
    if (
      verified.hash.toLowerCase() !== record.hash.toLowerCase() ||
      verified.account.toLowerCase() !== record.account.toLowerCase()
    )
      return false;
    saveTransaction(manifest, { ...verified, registered: true });
    return true;
  } catch {
    return false;
  }
}
export async function retrySavedTransactions(
  manifest: Manifest,
  account: Address,
) {
  const storageKey = key(manifest, account);
  if (retrying.has(storageKey)) return retrying.get(storageKey)!;
  const operation = (async () => {
    const records = savedTransactions(manifest, account)
      .filter(
        (r) =>
          !r.registered || r.status === "pending" || r.status === "unconfirmed",
      )
      .slice(0, 8);
    for (let i = 0; i < records.length; i += 2)
      await Promise.all(
        records.slice(i, i + 2).map((r) => registerTransaction(manifest, r)),
      );
  })();
  retrying.set(storageKey, operation);
  try {
    await operation;
  } finally {
    retrying.delete(storageKey);
  }
}
