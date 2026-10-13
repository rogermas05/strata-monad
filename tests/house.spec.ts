import { test, expect, type APIRequestContext } from "@playwright/test";
import type {
  HouseAccount,
  RewardsAccount,
  Snapshot,
} from "../packages/core/src/index.ts";

const snapshot = async (request: APIRequestContext): Promise<Snapshot> =>
  (await request.get("/api/snapshot")).json();
async function post<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<T> {
  const response = await request.post(path, { data, timeout: 240000 });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const houseCycle = (request: APIRequestContext, marketIds?: number[]) =>
  post<{ hash: string | null; house: Snapshot["house"] }>(
    request,
    "/api/demo/house-cycle",
    marketIds ? { marketIds } : {},
  );
const account = async (request: APIRequestContext, user: string) =>
  (await request.get(`/api/house/${user}`)).json() as Promise<HouseAccount>;
const rewards = async (request: APIRequestContext, user: string) =>
  (await request.get(`/api/rewards/${user}`)).json() as Promise<RewardsAccount>;
const vaultOrders = (state: Snapshot, id: number) =>
  state.markets
    .find((m) => m.id === id)!
    .orders.filter(
      (o) => o.owner.toLowerCase() === state.house!.address.toLowerCase(),
    );

let checkpoint: string | undefined;
test.beforeEach(async ({ request }) => {
  const health = await request.get("/api/health");
  expect((await health.json()).chainId).toBe(31337);
  const state = await snapshot(request);
  test.skip(!state.house, "Deployment has no house vault");
  checkpoint = (
    await post<{ id: string }>(request, "/api/demo/checkpoint", {
      operation: "begin",
    })
  ).id;
});
test.afterEach(async ({ request }) => {
  if (!checkpoint) return;
  await post(request, "/api/demo/checkpoint", {
    operation: "restore",
    id: checkpoint,
  });
  checkpoint = undefined;
});

test("genesis deposit launches the vault, quotes, settles and pays out points as staked STRATA", async ({
  request,
  page,
}) => {
  test.setTimeout(600000);
  const initial = await snapshot(request);
  const user = initial.manifest.demoUser;
  expect(initial.house!.epoch).toBe(0);

  // Genesis: deposit through the UI and see the live counter move.
  await page.goto("/house");
  await expect(page.getByText("Genesis pre-deposits are open")).toBeVisible();
  await page.getByLabel("Deposit amount").fill("5000");
  await page.getByRole("button", { name: "Deposit to the house" }).click();
  await expect(page.getByText("Transaction included")).toBeVisible({
    timeout: 60000,
  });
  await expect
    .poll(async () => (await account(request, user)).pendingDeposit)
    .toBe(5000);

  // Launch: the first roll prices genesis deposits at 1.0 and admits the nearest week.
  const launch = initial.house!.launchTime - initial.timestamp + 1;
  await post(request, "/api/demo/advance", { seconds: Math.max(1, launch) });
  const launched = (await houseCycle(request)).house!;
  expect(launched.epoch).toBe(1);
  expect(launched.series.length).toBeGreaterThan(0);
  expect(launched.history[0].pricePerShare).toBe(1);
  expect((await account(request, user)).shares).toBe(5000);

  // Quote one admitted, currently open book from vault capital.
  const live = (await snapshot(request)).markets.find(
    (m) => launched.series.includes(m.id) && m.healthy && m.kind === "put",
  )!;
  expect(live).toBeDefined();
  await houseCycle(request, [live.id]);
  const quoted = await snapshot(request);
  const asks = vaultOrders(quoted, live.id).filter((o) => !o.isBuy);
  expect(asks.length).toBeGreaterThan(0);
  // Unsold inventory offsets its own obligation: no net short yet.
  expect(quoted.house!.maxLoss).toBe(0);

  // Remove project quotes so the fill can only come from the house.
  await post(request, "/api/demo/maker-halt", {});
  // Buy from the house at its own best ask.
  const best = Math.min(...asks.map((o) => o.price));
  await post(request, "/api/actions", {
    action: "trade",
    marketId: live.id,
    isBuy: true,
    quantity: "0.5",
    price: (best * 0.5 * 1.05).toFixed(6),
  });
  // The sold claims are now a funded net short, bounded by the strike.
  const sold = (await snapshot(request)).house!;
  expect(sold.maxLoss).toBeCloseTo(0.5 * live.strike, 4);

  // Expire the whole epoch, settle every reference, then roll.
  const last = Math.max(
    ...quoted.markets
      .filter((m) => launched.series.includes(m.id))
      .map((m) => m.expiry),
  );
  await post(request, "/api/demo/advance", {
    seconds: last - quoted.timestamp + 3600,
  });
  const rolled = (await houseCycle(request)).house!;
  expect(rolled.epoch).toBe(2);
  expect(rolled.history.at(-1)!.epoch).toBe(1);
  expect(rolled.rootEpoch).toBe(2);
  // Every epoch-1 position settled to cash before pricing.
  expect(rolled.reservedWithdrawals).toBe(0);

  // Points: genesis, one epoch of deposits, and possibly the losing ticket.
  const earned = await rewards(request, user);
  expect(earned.points.genesis).toBeGreaterThan(0);
  expect(earned.points.deposits).toBeGreaterThan(0);
  expect(earned.claim).not.toBeNull();
  expect(earned.claimable).toBeCloseTo(earned.points.total, 4);

  await page.goto("/rewards");
  await page.getByRole("button", { name: /Claim & stake/ }).click();
  await expect(page.getByText("Transaction included")).toBeVisible({
    timeout: 60000,
  });
  await expect
    .poll(async () => (await rewards(request, user)).staked)
    .toBeCloseTo(earned.claimable, 4);

  // Withdrawals queue for the next roll.
  await post(request, "/api/actions", {
    action: "house-request-withdraw",
    amount: "1000",
  });
  const queued = await account(request, user);
  expect(queued.withdrawal.shares).toBe(1000);
  expect(queued.withdrawal.ready).toBe(false);
});

test("house pages render vault state and rules", async ({ page }) => {
  await page.goto("/house");
  await expect(
    page.getByRole("heading", { name: "House vault" }),
  ).toBeVisible();
  await expect(page.getByText("How the house works")).toBeVisible();
  await page.getByRole("link", { name: "Rewards" }).click();
  await expect(
    page.getByRole("heading", { name: "Points & STRATA" }),
  ).toBeVisible();
  await expect(page.getByText("Trade against the house")).toBeVisible();
});
