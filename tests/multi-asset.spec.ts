import { test, expect, type APIRequestContext } from "@playwright/test";
import type { Snapshot, Portfolio } from "../packages/core/src/index.ts";

const ASSET = "SPY";
const CHALLENGE_MARGIN_SECONDS = 30;

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get("/api/snapshot")).json();
const portfolio = async (request: APIRequestContext): Promise<Portfolio> => {
  const state = await snapshot(request);
  return (
    await request.get(`/api/portfolio/${state.manifest.demoUser}`)
  ).json();
};
const advance = (request: APIRequestContext, data: unknown) =>
  request.post("/api/demo/advance", { data, timeout: 150000 });
async function advanced(request: APIRequestContext, data: unknown) {
  const response = await advance(request, data);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Snapshot>;
}
const act = (request: APIRequestContext, data: unknown) =>
  request.post("/api/actions", { data, timeout: 150000 });

let checkpoint: string | undefined;
test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "begin" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  checkpoint = (await response.json()).id;
});
test.afterEach(async ({ request }) => {
  if (!checkpoint) return;
  const response = await request.post("/api/demo/checkpoint", {
    data: { operation: "restore", id: checkpoint },
    timeout: 150000,
  });
  expect(response.ok(), await response.text()).toBe(true);
  checkpoint = undefined;
});

test("a scheduled asset trades in session, closes for new exposure and settles on its last print after the challenge window", async ({
  request,
  page,
}) => {
  test.setTimeout(300000);
  // Arrange: the nearest SPY put and a later one that outlives the first close.
  const initial = await snapshot(request);
  const binding = initial.manifest.assets?.find((a) => a.key === ASSET);
  const puts = initial.markets
    .filter((m) => m.asset === ASSET && m.active && m.kind === "put")
    .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike);
  test.skip(!binding || !puts.length, "No active scheduled listing");
  const reference = binding!.reference;
  const put = puts.find((m) => m.strike >= reference)!;
  const later = puts.find((m) => m.expiry > put.expiry);
  const lastPrint = put.strike - 10;

  // Act: open the session on a controlled price and let the maker quote.
  const open = await advanced(request, {
    openAsset: ASSET,
    prices: { [ASSET]: reference },
  });
  expect(open.underlyings[ASSET]).toMatchObject({ live: true, open: true });
  const quoted = await request.post("/api/demo/maker-cycle", {
    data: { marketIds: [put.id] },
    timeout: 150000,
  });
  expect(quoted.ok(), await quoted.text()).toBe(true);
  const ask = ((await quoted.json()) as Snapshot).markets.find(
    (m) => m.id === put.id,
  )!.ask;
  expect(ask).not.toBeNull();
  const bought = await act(request, {
    action: "trade",
    marketId: put.id,
    isBuy: true,
    quantity: "1",
    price: (ask! * 1.01).toFixed(6),
  });
  expect(bought.ok(), await bought.text()).toBe(true);

  // An earlier price, then the last print one minute before the close.
  let now = (await snapshot(request)).timestamp;
  await advanced(request, {
    seconds: put.expiry - 600 - now,
    prices: { [ASSET]: lastPrint + 5 },
  });
  now = (await snapshot(request)).timestamp;
  await advanced(request, {
    seconds: put.expiry - 60 - now,
    prices: { [ASSET]: lastPrint },
  });

  // Assert: just after the close the market is shut and still unresolved.
  now = (await snapshot(request)).timestamp;
  const closed = await advanced(request, {
    seconds: put.expiry + CHALLENGE_MARGIN_SECONDS - now,
  });
  expect(closed.underlyings[ASSET]).toMatchObject({ live: false, open: false });
  expect(
    closed.markets.find((m) => m.id === put.id)!.settlementPrice,
  ).toBeNull();
  const offHours = await advance(request, {
    seconds: 1,
    prices: { [ASSET]: lastPrint + 50 },
  });
  expect(offHours.status()).toBe(400);

  // After the challenge window the last print is final and pays the holder.
  const settled = await advanced(request, {
    seconds: binding!.challengeWindow + CHALLENGE_MARGIN_SECONDS,
  });
  expect(settled.markets.find((m) => m.id === put.id)!.settlementPrice).toBe(
    lastPrint,
  );
  // The last print is now older than the live age: no new exposure anywhere on SPY.
  if (later) {
    const write = await act(request, {
      action: "write",
      marketId: later.id,
      quantity: "1",
    });
    expect(write.ok()).toBe(false);
    await page.goto(`/trade?market=${later.id}`);
    await expect(
      page.getByRole("button", { name: "Market closed", exact: true }),
    ).toBeVisible();
  }
  const before = await portfolio(request);
  const redeemed = await act(request, {
    action: "redeem",
    marketId: put.id,
    quantity: "1",
  });
  expect(redeemed.ok(), await redeemed.text()).toBe(true);
  expect((await portfolio(request)).usdc - before.usdc).toBeCloseTo(10, 6);
});
