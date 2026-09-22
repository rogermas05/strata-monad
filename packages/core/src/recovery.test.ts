import { expect, it } from "vitest";
import { padHex, toHex, verifyTypedData, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  parseRecovery,
  recoveryTypedData,
  checkRecovery,
  attachSignature,
  type RecoveryPacket,
} from "./recovery.ts";
import type { Manifest } from "./types.ts";

// Synthetic test keys; no user accounts or secrets are used.
const writer = privateKeyToAccount(padHex(toHex(1), { size: 32 }));
const holder = privateKeyToAccount(padHex(toHex(2), { size: 32 }));
const relay = privateKeyToAccount(padHex(toHex(3), { size: 32 }));
const manifest = {
  chainId: 31337,
  engine: writer.address,
  oracle: relay.address,
  assetId: padHex("0x01", { size: 32 }),
  series: [{ id: 1, token: holder.address, expiry: 1000 }],
} as Manifest;
function packet(type: "claim" | "unwind" = "claim"): RecoveryPacket {
  const terms = {
    seriesId: "1",
    holder: holder.address,
    quantity: "1000000000000000000",
    deadline: "1200",
  };
  return parseRecovery(
    {
      version: 1,
      chainId: manifest.chainId,
      engine: manifest.engine,
      type,
      terms:
        type === "claim"
          ? { ...terms, nonce: "0" }
          : {
              ...terms,
              writer: writer.address,
              payment: "250000",
              writerNonce: "0",
              holderNonce: "0",
            },
    },
    manifest,
  );
}
function rpc({
  settlement = 100000000n,
  nonce = 0n,
  quantity = 2n * 10n ** 18n,
} = {}) {
  return {
    getBlock: async () => ({ timestamp: 1100n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "nonces") return nonce;
      if (functionName === "balanceOf") return quantity;
      if (functionName === "settlementPrice") return settlement;
      if (functionName === "writers") return [quantity, 2000000n];
      if (functionName === "previewPayout") return 500000n;
      if (functionName === "requiredCollateral") return 1000000n;
      throw new Error("Unexpected contract read");
    },
    verifyTypedData,
  } as unknown as Pick<
    PublicClient,
    "getBlock" | "readContract" | "verifyTypedData"
  >;
}
async function sign(p: RecoveryPacket, account: typeof writer) {
  const data = recoveryTypedData(p);
  const signature =
    data.primaryType === "Claim"
      ? await account.signTypedData(data)
      : await account.signTypedData(data);
  return attachSignature(p, account.address, signature);
}
it("rejects other domains, unknown series, noncanonical numbers and self-unwinds", () => {
  const p = packet();
  expect(() => parseRecovery({ ...p, chainId: 1 }, manifest)).toThrow(
    "different chain",
  );
  expect(() =>
    parseRecovery({ ...p, engine: relay.address }, manifest),
  ).toThrow("different chain");
  expect(() =>
    parseRecovery({ ...p, terms: { ...p.terms, seriesId: "2" } }, manifest),
  ).toThrow("Unknown");
  for (const quantity of ["0", "-1", "01", (2n ** 256n).toString()])
    expect(() =>
      parseRecovery({ ...p, terms: { ...p.terms, quantity } }, manifest),
    ).toThrow();
  const u = packet("unwind");
  expect(() =>
    parseRecovery(
      { ...u, terms: { ...u.terms, writer: holder.address } },
      manifest,
    ),
  ).toThrow("must differ");
});
it("binds the holder, quantity and nonce while letting a different account submit", async () => {
  const p = await sign(packet(), holder);
  if (p.type !== "claim") throw new Error("Wrong fixture");
  await checkRecovery(rpc(), p, manifest, true);
  await expect(
    checkRecovery(
      rpc(),
      { ...p, terms: { ...p.terms, quantity: "2000000000000000000" } },
      manifest,
      true,
    ),
  ).rejects.toThrow("Signature");
  await expect(
    checkRecovery(rpc({ nonce: 1n }), p, manifest, true),
  ).rejects.toThrow("nonce changed");
  expect(() => attachSignature(p, relay.address, "0x12")).toThrow(
    "not a party",
  );
});
it("requires both participants to sign identical unwind terms", async () => {
  const partial = await sign(packet("unwind"), writer);
  await expect(
    checkRecovery(rpc({ settlement: 0n }), partial, manifest, true),
  ).rejects.toThrow("Every required signature");
  const complete = await sign(partial, holder);
  await checkRecovery(rpc({ settlement: 0n }), complete, manifest, true);
  if (complete.type !== "unwind") throw new Error("Wrong fixture");
  await expect(
    checkRecovery(
      rpc({ settlement: 0n }),
      { ...complete, terms: { ...complete.terms, payment: "500000" } },
      manifest,
      true,
    ),
  ).rejects.toThrow("Signature");
  await expect(checkRecovery(rpc(), complete, manifest, true)).rejects.toThrow(
    "Reference is finalized",
  );
});
it("rejects unavailable claims, missing wallet inventory and expired authorizations", async () => {
  const p = packet();
  if (p.type !== "claim") throw new Error("Wrong fixture");
  await expect(
    checkRecovery(rpc({ settlement: 0n }), p, manifest),
  ).rejects.toThrow("not been finalized");
  await expect(
    checkRecovery(rpc({ quantity: 0n }), p, manifest),
  ).rejects.toThrow("withdraw enough claims");
  await expect(
    checkRecovery(
      rpc(),
      { ...p, terms: { ...p.terms, deadline: "1099" } },
      manifest,
    ),
  ).rejects.toThrow("expired");
});
