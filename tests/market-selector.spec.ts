import { test, expect } from "@playwright/test";
import { asset } from "../packages/core/src/assets.ts";
import type { Snapshot } from "../packages/core/src/index.ts";

test("market selector filters the full shelf, keeps favorites through reload and selects with the keyboard", async ({
  page,
  request,
}) => {
  const snapshot = (await (
    await request.get("/api/snapshot")
  ).json()) as Snapshot;
  const puts = snapshot.markets.filter(
    (market) =>
      market.active && market.asset === "MON" && market.kind === "put",
  );
  await page.goto("/trade");
  await page.getByRole("button", { name: "Change instrument" }).click();
  const dialog = page.getByRole("dialog", { name: "Select market" });
  const search = dialog.getByRole("textbox", { name: "Find market" });
  await expect(search).toBeFocused();
  await expect(dialog.locator(".market-select-row")).toHaveCount(
    snapshot.markets.filter((market) => market.active).length,
  );
  await search.fill("MON put");
  await expect(dialog.locator(".market-select-row")).toHaveCount(puts.length);
  const picked = puts[0];
  await dialog
    .getByRole("button", {
      name: `Add ${picked.symbol} to favorites`,
      exact: true,
    })
    .click();
  await dialog.getByRole("tab", { name: "Favorites", exact: true }).click();
  await expect(dialog.locator(".market-select-row")).toHaveCount(1);
  await expect(
    dialog.getByRole("button", {
      name: `Select ${picked.symbol}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Find a market" }).click();
  await dialog.getByRole("tab", { name: "Favorites", exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: `Select ${picked.symbol}`,
      exact: true,
    }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(new RegExp(`market=${picked.id}(?:&|$)`));
  await expect(dialog).toHaveCount(0);
});

test("market selector handles empty results, expiry filters and mobile without overflow", async ({
  page,
  request,
}) => {
  const snapshot = (await (
    await request.get("/api/snapshot")
  ).json()) as Snapshot;
  await page.goto("/trade");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Change instrument" }).click();
  const dialog = page.getByRole("dialog", { name: "Select market" });
  await dialog
    .getByRole("textbox", { name: "Find market" })
    .fill("no-contract-zyx");
  await expect(
    dialog.getByText("No matching contracts", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Reset filters" }).click();
  const expiry = Math.min(
    ...snapshot.markets
      .filter((market) => market.active)
      .map((market) => market.expiry),
  );
  await dialog
    .getByLabel("Contract expiry")
    .selectOption(new Date(expiry * 1000).toISOString().slice(0, 10));
  await expect(dialog.locator(".market-select-row")).toHaveCount(
    snapshot.markets.filter(
      (market) =>
        market.active &&
        new Date(market.expiry * 1000).toISOString().slice(0, 10) ===
          new Date(expiry * 1000).toISOString().slice(0, 10),
    ).length,
  );
  const search = dialog.getByRole("textbox", { name: "Find market" });
  await search.focus();
  await search.press("ArrowDown");
  const chosen = await dialog
    .locator(".market-selector-row.highlighted .market-select-row")
    .getAttribute("aria-label");
  await expect(
    dialog.getByRole("button", { name: chosen!, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const box = await dialog.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await search.press("Enter");
  await expect(dialog).toHaveCount(0);
});

test("public market selection stays fixed when refreshed prices cross a strike", async ({
  page,
  request,
}) => {
  const snapshot = (await (
    await request.get("/api/snapshot")
  ).json()) as Snapshot;
  const puts = snapshot.markets
    .filter(
      (market) =>
        market.active && market.asset === "MON" && market.kind === "put",
    )
    .sort(
      (a, b) =>
        a.expiry - b.expiry ||
        Math.abs(a.strike - snapshot.spot) - Math.abs(b.strike - snapshot.spot),
    );
  const first = puts[0];
  let requests = 0;
  await page.route("**/api/snapshot", async (route) => {
    requests++;
    // UI fixture only: no wallet, RPC request or transaction is exercised.
    const spot =
      requests === 1
        ? snapshot.spot
        : Math.max(...puts.map((market) => market.strike)) * 2;
    const value = {
      ...snapshot,
      spot,
      manifest: {
        ...snapshot.manifest,
        mode: "testnet",
        chainId: 10143,
        rpcUrl: "https://testnet-rpc.monad.xyz",
      },
    };
    await route.fulfill({ json: value });
  });
  await page.goto("/trade");
  await expect(page.locator(".asset-title")).toHaveAttribute(
    "title",
    first.symbol,
  );
  await expect.poll(() => requests).toBeGreaterThan(1);
  await expect(page.locator(".asset-title")).toHaveAttribute(
    "title",
    first.symbol,
  );
});

test("twenty assets remain searchable and fit a compact mobile strip", async ({
  page,
  request,
}) => {
  const snapshot = (await (
    await request.get("/api/snapshot")
  ).json()) as Snapshot;
  const keys = [
    "MON",
    "BTC",
    "ETH",
    "XAU",
    "SOL",
    "XRP",
    "DOGE",
    "BNB",
    "HYPE",
    "QQQ",
    "TSLA",
    "XAG",
    "EUR",
    "AVAX",
    "ADA",
    "LINK",
    "DOT",
    "LTC",
    "SUI",
    "NEAR",
  ];
  const template = snapshot.markets.find(
    (m) => m.asset === "MON" && m.active && m.kind === "put",
  )!;
  // Rendering fixture only: these additional contracts have no on-chain addresses, fills or proofs.
  const markets = keys.map((key, i) => ({
    ...template,
    id: 2000 + i,
    asset: key,
    symbol: `${key}-UI-FIXTURE`,
  }));
  const value = {
    ...snapshot,
    manifest: {
      ...snapshot.manifest,
      mode: "testnet",
      assets: keys.map((key) => ({
        ...snapshot.manifest.assets![0],
        key,
        name: asset(key).name,
        assetClass: asset(key).assetClass,
      })),
      series: markets,
    },
    markets,
    underlyings: Object.fromEntries(
      keys.map((key) => [key, { ...snapshot.underlyings.MON, key }]),
    ),
  };
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ json: value }),
  );
  await page.goto("/trade");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".market-overview-expanded > button")).toHaveCount(
    20,
  );
  const strip = page.locator(".market-overview-expanded");
  expect((await strip.boundingBox())!.height).toBeLessThan(100);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Change instrument" }).click();
  const dialog = page.getByRole("dialog", { name: "Select market" });
  await dialog.getByRole("textbox", { name: "Find market" }).fill("NEAR");
  await expect(dialog.locator(".market-select-row")).toHaveCount(1);
  await dialog.getByRole("textbox", { name: "Find market" }).press("Enter");
  await expect(
    page.locator(".market-overview-expanded [aria-label='NEAR']"),
  ).toHaveAttribute("aria-selected", "true");
  expect(await strip.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
