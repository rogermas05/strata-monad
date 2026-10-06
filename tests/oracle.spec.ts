import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import type { Snapshot, Manifest } from "../packages/core/src/types.ts";
import {
  prepareOracleProof,
  recheckOracleProof,
  expiryOracleAbi,
} from "../packages/core/src/oracle-proof.ts";
import { pythAbi } from "../packages/core/src/pyth.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import { artifact } from "../scripts/artifacts.ts";
import { installWallet, connectInjected } from "./helpers/wallet.ts";

test.describe.configure({ mode: "serial" });
let checkpoint: string;
test.beforeEach(async ({ request }) => {
  const r = await request.post("/api/demo/checkpoint", {
    data: { operation: "begin" },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  checkpoint = (await r.json()).id;
});
test.afterEach(async ({ request }) => {
  if (!checkpoint) return;
  const r = await request.post("/api/demo/checkpoint", {
    data: { operation: "restore", id: checkpoint },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  checkpoint = "";
});

test("controlled deployment rejects oracle packages without sending a transaction", async ({
  page,
  request,
}) => {
  const s: Snapshot = await (await request.get("/api/snapshot")).json();
  const chain = defineChain({
    id: s.manifest.chainId,
    name: "Local",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [s.manifest.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(s.manifest.rpcUrl),
  });
  const nonce = await client.getTransactionCount({
    address: s.manifest.demoUser,
  });
  await page.goto("/settlements");
  await page.getByRole("link", { name: /^Oracle evidence/ }).click();
  await expect(page.locator("main h1")).toHaveText("Oracle evidence");
  await expect(
    page.getByRole("button", { name: "Retrieve signed update" }),
  ).toBeDisabled();
  await expect(page.getByText("Recorded controlled references")).toBeVisible();
  await page.getByLabel("Oracle proof JSON").fill("{invalid json");
  await page.getByRole("button", { name: "Load package", exact: true }).click();
  await expect(page.locator("main [role=alert]")).toBeVisible();
  await page.getByLabel("Import oracle proof").setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(160001, 32),
  });
  await expect(page.locator("main [role=alert]")).toContainText("exceeds");
  const preparation = await request.post("/api/oracle/prepare", {
    data: { kind: "live", account: s.manifest.demoUser },
  });
  expect(preparation.status()).toBe(503);
  expect((await preparation.json()).error).toContain("controlled demo oracle");
  expect(
    (
      await request.post("/api/oracle/inspect", {
        data: { proof: {}, account: s.manifest.demoUser },
      })
    ).status(),
  ).toBe(400);
  const zeroHash = `0x${"00".repeat(32)}`;
  const invalidProof = {
    version: 1,
    kind: "live",
    chainId: s.manifest.chainId,
    engine: s.manifest.engine,
    oracle: s.manifest.oracle,
    verifier: s.manifest.oracle,
    feed: s.manifest.assetId,
    policyId: zeroHash,
    expiry: null,
    updates: ["0x00"],
    maxFee: "invalid",
    observation: {
      publishedAt: "1",
      rawPrice: "1",
      confidence: "0",
      exponent: -8,
      normalizedPrice: "1",
      proofHash: zeroHash,
    },
    verification: {
      blockNumber: "1",
      blockHash: zeroHash,
      blockTimestamp: "1",
      oracleCodeHash: zeroHash,
      verifierCodeHash: zeroHash,
    },
  };
  expect(
    (
      await request.post("/api/oracle/inspect", {
        data: { proof: invalidProof, account: s.manifest.demoUser },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/actions", {
        data: { action: "submit-oracle-proof", proof: invalidProof },
      })
    ).status(),
  ).toBe(400);
  await page.getByLabel("Oracle proof JSON").fill(JSON.stringify(invalidProof));
  await page.getByRole("button", { name: "Load package", exact: true }).click();
  await expect(page.locator("main [role=alert]")).toHaveText(
    "Invalid proof package. Check the fields, numeric values and payload size.",
  );
  expect(
    (
      await request.post("/api/oracle/inspect", {
        data: { oversized: "x".repeat(160001) },
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post("/api/actions", {
        data: { action: "submit-oracle-proof" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (await request.get("/api/oracle/archive/live/live/invalid")).status(),
  ).toBe(400);
  expect(
    (
      await request.get(`/api/oracle/archive/live/live/0x${"11".repeat(32)}`)
    ).status(),
  ).toBe(404);
  expect(
    await client.getTransactionCount({ address: s.manifest.demoUser }),
  ).toBe(nonce);
  await page.screenshot({ path: ".runtime/oracle-evidence-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".runtime/oracle-evidence-mobile.png",
    fullPage: true,
  });
});

test("oracle wallet workspace executes exact-fee live and immutable expiry transactions against a local interface fixture, not authentic Pyth", async ({
  request,
  page,
}) => {
  const s: Snapshot = await (await request.get("/api/snapshot")).json();
  const m = s.manifest;
  const chain = defineChain({
    id: m.chainId,
    name: "Local interface fixture",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [m.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(m.rpcUrl),
    pollingInterval: 100,
  });
  const wallet = createWalletClient({
    account: m.deployer,
    chain,
    transport: http(m.rpcUrl),
  });
  async function deploy(a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) {
    const receipt = await waitReceipt(
      client,
      await wallet.deployContract({ ...a, args }),
    );
    expect(receipt.status).toBe("success");
    return receipt.contractAddress!;
  }
  async function send(
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
    value = 0n,
  ) {
    const simulation = await client.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: m.deployer,
      value,
    });
    const receipt = await waitReceipt(
      client,
      await wallet.writeContract(simulation.request),
    );
    expect(receipt.status).toBe("success");
    return receipt;
  }
  const doubleFile = JSON.parse(
    readFileSync(
      "contracts/out/PythOracle.t.sol/PythInterfaceDouble.json",
      "utf8",
    ),
  );
  const double = {
    abi: doubleFile.abi as Abi,
    bytecode: doubleFile.bytecode.object as Hex,
  };
  const verifier = await deploy(double);
  const oracle = await deploy(artifact("PythExpiryOracle"), [verifier]);
  const engineArtifact = artifact("OptionsEngine");
  const engine = await deploy(engineArtifact, [m.usdc, oracle, 300n]);
  await send(engine, engineArtifact.abi, "approveUnderlying", [m.wmon, true]);
  const expiry = Number((await client.getBlock()).timestamp) + 30;
  await send(engine, engineArtifact.abi, "createSeries", [
    m.wmon,
    m.assetId,
    BigInt(expiry),
    0,
    100000000n,
    0n,
    10n ** 20n,
    "INTERFACE-FIXTURE",
  ]);
  const series = (await client.readContract({
    address: engine,
    abi: engineArtifact.abi,
    functionName: "getSeries",
    args: [1n],
  })) as { token: Address };
  const manifest: Manifest = {
    ...m,
    engine,
    oracle,
    oracleMode: "pyth",
    assets: undefined,
    series: [{ ...m.series[0], id: 1, token: series.token, expiry }],
  };
  await client.request({
    method: "evm_increaseTime" as never,
    params: [40] as never,
  });
  await client.request({ method: "evm_mine" as never });
  function evidence(published: number, confidence: bigint, previous: number) {
    const price = {
      price: 103000000n,
      conf: confidence,
      expo: -8,
      publishTime: BigInt(published),
    };
    const updates = [
      encodeAbiParameters(
        parseAbiParameters(
          "(bytes32 id,(int64 price,uint64 conf,int32 expo,uint256 publishTime) price,(int64 price,uint64 conf,int32 expo,uint256 publishTime) emaPrice),uint256",
        ),
        [{ id: m.assetId, price, emaPrice: price }, BigInt(previous)],
      ),
    ];
    return {
      updates,
      feed: m.assetId,
      price: "103000000",
      confidence: confidence.toString(),
      exponent: -8,
      publishTime: published,
      previousPublishTime: previous,
    };
  }
  // Only this test's browser sees the isolated deployment. Inspection responses
  // use actual contract calls; the normal backend/manifest remains controlled.
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ json: { ...s, manifest, timestamp: expiry + 40 } }),
  );
  await page.route("**/api/oracle", (route) =>
    route.fulfill({
      json: {
        mode: "pyth",
        providerConfigured: false,
        backupConfigured: false,
      },
    }),
  );
  await page.route("**/api/oracle/inspect", async (route) => {
    try {
      const { proof, account } = route.request().postDataJSON();
      await route.fulfill({
        json: await recheckOracleProof(client, manifest, proof, account),
      });
    } catch {
      await route.fulfill({
        status: 400,
        json: { error: "Interface fixture verification failed" },
      });
    }
  });
  await installWallet(page, manifest, m.demoUser);
  await page.goto("/oracle");
  await connectInjected(page);
  const nonce = await client.getTransactionCount({ address: m.demoUser });
  async function submitFromWorkspace(proof: unknown) {
    await page.getByLabel("Oracle proof JSON").fill(JSON.stringify(proof));
    await page
      .getByRole("button", { name: "Load package", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Review oracle transaction",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Check against chain", exact: true })
      .click();
    await expect(
      page.getByText("Checks passed", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Review oracle transaction", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveAccessibleName(
      "Submit oracle evidence",
    );
    await expect(page.getByRole("dialog")).toContainText(
      "0.000000000000000007 MON",
    );
    await page
      .getByRole("button", { name: "Confirm oracle submission", exact: true })
      .click();
    await expect(page.getByText("Submitted", { exact: true })).toBeVisible();
    await expect(page.locator(".toast[role=status]")).toContainText(
      "Transaction included",
    );
  }
  const live = await prepareOracleProof(
    client,
    manifest,
    evidence(Number((await client.getBlock()).timestamp), 1000n, expiry),
    m.deployer,
  );
  expect(live.maxFee).toBe("7");
  await submitFromWorkspace(live);
  expect(await client.getBalance({ address: verifier })).toBe(7n);
  const stored = await client.readContract({
    address: verifier,
    abi: pythAbi,
    functionName: "getPriceUnsafe",
    args: [m.assetId],
  });
  expect(stored.publishTime.toString()).toBe(live.observation.publishedAt);
  const historical = await prepareOracleProof(
    client,
    manifest,
    evidence(expiry + 1, 2000000n, expiry - 1),
    m.deployer,
    expiry,
  );
  const checked = await recheckOracleProof(
    client,
    manifest,
    historical,
    m.deployer,
  );
  await submitFromWorkspace(checked);
  expect(await client.getBalance({ address: verifier })).toBe(14n);
  expect(
    await client.readContract({
      address: oracle,
      abi: expiryOracleAbi,
      functionName: "settlementPrice",
      args: [m.assetId, BigInt(expiry)],
    }),
  ).toBe(103000000n);
  const recorded = await client.readContract({
    address: oracle,
    abi: expiryOracleAbi,
    functionName: "evidence",
    args: [m.assetId, BigInt(expiry)],
  });
  expect(recorded).toEqual([
    BigInt(expiry + 1),
    103000000n,
    2000000n,
    -8,
    historical.observation.proofHash,
  ]);
  await expect(
    recheckOracleProof(client, manifest, historical, m.deployer),
  ).rejects.toThrow("already finalized");
  expect(await client.getTransactionCount({ address: m.demoUser })).toBe(
    nonce + 2,
  );
  await page.screenshot({
    path: ".runtime/oracle-interface-fixture-submitted.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".runtime/oracle-interface-fixture-mobile.png",
    fullPage: true,
  });
});
