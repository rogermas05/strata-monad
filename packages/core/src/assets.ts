import type { Hex } from "viem";
import { parseSchedule, weeklyCloses, zonedTime } from "./market-schedule.ts";

/** Engine series kinds (mirrors OptionsEngine.Kind). */
export type OptionKind = "call" | "put" | "bull-spread" | "bear-spread";

/**
 * - pyth-first-after-expiry: first Pyth update at/after expiry (24/7 markets).
 * - pyth-latest-before-close: latest Pyth update at/before expiry, where expiry
 *   is a session close, with a permissionless challenge window (scheduled markets).
 */
export type SettlementPolicy =
  "pyth-first-after-expiry" | "pyth-latest-before-close";

export interface AssetSpec {
  key: string;
  name: string;
  assetClass: "crypto" | "equity-etf" | "equity" | "metal" | "fx";
  pythSymbol: string;
  pythFeedId: Hex;
  /** Pyth market-hours schedule and the date it was read from Hermes. */
  schedule: string;
  scheduleSnapshot: string;
  settlement: SettlementPolicy;
  /**
   * Uncapped calls need a deliverable 18-decimal token. Assets without one list
   * only cash-settled kinds whose maximum payout can be fully funded.
   */
  kinds: OptionKind[];
  deliverableToken?: "wmon";
  /** Router live-price age: beyond this the market reads as closed. */
  maxLiveAge: number;
  /** 24/7 markets expire at a fixed weekly UTC time; scheduled ones at the week's last close. */
  expiry:
    | { kind: "weekly-utc"; weekday: number; hour: number }
    | { kind: "weekly-close" };
  /** "listed" may be deployed; "candidate" still needs oracle admission and listing review. */
  status: "listed" | "candidate";
  risks: string[];
}

const SNAPSHOT = "2026-10-12";
/** Longest listed term; also keeps expiries inside the schedule snapshot window. */
export const LISTING_HORIZON_WEEKS = 26;
const US_EQUITY =
  "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C";
const ALWAYS_OPEN = "America/New_York;O,O,O,O,O,O,O;";
const CASH_KINDS: OptionKind[] = ["put", "bull-spread", "bear-spread"];
const EQUITY_LIVE_AGE = 120;
const CRYPTO_LIVE_AGE = 3600;
// Deribit-style weekly crypto expiry: Friday 08:00 UTC.
const CRYPTO_EXPIRY = { kind: "weekly-utc", weekday: 5, hour: 8 } as const;

