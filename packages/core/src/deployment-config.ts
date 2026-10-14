import { z } from "zod";
import { getAddress, zeroAddress } from "viem";
import type { Manifest } from "./types.ts";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s));
const contract = address.refine((s) => s !== zeroAddress);
const integer = z.number().int().positive().safe();
function httpUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.hash;
  } catch {
    return false;
  }
}
export function loopbackRpc(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      !!url.port
    );
  } catch {
    return false;
  }
}
export function credentialFreeRpc(value: string) {
  if (!httpUrl(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.search;
}
const feedId = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const browserRpc = z.string().max(2048).refine(credentialFreeRpc);
export const manifestSchema = z
  .object({
    chainId: integer,
    rpcUrl: browserRpc,
    mode: z.enum(["local", "local-fork", "testnet"]),
    venueMode: z.enum(["demo", "kuru"]),
    engine: contract,
    oracle: contract,
    router: contract,
    usdc: contract,
    wmon: contract,
    assetId: feedId,
    deployer: contract,
    maker: contract,
    demoUser: address,
    deployedBlock: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .max(30),
    createdAt: z.iso.datetime(),
    oracleMode: z.enum(["demo", "pyth"]),
    kuruMargin: contract.optional(),
    kuruFactory: contract.optional(),
    house: z
      .object({
        vault: contract,
        strata: contract,
        staking: contract,
        distributor: contract,
        operator: contract,
        launchTime: integer,
        genesisStart: integer,
        deployedBlock: z
          .string()
          .regex(/^(0|[1-9]\d*)$/)
          .max(30),
      })
      .strict()
      .optional(),
    assets: z
      .array(
        z
          .object({
            key: z.string().min(1).max(16),
            name: z.string().min(1).max(80),
            assetClass: z.enum([
              "crypto",
              "equity-etf",
              "equity",
              "metal",
              "fx",
            ]),
            assetId: feedId,
            adapter: contract,
            policy: z.enum([
              "pyth-first-after-expiry",
              "pyth-latest-before-close",
            ]),
            maxLiveAge: integer.min(1).max(86400),
            challengeWindow: z.number().int().nonnegative().max(172800),
            schedule: z.string().min(1).max(2048),
            scheduleSnapshot: z.iso.date(),
            volatility: z.number().min(0.01).max(5),
            reference: z.number().positive().max(1e10),
            deliverable: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(64)
      .optional(),
    series: z
      .array(
        z
          .object({
            id: integer,
            token: contract,
            market: contract,
            venue: contract,
            symbol: z.string().min(1).max(80),
            expiry: integer,
            strike: z.number().positive().max(1e10),
            upperStrike: z.number().nonnegative().max(1e10),
            kind: z.enum(["call", "put", "bull-spread", "bear-spread"]),
            asset: z.string().min(1).max(16),
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      !httpUrl(m.rpcUrl) ||
      (m.mode === "testnet"
        ? m.chainId !== 10143 || new URL(m.rpcUrl).protocol !== "https:"
        : m.chainId !== 31337 || !loopbackRpc(m.rpcUrl))
    )
      ctx.addIssue({
        code: "custom",
        message: "Network mode does not match its chain and browser endpoint",
      });
    if (
      m.house &&
      (m.venueMode !== "kuru" ||
        m.house.genesisStart > m.house.launchTime ||
        m.house.operator.toLowerCase() !== m.maker.toLowerCase())
    )
      ctx.addIssue({
        code: "custom",
        message: "House vault needs Kuru books and the maker as operator",
      });
    if (m.venueMode === "kuru" && (!m.kuruMargin || !m.kuruFactory))
      ctx.addIssue({
        code: "custom",
        message: "Kuru custody and factory are required",
      });
    if (
      new Set(m.series.map((s) => s.id)).size !== m.series.length ||
      new Set(m.series.map((s) => s.token.toLowerCase())).size !==
        m.series.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Series IDs and tokens must be unique",
      });
    if (m.assets) {
      const keys = m.assets.map((a) => a.key);
      const ids = m.assets.map((a) => a.assetId.toLowerCase());
      if (
        new Set(keys).size !== keys.length ||
        new Set(ids).size !== ids.length ||
        !ids.includes(m.assetId.toLowerCase()) ||
        m.series.some((s) => !keys.includes(s.asset))
      )
        ctx.addIssue({
          code: "custom",
          message: "Assets must be unique and cover every series",
        });
      for (const a of m.assets) {
        const cash = m.series.filter((s) => s.asset === a.key);
        if (!a.deliverable && cash.some((s) => s.kind === "call"))
          ctx.addIssue({
            code: "custom",
            message: "Uncapped calls need a deliverable asset",
          });
      }
    }
    for (const s of m.series)
      if (
        ["call", "put"].includes(s.kind)
          ? s.upperStrike !== 0
          : s.upperStrike <= s.strike
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid series payoff terms",
        });
  });
export function parseDeploymentManifest(text: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Deployment manifest is not valid JSON");
  }
  const result = manifestSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "Deployment manifest is invalid. Check documented fields, network mode and credential-free browser RPC.",
    );
  return result.data as Manifest;
}
export function serviceRpcUrl(
  manifest: Pick<Manifest, "rpcUrl">,
  configured?: string,
) {
  const url = configured || manifest.rpcUrl;
  if (!httpUrl(url))
    throw new Error(
      "Service RPC must be an HTTP(S) endpoint without a fragment",
    );
  if (new URL(url).username || new URL(url).password)
    throw new Error(
      "Service RPC user-info authentication is unsupported; use a provider URL credential",
    );
  return url;
}
export function redactDiagnostic(value: unknown, secrets: string[] = []) {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets.filter((s) => s.length >= 4))
    message = message.split(secret).join("[redacted]");
  return message
    .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]")
    .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]");
}
export function localSigningAllowed(
  manifest: Manifest,
  service: string,
  readOnly = "0",
) {
  if (!["0", "1", ""].includes(readOnly))
    throw new Error("API_READ_ONLY must be 0 or 1");
  return (
    readOnly !== "1" &&
    manifest.chainId === 31337 &&
    loopbackRpc(manifest.rpcUrl) &&
    loopbackRpc(service)
  );
}
export function rpcDiagnosticSecrets(endpoint: string) {
  if (!endpoint) return [];
  try {
    const url = new URL(endpoint);
    const segments = url.pathname.split("/").map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    return [
      endpoint,
      ...url.searchParams.values(),
      ...segments.filter((s) => s.length >= 8),
    ];
  } catch {
    return [endpoint];
  }
}
