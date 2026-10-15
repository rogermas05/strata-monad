import { expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain, keccak256, type PublicClient, type Hex } from "viem";
import {
  ManagedSigner,
  type SignerJob,
} from "../../../scripts/lib/managed-signer.ts";
const account = privateKeyToAccount(("0x" + "1".padStart(64, "0")) as Hex);
const hash = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const chain = defineChain({
  id: 31337,
  name: "Synthetic signer fixture",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "strata-signer-"));
  const state = {
    nonce: 0,
    pending: 0,
    chain: 31337,
    fee: 2n,
    balance: 1000000n,
    ambiguous: false,
    blockHash: hash(1),
    raws: [] as Hex[],
    known: new Set<Hex>(),
    authorizations: 0,
  };
  const client = {
    getChainId: async () => state.chain,
    getTransactionCount: async ({ blockTag }: any) =>
      blockTag === "pending" ? state.pending : state.nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: state.fee,
      maxPriorityFeePerGas: 1n,
    }),
    getBalance: async () => state.balance,
    estimateGas: async () => 21000n,
    getBlock: async () => ({ hash: state.blockHash }),
    getTransaction: async ({ hash }: any) => {
      if (!state.known.has(hash))
        throw Object.assign(new Error("Missing synthetic transaction"), {
          name: "TransactionNotFoundError",
        });
      return { hash };
    },
    sendRawTransaction: async ({ serializedTransaction }: any) => {
      state.raws.push(serializedTransaction);
      const txHash = keccak256(serializedTransaction);
      state.known.add(txHash);
      state.nonce++;
      state.pending = state.nonce;
      if (state.ambiguous) {
        state.ambiguous = false;
        throw new Error("Ambiguous response dummy_provider_secret");
      }
      return txHash;
    },
    getTransactionReceipt: async ({ hash: txHash }: any) => ({
      transactionHash: txHash,
      status: "success",
      blockNumber: 10n,
      blockHash: hash(1),
    }),
  } as unknown as PublicClient;
  const options = {
    directory,
    client,
    chain,
    endpoint: "http://127.0.0.1:1",
    account,
    expectedAddress: account.address,
    maxGas: 100000n,
    maxFeePerGas: 10n,
    maxNativeValue: 0n,
    maxTransactionCost: 100000n,
    receiptTimeout: 1000,
    secrets: ["dummy_provider_secret"],
    authorize: async () => {
      state.authorizations++;
    },
  };
  let signer = new ManagedSigner(options);
  const intent = { id: "fixture:one", to: account.address, data: "0x" as Hex };
  return {
    directory,
    state,
    options,
    intent,
    get signer() {
      return signer;
    },
    restart() {
      signer.close();
      signer = new ManagedSigner(options);
    },
    cleanup() {
      signer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
it("rejects cumulative spending before journaling or broadcasting and rechecks recovered broadcasts", async () => {
  const f = fixture();
  let blocked = true;
  let reservations = 0;
  const signer = new ManagedSigner({
    ...f.options,
    reserveCost: async (_id, cost) => {
      reservations++;
      expect(cost).toBeGreaterThan(0n);
      if (blocked) throw new Error("Daily gas budget reached");
    },
  });
  try {
    await expect(signer.send(f.intent)).rejects.toThrow("budget");
    expect(f.state.raws).toHaveLength(0);
    blocked = false;
    await signer.send({ ...f.intent, id: "new-request" });
    expect(f.state.raws).toHaveLength(1);
    expect(reservations).toBe(3); // rejected, preparation, immediate pre-broadcast
  } finally {
    signer.close();
    f.cleanup();
  }
});

it("persists the signed envelope in cloud storage before broadcast and recovers on a fresh machine", async () => {
  const f = fixture();
  const jobs = new Map<string, SignerJob>();
  const secondDirectory = mkdtempSync(join(tmpdir(), "strata-cloud-signer-"));
  let rejectSave = true;
  const journal = {
    load: async () => [...jobs.values()].map((j) => ({ ...j })),
    save: async (job: SignerJob) => {
      if (rejectSave) throw new Error("Cloud unavailable");
      if (job.status === "prepared") expect(f.state.raws).toHaveLength(0);
      jobs.set(job.id, { ...job });
    },
  };
  const first = new ManagedSigner({ ...f.options, journal });
  let second: ManagedSigner | undefined;
  try {
    await expect(first.send(f.intent)).rejects.toThrow("Cloud unavailable");
    expect(f.state.raws).toHaveLength(0);
    rejectSave = false;
    f.state.ambiguous = true;
    await expect(first.send(f.intent)).rejects.toThrow("Ambiguous");
    expect(jobs.get(f.intent.id)?.status).toBe("submitted");
    second = new ManagedSigner({
      ...f.options,
      directory: secondDirectory,
      journal,
    });
    const recovered = await second.send(f.intent);
    expect(recovered).toBe(jobs.get(f.intent.id)?.hash);
    expect(jobs.get(f.intent.id)?.status).toBe("included");
    expect(f.state.raws).toHaveLength(1);
    f.state.blockHash = hash(2);
    await expect(
      second.send({ ...f.intent, id: "new-cloud-job" }),
    ).rejects.toThrow("reorganized");
  } finally {
    first.close();
    second?.close();
    f.cleanup();
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});
it("journals a real local signature, resolves ambiguous RPC inclusion and remains idempotent across restart with synthetic RPC", async () => {
  const f = fixture();
  try {
    f.state.ambiguous = true;
    let observed: Hex | undefined;
    try {
      await f.signer.send(f.intent);
    } catch (e) {
      observed = (e as any).transactionHash;
      expect((e as Error).message).not.toContain("dummy_provider_secret");
    }
    expect(observed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await f.signer.send(f.intent)).toBe(observed);
    f.restart();
    expect(await f.signer.send(f.intent)).toBe(observed);
    expect(f.state.raws).toHaveLength(1);
    expect(f.state.nonce).toBe(1);
    const dbPath = join(
      f.directory,
      "31337",
      account.address.toLowerCase(),
      "transactions.sqlite",
    );
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  } finally {
    f.cleanup();
  }
});
it("recovers an earlier pending operation and requires a fresh state decision before another signature", async () => {
  const f = fixture();
  try {
    f.state.ambiguous = true;
    await expect(f.signer.send(f.intent)).rejects.toThrow("Ambiguous");
    await expect(
      f.signer.send({ ...f.intent, id: "fixture:two" }),
    ).rejects.toThrow("Refresh chain state");
    expect(f.state.raws).toHaveLength(1);
    await f.signer.send({ ...f.intent, id: "fixture:two" });
    expect(f.state.raws).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});
it("rejects changed intents, wrong chains, pending nonces, cost excess and insufficient balances before broadcast", async () => {
  const f = fixture();
  try {
    await f.signer.send(f.intent);
    await expect(f.signer.send({ ...f.intent, data: "0x01" })).rejects.toThrow(
      "reused",
    );
    const next = { ...f.intent, id: "fixture:next" };
    f.state.chain = 10143;
    await expect(f.signer.send(next)).rejects.toThrow("chain mismatch");
    f.state.chain = 31337;
    f.state.pending++;
    await expect(f.signer.send(next)).rejects.toThrow("pending activity");
    f.state.pending--;
    f.state.fee = 100n;
    await expect(f.signer.send(next)).rejects.toThrow("fee exceeds");
    f.state.fee = 2n;
    f.state.balance = 1n;
    await expect(f.signer.send(next)).rejects.toThrow("insufficient");
    expect(f.state.raws).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it("stops for a reorganized journal anchor and rejects altered signed bytes", async () => {
  const f = fixture();
  try {
    await f.signer.send(f.intent);
    f.state.blockHash = hash(2);
    await expect(
      f.signer.send({ ...f.intent, id: "fixture:next" }),
    ).rejects.toThrow("reorganized");
    f.state.blockHash = hash(1);
    const db = new DatabaseSync(
      join(
        f.directory,
        "31337",
        account.address.toLowerCase(),
        "transactions.sqlite",
      ),
    );
    db.prepare("UPDATE jobs SET raw='0x02ff' WHERE id=?").run(f.intent.id);
    db.close();
    await expect(f.signer.send(f.intent)).rejects.toThrow("hash mismatch");
    expect(f.state.raws).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it("fails closed for a role mismatch, active process lock and authorization rejection", async () => {
  const f = fixture();
  try {
    expect(
      () =>
        new ManagedSigner({
          ...f.options,
          expectedAddress: ("0x" + "2".repeat(40)) as any,
        }),
    ).toThrow("role address");
    const lock = join(
      f.directory,
      "31337",
      account.address.toLowerCase(),
      "sender.lock",
    );
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    await expect(f.signer.send(f.intent)).rejects.toThrow("holds this sender");
    rmSync(lock);
    f.options.authorize = async () => {
      throw new Error("Role policy rejected this target");
    };
    await expect(f.signer.send(f.intent)).rejects.toThrow(
      "Role policy rejected",
    );
    expect(f.state.raws).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