/** Feed IDs and schedules were read from hermes.pyth.network/v2/price_feeds on the snapshot date. */
export const ASSETS: AssetSpec[] = [
  {
    key: "MON",
    name: "Monad",
    assetClass: "crypto",
    pythSymbol: "Crypto.MON/USD",
    pythFeedId:
      "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-first-after-expiry",
    kinds: ["call", ...CASH_KINDS],
    deliverableToken: "wmon",
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "listed",
    risks: [],
  },
  {
    key: "BTC",
    name: "Bitcoin",
    assetClass: "crypto",
    pythSymbol: "Crypto.BTC/USD",
    pythFeedId:
      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: [
      "No deliverable token on Monad yet: calls only as capped bull spreads.",
    ],
  },
  {
    key: "ETH",
    name: "Ether",
    assetClass: "crypto",
    pythSymbol: "Crypto.ETH/USD",
    pythFeedId:
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: [
      "No deliverable token on Monad yet: calls only as capped bull spreads.",
    ],
  },
  {
    key: "SOL",
    name: "Solana",
    assetClass: "crypto",
    pythSymbol: "Crypto.SOL/USD",
    pythFeedId:
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: [
      "No deliverable token on Monad: bullish exposure uses capped spreads.",
    ],
  },
  {
    key: "XRP",
    name: "XRP",
    assetClass: "crypto",
    pythSymbol: "Crypto.XRP/USD",
    pythFeedId:
      "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: [
      "No deliverable token on Monad: bullish exposure uses capped spreads.",
    ],
  },
  {
    key: "DOGE",
    name: "Dogecoin",
    assetClass: "crypto",
    pythSymbol: "Crypto.DOGE/USD",
    pythFeedId:
      "0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
    schedule: ALWAYS_OPEN,
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: [
      "No deliverable token on Monad: bullish exposure uses capped spreads.",
    ],
  },
  {
    key: "BNB",
    name: "BNB",
    assetClass: "crypto",
    pythSymbol: "Crypto.BNB/USD",
    pythFeedId:
      "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "HYPE",
    name: "Hyperliquid",
    assetClass: "crypto",
    pythSymbol: "Crypto.HYPE/USD",
    pythFeedId:
      "0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "TSLA",
    name: "Tesla",
    assetClass: "equity",
    pythSymbol: "Equity.US.TSLA/USD",
    pythFeedId:
      "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    schedule:
      "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: [
      "Immutable terms cannot follow a stock split; do not list across a known corporate-action date.",
    ],
  },
  {
    key: "XAG",
    name: "Silver",
    assetClass: "metal",
    pythSymbol: "Metal.XAG/USD",
    pythFeedId:
      "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
    schedule:
      "America/New_York;0000-1700&1800-2400,0000-1700&1800-2400,0000-1700&1800-2400,0000-1700&1800-2400,0000-1700,C,1800-2400;0907/0000-1430&1800-2400,1126/0000-1430&1800-2400,1127/0000-1445,1224/0000-1345,1225/C,1231/0000-1700,0101/C,0118/0000-1430&1800-2400,0215/0000-1430&1800-2400,0325/0000-1700,0326/C,0531/0000-1430&1800-2400,0618/0000-1300,0705/0000-1430&1800-2400",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "EUR",
    name: "Euro",
    assetClass: "fx",
    pythSymbol: "FX.EUR/USD",
    pythFeedId:
      "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
    schedule:
      "America/New_York;O,O,O,O,0000-1700,C,1700-2400;1224/0000-1700,1231/0000-1700",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "AVAX",
    name: "Avalanche",
    assetClass: "crypto",
    pythSymbol: "Crypto.AVAX/USD",
    pythFeedId:
      "0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "ADA",
    name: "Cardano",
    assetClass: "crypto",
    pythSymbol: "Crypto.ADA/USD",
    pythFeedId:
      "0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "LINK",
    name: "Chainlink",
    assetClass: "crypto",
    pythSymbol: "Crypto.LINK/USD",
    pythFeedId:
      "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "DOT",
    name: "Polkadot",
    assetClass: "crypto",
    pythSymbol: "Crypto.DOT/USD",
    pythFeedId:
      "0xca3eed9b267293f6595901c734c7525ce8ef49adafe8284606ceb307afa2ca5b",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "LTC",
    name: "Litecoin",
    assetClass: "crypto",
    pythSymbol: "Crypto.LTC/USD",
    pythFeedId:
      "0x6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "SUI",
    name: "Sui",
    assetClass: "crypto",
    pythSymbol: "Crypto.SUI/USD",
    pythFeedId:
      "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "NEAR",
    name: "NEAR Protocol",
    assetClass: "crypto",
    pythSymbol: "Crypto.NEAR/USD",
    pythFeedId:
      "0xc415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750",
    schedule: "America/New_York;O,O,O,O,O,O,O;",
    scheduleSnapshot: "2026-10-13",
    settlement: "pyth-first-after-expiry",
    kinds: CASH_KINDS,
    maxLiveAge: CRYPTO_LIVE_AGE,
    expiry: CRYPTO_EXPIRY,
    status: "candidate",
    risks: ["Cash-settled capped exposure; no deliverable token on Monad."],
  },
  {
    key: "SPY",
    name: "SPDR S&P 500 ETF",
    assetClass: "equity-etf",
    pythSymbol: "Equity.US.SPY/USD",
    pythFeedId:
      "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    schedule: US_EQUITY,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: [
      "Settles on Pyth's regular-session price at the close, not the official closing auction.",
      "Ex-dividend price drops are not adjusted; they are priced into option premiums.",
    ],
  },
  {
    key: "QQQ",
    name: "Invesco QQQ Trust",
    assetClass: "equity-etf",
    pythSymbol: "Equity.US.QQQ/USD",
    pythFeedId:
      "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
    schedule: US_EQUITY,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: [
      "Settles on Pyth's regular-session price at the close, not the official closing auction.",
    ],
  },
  {
    key: "AAPL",
    name: "Apple",
    assetClass: "equity",
    pythSymbol: "Equity.US.AAPL/USD",
    pythFeedId:
      "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    schedule: US_EQUITY,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: [
      "Immutable terms cannot follow a stock split; do not list across a known corporate-action date.",
    ],
  },
  {
    key: "NVDA",
    name: "NVIDIA",
    assetClass: "equity",
    pythSymbol: "Equity.US.NVDA/USD",
    pythFeedId:
      "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    schedule: US_EQUITY,
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: [
      "Immutable terms cannot follow a stock split; do not list across a known corporate-action date.",
    ],
  },
  {
    key: "XAU",
    name: "Gold",
    assetClass: "metal",
    pythSymbol: "Metal.XAU/USD",
    pythFeedId:
      "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
    schedule:
      "America/New_York;0000-1700&1800-2400,0000-1700&1800-2400,0000-1700&1800-2400,0000-1700&1800-2400,0000-1700,C,1800-2400;0907/0000-1430&1800-2400,1126/0000-1430&1800-2400,1127/0000-1445,1224/0000-1345,1225/C,1231/0000-1700,0101/C,0118/0000-1430&1800-2400,0215/0000-1430&1800-2400,0325/0000-1700,0326/C,0531/0000-1430&1800-2400,0618/0000-1300,0705/0000-1430&1800-2400",
    scheduleSnapshot: SNAPSHOT,
    settlement: "pyth-latest-before-close",
    kinds: CASH_KINDS,
    maxLiveAge: EQUITY_LIVE_AGE,
    expiry: { kind: "weekly-close" },
    status: "candidate",
    risks: ["Spot gold trades 24/5; expiry uses the weekly Friday close."],
  },
];

