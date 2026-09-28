/**
 * Isolated live-node rehearsal for the managed signer.
 *
 * Starts a private Anvil node on its own port (never the terminal's fork),
 * signs with Anvil's publicly documented test keys only, and exercises real
 * signed creation and calls, ambiguous RPC failures after inclusion, restart
 * recovery by exact hash, changed-intent rejection, journal tampering and a
 * reorganized journal anchor. Evidence is written under .runtime/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createPublicClient,
  http,
  keccak256,
  pad,
  toHex,
  toFunctionSelector,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ManagedSigner } from "./lib/managed-signer.ts";
import { policyAuthorizer } from "./lib/signer-policy.ts";

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's default, publicly documented development keys (accounts 1–4).
const TEST_KEYS: Hex[] = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];
// Minimal contract: runtime stores the first argument word into slot 0.
const INIT_CODE: Hex = "0x6007600c60003960076000f360043560005500";
const STORE = toFunctionSelector("store(uint256)");

const root = resolve(".runtime/signer-rehearsals", String(Date.now()));
const evidence: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string) {
  evidence.push({ step, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${step}: ${detail}\n`);
  if (!ok) throw new Error(`${step} failed: ${detail}`);
}

async function expectError(
  step: string,
  run: () => Promise<unknown>,
  match: string,
) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return record(step, message.includes(match), message.slice(0, 160));
  }
  record(step, false, "operation unexpectedly succeeded");
}

async function startNode(): Promise<ChildProcess> {
  const node = spawn(
    "anvil",
    ["--port", String(PORT), "--chain-id", "31337", "--silent"],
    { stdio: "ignore" },
  );
  const client = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      return node;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  node.kill();
  throw new Error(`Anvil did not start on port ${PORT}`);
}

const word = (n: number) => `${STORE}${pad(toHex(n)).slice(2)}` as Hex;

function signerFor(
  key: Hex,
  client: PublicClient,
  directory: string,
  target?: `0x${string}`,
) {
  const account = privateKeyToAccount(key);
  return new ManagedSigner({
    client,
    chain: foundry,
    endpoint: RPC,
    account,
    expectedAddress: account.address,
    directory,
    maxGas: 1_000_000n,
    maxFeePerGas: 100_000_000_000n,
    maxNativeValue: 0n,
    maxTransactionCost: 10n ** 17n,
    receiptTimeout: 15_000,
    authorize: policyAuthorizer({
      role: "rehearsal",
      calls: target ? [{ target, selectors: [STORE] }] : [],
      creations: [keccak256(INIT_CODE)],
    }),
  });
}

/** Wraps a client so raw broadcasts fail before or after reaching the node. */
function flakyClient(base: PublicClient, mode: "after" | "before") {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "sendRawTransaction")
        return async (
          args: Parameters<PublicClient["sendRawTransaction"]>[0],
        ) => {
          if (mode === "after") await target.sendRawTransaction(args);
          throw new Error("socket hang up (simulated ambiguous RPC response)");
        };
      return Reflect.get(target, prop, receiver);
    },
  }) as PublicClient;
}

