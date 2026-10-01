import "dotenv/config";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { fetchEvidence } from "../packages/core/src/hermes.ts";
import {
  pythAbi,
  validateVerifiedEvidence,
} from "../packages/core/src/pyth.ts";

async function main() {
  const verifierInput = process.env.PYTH_VERIFIER,
    feed = process.env.PYTH_FEED_ID as Hex | undefined,
    key = process.env.PYTH_API_KEY;
  if (!verifierInput || !feed || !key)
    throw new Error(
      "Configure PYTH_VERIFIER, PYTH_FEED_ID and PYTH_API_KEY in the ignored .env file",
    );
  const verifier = getAddress(verifierInput);
  if (!/^0x[0-9a-fA-F]{64}$/.test(feed))
    throw new Error("PYTH_FEED_ID must be a bytes32 feed identifier");
  const client = createPublicClient({
    transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8546", {
      timeout: 15000,
      retryCount: 0,
    }),
  });
  const block = await client.getBlock(),
    chainId = await client.getChainId();
  const code = await client.getCode({
    address: verifier,
    blockNumber: block.number,
  });
  if (!code || code === "0x")
    throw new Error("Pyth verifier has no code on this RPC");
  const expiry = Number(
    process.env.PYTH_CHECK_TIMESTAMP ?? Number(block.timestamp) - 60,
  );
  if (
    !Number.isSafeInteger(expiry) ||
    expiry < 0 ||
    BigInt(expiry) > block.timestamp
  )
    throw new Error(
      "PYTH_CHECK_TIMESTAMP must be an elapsed integer chain timestamp",
    );
  const evidence = await fetchEvidence({
    endpoint: process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes",
    apiKey: key,
    feed,
    expiry,
  });
  const fee = await client.readContract({
    address: verifier,
    abi: pythAbi,
    functionName: "getUpdateFee",
    args: [evidence.updates],
    blockNumber: block.number,
  });
  const simulation = await client.simulateContract({
    address: verifier,
    abi: pythAbi,
    functionName: "parsePriceFeedUpdatesUnique",
    args: [evidence.updates, [feed], BigInt(expiry), block.timestamp],
    value: fee,
    blockNumber: block.number,
    account: getAddress(
      process.env.CHECK_ACCOUNT ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ) as Address,
  });
  const observation = validateVerifiedEvidence(
    evidence,
    simulation.result,
    expiry,
    block.timestamp,
  );
  // Pin the admission record to a block that remains canonical after retrieval and simulation.
  if (
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new Error(
      "Verification block was reorganized; repeat admission on a canonical block",
    );
  const record = {
    version: 1,
    verification: "read-only-eth-call",
    chainId,
    verifier,
    verifierCodeHash: keccak256(code),
    feed,
    expiry,
    block: {
      number: block.number.toString(),
      hash: block.hash,
      timestamp: block.timestamp.toString(),
    },
    fee: fee.toString(),
    observation,
    updates: evidence.updates,
    providerMetadata: {
      publishTime: evidence.publishTime,
      previousPublishTime: evidence.previousPublishTime,
    },
    recordedAt: new Date().toISOString(),
    note: "Successful simulation at the recorded block. No finalization transaction was broadcast. Re-simulate before submission.",
  };
  const directory = resolve(
    ".runtime/oracle-admission",
    String(chainId),
    verifier.toLowerCase(),
  );
  mkdirSync(directory, { recursive: true });
  const archivePath = resolve(
      directory,
      `${feed.toLowerCase()}-${expiry}-${observation.proofHash}.json`,
    ),
    temporary = `${archivePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, archivePath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  console.log(
    JSON.stringify(
      {
        authenticatedOnchainSimulation: true,
        chainId,
        verifier,
        feed,
        expiry,
        observation,
        fee: fee.toString(),
        archivePath,
        note: record.note,
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  // Provider keys and authenticated RPC URLs must not leak through transport errors.
  const detail = error instanceof Error ? error.message : "Admission failed";
  console.error(
    detail
      .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]")
      .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
      .split("\n")
      .slice(0, 3)
      .join("\n"),
  );
  process.exitCode = 1;
});
