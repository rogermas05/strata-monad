import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type {
  Snapshot,
  Portfolio,
  Manifest,
} from "../packages/core/src/index.ts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
} from "viem";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import tokenAbi from "../packages/core/src/generated/OptionToken.json" with { type: "json" };
import type { Abi } from "viem";

import { installWallet, connectInjected } from "./helpers/wallet.ts";
async function devSend(
  manifest: Manifest,
  address: Address,
  fn: string,
  args: unknown[],
) {
  const chain = defineChain({
    id: 31337,
    name: "Local",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(manifest.rpcUrl),
    pollingInterval: 100,
  });
  const wallet = createWalletClient({
    account: manifest.demoUser,
    chain,
    transport: http(manifest.rpcUrl),
  });
  const simulation = await client.simulateContract({
    account: manifest.demoUser,
    address,
    abi: tokenAbi as Abi,
    functionName: fn,
    args,
  });
  const receipt = await waitReceipt(
    client,
    await wallet.writeContract(simulation.request),
  );
  expect(receipt.status).toBe("success");
}
async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  return (await request.get("/api/snapshot")).json();
}
async function portfolio(request: APIRequestContext): Promise<Portfolio> {
  const s = await snapshot(request);
  return (await request.get(`/api/portfolio/${s.manifest.demoUser}`)).json();
}
async function action(request: APIRequestContext, body: unknown) {
  const response = await request.post("/api/actions", { data: body });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBeTruthy();
  return result;
}
test.describe.configure({ mode: "serial" });
let checkpointId: string | undefined;
let startingPortfolio: Portfolio;
let settlementMarketId: number;
test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "begin" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  checkpointId = (await response.json()).id;
  startingPortfolio = await portfolio(request);
});
test.afterAll(async ({ request }) => {
  if (!checkpointId) return;
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "restore", id: checkpointId },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const restored = await portfolio(request);
  expect(restored.usdc).toBe(startingPortfolio.usdc);
  expect(restored.wmon).toBe(startingPortfolio.wmon);
  expect(restored.positions).toEqual(startingPortfolio.positions);
});
test("connection loss disables cached quotes and recovers after a confirmed refresh", async ({
  page,
}) => {
  await page.goto("/trade?market=15");
  await expect(
    page.getByRole("button", { name: "Review purchase", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/snapshot", (route) => route.abort("failed"));
  await expect(page.locator(".service-notice")).toContainText(
    "Connection interrupted",
  );
  await expect(
    page.getByRole("button", { name: "Price unavailable", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: ".runtime/terminal-connection-outage.png" });
  await page.unroute("**/api/snapshot");
  await expect(page.locator(".service-notice")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review purchase", exact: true }),
  ).toBeEnabled();
});
test("buy across depth levels from the terminal and deliver exact wallet claims", async ({
  page,
  request,
}) => {
  const before = await portfolio(request),
    qty = before.positions.find((p) => p.marketId === 15)!.quantity;
  await page.goto("/trade?market=15");
  await page.getByLabel("Trade quantity").fill("25");
  await page
    .getByRole("button", { name: "Review purchase", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Exact quantity or the transaction reverts",
  );
  await page
    .getByRole("button", { name: "Confirm purchase", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  const after = await portfolio(request);
  expect(after.positions.find((p) => p.marketId === 15)!.quantity).toBe(
    qty + 25,
  );
  expect(after.usdc).toBeLessThan(before.usdc);
  expect(after.venueUsdc).toBe(0);
  await page.screenshot({ path: ".runtime/trade-desktop.png" });
});
test("funded writing and inventory burn return the correct collateral", async ({
  page,
  request,
}) => {
  const before = await portfolio(request);
  await page.goto("/write?market=16");
  await page.getByLabel("Writer quantity").fill("2");
  await page
    .getByRole("button", { name: "Review issuance", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lock collateral & issue", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  const written = await portfolio(request);
  const p = written.positions.find((p) => p.marketId === 16)!;
  expect(p.writerQuantity).toBe(2);
  expect(p.collateral).toBe(2.1);
  await page
    .getByRole("button", { name: "Burn inventory & release", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await portfolio(request)).positions.find((p) => p.marketId === 16)!
          .writerQuantity,
    )
    .toBe(0);
  expect((await portfolio(request)).usdc).toBeCloseTo(before.usdc, 6);
});
test("limit order funding, cancellation and venue withdrawal recover wallet funds", async ({
  page,
  request,
}) => {
  const before = await portfolio(request);
  await page.goto("/trade?market=15");
  await page.getByRole("button", { name: "Limit", exact: true }).click();
  await page.getByLabel("Trade quantity").fill("5");
  await page.getByLabel("Limit price").fill("0.0001");
  await page
    .getByRole("button", { name: "Review purchase", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm purchase", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  await page.goto("/portfolio");
  await page.getByRole("button", { name: /Open orders/ }).click();
  await page.getByRole("button", { name: "Cancel order", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  await expect
    .poll(async () => {
      const account = await portfolio(request);
      return { orders: account.orders.length, venueUsdc: account.venueUsdc };
    })
    .toEqual({ orders: 0, venueUsdc: before.venueUsdc });
  const after = await portfolio(request);
  expect(after.venueUsdc).toBe(0);
  expect(after.usdc).toBeCloseTo(before.usdc, 6);
});
test("invalid precision and insufficient liquidity fail without moving balances", async ({
  request,
}) => {
  const before = await portfolio(request);
  const invalid = await request.post("/api/actions", {
    data: {
      action: "place",
      marketId: 15,
      isBuy: true,
      quantity: "0.00001",
      price: "0.001",
    },
  });
  expect(invalid.status()).toBe(400);
  const noDepth = await request.post("/api/actions", {
    data: {
      action: "trade",
      marketId: 15,
      isBuy: true,
      quantity: "100000",
      price: "5000",
    },
  });
  expect(noDepth.status()).toBe(400);
  const after = await portfolio(request);
  expect(after.usdc).toBe(before.usdc);
  expect(after.positions.find((p) => p.marketId === 15)!.quantity).toBe(
    before.positions.find((p) => p.marketId === 15)!.quantity,
  );
});
test("two-leg strategy executes atomically from the strategy builder", async ({
  page,
  request,
}) => {
  const before = await portfolio(request);
  await page.goto("/strategies");
  await page.getByRole("button", { name: "Straddle", exact: true }).click();
  const call = Number(await page.getByLabel("Leg 1 instrument").inputValue()),
    put = Number(await page.getByLabel("Leg 2 instrument").inputValue());
  settlementMarketId = call;
  await page
    .getByRole("button", { name: "Review atomic strategy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Execute 2-leg strategy", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  const after = await portfolio(request);
  for (const id of [call, put])
    expect(after.positions.find((p) => p.marketId === id)!.quantity).toBe(
      before.positions.find((p) => p.marketId === id)!.quantity + 10,
    );
  await page.screenshot({ path: ".runtime/strategy-desktop.png" });
});
test("injected wallet signs actual chain transactions without server demo signing", async ({
  page,
  request,
}) => {
  const s = await snapshot(request),
    before = await portfolio(request);
  let serverActions = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/actions") && r.method() === "POST")
      serverActions++;
  });
  await installWallet(page, s.manifest, s.manifest.demoUser);
  await page.goto("/trade?market=15");
  await connectInjected(page);
  await page.getByLabel("Trade quantity").fill("1");
  await page
    .getByRole("button", { name: "Review purchase", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm purchase", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  expect(serverActions).toBe(0);
  expect(
    (await portfolio(request)).positions.find((p) => p.marketId === 15)!
      .quantity,
  ).toBe(before.positions.find((p) => p.marketId === 15)!.quantity + 1);
});
test("maker controls persist risk settings and reject an unfunded inventory target", async ({
  page,
  request,
}) => {
  await page.goto("/maker");
  await page.getByLabel("Target depth (MON / side)").fill("50");
  await page.getByLabel("Issuance cap (MON / series)").fill("40");
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "Issuance cap must cover target inventory",
  );
  const invalid = await request.post("/api/demo/maker-config", {
    data: {
      ...(await snapshot(request)).maker.config,
      targetInventory: 50,
      maxWritten: 40,
    },
  });
  expect(invalid.status()).toBe(400);
  await page.getByLabel("Issuance cap (MON / series)").fill("150");
  await page.getByLabel("Model volatility (%)").fill("80");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Maker settings saved",
  );
  expect((await snapshot(request)).maker.config).toMatchObject({
    volatility: 0.8,
    targetInventory: 50,
    maxWritten: 150,
  });
  await page
    .getByRole("button", { name: "Pause updates", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume updates", exact: true }),
  ).toBeVisible();
  expect((await snapshot(request)).maker.enabled).toBe(false);
  await page
    .getByRole("button", { name: "Resume updates", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause updates", exact: true }),
  ).toBeVisible();
  expect((await snapshot(request)).maker.enabled).toBe(true);
  await page.screenshot({ path: ".runtime/maker-controls-desktop.png" });
});
test("two wallets agree on an unresolved unwind and recover collateral atomically", async ({
  page,
  request,
}) => {
  const s = await snapshot(request);
  const accounts = await (
    await request.post(s.manifest.rpcUrl, {
      data: { jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] },
    })
  ).json();
  const holder = accounts.result[3] as Address;
  await action(request, {
    action: "trade",
    marketId: 13,
    isBuy: true,
    quantity: "2",
    price: "5",
  });
  await action(request, { action: "write", marketId: 16, quantity: "2" });
  const market = s.markets.find((m) => m.id === 16)!;
  await devSend(s.manifest, market.token, "transfer", [
    holder,
    parseUnits("1", 18),
  ]);
  await devSend(s.manifest, s.manifest.usdc, "approve", [
    s.manifest.engine,
    0n,
  ]);
  const current = await snapshot(request);
  const advance = await request.post("/api/demo/advance", {
    data: {
      seconds: Math.max(1, market.expiry - current.timestamp + 2),
      publish: false,
      finalize: false,
    },
  });
  expect(advance.ok(), await advance.text()).toBeTruthy();
  expect(
    (await snapshot(request)).markets.find((m) => m.id === 16)!.settlementPrice,
  ).toBe(null);
  const beforeWriter = await portfolio(request);
  const beforeHolder: Portfolio = await (
    await request.get(`/api/portfolio/${holder}`)
  ).json();
  await installWallet(page, s.manifest, holder);
  await page.goto("/recovery?market=16&mode=unwind");
  await page.getByLabel("Holder account").fill(holder);
  await page.getByLabel("Recovery quantity").fill("1");
  await page.getByLabel("Unwind payment").fill("0.25");
  await page
    .getByRole("button", { name: "Prepare authorization", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign as writer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("$0.250000");
  await page
    .getByRole("button", { name: "Confirm signature", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Authorization signed",
  );
  await page
    .getByRole("button", { name: "Approve payment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm payment approval", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  await connectInjected(page);
  await page
    .getByRole("button", { name: "Sign as holder", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm signature", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Authorization signed",
  );
  const packet = JSON.parse(
    await page.getByLabel("Authorization JSON").inputValue(),
  );
  const tampered = await request.post("/api/actions", {
    data: {
      action: "submit-recovery",
      packet: { ...packet, terms: { ...packet.terms, payment: "500000" } },
    },
  });
  expect(tampered.status()).toBe(400);
  await expect(
    page.getByRole("button", { name: "Review submission", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Review submission", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Submit authorized recovery", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await portfolio(request)).positions.find((p) => p.marketId === 16)!
          .writerQuantity,
    )
    .toBe(1);
  const afterWriter = await portfolio(request);
  const afterHolder: Portfolio = await (
    await request.get(`/api/portfolio/${holder}`)
  ).json();
  expect(afterHolder.usdc - beforeHolder.usdc).toBeCloseTo(0.25, 6);
  expect(afterHolder.positions.find((p) => p.marketId === 16)!.quantity).toBe(
    0,
  );
  expect(afterWriter.usdc - beforeWriter.usdc).toBeCloseTo(0.8, 6);
  expect(afterWriter.positions.find((p) => p.marketId === 16)!.collateral).toBe(
    1.05,
  );
  const replay = await request.post("/api/actions", {
    data: { action: "submit-recovery", packet },
  });
  expect(replay.status()).toBe(400);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".runtime/unwind-recovery-desktop.png" });
});
test("expiry finalizes immutable reference and pays a wallet holder onchain", async ({
  page,
  request,
}) => {
  const s = await snapshot(request),
    m = s.markets.find((m) => m.id === settlementMarketId)!,
    before = await portfolio(request),
    q = before.positions.find((p) => p.marketId === m.id)!.quantity;
  expect(q).toBeGreaterThan(0);
  const response = await request.post("/api/demo/advance", {
    data: { seconds: Math.max(1, m.expiry - s.timestamp + 2), price: 1.2 },
  });
  expect(response.ok()).toBeTruthy();
  const settled = await snapshot(request);
  expect(settled.markets.find((x) => x.id === m.id)!.settlementPrice).toBe(1.2);
  await page.goto("/settlements");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: m.symbol, exact: true }) });
  await row.getByRole("button", { name: "Claim payout", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  const after = await portfolio(request);
  expect(after.positions.find((p) => p.marketId === m.id)!.quantity).toBe(0);
  expect(after.wmon - before.wmon).toBeCloseTo((q * (1.2 - m.strike)) / 1.2, 8);
  await page.screenshot({ path: ".runtime/settlement-desktop.png" });
});
test("delegated claims pay the holder through a separate relay wallet and can be revoked", async ({
  page,
  request,
}) => {
  const s = await snapshot(request);
  const accounts = await (
    await request.post(s.manifest.rpcUrl, {
      data: { jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] },
    })
  ).json();
  const relay = accounts.result[3] as Address;
  const before = await portfolio(request);
  const beforeRelay: Portfolio = await (
    await request.get(`/api/portfolio/${relay}`)
  ).json();
  const market = s.markets.find((m) => m.id === 13)!;
  await installWallet(page, s.manifest, relay);
  await page.goto("/recovery?market=13");
  await page
    .getByRole("button", { name: "Prepare authorization", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign as holder", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm signature", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Authorization signed",
  );
  const packet = JSON.parse(
    await page.getByLabel("Authorization JSON").inputValue(),
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download JSON", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("strata-claim-13.json");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByLabel("Authorization JSON").fill(JSON.stringify(packet));
  await page
    .getByRole("button", { name: "Load authorization", exact: true })
    .click();
  await connectInjected(page);
  await page
    .getByRole("button", { name: "Review submission", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Payout recipient");
  await page
    .getByRole("button", { name: "Submit authorized recovery", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await portfolio(request)).positions.find((p) => p.marketId === 13)!
          .quantity,
    )
    .toBe(before.positions.find((p) => p.marketId === 13)!.quantity - 1);
  const after = await portfolio(request);
  const afterRelay: Portfolio = await (
    await request.get(`/api/portfolio/${relay}`)
  ).json();
  expect(after.wmon - before.wmon).toBeCloseTo(
    (market.settlementPrice! - market.strike) / market.settlementPrice!,
    8,
  );
  expect(afterRelay.wmon).toBe(beforeRelay.wmon);
  await page.evaluate(
    (account) => (window as any).selectTestWalletAccount(account),
    s.manifest.demoUser,
  );
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page
    .getByRole("button", { name: "Prepare authorization", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign as holder", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm signature", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Authorization signed",
  );
  const revoked = JSON.parse(
    await page.getByLabel("Authorization JSON").inputValue(),
  );
  const q = (await portfolio(request)).positions.find(
    (p) => p.marketId === 13,
  )!.quantity;
  await page
    .getByRole("button", { name: "Revoke pending authorizations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm revocation", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "Transaction included",
  );
  const invalid = await request.post("/api/actions", {
    data: { action: "submit-recovery", packet: revoked },
  });
  expect(invalid.status()).toBe(400);
  expect(
    (await portfolio(request)).positions.find((p) => p.marketId === 13)!
      .quantity,
  ).toBe(q);
  await expect(
    page.getByRole("button", { name: "Review submission", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".runtime/delegated-claim-desktop.png" });
});
test("all workspaces render without runtime errors, dialogs support keyboard, mobile stays within viewport", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of [
    "/trade",
    "/markets",
    "/strategies",
    "/portfolio",
    "/write",
    "/analytics",
    "/settlements",
    "/recovery",
    "/oracle",
    "/maker",
    "/status",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main h1")).toBeVisible();
  }
  await page.goto("/trade");
  await page
    .getByRole("button", { name: "Review purchase", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/portfolio");
  await page.screenshot({ path: ".runtime/portfolio-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    "/trade",
    "/strategies",
    "/portfolio",
    "/maker",
    "/analytics",
    "/status",
    "/recovery",
    "/oracle",
  ]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
  await page.goto("/trade");
  await page.screenshot({ path: ".runtime/trade-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("stale oracle pauses new exposure while cancellation and withdrawal remain usable", async ({
  page,
  request,
}) => {
  const live = await snapshot(request);
  const market = live.markets.find(
    (candidate) =>
      candidate.active &&
      candidate.kind === "call" &&
      candidate.expiry > live.timestamp + 4000,
  )!;
  const writer = live.markets.find(
    (candidate) =>
      candidate.active &&
      candidate.kind === "put" &&
      candidate.expiry > live.timestamp + 4000,
  )!;
  expect(market).toBeDefined();
  expect(writer).toBeDefined();
  const expired = live.markets.find((candidate) => !candidate.active);
  if (expired) {
    const before = await portfolio(request);
    const rejected = await request.post("/api/actions", {
      data: {
        action: "place",
        marketId: expired.id,
        isBuy: true,
        quantity: "1",
        price: "0.0001",
      },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toContain("Expired market");
    expect(await portfolio(request)).toEqual(before);
  }
  await action(request, {
    action: "place",
    marketId: market.id,
    isBuy: true,
    quantity: "1",
    price: "0.0001",
  });
  const resting = (await portfolio(request)).orders.find(
    (order) => order.marketId === market.id,
  )!;
  expect(resting).toBeDefined();
  const advanced = await request.post("/api/demo/advance", {
    data: { seconds: 4000, publish: false, finalize: false },
  });
  expect(advanced.ok(), await advanced.text()).toBeTruthy();
  const paused = await snapshot(request);
  expect(paused.service.status).toBe("degraded");
  expect(paused.service.newExposureAllowed).toBe(false);
  expect(
    paused.markets.find((candidate) => candidate.id === market.id)!.healthy,
  ).toBe(false);
  expect((await request.get("/api/health")).status()).toBe(503);
  const before = await portfolio(request);
  for (const input of [
    {
      action: "trade",
      marketId: market.id,
      quantity: "1",
      isBuy: true,
      price: "1",
    },
    { action: "write", marketId: writer.id, quantity: "1" },
    {
      action: "place",
      marketId: market.id,
      quantity: "1",
      isBuy: true,
      price: "0.0001",
    },
  ]) {
    const rejected = await request.post("/api/actions", { data: input });
    expect(rejected.status()).toBe(400);
    const result = await rejected.json();
    expect(result.hashes).toEqual([]);
    expect(result.error).toContain("freshness");
  }
  expect(await portfolio(request)).toEqual(before);
  await page.goto(`/trade?market=${market.id}`);
  await expect(page.locator(".service-notice")).toContainText(
    "freshness limit",
  );
  await expect(
    page.getByRole("button", { name: "Price unavailable", exact: true }),
  ).toBeDisabled();
  await action(request, {
    action: "cancel",
    marketId: market.id,
    orderId: resting.id,
  });
  expect(
    (await portfolio(request)).orders.some(
      (order) => order.id === resting.id && order.marketId === market.id,
    ),
  ).toBe(false);
  expect((await portfolio(request)).venueUsdc).toBe(0);
  await page.screenshot({ path: ".runtime/terminal-stale-oracle.png" });
});
