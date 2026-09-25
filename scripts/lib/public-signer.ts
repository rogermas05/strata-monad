import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import {
  parseEther,
  parseGwei,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { ManagedSigner, type ManagedSignerOptions } from "./managed-signer.ts";

/** Secrets stay in the backend environment; only role addresses are public. */
export function configuredSigner(
  role: "deployer" | "maker",
  client: PublicClient,
  chain: Chain,
  endpoint: string,
  directory: string,
  authorize: ManagedSignerOptions["authorize"],
  extra: Partial<Pick<ManagedSignerOptions, "journal" | "receiptTimeout">> = {},
) {
  const prefix = `STRATA_${role.toUpperCase()}`;
  const key = process.env[`${prefix}_PRIVATE_KEY`];
  const expected = process.env[`${prefix}_ADDRESS`];
  if (
    !key ||
    !/^0x[0-9a-fA-F]{64}$/.test(key) ||
    !expected ||
    !/^0x[0-9a-fA-F]{40}$/.test(expected)
  )
    throw new Error(
      `Configure the ${role} signer key and address in backend secrets`,
    );
  const account = privateKeyToAccount(key as `0x${string}`);
  if (chain.id === 10143) {
    for (let addressIndex = 0; addressIndex < 10; addressIndex++)
      if (
        mnemonicToAccount(
          "test test test test test test test test test test test junk",
          { addressIndex },
        ).address === account.address
      )
        throw new Error(
          "Public signing refuses known Anvil development accounts",
        );
  }
  return new ManagedSigner({
    client,
    chain,
    endpoint,
    account,
    expectedAddress: expected as Address,
    directory,
    authorize,
    maxGas: 16000000n,
    maxFeePerGas: parseGwei(process.env.STRATA_MAX_FEE_GWEI ?? "300"),
    maxNativeValue: parseEther(process.env.STRATA_MAX_NATIVE_VALUE ?? "25"),
    maxTransactionCost: parseEther(
      process.env.STRATA_MAX_TRANSACTION_COST ?? "30",
    ),
    secrets: [
      key,
      process.env.PYTH_API_KEY ?? "",
      process.env.STRATA_SUPABASE_SERVICE_KEY ?? "",
    ],
    ...extra,
  });
}
