import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("./neon-store.ts");
});

it("keeps Neon as the sole signing authority when it is configured, including on failure", async () => {
  vi.stubEnv("STRATA_STATE_DATABASE_URL", "postgresql://test-only.invalid/db");
  vi.stubEnv("STRATA_SUPABASE_URL", "https://legacy.example");
  vi.stubEnv("STRATA_SUPABASE_SERVICE_KEY", "test-only");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.doMock("./neon-store.ts", () => ({
    requestNeon: vi.fn().mockRejectedValue(new Error("Neon unavailable")),
  }));
  const { cloudRequest } = await import("./cloud-store.ts");
  await expect(
    cloudRequest("rpc/strata_claim_worker", "POST", {}),
  ).rejects.toThrow("Neon unavailable");
  expect(fetch).not.toHaveBeenCalled();
});

it("only downloads changed large state and never reuses a deleted or superseded snapshot", async () => {
  vi.stubEnv("STRATA_SUPABASE_URL", "https://state.example");
  vi.stubEnv("STRATA_SUPABASE_SERVICE_KEY", "test-only");
  let timestamp = "2026-10-14T00:00:00Z";
  let value = { block: 1, service: { newExposureAllowed: true } };
  let exists = true;
  let fullReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const full = new URL(url).searchParams.get("select")?.includes("value");
      if (full) fullReads++;
      return new Response(
        JSON.stringify(
          !exists
            ? []
            : [{ updated_at: timestamp, ...(full ? { value } : {}) }],
        ),
      );
    }),
  );
  const { loadCloudState } = await import("./cloud-store.ts");
  expect(await loadCloudState("public-snapshot")).toEqual(value);
  expect(await loadCloudState("public-snapshot")).toEqual(value);
  expect(fullReads).toBe(1);
  timestamp = "2026-10-14T00:00:05Z";
  value = { block: 2, service: { newExposureAllowed: false } };
  expect(await loadCloudState("public-snapshot")).toEqual(value);
  expect(fullReads).toBe(2);
  exists = false;
  expect(await loadCloudState("public-snapshot")).toBeUndefined();
});
