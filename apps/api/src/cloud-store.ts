import type {
  SignerJournal,
  SignerJob,
} from "../../../scripts/lib/managed-signer.ts";

const endpoint = process.env.STRATA_SUPABASE_URL;
const serviceKey = process.env.STRATA_SUPABASE_SERVICE_KEY;
export const cloudEnabled = !!endpoint && !!serviceKey;
let leaseOwner: string | undefined;
export const workerLease = "strata-public-worker";
export const hasWorkerLease = () => !!leaseOwner;

export async function cloudRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (!cloudEnabled || !endpoint?.startsWith("https://"))
    throw new Error("Backend cloud storage is not configured");
  const response = await fetch(`${endpoint}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey!,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "return=representation,resolution=merge-duplicates",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Cloud persistence failed (${response.status})`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
export async function claimWorker(owner: string) {
  // A retiring invocation cannot inherit a newer invocation's lease in the same
  // process. A killed invocation (e.g. at the function time limit) never runs its
  // release, so its owner is only respected while its database lease is alive.
  if (leaseOwner) {
    // Read only: renewing here would keep a hung owner's lease alive forever.
    const rows = await cloudRequest<{ expires_at: string }[]>(
      `strata_worker_leases?id=eq.${workerLease}&owner=eq.${encodeURIComponent(leaseOwner)}&select=expires_at`,
    );
    if (rows[0] && Date.parse(rows[0].expires_at) > Date.now()) return false;
    leaseOwner = undefined;
  }
  const claimed = await cloudRequest<boolean>(
    "rpc/strata_claim_worker",
    "POST",
    { lease_name: workerLease, owner_id: owner },
  );
  if (claimed) leaseOwner = owner;
  return claimed;
}
export async function assertWorkerLease() {
  if (
    !leaseOwner ||
    !(await cloudRequest<boolean>("rpc/strata_renew_worker", "POST", {
      lease_name: workerLease,
      owner_id: leaseOwner,
    }))
  )
    throw new Error("Worker lease lost; signing is stopped");
}
export async function releaseWorker() {
  const owner = leaseOwner;
  leaseOwner = undefined;
  if (owner)
    await cloudRequest("rpc/strata_release_worker", "POST", {
      lease_name: workerLease,
      owner_id: owner,
    });
}
export async function loadCloudState<T>(id: string): Promise<T | undefined> {
  const rows = await cloudRequest<{ value: T }[]>(
    `strata_state?id=eq.${encodeURIComponent(id)}&select=value`,
  );
  return rows[0]?.value;
}
export async function saveCloudState(id: string, value: unknown) {
  await assertWorkerLease();
  return cloudRequest("rpc/strata_save_state", "POST", {
    state_id: id,
    state_value: value,
    owner_id: leaseOwner,
  });
}
export function cloudSignerJournal(
  chain: number,
  sender: string,
): SignerJournal {
  const domain = `${chain}:${sender.toLowerCase()}`;
  return {
    load: async (intentId) => {
      await assertWorkerLease();
      const base = `strata_signer_jobs?domain=eq.${encodeURIComponent(domain)}&select=value`;
      const [rows, last] = await Promise.all([
        cloudRequest<{ value: SignerJob }[]>(
          `${base}&or=(id.eq.${encodeURIComponent(intentId)},status.in.(prepared,submitted))&order=nonce.asc`,
        ),
        cloudRequest<{ value: SignerJob }[]>(
          `${base}&status=in.(included,reverted)&order=nonce.desc&limit=1`,
        ),
      ]);
      return [
        ...new Map(
          [...rows, ...last].map((row) => [row.value.id, row.value]),
        ).values(),
      ];
    },
    save: async (job) => {
      await assertWorkerLease();
      await cloudRequest("rpc/strata_save_signer_job", "POST", {
        job_domain: domain,
        job_id: job.id,
        job_value: job,
        owner_id: leaseOwner,
      });
    },
  };
}

/** A visitor asked for on-chain trading. Public, so it needs no worker lease. */
export async function requestTradingWake(at = Date.now()) {
  await cloudRequest("strata_state", "POST", {
    id: "trading-wake",
    value: { at },
    updated_at: new Date(at).toISOString(),
  });
}
