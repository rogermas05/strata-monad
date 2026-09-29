import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  encodeFunctionData,
  erc20Abi,
  hexToBigInt,
  type Address,
  type Hex,
} from "viem";
import type { Snapshot, Portfolio } from "../packages/core/src/index.ts";

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get("/api/snapshot")).json();
const portfolio = async (request: APIRequestContext): Promise<Portfolio> => {
  const state = await snapshot(request);
  return (
    await request.get(`/api/portfolio/${state.manifest.demoUser}`)
  ).json();
};
async function action(request: APIRequestContext, data: unknown) {
  const response = await request.post("/api/actions", { data });
  expect(response.ok(), await response.text()).toBe(true);
}
async function cycle(request: APIRequestContext, marketId?: number) {
  const response = await request.post("/api/demo/maker-cycle", {
    data: marketId ? { marketIds: [marketId] } : {},
    timeout: 150000,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Snapshot>;
}
function ownedDepth(state: Snapshot, id: number, buy: boolean) {
  return state.markets
    .find((market) => market.id === id)!
    .orders.filter(
      (order) =>
        order.isBuy === buy &&
        order.owner.toLowerCase() === state.manifest.maker.toLowerCase(),
    )
    .reduce((sum, order) => sum + order.remaining, 0);
}
let checkpoint: string | undefined;
let starting: Portfolio;
test.beforeEach(async ({ request }) => {
  const health = await request.get("/api/health");
  expect((await health.json()).chainId).toBe(31337);
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "begin" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  checkpoint = (await response.json()).id;
  starting = await portfolio(request);
});
test.afterEach(async ({ request }) => {
  if (!checkpoint) return;
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "restore", id: checkpoint },
  });
  expect(response.ok(), await response.text()).toBe(true);
  checkpoint = undefined;
  expect(await portfolio(request)).toEqual(starting);
});

test("actual fills skew maker prices, exhaust the net short budget and preserve a reducing bid", async ({
  request,
  page,
}) => {
  test.setTimeout(90000);
  const initial = await snapshot(request);
  const market = initial.markets.find(
    (market) => market.active && market.kind === "call" && market.id === 15,
  )!;
  expect(market).toBeDefined();
  await request.post("/api/demo/maker-config", {
    data: {
      ...initial.maker.config,
      maxNetInventory: 90,
      inventorySkewBps: 2000,
    },
  });
  await action(request, {
    action: "trade",
    marketId: market.id,
    isBuy: true,
    quantity: "40",
    price: "5",
  });
  const skewed = await cycle(request, market.id);
  const position = skewed.maker.inventory.find(
    (position) => position.marketId === market.id,
  )!;
  expect(position.netQuantity).toBe(-40);
  expect(position.reservationPrice).toBeGreaterThan(
    skewed.markets.find((candidate) => candidate.id === market.id)!.mark,
  );
  expect(position.priceSkewBps).toBeCloseTo(888.888, 2);
  expect(ownedDepth(skewed, market.id, false)).toBe(50);
  const written = position.writtenClaims;
  await action(request, {
    action: "trade",
    marketId: market.id,
    isBuy: true,
    quantity: "50",
    price: "10",
  });
  const capped = await cycle(request, market.id);
  const cappedPosition = capped.maker.inventory.find(
    (position) => position.marketId === market.id,
  )!;
  expect(cappedPosition.netQuantity).toBe(-90);
  expect(cappedPosition.writtenClaims).toBe(written);
  expect(ownedDepth(capped, market.id, false)).toBe(0);
  expect(ownedDepth(capped, market.id, true)).toBeGreaterThan(0);
  const beforeRejected = await portfolio(request);
  expect(
    (
      await request.post("/api/actions", {
        data: {
          action: "trade",
          marketId: market.id,
          isBuy: true,
          quantity: "1",
          price: "1",
        },
      })
    ).status(),
  ).toBe(400);
  expect(await portfolio(request)).toEqual(beforeRejected);
  await action(request, {
    action: "trade",
    marketId: market.id,
    isBuy: false,
    quantity: "5",
    price: "0.0001",
  });
  const reduced = await cycle(request, market.id);
  expect(
    reduced.maker.inventory.find((position) => position.marketId === market.id)!
      .netQuantity,
  ).toBe(-85);
  expect(ownedDepth(reduced, market.id, false)).toBe(5);
  await page.goto("/maker");
  await expect(page.getByLabel("Net inventory cap (MON / series)")).toHaveValue(
    "90",
  );
  await expect(
    page.getByRole("row").filter({ hasText: market.symbol }),
  ).toContainText("-85");
  await page.screenshot({ path: ".runtime/maker-risk-desktop.png" });
});

