import { describe, expect, it } from "vitest";
import {
  parseDeploymentManifest,
  serviceRpcUrl,
  redactDiagnostic,
  rpcDiagnosticSecrets,
  localSigningAllowed,
} from "./deployment-config.ts";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const local = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8546",
  mode: "local-fork",
  venueMode: "kuru",
  engine: address(1),
  oracle: address(2),
  router: address(3),
  usdc: address(4),
  wmon: address(5),
  assetId: `0x${"aa".repeat(32)}`,
  deployer: address(6),
  maker: address(7),
  demoUser: address(8),
  deployedBlock: "1",
  createdAt: "2026-10-12T00:00:00.000Z",
  oracleMode: "demo",
  kuruMargin: address(9),
  kuruFactory: address(10),
  series: [
    {
      id: 1,
      token: address(11),
      market: address(12),
      venue: address(13),
      symbol: "MON-C",
      expiry: 1792000000,
      strike: 1,
      upperStrike: 0,
      kind: "call",
      asset: "MON",
    },
  ],
};
describe("deployment configuration boundary", () => {
  it("keeps observer services and public endpoints unable to sign unlocked transactions", () => {
    const manifest = parseDeploymentManifest(JSON.stringify(local));
    expect(localSigningAllowed(manifest, local.rpcUrl)).toBe(true);
    expect(localSigningAllowed(manifest, local.rpcUrl, "1")).toBe(false);
    expect(
      localSigningAllowed(
        manifest,
        "https://provider.invalid/private-unit-key",
      ),
    ).toBe(false);
    expect(() => localSigningAllowed(manifest, local.rpcUrl, "true")).toThrow(
      "0 or 1",
    );
  });
  it("keeps the authenticated service endpoint out of the public manifest", () => {
    const manifest = parseDeploymentManifest(JSON.stringify(local));
    const privateUrl =
      "https://provider.invalid/private-unit-key?token=unit-test-token";
    expect(serviceRpcUrl(manifest, privateUrl)).toBe(privateUrl);
    expect(manifest.rpcUrl).toBe(local.rpcUrl);
    expect(JSON.stringify(manifest)).not.toContain("unit-key");
    for (const rpcUrl of [
      privateUrl,
      "https://user:password@provider.invalid",
      "file:///private",
      "invalid-url",
      "https://provider.invalid/#key",
    ]) {
      expect(() =>
        parseDeploymentManifest(JSON.stringify({ ...local, rpcUrl })),
      ).toThrow("manifest is invalid");
    }
    expect(() =>
      parseDeploymentManifest(
        JSON.stringify({ ...local, privateKey: "unit-private-key" }),
      ),
    ).toThrow("manifest is invalid");
  });
  it("enforces network mode, unique series and bounded payoff terms", () => {
    for (const changed of [
      { chainId: 143 },
      { mode: "testnet" },
      { kuruMargin: undefined },
      { series: [local.series[0], local.series[0]] },
      { series: [{ ...local.series[0], upperStrike: 2 }] },
    ])
      expect(() =>
        parseDeploymentManifest(JSON.stringify({ ...local, ...changed })),
      ).toThrow();
    expect(
      parseDeploymentManifest(
        JSON.stringify({
          ...local,
          chainId: 10143,
          mode: "testnet",
          rpcUrl: "https://testnet-rpc.monad.xyz",
        }),
      ).chainId,
    ).toBe(10143);
  });
  it("accepts per-asset oracle bindings and rejects series outside them", () => {
    const binding = {
      key: "MON",
      name: "Monad",
      assetClass: "crypto",
      assetId: local.assetId,
      adapter: address(14),
      policy: "pyth-first-after-expiry",
      maxLiveAge: 3600,
      challengeWindow: 0,
      schedule: "America/New_York;O,O,O,O,O,O,O;",
      scheduleSnapshot: "2026-10-12",
      volatility: 0.85,
      reference: 1.03,
      deliverable: true,
    };
    const spy = {
      ...binding,
      key: "SPY",
      name: "SPDR S&P 500 ETF",
      assetClass: "equity-etf",
      assetId: `0x${"bb".repeat(32)}`,
      policy: "pyth-latest-before-close",
      maxLiveAge: 120,
      challengeWindow: 7200,
      deliverable: false,
    };
    const put = {
      ...local.series[0],
      id: 2,
      token: address(15),
      symbol: "SPY-P",
      strike: 650,
      kind: "put",
      asset: "SPY",
    };
    const parse = (changed: object) =>
      parseDeploymentManifest(JSON.stringify({ ...local, ...changed }));

    const parsed = parse({
      assets: [binding, spy],
      series: [local.series[0], put],
    });

    expect(parsed.assets?.map((a) => a.key)).toEqual(["MON", "SPY"]);
    for (const changed of [
      { assets: [binding], series: [local.series[0], put] },
      { assets: [binding, { ...spy, key: "MON" }] },
      { assets: [binding, { ...spy, assetId: local.assetId }] },
      { assets: [spy], series: [put] },
      { assets: [binding, { ...spy, maxLiveAge: 0 }] },
      {
        assets: [binding, spy],
        series: [local.series[0], { ...put, kind: "call" }],
      },
    ])
      expect(() => parse(changed)).toThrow();
  });
  it("redacts known provider credentials and transport URLs without exposing invalid JSON contents", () => {
    const endpoint =
      "https://provider.invalid/private-unit-key?token=unit-test-token";
    const text = redactDiagnostic(
      `Request to ${endpoint} failed. private-unit-key unit-test-token Bearer another-secret`,
      rpcDiagnosticSecrets(endpoint),
    );
    expect(text).not.toContain("private-unit-key");
    expect(text).not.toContain("unit-test-token");
    expect(text).not.toContain("another-secret");
    expect(() => parseDeploymentManifest("{unit-private-key")).toThrow(
      "not valid JSON",
    );
    expect(() =>
      serviceRpcUrl(
        parseDeploymentManifest(JSON.stringify(local)),
        "ws://private.invalid",
      ),
    ).toThrow("HTTP(S)");
  });
});
