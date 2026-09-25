import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Hex,
} from "viem";
import { artifact } from "./artifacts.ts";
import {
  prepareDeploymentPackage,
  packageDigest,
  factoryDeploymentAbi,
  implementationSlot,
  type DeploymentPackage,
  type DeploymentStep,
} from "../packages/core/src/deployment-package.ts";
import {
  loopbackRpc,
  parseDeploymentManifest,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
export function writeDeploymentJson(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
const journalSchema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    entries: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            status: z.enum(["submitted", "included", "reverted"]),
            block: z.string().regex(/^\d+$/).optional(),
            blockHash: z
              .string()
              .regex(/^0x[0-9a-fA-F]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
async function executeUnlockedDeployment(
  input: unknown,
  directory: string,
  options: { stepLimit?: number; progress?: (message: string) => void } = {},
) {
  const pkg = input as DeploymentPackage;
  if (
    !pkg ||
    pkg.version !== 1 ||
    pkg.kind !== "unsigned-deployment" ||
    !pkg.anchor ||
    !/^\d{1,30}$/.test(pkg.anchor.number) ||
    !Number.isSafeInteger(pkg.nonceStart) ||
    !pkg.digest ||
    !Array.isArray(pkg.steps) ||
    pkg.steps.length > 4096
  )
    throw new Error("Invalid deployment package");
  if (pkg.intent?.chainId !== 31337 || !loopbackRpc(pkg.intent?.rpcUrl ?? ""))
    throw new Error(
      "This executor is restricted to an isolated loopback chain 31337. It never broadcasts public transactions.",
    );
  const chain = defineChain({
    id: 31337,
    name: "Strata deployment rehearsal",
    nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [pkg.intent.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(pkg.intent.rpcUrl, { timeout: 15000, retryCount: 0 }),
    pollingInterval: 100,
  });
  const { digest, ...body } = pkg;
  if (packageDigest(body) !== digest)
    throw new Error("Deployment package digest mismatch");
  const rebuilt = await prepareDeploymentPackage(client, pkg.intent, artifact, {
    nonceStart: pkg.nonceStart,
    blockNumber: BigInt(pkg.anchor.number),
  });
  if (rebuilt.digest !== digest)
    throw new Error(
      "Package differs from the current trusted artifacts and anchored configuration; prepare a new package",
    );
  if (
    (await client.getBlock({ blockNumber: BigInt(pkg.anchor.number) })).hash !==
    pkg.anchor.hash
  )
    throw new Error("Deployment anchor was reorganized");
  const journalPath = resolve(directory, "journal.json");
  const journal = existsSync(journalPath)
    ? journalSchema.parse(JSON.parse(readFileSync(journalPath, "utf8")))
    : {
        version: 1 as const,
        digest,
        entries: [] as z.infer<typeof journalSchema>["entries"],
      };
  if (
    journal.digest !== digest ||
    new Set(journal.entries.map((e) => e.index)).size !==
      journal.entries.length ||
    journal.entries.some((e) => e.index >= pkg.steps.length)
  )
    throw new Error("Deployment journal does not match the package");
  writeDeploymentJson(journalPath, journal);
  const wallet = createWalletClient({
    account: pkg.intent.deployer,
    chain,
    transport: http(pkg.intent.rpcUrl),
  });
  async function dependencies() {
    for (const [address, expected] of Object.entries(
      pkg.dependencies.codeHashes,
    )) {
      const code = await client.getCode({ address: address as Hex });
      if (!code || keccak256(code) !== expected)
        throw new Error(
          "Deployment dependency code changed; stop and prepare a fresh package",
        );
    }
    const [book, vault, margin, implementation] = await Promise.all([
      client.readContract({
        address: pkg.intent.factory,
        abi: factoryDeploymentAbi,
        functionName: "orderBookImplementation",
      }),
      client.readContract({
        address: pkg.intent.factory,
        abi: factoryDeploymentAbi,
        functionName: "kuruAmmVaultImplementation",
      }),
      client.readContract({
        address: pkg.intent.factory,
        abi: factoryDeploymentAbi,
        functionName: "marginAccountAddress",
      }),
      client.getStorageAt({
        address: pkg.intent.factory,
        slot: implementationSlot,
      }),
    ]);
    if (
      book.toLowerCase() !==
        pkg.dependencies.orderBookImplementation.toLowerCase() ||
      vault.toLowerCase() !==
        pkg.dependencies.vaultImplementation.toLowerCase() ||
      margin.toLowerCase() !== pkg.intent.margin.toLowerCase() ||
      implementation !== pkg.dependencies.factoryImplementation
    )
      throw new Error(
        "Kuru deployment bindings changed; prepare a fresh package",
      );
  }
  async function verifyTransaction(hash: Hex, step: DeploymentStep) {
    const tx = await client.getTransaction({ hash });
    if (
      tx.from.toLowerCase() !== pkg.intent.deployer.toLowerCase() ||
      tx.nonce !== step.nonce ||
      (tx.to?.toLowerCase() ?? null) !== (step.to?.toLowerCase() ?? null) ||
      tx.input.toLowerCase() !== step.data.toLowerCase() ||
      tx.value !== 0n
    )
      throw new Error(
        "Recorded transaction is outside the reviewed deployment step",
      );
  }
  let completed = 0;
  for (const step of pkg.steps) {
    if (options.stepLimit !== undefined && completed >= options.stepLimit)
      return { status: "paused" as const, completed, journalPath };
    await dependencies();
    let entry = journal.entries.find((e) => e.index === step.index);
    if (!entry) {
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({
          address: pkg.intent.deployer,
          blockTag: "latest",
        }),
        client.getTransactionCount({
          address: pkg.intent.deployer,
          blockTag: "pending",
        }),
      ]);
      if (latest > step.nonce) {
        // Recover the response-to-journal crash window from actual canonical transactions.
        const tip = await client.getBlockNumber({ cacheTime: 0 });
        if (tip - BigInt(pkg.anchor.number) > 256n)
          throw new Error(
            "Unrecorded deployment nonce is too old to scan safely; supply its actual hash in the journal",
          );
        for (let n = BigInt(pkg.anchor.number); n <= tip; n++) {
          const block = await client.getBlock({
            blockNumber: n,
            includeTransactions: true,
          });
          const tx = block.transactions.find(
            (t) =>
              typeof t !== "string" &&
              t.from.toLowerCase() === pkg.intent.deployer.toLowerCase() &&
              t.nonce === step.nonce,
          );
          if (tx && typeof tx !== "string") {
            await verifyTransaction(tx.hash, step);
            entry = { index: step.index, hash: tx.hash, status: "submitted" };
            journal.entries.push(entry);
            writeDeploymentJson(journalPath, journal);
            break;
          }
        }
        if (!entry)
          throw new Error(
            "Deployment nonce was consumed outside the package; stop and inspect the account",
          );
      } else {
        if (latest !== step.nonce || pending !== latest)
          throw new Error(
            "Deployer nonce or pending transaction changed; stop without rebroadcasting",
          );
        const block = await client.getBlock();
        if (
          pkg.intent.series.some(
            (s) => BigInt(s.expiry) <= block.timestamp + 60n,
          )
        )
          throw new Error(
            "Deployment expiries are too close; prepare a new shelf",
          );
        const request = {
          account: pkg.intent.deployer,
          to: step.to ?? undefined,
          data: step.data,
          value: 0n,
          nonce: step.nonce,
        };
        const estimate = await client.estimateGas(request),
          gas = estimate + estimate / 5n + 5000n;
        if (gas > 16000000n)
          throw new Error("Deployment step exceeds the rehearsal gas bound");
        options.progress?.(
          `${step.index + 1}/${pkg.steps.length} ${step.label}`,
        );
        const hash = await wallet.sendTransaction({ ...request, gas });
        entry = { index: step.index, hash, status: "submitted" };
        journal.entries.push(entry);
        try {
          writeDeploymentJson(journalPath, journal);
        } catch {
          throw new Error(
            `Transaction ${hash} was broadcast but could not be journaled. Do not resubmit; retain its hash.`,
          );
        }
      }
    }
    await verifyTransaction(entry.hash as Hex, step);
    const receipt = await waitReceipt(client, entry.hash as Hex, 120000);
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash)
      throw new Error(
        "Deployment receipt was reorganized; inspect before continuing",
      );
    entry.status = receipt.status === "success" ? "included" : "reverted";
    entry.block = receipt.blockNumber.toString();
    entry.blockHash = receipt.blockHash;
    writeDeploymentJson(journalPath, journal);
    if (receipt.status !== "success")
      throw new Error(`Deployment step reverted: ${entry.hash}`);
    if (step.expectedAddress) {
      if (
        step.to === null &&
        receipt.contractAddress?.toLowerCase() !==
          step.expectedAddress.toLowerCase()
      )
        throw new Error("CREATE receipt disagrees with its expected address");
      const code = await client.getCode({ address: step.expectedAddress });
      if (!code || code === "0x")
        throw new Error(
          "Expected deployment address has no code after inclusion",
        );
    }
    completed++;
  }
  const manifest = parseDeploymentManifest(JSON.stringify(pkg.manifest));
  const verification = await checkDeployment(client, client, manifest);
  writeDeploymentJson(resolve(directory, "manifest.json"), manifest);
  writeDeploymentJson(resolve(directory, "verification.json"), verification);
  return {
    status: "complete" as const,
    completed,
    journalPath,
    manifestPath: resolve(directory, "manifest.json"),
    verification,
  };
}
export async function executeLocalDeployment(
  input: unknown,
  directory: string,
  options: { stepLimit?: number; progress?: (message: string) => void } = {},
) {
  const pkg = input as DeploymentPackage;
  if (
    pkg?.intent?.chainId !== 31337 ||
    !/^0x[0-9a-fA-F]{40}$/.test(pkg.intent.deployer) ||
    !/^0x[0-9a-fA-F]{64}$/.test(pkg.digest)
  )
    throw new Error("Invalid local deployment package");
  return withLocalSenderLock(pkg.intent.deployer, pkg.digest, () =>
    executeUnlockedDeployment(input, directory, options),
  );
}
export async function withLocalSenderLock<T>(
  sender: string,
  digest: string,
  operation: () => Promise<T>,
) {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(sender) ||
    !/^0x[0-9a-fA-F]{64}$/.test(digest)
  )
    throw new Error("Invalid sender lock");
  const locks = resolve(".runtime/deployment-locks");
  mkdirSync(locks, { recursive: true });
  const lock = resolve(locks, `31337-${sender.toLowerCase()}.json`);
  if (existsSync(lock)) {
    let previous: { pid: number };
    try {
      previous = JSON.parse(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
        throw new Error();
    } catch {
      throw new Error(
        "Deployment lock is malformed; inspect it before continuing",
      );
    }
    try {
      process.kill(previous.pid, 0);
      throw new Error("A deployment executor already owns this sender");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, digest }));
  } finally {
    closeSync(fd);
  }
  try {
    return await operation();
  } finally {
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, "utf8"));
      if (owner.pid === process.pid && owner.digest === digest)
        unlinkSync(lock);
    }
  }
}
