import type {
  HouseAccount,
  Portfolio,
  RewardsAccount,
  Snapshot,
} from "../../../packages/core/src/index.ts";
import type { OracleProof } from "../../../packages/core/src/oracle-proof.ts";
import type {
  RecoveryPacket,
  RecoveryEffect,
} from "../../../packages/core/src/recovery.ts";
export class ActionRequestError extends Error {
  constructor(
    message: string,
    public hashes: string[],
  ) {
    super(message);
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new ActionRequestError(
      data.error ?? "Request failed",
      Array.isArray(data.hashes)
        ? data.hashes.filter(
            (hash: unknown) =>
              typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash),
          )
        : [],
    );
  return data;
}
export const api = {
  snapshot: () => request<Snapshot>("/snapshot"),
  oracleStatus: () =>
    request<{
      mode: "demo" | "pyth";
      providerConfigured: boolean;
      backupConfigured: boolean;
      policy: string;
      packageBodyLimit: number;
    }>("/oracle"),
  prepareOracle: (body: {
    kind: "settlement" | "live";
    expiry?: number;
    account: string;
  }) => request<OracleProof>("/oracle/prepare", body),
  inspectOracle: (proof: OracleProof, account: string) =>
    request<OracleProof>("/oracle/inspect", { proof, account }),
  portfolio: (address: string) => request<Portfolio>(`/portfolio/${address}`),
  house: (address: string) => request<HouseAccount>(`/house/${address}`),
  wake: () => request<{ awakeUntil: number }>("/wake", {}),
  rewards: (address: string) => request<RewardsAccount>(`/rewards/${address}`),
  nonce: (address: string) =>
    request<{ nonce: string; usdcAllowance: string }>(`/recovery/${address}`),
  signRecovery: (packet: RecoveryPacket) =>
    request<RecoveryPacket>("/recovery/sign", packet),
  inspectRecovery: (packet: RecoveryPacket) =>
    request<RecoveryEffect>("/recovery/inspect", packet),
  action: (body: unknown) =>
    request<{ hashes: string[]; status: string; readModelUpdated?: boolean }>(
      "/actions",
      body,
    ),
};
