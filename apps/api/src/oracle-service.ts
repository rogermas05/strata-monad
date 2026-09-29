import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { fetchEvidence } from "../../../packages/core/src/hermes.ts";
import {
  parseOracleProof,
  prepareOracleProof,
  recheckOracleProof,
  type OracleProof,
} from "../../../packages/core/src/oracle-proof.ts";
import { client, manifest, runtimeDirectory } from "./runtime.ts";
import { cloudEnabled, cloudRequest } from "./cloud-store.ts";
import { createPublicClient, http, getAddress } from "viem";
import { pushedUpdateSource } from "../../../packages/core/src/pushed-updates.ts";
const directory = resolve(
  runtimeDirectory,
  "oracle-proofs",
  String(manifest.chainId),
  manifest.oracle.toLowerCase(),
);
const pending = new Map<string, Promise<OracleProof>>();
function file(proof: Pick<OracleProof, "kind" | "expiry" | "observation">) {
  return resolve(
    directory,
    `${proof.kind}-${proof.expiry ?? "live"}-${proof.observation.proofHash.toLowerCase()}.json`,
  );
}
export async function archiveProof(input: OracleProof) {
  const proof = parseOracleProof(input, manifest);
  if (cloudEnabled) {
    await cloudRequest("strata_proofs", "POST", {
      id: `${manifest.chainId}:${manifest.oracle.toLowerCase()}:${proof.kind}:${proof.expiry ?? "live"}:${proof.observation.proofHash.toLowerCase()}`,
      value: proof,
    });
    return proof;
  }
  mkdirSync(directory, { recursive: true });
  const target = file(proof),
    temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(proof, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return proof;
}
export async function archivedProof(
  kind: "settlement" | "live",
  expiry: number | null,
  hash: Hex,
) {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    (kind === "live"
      ? expiry !== null
      : !Number.isSafeInteger(expiry) || expiry! < 0)
  )
    throw new Error("Invalid archive key");
  if (cloudEnabled) {
    const id = `${manifest.chainId}:${manifest.oracle.toLowerCase()}:${kind}:${expiry ?? "live"}:${hash.toLowerCase()}`;
    const rows = await cloudRequest<{ value: unknown }[]>(
      `strata_proofs?id=eq.${encodeURIComponent(id)}&select=value`,
    );
    if (!rows[0]) throw new Error("Proof unavailable");
    return parseOracleProof(rows[0].value, manifest);
  }
  const path = file({
    kind,
    expiry,
    observation: { proofHash: hash } as OracleProof["observation"],
  });
  if (statSync(path).size > 160000)
    throw new Error("Archive exceeds supported bounds");
  const proof = parseOracleProof(
    JSON.parse(readFileSync(path, "utf8")),
    manifest,
  );
  if (
    proof.kind !== kind ||
    proof.expiry !== expiry ||
    proof.observation.proofHash.toLowerCase() !== hash.toLowerCase()
  )
    throw new Error("Archive key mismatch");
  return proof;
}
export function oracleServiceStatus() {
  return {
    mode: manifest.oracleMode,
    providerConfigured: !!process.env.PYTH_API_KEY,
    backupConfigured:
      !!process.env.HERMES_BACKUP_URL &&
      !!(process.env.PYTH_BACKUP_API_KEY || process.env.PYTH_API_KEY),
    policy:
      manifest.assets?.find(
        (a) => a.assetId.toLowerCase() === manifest.assetId.toLowerCase(),
      )?.policy === "pyth-latest-before-close"
        ? "STRATA_PYTH_LATEST_AT_OR_BEFORE_EXPIRY_V1"
        : "STRATA_PYTH_UNIQUE_FIRST_V1",
    packageBodyLimit: 160000,
  };
}
export async function prepareFromProvider(
  kind: "settlement" | "live",
  expiry: number | undefined,
  account: Address,
): Promise<OracleProof> {
  if (manifest.oracleMode !== "pyth")
    throw new Error("The current deployment uses the controlled demo oracle");
  if (
    kind === "settlement" &&
    (expiry === undefined ||
      !manifest.series.some((series) => series.expiry === expiry))
  )
    throw new Error("Choose a listed expiry");
  if (kind === "live" && expiry !== undefined)
    throw new Error("Live updates do not select an expiry");
  const pushed =
    (process.env.PYTH_PUSHED_FEEDS ?? "").split(",").includes("MON") &&
    process.env.PYTH_PUSHED_RPC_URL &&
    process.env.PYTH_PUSHED_CONTRACT;
  if (!process.env.PYTH_API_KEY && !pushed)
    throw new Error(
      "Authenticated oracle access is not configured on this service",
    );
  const key = `${kind}:${expiry ?? "live"}:${account.toLowerCase()}`;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 4)
    throw new Error("Oracle preparation is busy; retry shortly");
  const operation = (async () => {
    if (pushed) {
      const source = pushedUpdateSource(
        createPublicClient({
          transport: http(process.env.PYTH_PUSHED_RPC_URL!, { timeout: 15000 }),
        }),
        getAddress(process.env.PYTH_PUSHED_CONTRACT!),
      );
      const evidence = await source(
        manifest.assetId,
        kind === "settlement" ? expiry : undefined,
      );
      if (!evidence) throw new Error("Signed pushed evidence is unavailable");
      return archiveProof(
        await prepareOracleProof(client, manifest, evidence, account, expiry),
      );
    }
    const providers = [
      {
        endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
        apiKey: process.env.PYTH_API_KEY!,
      },
      ...(process.env.HERMES_BACKUP_URL
        ? [
            {
              endpoint: process.env.HERMES_BACKUP_URL,
              apiKey:
                process.env.PYTH_BACKUP_API_KEY || process.env.PYTH_API_KEY!,
            },
          ]
        : []),
    ];
    for (const provider of providers) {
      try {
        const evidence = await fetchEvidence({
          ...provider,
          feed: manifest.assetId,
          expiry,
        });
        return archiveProof(
          await prepareOracleProof(client, manifest, evidence, account, expiry),
        );
      } catch {
        /* A provider error or invalid proof never becomes a prepared package. Try the configured backup. */
      }
    }
    throw new Error(
      "Verified oracle evidence is unavailable. Retry retrieval or import a previously prepared package.",
    );
  })();
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    pending.delete(key);
  }
}
export async function inspectProof(value: unknown, account: Address) {
  return recheckOracleProof(client, manifest, value, account);
}