export function asset(key: string): AssetSpec {
  const spec = ASSETS.find((a) => a.key === key);
  if (!spec) throw new Error(`Unknown asset ${key}`);
  return spec;
}

/** Next weekly expiries (Unix seconds) after `from` under the asset's expiry rule. */
export function weeklyExpiries(
  spec: AssetSpec,
  from: number,
  weeks: number,
): number[] {
  const schedule = parseSchedule(spec.schedule, spec.scheduleSnapshot);
  if (spec.expiry.kind === "weekly-close")
    return weeklyCloses(schedule, from, weeks);
  const { weekday, hour } = spec.expiry;
  const d = new Date(from * 1000);
  const days = (weekday - d.getUTCDay() + 7) % 7;
  let first =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, hour) /
    1000;
  if (first <= from) first += 7 * 86400;
  return Array.from({ length: weeks }, (_, i) => first + i * 7 * 86400);
}

export interface ListingRequest {
  asset: string;
  kind: OptionKind;
  expiry: number;
  strike: number;
  upperStrike?: number;
}

/** Rejects listings the engine would accept but the asset's policy does not allow. */
export function validateListing(
  request: ListingRequest,
  now: number,
  options: { allowCandidates?: boolean } = {},
): AssetSpec {
  const spec = asset(request.asset);
  if (spec.status !== "listed" && !options.allowCandidates)
    throw new Error(
      `${spec.key} is a candidate asset pending oracle admission`,
    );
  if (!spec.kinds.includes(request.kind))
    throw new Error(
      `${spec.key} cannot list ${request.kind}: ${
        request.kind === "call"
          ? "uncapped calls need a deliverable token; list a bull spread"
          : "kind not allowed"
      }`,
    );
  if (request.kind === "call" && !spec.deliverableToken)
    throw new Error(`${spec.key} has no deliverable token`);
  const spread =
    request.kind === "bull-spread" || request.kind === "bear-spread";
  if (
    !(request.strike > 0) ||
    (spread
      ? !(
          request.upperStrike !== undefined &&
          request.upperStrike > request.strike
        )
      : request.upperStrike !== undefined)
  )
    throw new Error("Invalid strikes for this kind");
  const valid = weeklyExpiries(spec, now, LISTING_HORIZON_WEEKS);
  if (!valid.includes(request.expiry))
    throw new Error(
      `${spec.key} expiry must be one of its weekly ${
        spec.expiry.kind === "weekly-close" ? "session closes" : "UTC expiries"
      }`,
    );
  return spec;
}

/** Wall-clock helper for tests and listing tools. */
export const newYorkTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
) => zonedTime({ year, month, day }, hour * 60 + minute, "America/New_York");
