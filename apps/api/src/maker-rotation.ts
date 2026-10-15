import type { Snapshot } from "../../../packages/core/src/types.ts";
import { makerInventoryTarget } from "./maker-config.ts";

/** Newly opened books get depth before already funded books are refreshed. */
export function nextMakerMarket(snapshot: Snapshot, cursor: number) {
  const active = snapshot.markets.filter((m) => m.active && m.healthy);
  const missing = active.filter((market) => {
    const position = snapshot.maker.inventory.find(
      (p) => p.marketId === market.id,
    );
    if (!position) return false;
    const held =
      BigInt(position.walletClaims) +
      BigInt(position.venueClaims) +
      BigInt(position.restingClaims);
    const allocation = makerInventoryTarget(snapshot.maker.config, market);
    const canWrite =
      BigInt(position.writtenClaims) <
        BigInt(allocation.maxWritten) * 10n ** 18n &&
      BigInt(snapshot.maker.risk.writtenClaims) <
        BigInt(snapshot.maker.config.maxTotalWritten) * 10n ** 18n;
    return (
      (market.bid === null && position.bidCapacity > 0) ||
      (market.ask === null &&
        position.askCapacity > 0 &&
        (held > 0n || canWrite))
    );
  });
  return (
    missing[0] ?? (active.length ? active[cursor % active.length] : undefined)
  );
}