test("stale pricing cancels project quotes and returns custody without changing writer obligations", async ({
  request,
}) => {
  test.setTimeout(180000);
  const before = await snapshot(request),
    user = await portfolio(request);
  expect(
    before.markets.some((market) =>
      market.orders.some(
        (order) =>
          order.owner.toLowerCase() === before.manifest.maker.toLowerCase(),
      ),
    ),
  ).toBe(true);
  const advance = await request.post("/api/demo/advance", {
    data: { seconds: 4000, publish: false, finalize: false },
  });
  expect(advance.ok(), await advance.text()).toBe(true);
  const stopped = await cycle(request);
  expect(stopped.service.newExposureAllowed).toBe(false);
  expect(
    stopped.markets
      .flatMap((market) => market.orders)
      .filter(
        (order) =>
          order.owner.toLowerCase() === stopped.manifest.maker.toLowerCase(),
      ),
  ).toHaveLength(0);
  expect(stopped.maker.venueUsdc).toBe(0);
  for (const position of stopped.maker.inventory) {
    const previous = before.maker.inventory.find(
      (previous) => previous.marketId === position.marketId,
    )!;
    expect(position.writtenClaims).toBe(previous.writtenClaims);
    expect(position.collateral).toBe(previous.collateral);
    expect(position.netQuantity).toBe(previous.netQuantity);
    expect(position.venueClaims).toBe("0");
    expect(position.restingClaims).toBe("0");
  }
  expect(await portfolio(request)).toEqual(user);
});

test("reviewed maker halt cancels liquidity, preserves collateral and remains paused after reload", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const before = await snapshot(request);
  await page.goto("/maker");
  await page
    .getByRole("button", { name: "Halt & withdraw quotes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Halt maker liquidity",
  );
  await expect(page.getByRole("dialog")).toContainText(before.manifest.maker);
  await page
    .getByRole("button", { name: "Confirm halt & withdrawal", exact: true })
    .click();
  await expect
    .poll(
      async () => {
        const state = await snapshot(request);
        return {
          enabled: state.maker.enabled,
          orders: state.markets
            .flatMap((market) => market.orders)
            .filter(
              (order) =>
                order.owner.toLowerCase() ===
                state.manifest.maker.toLowerCase(),
            ).length,
          cash: state.maker.venueUsdc,
        };
      },
      { timeout: 150000 },
    )
    .toEqual({ enabled: false, orders: 0, cash: 0 });
  const stopped = await snapshot(request);
  expect(
    stopped.maker.inventory.map((position) => [
      position.writtenClaims,
      position.collateral,
    ]),
  ).toEqual(
    before.maker.inventory.map((position) => [
      position.writtenClaims,
      position.collateral,
    ]),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume updates", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".runtime/maker-halted-mobile.png",
    fullPage: true,
  });
});

test("portfolio and expiry budgets cancel unsafe reservations, preserve backing and retain only reducing liquidity", async ({
  request,
  page,
}) => {
  test.setTimeout(180000);
  const initial = await snapshot(request);
  const market = initial.markets.find((m) => m.id === 15)!;
  await action(request, {
    action: "trade",
    isBuy: true,
    marketId: market.id,
    quantity: "40",
    price: "5",
  });
  const sold = await snapshot(request);
  const originalBacking = sold.maker.inventory.map((p) => [
    p.marketId,
    p.writtenClaims,
    p.collateral,
  ]);
  const cfg = await request.post("/api/demo/maker-config", {
    data: {
      ...sold.maker.config,
      maxPortfolioInventory: 20,
      maxExpiryInventory: 20,
    },
  });
  expect(cfg.ok(), await cfg.text()).toBe(true);
  const restricted = await cycle(request, market.id);
  expect(restricted.maker.risk.actualBreached).toBe(true);
  expect(ownedDepth(restricted, market.id, false)).toBe(0);
  expect(ownedDepth(restricted, market.id, true)).toBe(40);
  expect(
    restricted.maker.inventory.map((p) => [
      p.marketId,
      p.writtenClaims,
      p.collateral,
    ]),
  ).toEqual(originalBacking);
  await page.goto("/maker");
  await expect(
    page.getByText("Reducing exposure", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Portfolio risk budgets", exact: true }),
  ).toBeVisible();
  await action(request, {
    action: "trade",
    isBuy: false,
    marketId: market.id,
    quantity: "40",
    price: "0.0001",
  });
  const flat = await cycle(request, market.id);
  expect(flat.maker.risk.actualBreached).toBe(false);
  expect(BigInt(flat.maker.risk.reservedGrossClaims)).toBeLessThanOrEqual(
    20n * 10n ** 18n,
  );
  expect(ownedDepth(flat, market.id, true)).toBe(20);
  expect(ownedDepth(flat, market.id, false)).toBe(20);
  const other = await cycle(request, 16);
  expect(ownedDepth(other, 16, true)).toBe(0);
  expect(ownedDepth(other, 16, false)).toBe(0);
  expect(BigInt(other.maker.risk.reservedGrossClaims)).toBeLessThanOrEqual(
    20n * 10n ** 18n,
  );
  await page.reload();
  await expect(page.getByLabel("Portfolio exposure cap (MON)")).toHaveValue(
    "20",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".runtime/maker-portfolio-mobile.png",
    fullPage: true,
  });
});

