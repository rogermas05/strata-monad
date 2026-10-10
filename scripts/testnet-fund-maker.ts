import "dotenv/config";
import {
  createPublicClient,
  defineChain,
  http,
  parseEther,
  type Address,
} from "viem";
import { configuredSigner } from "./lib/public-signer.ts";
const endpoint = "https://testnet-rpc.monad.xyz";
const chain = defineChain({
  id: 10143,
  name: "Monad testnet",
  nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [endpoint] } },
});
const client = createPublicClient({
  chain,
  transport: http(endpoint, { timeout: 15000, retryCount: 0 }),
  pollingInterval: 500,
});
async function main() {
  const maker = process.env.STRATA_MAKER_ADDRESS as Address;
  const deployer = process.env.STRATA_DEPLOYER_ADDRESS as Address;
  if ((await client.getBalance({ address: maker })) >= parseEther("1")) {
    console.log("Maker already funded");
    return;
  }
  if ((await client.getBalance({ address: deployer })) < parseEther("1.52"))
    throw new Error(
      "Deployer cannot fund the maker while retaining a keeper gas reserve",
    );
  const signer = configuredSigner(
    "deployer",
    client,
    chain,
    endpoint,
    ".runtime/testnet/signers",
    async (intent) => {
      if (
        intent.to?.toLowerCase() !== maker.toLowerCase() ||
        intent.data !== "0x" ||
        intent.value !== parseEther("1")
      )
        throw new Error("Only the exact maker funding transfer is authorized");
    },
  );
  try {
    console.log(
      JSON.stringify({
        maker,
        hash: await signer.send({
          id: "testnet-maker-funding-v2",
          to: maker,
          data: "0x",
          value: parseEther("1"),
        }),
      }),
    );
  } finally {
    signer.close();
  }
}
main().catch(() => {
  console.error("Maker funding failed; no credentials printed");
  process.exitCode = 1;
});
