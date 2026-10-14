import { parseUnits, type Abi, type Address, type Hex } from "viem";
import {
  HouseVault,
  StrataDistributor,
  StrataStaking,
} from "./generated/contracts.ts";
import type { Manifest } from "./types.ts";

export const houseActions = [
  "house-deposit",
  "house-cancel-deposit",
  "house-redeem",
  "house-request-withdraw",
  "house-complete-withdraw",
  "rewards-claim",
  "strata-stake",
  "strata-request-unstake",
  "strata-withdraw",
  "strata-claim-usdc",
] as const;
export type HouseActionName = (typeof houseActions)[number];
export interface HouseAction {
  action: HouseActionName;
  /** USDC for deposits, sHOUSE for withdrawals, STRATA for staking. */
  amount?: string;
  stake?: boolean;
  claim?: { cumulative: string; proof: Hex[] };
}
export type HouseStep =
  | { kind: "approve"; token: Address; spender: Address; amount: bigint }
  | {
      kind: "call";
      address: Address;
      abi: Abi;
      functionName: string;
      args: unknown[];
    };

export function isHouseAction(action: string): action is HouseActionName {
  return (houseActions as readonly string[]).includes(action);
}

function positive(amount: string | undefined, decimals: number) {
  if (!amount || !/^\d+(\.\d+)?$/.test(amount))
    throw new Error("Enter a positive amount");
  const value = parseUnits(amount, decimals);
  if (value <= 0n) throw new Error("Enter a positive amount");
  return value;
}

/** Ordered approvals and calls for one house action; wallets and the demo signer share it. */
export function houseSteps(
  m: Manifest,
  action: HouseAction,
  account: Address,
): HouseStep[] {
  const house = m.house;
  if (!house) throw new Error("This deployment has no house vault");
  const vault = (functionName: string, args: unknown[] = []): HouseStep => ({
    kind: "call",
    address: house.vault,
    abi: HouseVault as Abi,
    functionName,
    args,
  });
  const staking = (functionName: string, args: unknown[] = []): HouseStep => ({
    kind: "call",
    address: house.staking,
    abi: StrataStaking as Abi,
    functionName,
    args,
  });
  switch (action.action) {
    case "house-deposit": {
      const amount = positive(action.amount, 6);
      return [
        { kind: "approve", token: m.usdc, spender: house.vault, amount },
        vault("deposit", [amount]),
      ];
    }
    case "house-cancel-deposit":
      return [vault("cancelDeposit", [positive(action.amount, 6)])];
    case "house-redeem":
      return [vault("redeemShares")];
    case "house-request-withdraw":
      return [vault("requestWithdraw", [positive(action.amount, 6)])];
    case "house-complete-withdraw":
      return [vault("completeWithdraw")];
    case "rewards-claim": {
      if (!action.claim) throw new Error("No published rewards to claim yet");
      return [
        {
          kind: "call",
          address: house.distributor,
          abi: StrataDistributor as Abi,
          functionName: "claim",
          args: [
            account,
            BigInt(action.claim.cumulative),
            action.claim.proof,
            action.stake ?? false,
          ],
        },
      ];
    }
    case "strata-stake": {
      const amount = positive(action.amount, 18);
      return [
        {
          kind: "approve",
          token: house.strata,
          spender: house.staking,
          amount,
        },
        staking("stake", [amount]),
      ];
    }
    case "strata-request-unstake":
      return [staking("requestUnstake", [positive(action.amount, 18)])];
    case "strata-withdraw":
      return [staking("withdraw")];
    case "strata-claim-usdc":
      return [staking("claim")];
  }
}
