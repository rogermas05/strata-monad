import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
} from "viem";
import { artifact, exportAbis } from "./artifacts.ts";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import type { Manifest } from "../packages/core/src/index.ts";
const m = JSON.parse(
  readFileSync(".runtime/manifest.json", "utf8"),
) as Manifest;
const chain = defineChain({
  id: 31337,
  name: "Local fork",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [m.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(m.rpcUrl) });
if (
  m.chainId !== 31337 ||
  (await client.getChainId()) !== 31337 ||
  m.venueMode !== "kuru"
)
  throw new Error("This migration is restricted to local Kuru forks");
const wallet = createWalletClient({
  account: m.deployer,
  chain,
  transport: http(m.rpcUrl),
});
async function deploy(name: string, args: unknown[]): Promise<Address> {
  const r = await waitReceipt(
    client,
    await wallet.deployContract({ ...artifact(name), args, gas: 14000000n }),
  );
  if (r.status !== "success" || !r.contractAddress)
    throw new Error("Deployment failed");
  return r.contractAddress;
}
m.router = await deploy("StrategyRouter", [m.engine]);
for (const s of m.series) {
  s.venue = await deploy("KuruExactAdapter", [
    s.market,
    m.kuruMargin,
    s.expiry,
  ]);
  const r = await waitReceipt(
    client,
    await wallet.writeContract({
      address: m.router,
      abi: artifact("StrategyRouter").abi,
      functionName: "register",
      args: [BigInt(s.id), s.venue],
      gas: 2000000n,
    }),
  );
  if (r.status !== "success") throw new Error("Registration failed");
}
writeFileSync(".runtime/manifest.json", JSON.stringify(m, null, 2));
exportAbis();
console.log(
  "Local router and exact-fill adapters replaced. Restart the API to load the manifest. Series escrow and order books are preserved.",
);
