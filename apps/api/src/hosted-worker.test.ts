import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("services only requested books once across repeated scheduled invocations", async () => {
  vi.stubEnv("STRATA_WORKER_TOKEN", "fixture-only");
  const state = new Map<string, any>([
    [
      "public-manifest",
      {
        series: [
          { id: 48, asset: "MON" },
          { id: 50, asset: "BTC" },
        ],
      },
    ],
    ["trading-wake", { at: Date.now(), marketIds: [48] }],
  ]);
  const refresh = vi.fn(async () => ({ markets: [], service: {} }));
  const relay = vi.fn();
  const maker = vi.fn();
  const maintain = vi.fn();
  vi.doMock("./cloud-store.ts", () => ({
    cloudEnabled: true,
    loadCloudState: async (key: string) => state.get(key),
    claimWorker: async () => true,
    releaseWorker: async () => {},
    saveCloudState: async (key: string, value: unknown) => {
      state.set(key, value);
    },
    requestTradingWake: vi.fn(),
    withReadOnlyState: (fn: () => unknown) => fn(),
  }));
  vi.doMock("./server.ts", () => ({ app: {} }));
  vi.doMock("./runtime.ts", () => ({
    publicWorkers: true,
    manifest: state.get("public-manifest"),
    client: { getBalance: async () => 10n ** 19n },
    serialized: (fn: () => unknown) => fn(),
    reloadCloudReadModel: vi.fn(),
    refresh,
    persistCloudReadModel: vi.fn(),
    current: () => ({ service: {} }),
    workerErrors: [],
    workerSignerStatus: () => [],
    recordWorkerError: vi.fn(),
  }));
  vi.doMock("./pyth-keeper.ts", () => ({
    refreshLivePrices: relay,
    refreshDisplayPrices: vi.fn(),
  }));
  vi.doMock("./maker-worker.ts", () => ({ runMakerCycle: maker }));
  vi.doMock("./idle-maintenance.ts", () => ({ maintainIdleDemo: maintain }));
  const { default: handler } = await import("../../../api/index.ts");
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = {
    url: "/api/worker",
    headers: { authorization: "Bearer fixture-only" },
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  await handler(request, response);
  expect(maker).toHaveBeenCalledExactlyOnceWith({ marketIds: [48] });
  expect(relay.mock.calls).toEqual([[["MON"]], [["MON"]]]);
  // The next cron tick must return to display work, without further relays,
  // maker rotation, House quoting, or expired-maker cleanup transactions.
  await handler(request, response);
  await handler(request, response);
  expect(maker).toHaveBeenCalledTimes(1);
  expect(relay).toHaveBeenCalledTimes(2);
  expect(state.get("trading-consumed-at")).toBe(state.get("trading-wake").at);
});