async function main() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const node = await startNode();
  const client = createPublicClient({ chain: foundry, transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method, params } as never) as Promise<unknown>;
  try {
    // A. Real signed creation through the policy-gated signer.
    const journalA = resolve(root, "journal-a");
    const keyA = TEST_KEYS[0];
    const addressA = privateKeyToAccount(keyA).address;
    let signer = signerFor(keyA, client, journalA);
    const createHash = await signer.send({
      id: "create-store",
      data: INIT_CODE,
    });
    const created = await client.getTransactionReceipt({ hash: createHash });
    const contract = created.contractAddress!;
    record(
      "signed creation",
      !!contract &&
        (await client.getCode({ address: contract })) === "0x60043560005500",
      `${contract} via ${createHash}`,
    );
    signer.close();

    // B. Real signed call, restricted to an exact target/selector.
    signer = signerFor(keyA, client, journalA, contract);
    const setOne = await signer.send({
      id: "store-1",
      to: contract,
      data: word(1),
    });
    record(
      "signed policy call",
      BigInt(
        (await client.getStorageAt({ address: contract, slot: "0x0" })) ?? 0,
      ) === 1n,
      setOne,
    );

    // C. Replaying the same intent returns the journaled hash without a new transaction.
    const nonceBefore = await client.getTransactionCount({ address: addressA });
    const replay = await signer.send({
      id: "store-1",
      to: contract,
      data: word(1),
    });
    record(
      "idempotent replay",
      replay === setOne &&
        (await client.getTransactionCount({ address: addressA })) ===
          nonceBefore,
      `same hash ${replay}, nonce unchanged at ${nonceBefore}`,
    );

    // D. Reusing an ID with different calldata is refused.
    await expectError(
      "changed intent rejection",
      () => signer.send({ id: "store-1", to: contract, data: word(9) }),
      "reused with different transaction data",
    );

    // E. Policy refuses calls outside the role.
    await expectError(
      "policy refusal",
      () => signer.send({ id: "rogue", to: addressA, data: word(1) }),
      "not authorized to call",
    );
    signer.close();

    // F. RPC fails after real inclusion; a restarted signer recovers the exact hash.
    signer = signerFor(keyA, flakyClient(client, "after"), journalA, contract);
    let ambiguousHash: Hex | undefined;
    try {
      await signer.send({ id: "store-2", to: contract, data: word(2) });
    } catch (error) {
      ambiguousHash = (error as { transactionHash?: Hex }).transactionHash;
    }
    signer.close();
    const included = ambiguousHash
      ? await client.getTransactionReceipt({ hash: ambiguousHash })
      : undefined;
    record(
      "ambiguous failure retains hash",
      !!ambiguousHash && included?.status === "success",
      `error carried ${ambiguousHash}; receipt ${included?.status}`,
    );
    const nonceAfterAmbiguous = await client.getTransactionCount({
      address: addressA,
    });
    signer = signerFor(keyA, client, journalA, contract);
    const recovered = await signer.send({
      id: "store-2",
      to: contract,
      data: word(2),
    });
    record(
      "restart recovers exact hash",
      recovered === ambiguousHash &&
        (await client.getTransactionCount({ address: addressA })) ===
          nonceAfterAmbiguous,
      `no duplicate broadcast; nonce stays ${nonceAfterAmbiguous}`,
    );
    signer.close();

    // G. Broadcast never reached the node; a different operation first rebroadcasts
    // the original signed bytes and then refuses to sign until state is refreshed.
    signer = signerFor(keyA, flakyClient(client, "before"), journalA, contract);
    let pendingHash: Hex | undefined;
    try {
      await signer.send({ id: "store-3", to: contract, data: word(3) });
    } catch (error) {
      pendingHash = (error as { transactionHash?: Hex }).transactionHash;
    }
    signer.close();
    record(
      "lost broadcast stays journaled",
      !!pendingHash &&
        (await client.getTransaction({ hash: pendingHash }).then(
          () => false,
          () => true,
        )),
      `signed ${pendingHash} not yet on the node`,
    );
    signer = signerFor(keyA, client, journalA, contract);
    await expectError(
      "fresh-state gate after recovery",
      () => signer.send({ id: "store-4", to: contract, data: word(4) }),
      "Refresh chain state",
    );
    const storeThree = await client.getTransactionReceipt({
      hash: pendingHash!,
    });
    record(
      "original bytes rebroadcast",
      storeThree.status === "success" &&
        BigInt(
          (await client.getStorageAt({ address: contract, slot: "0x0" })) ?? 0,
        ) === 3n,
      `${pendingHash} included; store-4 was never signed`,
    );
    const afterGate = await signer.send({
      id: "store-4",
      to: contract,
      data: word(4),
    });
    record("signing resumes after refresh", !!afterGate, afterGate);
    signer.close();

    // H. Tampered journal bytes are rejected before any broadcast.
    const journalB = resolve(root, "journal-b");
    const keyB = TEST_KEYS[1];
    signer = signerFor(keyB, client, journalB, contract);
    await signer.send({ id: "tamper", to: contract, data: word(5) });
    signer.close();
    const dbPath = resolve(
      journalB,
      "31337",
      privateKeyToAccount(keyB).address.toLowerCase(),
      "transactions.sqlite",
    );
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT raw FROM jobs WHERE id='tamper'").get() as {
      raw: string;
    };
    const flipped =
      row.raw.slice(0, -2) + (row.raw.endsWith("00") ? "01" : "00");
    db.prepare("UPDATE jobs SET raw=? WHERE id='tamper'").run(flipped);
    db.close();
    signer = signerFor(keyB, client, journalB, contract);
    await expectError(
      "tampered journal rejection",
      () => signer.send({ id: "tamper", to: contract, data: word(5) }),
      "hash mismatch",
    );
    signer.close();

    // I. A reorganized anchor blocks further signing for that sender.
    const journalC = resolve(root, "journal-c");
    const keyC = TEST_KEYS[2];
    const checkpoint = await rpc("evm_snapshot");
    signer = signerFor(keyC, client, journalC, contract);
    await signer.send({ id: "anchor", to: contract, data: word(6) });
    signer.close();
    await rpc("evm_revert", [checkpoint]);
    const latest = await client.getBlock();
    await rpc("evm_setNextBlockTimestamp", [toHex(latest.timestamp + 17n)]);
    await rpc("evm_mine");
    await rpc("evm_mine");
    signer = signerFor(keyC, client, journalC, contract);
    await expectError(
      "reorganized anchor rejection",
      () => signer.send({ id: "after-reorg", to: contract, data: word(7) }),
      "reorganized",
    );
    signer.close();

    // J. Role, chain-policy and cost-bound refusals on the live node.
    const keyD = TEST_KEYS[3];
    await expectError(
      "role address mismatch",
      async () =>
        new ManagedSigner({
          ...signerOptions(keyD, client, resolve(root, "journal-d")),
          expectedAddress: addressA,
        }),
      "configured role address",
    );
    const cheap = new ManagedSigner({
      ...signerOptions(keyD, client, resolve(root, "journal-d")),
      maxFeePerGas: 1n,
    });
    await expectError(
      "fee bound refusal",
      () => cheap.send({ id: "fee", data: INIT_CODE }),
      "Network fee exceeds",
    );
    cheap.close();
  } finally {
    node.kill();
  }
  const summary = {
    rpc: RPC,
    chainId: 31337,
    keys: "Anvil public development keys only",
    passed: evidence.every((e) => e.ok),
    evidence,
  };
  writeFileSync(
    resolve(root, "rehearsal.json"),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(`\nEvidence: ${resolve(root, "rehearsal.json")}\n`);
}

function signerOptions(key: Hex, client: PublicClient, directory: string) {
  const account = privateKeyToAccount(key);
  return {
    client,
    chain: foundry,
    endpoint: RPC,
    account,
    expectedAddress: account.address,
    directory,
    maxGas: 1_000_000n,
    maxFeePerGas: 100_000_000_000n,
    maxNativeValue: 0n,
    maxTransactionCost: 10n ** 17n,
    authorize: policyAuthorizer({
      role: "rehearsal",
      calls: [],
      creations: [keccak256(INIT_CODE)],
    }),
  };
}

main().catch((error) => {
  writeFileSync(
    resolve(root, "rehearsal.json"),
    JSON.stringify({ passed: false, evidence, error: String(error) }, null, 2),
  );
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
