import type { MakerConfig, MakerInventory, Market } from "./types.ts";
import { makerPortfolioRisk } from "./maker-portfolio.ts";
const unit = 10n ** 18n,
  lot = 10n ** 15n;
export function makerSnapshotRisk(
  markets: Market[],
  inventory: MakerInventory[],
  account: string,
  config: MakerConfig,
) {
  return makerPortfolioRisk(
    markets.map((market) => {
      const p = inventory.find((p) => p.marketId === market.id);
      if (!p) throw new Error("Maker portfolio inventory is incomplete");
      const orders = market.orders.filter(
        (o) => o.owner.toLowerCase() === account.toLowerCase(),
      );
      return {
        marketId: market.id,
        expiry: market.expiry,
        heldClaims:
          BigInt(p.walletClaims) +
          BigInt(p.venueClaims) +
          BigInt(p.restingClaims),
        writtenClaims: BigInt(p.writtenClaims),
        bidClaims: orders
          .filter((o) => o.isBuy)
          .reduce(
            (s, o) => s + BigInt(Math.round(o.remaining * 1000)) * lot,
            0n,
          ),
        askClaims: orders
          .filter((o) => !o.isBuy)
          .reduce(
            (s, o) => s + BigInt(Math.round(o.remaining * 1000)) * lot,
            0n,
          ),
      };
    }),
    {
      maxGrossClaims: BigInt(config.maxPortfolioInventory) * unit,
      maxExpiryClaims: BigInt(config.maxExpiryInventory) * unit,
      maxWrittenClaims: BigInt(config.maxTotalWritten) * unit,
      maxSeriesClaims: BigInt(config.maxNetInventory) * unit,
    },
  );
}
