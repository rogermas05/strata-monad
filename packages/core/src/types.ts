import type { Address, Hex } from "viem";
import type { ServiceReadiness } from "./readiness.ts";
export type Kind = "call" | "put" | "bull-spread" | "bear-spread";
export interface TransactionRecord {
  hash: Hex;
  account: Address;
  target: Address;
  operation: string;
  status: "pending" | "included" | "reverted" | "unconfirmed" | "orphaned";
  block: string | null;
  created: number;
}
export const kinds: Kind[] = ["call", "put", "bull-spread", "bear-spread"];
export interface SeriesConfig {
  id: number;
  token: Address;
  market: Address;
  venue: Address;
  symbol: string;
  expiry: number;
  strike: number;
  upperStrike: number;
  kind: Kind;
  asset: string;
}
/** One listed underlying and its settlement binding on the oracle router. */
export interface ManifestAsset {
  key: string;
  name: string;
  assetClass: "crypto" | "equity-etf" | "equity" | "metal" | "fx";
  /** bytes32 used on-chain; the Pyth feed ID. */
  assetId: Hex;
  /** Adapter bound on the router (or the engine's oracle for legacy deployments). */
  adapter: Address;
  policy: "pyth-first-after-expiry" | "pyth-latest-before-close";
  maxLiveAge: number;
  /** Seconds after expiry before session-close settlement can be fixed. */
  challengeWindow: number;
  schedule: string;
  scheduleSnapshot: string;
  volatility: number;
  /** Controlled local reference price; never market data. */
  reference: number;
  deliverable: boolean;
}
export interface Manifest {
  chainId: number;
  rpcUrl: string;
  mode: "local" | "local-fork" | "testnet";
  venueMode: "demo" | "kuru";
  engine: Address;
  oracle: Address;
  router: Address;
  usdc: Address;
  wmon: Address;
  assetId: Hex;
  deployer: Address;
  maker: Address;
  demoUser: Address;
  deployedBlock: string;
  createdAt: string;
  series: SeriesConfig[];
  kuruMargin?: Address;
  kuruFactory?: Address;
  oracleMode: "demo" | "pyth";
  /** Present when the engine's oracle is an OracleRouter with per-asset bindings. */
  assets?: ManifestAsset[];
  /** House vault, STRATA token, staking and points distributor. */
  house?: HouseManifest;
}
export interface HouseManifest {
  vault: Address;
  strata: Address;
  staking: Address;
  distributor: Address;
  /** The maker key operates the vault's book. */
  operator: Address;
  /** Trading starts at the first roll on or after this time. */
  launchTime: number;
  /** Opening of the genesis pre-deposit window. */
  genesisStart: number;
  deployedBlock: string;
}
/** Vault state for the terminal. Money values are USDC, share values are sHOUSE. */
export interface HouseState {
  address: Address;
  epoch: number;
  launchTime: number;
  genesisStart: number;
  lastRollTime: number;
  /** Assets deployed this epoch, fixed at the last roll. */
  epochStartAssets: number;
  pendingDeposits: number;
  queuedShares: number;
  reservedWithdrawals: number;
  totalShares: number;
  depositCap: number;
  depositsPaused: boolean;
  performanceFeeBps: number;
  depositors: number;
  /** Cash, venue balances and positions marked at model prices. An estimate until the roll. */
  estimatedAssets: number;
  estimatedPricePerShare: number;
  /** Largest loss if every short position pays its maximum, net of held claims. */
  maxLoss: number;
  lastPricePerShare: number;
  series: number[];
  history: {
    epoch: number;
    pricePerShare: number;
    assets: number;
    fee: number;
    timestamp: number;
  }[];
  totalFees: number;
  rootEpoch: number;
}
export interface HouseAccount {
  address: Address;
  usdc: number;
  shares: number;
  value: number;
  pendingDeposit: number;
  withdrawal: { epoch: number; shares: number; ready: boolean; assets: number };
}
export interface PointsBreakdown {
  genesis: number;
  deposits: number;
  losses: number;
  total: number;
}
export interface RewardsAccount {
  address: Address;
  points: PointsBreakdown;
  /** Points accrued after the last published root, shown but not yet claimable. */
  unpublished: number;
  claim: { epoch: number; cumulative: string; proof: Hex[] } | null;
  claimed: number;
  claimable: number;
  strata: number;
  staked: number;
  cooling: number;
  unlockAt: number;
  earned: number;
  totalStaked: number;
}
export interface DepthLevel {
  price: number;
  quantity: number;
  total: number;
  orders: number;
}
export interface BookOrder {
  id: string;
  owner: Address;
  isBuy: boolean;
  price: number;
  remaining: number;
  reserved: number;
}
export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}
export interface Market extends SeriesConfig {
  bid: number | null;
  ask: number | null;
  mark: number;
  iv: number;
  greeks: Greeks;
  bids: DepthLevel[];
  asks: DepthLevel[];
  orders: BookOrder[];
  volume: number;
  openInterest: number;
  escrow: number;
  cap: number;
  settlementPrice: number | null;
  active: boolean;
  healthy: boolean;
}
export interface TradeRecord {
  hash: Hex;
  block: string;
  timestamp: number;
  marketId: number;
  maker: Address;
  taker: Address;
  isBuy: boolean;
  quantity: number;
  price: number;
  quote: number;
  controlled: boolean;
}
export interface Position {
  marketId: number;
  quantity: number;
  writerQuantity: number;
  collateral: number;
  reserved: number;
  venueFree: number;
  paidPremium: number;
  proceeds: number;
  claimed: number;
}
export interface UnderlyingState {
  key: string;
  spot: number;
  publishedAt: number;
  /** Fresh price within the asset's live age: new exposure is allowed. */
  live: boolean;
  /** Market session state from the published schedule at chain time. */
  open: boolean;
  nextChange: number | null;
  prices: { timestamp: number; price: number }[];
}
export interface Snapshot {
  service: ServiceReadiness;
  underlyings: Record<string, UnderlyingState>;
  manifest: Manifest;
  block: string;
  blockHash: Hex;
  timestamp: number;
  spot: number;
  pricePublishedAt: number;
  markets: Market[];
  trades: TradeRecord[];
  prices: { timestamp: number; price: number }[];
  settlements: {
    asset: Hex;
    expiry: number;
    price: number;
    publishedAt: number;
    proofHash: Hex;
    hash: Hex;
  }[];
  maker: {
    address: Address;
    usdc: number;
    venueUsdc: number;
    wmon: number;
    lastQuote: number;
    enabled: boolean;
    maintenance: boolean;
    errors: string[];
    config: MakerConfig;
    inventory: MakerInventory[];
    risk: {
      grossClaims: string;
      reservedGrossClaims: string;
      writtenClaims: string;
      actualBreached: boolean;
      reservationBreached: boolean;
      issuanceBreached: boolean;
      expiries: {
        expiry: number;
        grossClaims: string;
        reservedGrossClaims: string;
      }[];
    };
  };
  house?: HouseState;
  /** Hosted demo only: on-chain trading sleeps until a visitor wakes it. */
  trading?: {
    mode: "display" | "trading";
    awakeUntil: number;
    gasLow: boolean;
  };
  indexer: {
    lastBlock: string;
    lag: number;
    eventCount: number;
    status: "healthy" | "syncing" | "error";
    error?: string;
  };
}
export interface MakerConfig {
  volatility: number;
  spreadBps: number;
  edge: number;
  targetInventory: number;
  maxWritten: number;
  maxNetInventory: number;
  maxPortfolioInventory: number;
  maxExpiryInventory: number;
  maxTotalWritten: number;
  inventorySkewBps: number;
  /** Asset/kind allocations share the same portfolio and expiry risk budgets. */
  inventoryTargets?: Record<
    string,
    { targetInventory: number; maxWritten: number }
  >;
}
export interface MakerInventory {
  marketId: number;
  walletClaims: string;
  venueClaims: string;
  restingClaims: string;
  writtenClaims: string;
  collateral: string;
  netQuantity: number;
  optionDelta: number;
  optionVega: number;
  bidCapacity: number;
  askCapacity: number;
  priceSkewBps: number;
  reservationPrice: number;
}
export interface Portfolio {
  address: Address;
  usdc: number;
  wmon: number;
  native: number;
  venueUsdc: number;
  positions: Position[];
  orders: (BookOrder & { marketId: number })[];
}
