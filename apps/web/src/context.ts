import { createContext, useContext } from "react";
import type { Address } from "viem";
import type { OracleProof } from "../../../packages/core/src/oracle-proof.ts";
import type { RecoveryPacket } from "../../../packages/core/src/recovery.ts";
import type {
  Snapshot,
  Portfolio,
  Market,
} from "../../../packages/core/src/index.ts";
export type Action = {
  action: string;
  marketId?: number;
  quantity?: string;
  price?: string;
  isBuy?: boolean;
  /** USDC, sHOUSE or STRATA amount for house actions. */
  amount?: string;
  stake?: boolean;
  orderId?: string;
  packet?: RecoveryPacket;
  proof?: OracleProof;
  legs?: {
    marketId: number;
    isBuy: boolean;
    quantity: string;
    premiumLimit: string;
  }[];
};
export interface AppState {
  snapshot: Snapshot;
  portfolio: Portfolio | undefined;
  selected: Market;
  select: (id: number, side?: "buy" | "sell") => void;
  act: (action: Action) => Promise<boolean>;
  busy: boolean;
  walletAddress: Address | null;
  authorize: (packet: RecoveryPacket) => Promise<RecoveryPacket>;
  notify: (message: string) => void;
  openSearch: () => void;
}
export const Context = createContext<AppState | null>(null);
export function useApp() {
  const state = useContext(Context);
  if (!state) throw new Error("Missing app context");
  return state;
}
