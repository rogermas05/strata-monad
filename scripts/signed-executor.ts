import { resolve } from "node:path";
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";
import { artifact } from "./artifacts.ts";
import { configuredSigner } from "./lib/public-signer.ts";
import {
  prepareDeploymentPackage,
  packageDigest,
  factoryDeploymentAbi,
  implementationSlot,
  type DeploymentPackage,
} from "../packages/core/src/deployment-package.ts";
import {
  prepareMakerBootstrap,
  bootstrapDigest,
  type MakerBootstrap,
} from "../packages/core/src/maker-bootstrap.ts";
import {
  parseDeploymentManifest,
  serviceRpcUrl,
} from "../packages/core/src/deployment-config.ts";
import { checkDeployment } from "../packages/core/src/deployment-check.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";
import type { ManagedSigner, SignerIntent } from "./lib/managed-signer.ts";
import { monadTestnet } from "viem/chains";
import { rateLimitedHttp } from "../packages/core/src/rpc-transport.ts";

type Step = {
  index: number;
  nonce: number;
  to: Address | null;
  data: Hex;
  value: string;
  label: string;
  expectedAddress?: Address;
};
export function reviewedStepAuthorizer(steps: Step[]) {
  return async (intent: SignerIntent) => {
    if (
      !steps.some(
        (s) =>
          intent.nonce === s.nonce &&
          (intent.to?.toLowerCase() ?? null) ===
            (s.to?.toLowerCase() ?? null) &&
          intent.data.toLowerCase() === s.data.toLowerCase() &&
          (intent.value ?? 0n) === BigInt(s.value),
      )
    )
      throw new Error("Transaction is outside the exact reviewed package");
  };
}
async function dependencies(client: PublicClient, pkg: DeploymentPackage) {
  for (const [address, hash] of Object.entries(pkg.dependencies.codeHashes)) {
    const code = await client.getCode({ address: address as Address });
    if (!code || keccak256(code) !== hash)
      throw new Error("Deployment dependency code changed");
  }
  const read = (
    functionName:
      | "orderBookImplementation"
      | "kuruAmmVaultImplementation"
      | "marginAccountAddress",
  ) =>
    client.readContract({
      address: pkg.intent.factory,
      abi: factoryDeploymentAbi,
      functionName,
    });
  const [book, vault, margin, implementation] = await Promise.all([
    read("orderBookImplementation"),
    read("kuruAmmVaultImplementation"),
    read("marginAccountAddress"),
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
    throw new Error("Kuru implementation/custody changed since preparation");
}

/** Resumable exact signed execution. Rehearsals inject a signer on an isolated chain. */
export async function executeSignedPackage(
  input: DeploymentPackage | MakerBootstrap,
  directory: string,
  rehearsalSigner?: ManagedSigner,
) {
  const deployment = input.kind === "unsigned-deployment";
  const manifest = parseDeploymentManifest(
    JSON.stringify(deployment ? input.manifest : input.manifest),
  );
  if (manifest.chainId !== 10143 && !rehearsalSigner)
    throw new Error("Signed public execution requires Monad testnet");
  const endpoint = serviceRpcUrl(manifest, process.env.SERVICE_RPC_URL);
  const chain = defineChain({
    id: manifest.chainId,
    name: "Strata testnet",
    nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } },
    ...(manifest.chainId === 10143
      ? { contracts: monadTestnet.contracts }
      : {}),
  });
  const client = createPublicClient({
    chain,
    ...(manifest.chainId === 10143
      ? { batch: { multicall: { wait: 20, batchSize: 8192 } } }
      : {}),
    transport:
      manifest.chainId === 10143
        ? rateLimitedHttp(endpoint)
        : http(endpoint, { timeout: 15000, retryCount: 0 }),
    pollingInterval: 500,
  });
  const { digest, ...body } = input;
  if (
    (deployment
      ? packageDigest(body)
      : bootstrapDigest(body as Omit<MakerBootstrap, "digest">)) !== digest
  )
    throw new Error("Signed package digest mismatch");
  if (deployment) {
    const rebuilt = await prepareDeploymentPackage(
      client,
      input.intent,
      artifact,
      {
        blockNumber: BigInt(input.anchor.number),
        nonceStart: input.nonceStart,
      },
    );
    if (rebuilt.digest !== digest)
      throw new Error(
        "Deployment differs from trusted artifacts and anchored state",
      );
  } else {
    const rebuilt = await prepareMakerBootstrap(
      client,
      manifest,
      input.quantity,
      {
        blockNumber: BigInt(input.anchor.number),
        nonceStart: input.nonceStart,
      },
    );
    if (rebuilt.digest !== digest)
      throw new Error("Bootstrap differs from anchored funding and pricing");
  }
  if (
    (await client.getBlock({ blockNumber: BigInt(input.anchor.number) }))
      .hash !== input.anchor.hash
  )
    throw new Error("Package anchor reorganized");
  const authorize = reviewedStepAuthorizer(input.steps);
  const signer =
    rehearsalSigner ??
    configuredSigner(
      deployment ? "deployer" : "maker",
      client,
      chain,
      endpoint,
      resolve(directory, "signers"),
      authorize,
    );
  const sender = deployment ? input.intent.deployer : manifest.maker;
  if (signer.address.toLowerCase() !== sender.toLowerCase()) {
    if (!rehearsalSigner) signer.close();
    throw new Error("Signer does not match package sender");
  }
  const entries: { index: number; hash: Hex; block: string; label: string }[] =
    [];
  try {
    for (const step of input.steps) {
      if (deployment) await dependencies(client, input);
      const block = await client.getBlock();
      if (
        !deployment &&
        manifest.series
          .filter((s) => input.markets.some((m) => m.id === s.id))
          .some((s) => BigInt(s.expiry) <= block.timestamp + 60n)
      )
        throw new Error("Deployment shelf is too close to expiry");
      const intent = {
        id: `${input.kind}/${digest}/${step.index}`,
        nonce: step.nonce,
        to: step.to ?? undefined,
        data: step.data,
        value: BigInt(step.value),
      };
      await authorize(intent);
      if (!deployment) {
        const asset = manifest.assets?.[0];
        const [spot, published] = (await client.readContract({
          address: manifest.oracle,
          abi: artifact("OracleRouter").abi,
          functionName: "livePrice",
          args: [manifest.assetId],
        })) as [bigint, bigint];
        const delta =
          spot > BigInt(input.spot)
            ? spot - BigInt(input.spot)
            : BigInt(input.spot) - spot;
        if (
          !spot ||
          published > block.timestamp ||
          block.timestamp - published >
            BigInt(
              Math.min(Number(input.maxPriceAge), asset?.maxLiveAge ?? 3600),
            ) ||
          delta * 10000n > BigInt(input.spot) * 50n
        )
          throw new Error("Bootstrap live reference changed or became stale");
      }
      console.log(`${step.index + 1}/${input.steps.length} ${step.label}`);
      const hash = await signer.send(intent);
      const receipt = await client.getTransactionReceipt({ hash });
      if (
        receipt.status !== "success" ||
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
          receipt.blockHash
      )
        throw new Error("Signed receipt failed canonical verification");
      if (step.expectedAddress) {
        if (
          !step.to &&
          receipt.contractAddress?.toLowerCase() !==
            step.expectedAddress.toLowerCase()
        )
          throw new Error("CREATE address mismatch");
        if (!(await client.getCode({ address: step.expectedAddress })))
          throw new Error("Expected deployment code missing");
      }
      entries.push({
        index: step.index,
        hash,
        block: String(receipt.blockNumber),
        label: step.label,
      });
      writeDeploymentJson(
        resolve(
          directory,
          deployment ? "signed-journal.json" : "signed-bootstrap-journal.json",
        ),
        { digest, entries },
      );
    }
    const report = await checkDeployment(
      client,
      createPublicClient({ transport: http(manifest.rpcUrl) }),
      manifest,
    );
    writeDeploymentJson(
      resolve(
        directory,
        deployment ? "verification.json" : "bootstrap-verification.json",
      ),
      report,
    );
    if (deployment)
      writeDeploymentJson(resolve(directory, "manifest.json"), manifest);
    return {
      status: "complete",
      transactions: entries.length,
      manifestPath: resolve(directory, "manifest.json"),
    };
  } finally {
    if (!rehearsalSigner) signer.close();
  }
}