test("total issuance budget prevents replenishment across the shelf while existing claims stay tradable", async ({
  request,
}) => {
  const initial = await snapshot(request);
  const market = initial.markets.find((m) => m.id === 15)!;
  const totalWritten = Number(
    BigInt(initial.maker.risk.writtenClaims) / 10n ** 18n,
  );
  const cfg = await request.post("/api/demo/maker-config", {
    data: { ...initial.maker.config, maxTotalWritten: totalWritten },
  });
  expect(cfg.ok(), await cfg.text()).toBe(true);
  await action(request, {
    action: "trade",
    isBuy: true,
    marketId: market.id,
    quantity: "40",
    price: "5",
  });
  const current = await cycle(request, market.id);
  expect(current.maker.risk.writtenClaims).toBe(
    initial.maker.risk.writtenClaims,
  );
  // Without issuance, asks are limited to claims the maker still holds after the fill.
  const position = initial.maker.inventory.find(
    (p) => p.marketId === market.id,
  )!;
  const heldAfterFill =
    Number(
      (BigInt(position.walletClaims) +
        BigInt(position.venueClaims) +
        BigInt(position.restingClaims)) /
        10n ** 18n,
    ) - 40;
  expect(ownedDepth(current, market.id, false)).toBe(
    Math.min(initial.maker.config.targetInventory, heldAfterFill),
  );
  expect(
    current.maker.inventory.find((p) => p.marketId === market.id)!
      .writtenClaims,
  ).toBe(
    initial.maker.inventory.find((p) => p.marketId === market.id)!
      .writtenClaims,
  );
});

test("replenishment obtains fresh exact approvals after allowances are cleared", async ({
  request,
}) => {
  test.setTimeout(180000);
  const initial = await snapshot(request);
  const { manifest } = initial;
  expect(manifest.kuruMargin).toBeDefined();
  // A put series whose resting asks are the maker's entire claim inventory and
  // whose issuance cap has room, so a full fill forces new issuance, collateral
  // funding and a claim deposit.
  const market = initial.markets.find((m) => {
    const p = initial.maker.inventory.find((x) => x.marketId === m.id)!;
    return (
      m.active &&
      m.kind === "put" &&
      p.walletClaims === "0" &&
      p.venueClaims === "0" &&
      BigInt(p.restingClaims) === 90n * 10n ** 18n &&
      BigInt(p.writtenClaims) + 90n * 10n ** 18n <=
        BigInt(initial.maker.config.maxWritten) * 10n ** 18n &&
      ownedDepth(initial, m.id, false) === 90
    );
  })!;
  expect(market, "a fully quoted put series").toBeDefined();
  const before = initial.maker.inventory.find((p) => p.marketId === market.id)!;
  const rpc = async (method: string, params: unknown[]) => {
    const response = await request.post(manifest.rpcUrl, {
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    const body = await response.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    return body.result as string;
  };
  const allowance = async (token: Address, spender: Address) =>
    hexToBigInt(
      (await rpc("eth_call", [
        {
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "allowance",
            args: [manifest.maker, spender],
          }),
        },
        "latest",
      ])) as Hex,
    );
  const approvals: [Address, Address][] = [
    [manifest.usdc, manifest.engine],
    [manifest.usdc, manifest.kuruMargin!],
    [market.token, manifest.kuruMargin!],
  ];
  await rpc("anvil_impersonateAccount", [manifest.maker]);
  try {
    for (const [token, spender] of approvals) {
      const hash = await rpc("eth_sendTransaction", [
        {
          from: manifest.maker,
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
        },
      ]);
      await expect
        .poll(async () =>
          (await rpc("eth_getTransactionReceipt", [hash]).catch(() => null)) ===
          null
            ? "pending"
            : "mined",
        )
        .toBe("mined");
      expect(await allowance(token, spender)).toBe(0n);
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [manifest.maker]);
  }
  // Isolate approval mechanics from the per-series net short limit; the
  // checkpoint teardown restores the configured limits.
  const cfg = await request.post("/api/demo/maker-config", {
    data: { ...initial.maker.config, maxNetInventory: 300 },
  });
  expect(cfg.ok(), await cfg.text()).toBe(true);
  await action(request, {
    action: "trade",
    isBuy: true,
    marketId: market.id,
    quantity: "90",
    price: "50",
  });
  const current = await cycle(request, market.id);
  const after = current.maker.inventory.find((p) => p.marketId === market.id)!;
  const strikeUnits = BigInt(Math.round(market.strike * 1e6));
  // Exactly 90 new claims were issued and backed by the full put notional.
  expect(BigInt(after.writtenClaims) - BigInt(before.writtenClaims)).toBe(
    90n * 10n ** 18n,
  );
  expect(BigInt(after.collateral) - BigInt(before.collateral)).toBe(
    90n * strikeUnits,
  );
  // Fresh inventory was deposited and re-quoted at the full target depth.
  expect(ownedDepth(current, market.id, false)).toBe(
    current.maker.config.targetInventory,
  );
  expect(ownedDepth(current, market.id, true)).toBeGreaterThan(0);
  expect(after.walletClaims).toBe("0");
  // Exact approvals were consumed; no standing allowance was left behind.
  expect(await allowance(manifest.usdc, manifest.engine)).toBe(0n);
  expect(await allowance(market.token, manifest.kuruMargin!)).toBe(0n);
});
