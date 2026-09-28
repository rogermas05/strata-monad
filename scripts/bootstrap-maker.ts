import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from "viem";
import {
  prepareMakerBootstrap,
  bootstrapDigest,
  type MakerBootstrap,
} from "../packages/core/src/maker-bootstrap.ts";
import {
  parseDeploymentManifest,
  loopbackRpc,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import {
  writeDeploymentJson,
  withLocalSenderLock,
} from "./deployment-executor.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
const liveAbi = parseAbi([
  "function livePrice(bytes32) view returns(uint256,uint64)",
]);
async function executeUnlockedMakerBootstrap(
  pkg: MakerBootstrap,
  directory: string,
  stepLimit?: number,
) {
  if (pkg.manifest.chainId !== 31337 || !loopbackRpc(pkg.manifest.rpcUrl))
    throw new Error("Maker bootstrap execution is local-only");
  const manifest = parseDeploymentManifest(JSON.stringify(pkg.manifest));
  const chain = defineChain({
    id: 31337,
    name: "Local maker bootstrap",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(manifest.rpcUrl),
    pollingInterval: 100,
  });
  const wallet = createWalletClient({
    account: manifest.maker,
    chain,
    transport: http(manifest.rpcUrl),
  });
  const { digest, ...body } = pkg;
  if (bootstrapDigest(body) !== digest)
    throw new Error("Bootstrap digest mismatch");
  const rebuilt = await prepareMakerBootstrap(client, manifest, pkg.quantity, {
    blockNumber: BigInt(pkg.anchor.number),
    nonceStart: pkg.nonceStart,
  });
  if (rebuilt.digest !== digest)
    throw new Error(
      "Bootstrap differs from anchored onchain state and current pricing logic",
    );
  const path = resolve(directory, "bootstrap-journal.json");
  const schema = z
    .object({
      digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      entries: z
        .array(
          z
            .object({
              index: z.number().int().nonnegative(),
              hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
              block: z.string().regex(/^\d+$/).optional(),
              status: z.enum(["submitted", "success", "reverted"]).optional(),
            })
            .strict(),
        )
        .max(4096),
    })
    .strict();
  const journal = schema.parse(
    existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { digest, entries: [] },
  );
  if (
    journal.digest !== digest ||
    !Array.isArray(journal.entries) ||
    new Set(journal.entries.map((e) => e.index)).size !== journal.entries.length
  )
    throw new Error("Bootstrap journal mismatch");
  let completed = 0;
  for (const step of pkg.steps) {
    if (stepLimit !== undefined && completed >= stepLimit)
      return { status: "paused", completed };
    let entry = journal.entries.find((e) => e.index === step.index);
    if (!entry) {
      const [nonce, pending, block] = await Promise.all([
        client.getTransactionCount({ address: manifest.maker }),
        client.getTransactionCount({
          address: manifest.maker,
          blockTag: "pending",
        }),
        client.getBlock(),
      ]);
      if (nonce !== step.nonce || pending !== nonce)
        throw new Error(
          "Bootstrap nonce changed; inspect without rebroadcasting",
        );
      const [spot, published] = await client.readContract({
        address: manifest.oracle,
        abi: liveAbi,
        functionName: "livePrice",
        args: [manifest.assetId],
      });
      const delta =
        spot > BigInt(pkg.spot)
          ? spot - BigInt(pkg.spot)
          : BigInt(pkg.spot) - spot;
      if (
        spot <= 0n ||
        published > block.timestamp ||
        block.timestamp - published > BigInt(pkg.maxPriceAge) ||
        delta * 10000n > BigInt(pkg.spot) * 50n
      )
        throw new Error(
          "Bootstrap live reference moved or became stale; stop before further exposure",
        );
      if (
        manifest.series.some((s) => BigInt(s.expiry) <= block.timestamp + 60n)
      )
        throw new Error("Bootstrap shelf is too close to expiry");
      const request = {
        account: manifest.maker,
        to: step.to!,
        data: step.data,
        value: BigInt(step.value),
        nonce: step.nonce,
      };
      const estimate = await client.estimateGas(request),
        gas = estimate + estimate / 5n + 5000n;
      if (gas > 16000000n) throw new Error("Bootstrap gas bound exceeded");
      console.log(`${step.index + 1}/${pkg.steps.length} ${step.label}`);
      const hash = await wallet.sendTransaction({ ...request, gas });
      entry = { index: step.index, hash, status: "submitted" };
      journal.entries.push(entry);
      try {
        writeDeploymentJson(path, journal);
      } catch {
        throw new Error(
          `Bootstrap transaction ${hash} was broadcast but could not be journaled; retain the hash and do not resubmit.`,
        );
      }
    }
    const tx = await client.getTransaction({ hash: entry.hash as Hex });
    if (
      tx.from.toLowerCase() !== manifest.maker.toLowerCase() ||
      tx.nonce !== step.nonce ||
      tx.to?.toLowerCase() !== step.to?.toLowerCase() ||
      tx.input.toLowerCase() !== step.data.toLowerCase() ||
      tx.value !== BigInt(step.value)
    )
      throw new Error(
        "Bootstrap journal transaction does not match the reviewed step",
      );
    const receipt = await waitReceipt(client, entry.hash as Hex, 120000);
    if (
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
      receipt.blockHash
    )
      throw new Error("Bootstrap receipt reorganized");
    entry.block = String(receipt.blockNumber);
    entry.status = receipt.status;
    writeDeploymentJson(path, journal);
    if (receipt.status !== "success")
      throw new Error(`Bootstrap transaction reverted: ${entry.hash}`);
    completed++;
  }
  const report = await checkDeployment(client, client, manifest);
  writeDeploymentJson(
    resolve(directory, "bootstrap-verification.json"),
    report,
  );
  return { status: "complete", completed };
}
export async function executeMakerBootstrap(
  pkg: MakerBootstrap,
  directory: string,
  stepLimit?: number,
) {
  if (
    pkg?.kind !== "maker-bootstrap" ||
    pkg.version !== 1 ||
    pkg.manifest?.chainId !== 31337 ||
    !pkg.anchor ||
    !/^\d{1,30}$/.test(pkg.anchor.number)
  )
    throw new Error("Invalid local maker bootstrap");
  return withLocalSenderLock(pkg.manifest.maker, pkg.digest, () =>
    executeUnlockedMakerBootstrap(pkg, directory, stepLimit),
  );
}
