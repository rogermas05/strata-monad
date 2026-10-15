import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionSerializedEIP1559,
} from "viem";
import { waitReceipt } from "../../packages/core/src/receipts.ts";
import {
  redactDiagnostic,
  rpcDiagnosticSecrets,
} from "../../packages/core/src/deployment-config.ts";

export interface SignerIntent {
  id: string;
  to?: Address;
  data: Hex;
  value?: bigint;
  nonce?: number;
}
export interface SignerJob {
  id: string;
  nonce: number;
  hash: Hex;
  raw: Hex;
  target: Address | null;
  data: Hex;
  value: string;
  status: "prepared" | "submitted" | "included" | "reverted";
  block: string | null;
  block_hash: Hex | null;
}
type Job = SignerJob;
/** A durable cloud journal is loaded under the caller's distributed worker lease. */
export interface SignerJournal {
  load: (intentId: string) => Promise<SignerJob[]>;
  save: (job: SignerJob) => Promise<void>;
}
export interface ManagedSignerOptions {
  client: PublicClient;
  chain: Chain;
  endpoint: string;
  account: LocalAccount;
  expectedAddress: Address;
  directory: string;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxNativeValue: bigint;
  maxTransactionCost: bigint;
  receiptTimeout?: number;
  secrets?: string[];
  /** Mandatory deployment/role-specific authorization, rerun before submission. */
  authorize: (intent: SignerIntent) => Promise<void>;
  journal?: SignerJournal;
  /** Durable cumulative spending guard, run for new and recovered broadcasts. */
  reserveCost?: (
    intentId: string,
    maximumCost: bigint,
    balance: bigint,
  ) => Promise<void>;
}

/** Backend-only local signing. The journal contains signed transactions, never signing keys. */
export class ManagedSigner {
  readonly address: Address;
  private db: DatabaseSync;
  private lock: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: ManagedSignerOptions) {
    if (
      options.account.address.toLowerCase() !==
      options.expectedAddress.toLowerCase()
    )
      throw new Error("Signer does not match the configured role address");
    if (
      ![31337, 10143].includes(options.chain.id) ||
      options.maxGas < 21000n ||
      options.maxGas > 16000000n ||
      options.maxFeePerGas <= 0n ||
      options.maxNativeValue < 0n ||
      options.maxTransactionCost <= 0n
    )
      throw new Error("Invalid signer network or cost bounds");
    this.address = options.account.address;
    const directory = resolve(
      options.directory,
      String(options.chain.id),
      this.address.toLowerCase(),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lock = resolve(directory, "sender.lock");
    const path = resolve(directory, "transactions.sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS domain (id INTEGER PRIMARY KEY CHECK(id=1), chain INTEGER NOT NULL, account TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, nonce INTEGER NOT NULL UNIQUE, hash TEXT NOT NULL UNIQUE, raw TEXT NOT NULL, target TEXT, data TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL, block TEXT, block_hash TEXT);",
    );
    for (const file of [path, path + "-wal", path + "-shm"])
      if (existsSync(file)) chmodSync(file, 0o600);
    const domain = this.db.prepare("SELECT * FROM domain WHERE id=1").get() as
      { chain: number; account: string } | undefined;
    if (
      domain &&
      (domain.chain !== options.chain.id ||
        domain.account !== this.address.toLowerCase())
    ) {
      this.db.close();
      throw new Error("Signer journal domain mismatch");
    }
    if (!domain)
      this.db
        .prepare("INSERT INTO domain VALUES(1,?,?)")
        .run(options.chain.id, this.address.toLowerCase());
  }
  close() {
    this.db.close();
  }
  status() {
    return {
      chainId: this.options.chain.id,
      address: this.address,
      jobs: this.db
        .prepare("SELECT status, count(*) AS count FROM jobs GROUP BY status")
        .all(),
    };
  }
  send(intent: SignerIntent): Promise<Hex> {
    const next = this.queue.then(() =>
      this.exclusive(() => this.execute(intent)),
    );
    this.queue = next.catch(() => {});
    return next.catch((error) => {
      const sanitized = new Error(
        redactDiagnostic(error, [
          ...rpcDiagnosticSecrets(this.options.endpoint),
          ...(this.options.secrets ?? []),
        ]),
      );
      const hash = (error as { transactionHash?: Hex }).transactionHash;
      if (hash) Object.assign(sanitized, { transactionHash: hash });
      throw sanitized;
    });
  }
  private async exclusive<T>(operation: () => Promise<T>) {
    if (existsSync(this.lock)) {
      let pid: number;
      try {
        pid = JSON.parse(readFileSync(this.lock, "utf8")).pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
      } catch {
        throw new Error("Malformed signer lock requires operator inspection");
      }
      try {
        process.kill(pid, 0);
        throw new Error("Another signer process holds this sender");
      } catch (error) {
        if ((error as { code?: string }).code !== "ESRCH") throw error;
      }
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(fd);
    }
    try {
      return await operation();
    } finally {
      unlinkSync(this.lock);
    }
  }
  private async verifyJob(job: Job) {
    if (
      !/^0x02(?:[0-9a-fA-F]{2})+$/.test(job.raw) ||
      keccak256(job.raw) !== job.hash
    )
      throw new Error("Signed journal transaction hash mismatch");
    const tx = parseTransaction(job.raw);
    const sender = await recoverTransactionAddress({
      serializedTransaction: job.raw as TransactionSerializedEIP1559,
    });
    if (
      sender.toLowerCase() !== this.address.toLowerCase() ||
      tx.chainId !== this.options.chain.id ||
      tx.nonce !== job.nonce ||
      (tx.to?.toLowerCase() ?? null) !== (job.target?.toLowerCase() ?? null) ||
      (tx.data ?? "0x").toLowerCase() !== job.data.toLowerCase() ||
      (tx.value ?? 0n).toString() !== job.value
    )
      throw new Error("Signed journal transaction does not match its intent");
    if (
      tx.type !== "eip1559" ||
      (tx.gas ?? 0n) > this.options.maxGas ||
      (tx.maxFeePerGas ?? 0n) > this.options.maxFeePerGas ||
      (tx.value ?? 0n) > this.options.maxNativeValue ||
      (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) + (tx.value ?? 0n) >
        this.options.maxTransactionCost
    )
      throw new Error("Signed journal transaction exceeds current cost bounds");
  }
  private async execute(intent: SignerIntent): Promise<Hex> {
    const o = this.options;
    if (o.journal) {
      const jobs = await o.journal.load(intent.id);
      this.db.exec("BEGIN");
      try {
        this.db.prepare("DELETE FROM jobs").run();
        const insert = this.db.prepare(
          "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)",
        );
        for (const job of jobs) {
          await this.verifyJob(job);
          insert.run(
            job.id,
            job.nonce,
            job.hash,
            job.raw,
            job.target,
            job.data,
            job.value,
            job.status,
            job.block,
            job.block_hash,
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (
      !/^[a-zA-Z0-9._:/-]{1,200}$/.test(intent.id) ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(intent.data) ||
      (intent.to !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(intent.to)) ||
      (intent.value ?? 0n) < 0n ||
      (intent.value ?? 0n) > o.maxNativeValue ||
      (intent.nonce !== undefined &&
        (!Number.isSafeInteger(intent.nonce) || intent.nonce < 0))
    )
      throw new Error("Invalid signer intent");
    if ((await o.client.getChainId()) !== o.chain.id)
      throw new Error("Signer RPC chain mismatch");
    const prior = this.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(intent.id) as Job | undefined;
    if (prior) {
      if (
        (intent.to?.toLowerCase() ?? null) !==
          (prior.target?.toLowerCase() ?? null) ||
        intent.data.toLowerCase() !== prior.data.toLowerCase() ||
        (intent.value ?? 0n).toString() !== prior.value ||
        (intent.nonce !== undefined && intent.nonce !== prior.nonce)
      )
        throw new Error(
          "Signer intent ID was reused with different transaction data",
        );
      return this.resolveJob(prior);
    }
    const unfinished = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('prepared','submitted') ORDER BY nonce LIMIT 1",
      )
      .get() as Job | undefined;
    if (unfinished) {
      await this.resolveJob(unfinished);
      throw Object.assign(
        new Error(
          "Previous transaction recovered. Refresh chain state before preparing another operation.",
        ),
        { transactionHash: unfinished.hash },
      );
    }
    const last = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('included','reverted') ORDER BY nonce DESC LIMIT 1",
      )
      .get() as Job | undefined;
    if (last) await this.canonical(last);
    await o.authorize(intent);
    const [latest, pending, fees, balance] = await Promise.all([
      o.client.getTransactionCount({
        address: this.address,
        blockTag: "latest",
      }),
      o.client.getTransactionCount({
        address: this.address,
        blockTag: "pending",
      }),
      o.client.estimateFeesPerGas(),
      o.client.getBalance({ address: this.address }),
    ]);
    if (
      latest !== pending ||
      (intent.nonce !== undefined && intent.nonce !== pending) ||
      (last && pending <= last.nonce)
    )
      throw new Error(
        "Signer nonce has pending activity or conflicts with its journal",
      );
    if (
      fees.maxFeePerGas > o.maxFeePerGas ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    )
      throw new Error("Network fee exceeds signer cost bounds");
    const estimate = await o.client.estimateGas({
      account: this.address,
      to: intent.to,
      data: intent.data,
      value: intent.value ?? 0n,
    });
    const gas = (estimate * 125n + 99n) / 100n + 5000n;
    const cost = gas * fees.maxFeePerGas + (intent.value ?? 0n);
    if (gas > o.maxGas || cost > o.maxTransactionCost || balance < cost)
      throw new Error(
        "Signer gas, transaction budget or balance is insufficient",
      );
    // Offline local signing: the chain ID is the one validated above, so no
    // additional RPC request can bypass the injected client's chain policy.
    const raw = await o.account.signTransaction({
      chainId: o.chain.id,
      type: "eip1559",
      nonce: pending,
      to: intent.to,
      data: intent.data,
      value: intent.value ?? 0n,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const job: Job = {
      id: intent.id,
      nonce: pending,
      hash: keccak256(raw),
      raw,
      target: intent.to ?? null,
      data: intent.data,
      value: (intent.value ?? 0n).toString(),
      status: "prepared",
      block: null,
      block_hash: null,
    };
    // Reject a new over-budget job before making it durable. Otherwise an
    // unbroadcast prepared job could occupy the sender's queue until tomorrow.
    await o.reserveCost?.(job.hash, cost, balance);
    await this.verifyJob(job);
    // Durable signed intent precedes the first broadcast, including an ambiguous RPC failure.
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        job.id,
        job.nonce,
        job.hash,
        job.raw,
        job.target,
        job.data,
        job.value,
        job.status,
        job.block,
        job.block_hash,
      );
    // Cloud persistence must succeed before any broadcast, even on a cold instance.
    await o.journal?.save(job);
    return this.resolveJob(job);
  }
  private async canonical(job: Job) {
    if (!job.block || !job.block_hash)
      throw new Error("Included signer journal is missing canonical evidence");
    const block = await this.options.client.getBlock({
      blockNumber: BigInt(job.block),
    });
    if (block.hash !== job.block_hash)
      throw Object.assign(
        new Error(
          "Signer journal receipt was reorganized; inspect before further signing",
        ),
        { transactionHash: job.hash },
      );
  }
  private async resolveJob(job: Job): Promise<Hex> {
    const o = this.options;
    await this.verifyJob(job);
    if (job.status === "included" || job.status === "reverted") {
      await this.canonical(job);
      if (job.status === "reverted")
        throw Object.assign(new Error("Reviewed signer transaction reverted"), {
          transactionHash: job.hash,
        });
      return job.hash;
    }
    try {
      let known = false;
      try {
        const tx = await o.client.getTransaction({ hash: job.hash });
        known = tx.hash === job.hash;
      } catch (error) {
        if ((error as { name?: string }).name !== "TransactionNotFoundError")
          throw error;
      }
      if (!known) {
        if (o.reserveCost) {
          const tx = parseTransaction(job.raw);
          await o.reserveCost(
            job.hash,
            (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) + (tx.value ?? 0n),
            await o.client.getBalance({ address: this.address }),
          );
        }
        await o.authorize({
          id: job.id,
          to: job.target ?? undefined,
          data: job.data,
          value: BigInt(job.value),
          nonce: job.nonce,
        });
        const [latest, pending] = await Promise.all([
          o.client.getTransactionCount({
            address: this.address,
            blockTag: "latest",
          }),
          o.client.getTransactionCount({
            address: this.address,
            blockTag: "pending",
          }),
        ]);
        if (latest !== job.nonce || pending !== job.nonce)
          throw new Error(
            "Signed transaction nonce is consumed or occupied; no replacement is authorized",
          );
        this.db
          .prepare("UPDATE jobs SET status='submitted' WHERE id=?")
          .run(job.id);
        job.status = "submitted";
        await o.journal?.save(job);
        // Authorization includes the distributed lease and is checked immediately before broadcast.
        await o.authorize({
          id: job.id,
          to: job.target ?? undefined,
          data: job.data,
          value: BigInt(job.value),
          nonce: job.nonce,
        });
        const hash = await o.client.sendRawTransaction({
          serializedTransaction: job.raw as TransactionSerializedEIP1559,
        });
        if (hash !== job.hash)
          throw new Error("RPC returned a different signed transaction hash");
      }
      const receipt = await waitReceipt(
        o.client,
        job.hash,
        o.receiptTimeout ?? 120000,
      );
      if (receipt.transactionHash !== job.hash)
        throw new Error("Signer receipt hash mismatch");
      const block = await o.client.getBlock({
        blockNumber: receipt.blockNumber,
      });
      if (block.hash !== receipt.blockHash)
        throw new Error("Signer receipt is not canonical");
      this.db
        .prepare("UPDATE jobs SET status=?,block=?,block_hash=? WHERE id=?")
        .run(
          receipt.status === "success" ? "included" : "reverted",
          receipt.blockNumber.toString(),
          receipt.blockHash,
          job.id,
        );
      job.status = receipt.status === "success" ? "included" : "reverted";
      job.block = receipt.blockNumber.toString();
      job.block_hash = receipt.blockHash;
      await o.journal?.save(job);
      if (receipt.status !== "success")
        throw new Error("Reviewed signer transaction reverted");
      return job.hash;
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error("Signer submission failed"),
        { transactionHash: job.hash },
      );
    }
  }
}
