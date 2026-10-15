import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type StoreQuery = (
  text: string,
  parameters?: unknown[],
) => Promise<Record<string, any>[]>;
const columns: Record<string, string[]> = {
  strata_state: ["id", "value", "updated_at"],
  strata_worker_leases: ["id", "owner", "expires_at"],
  strata_signer_jobs: ["domain", "id", "nonce", "status", "value"],
  strata_proofs: ["id", "value"],
  strata_transactions: ["domain", "hash", "account", "created", "value"],
};

/** The exact backend store operations used by Strata; parameters never become SQL. */
export async function neonStoreRequest<T>(
  query: StoreQuery,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const url = new URL(path, "https://state.invalid/");
  const table = url.pathname.slice(1);
  const input = body as Record<string, unknown> | undefined;
  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (method === "POST" && table.startsWith("rpc/")) {
    const name = table.slice(4);
    const signatures: Record<string, [string, string][]> = {
      strata_claim_worker: [
        ["lease_name", "text"],
        ["owner_id", "uuid"],
      ],
      strata_renew_worker: [
        ["lease_name", "text"],
        ["owner_id", "uuid"],
      ],
      strata_release_worker: [
        ["lease_name", "text"],
        ["owner_id", "uuid"],
      ],
      strata_save_state: [
        ["state_id", "text"],
        ["state_value", "jsonb"],
        ["owner_id", "uuid"],
      ],
      strata_save_signer_job: [
        ["job_domain", "text"],
        ["job_id", "text"],
        ["job_value", "jsonb"],
        ["owner_id", "uuid"],
      ],
    };
    const signature = signatures[name];
    if (!signature || !input) throw new Error("Unsupported storage operation");
    const args = signature.map(
      ([key, cast]) =>
        `${parameter(cast === "jsonb" ? JSON.stringify(input[key]) : input[key])}::${cast}`,
    );
    return (
      await query(`SELECT ${name}(${args.join(",")}) AS result`, values)
    )[0].result as T;
  }
  const allowed = columns[table];
  if (!allowed) throw new Error("Unsupported storage table");
  if (method === "GET") {
    const selected = (url.searchParams.get("select") ?? "value").split(",");
    if (selected.some((column) => !allowed.includes(column)))
      throw new Error("Unsupported storage projection");
    const predicates: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit"].includes(key)) continue;
      if (key === "or" && table === "strata_signer_jobs") {
        const match =
          /^\(id\.eq\.(.*),status\.in\.\(prepared,submitted\)\)$/.exec(value);
        if (!match) throw new Error("Unsupported journal filter");
        predicates.push(
          `(id=${parameter(match[1])} OR status IN ('prepared','submitted'))`,
        );
      } else if (allowed.includes(key) && value.startsWith("eq.")) {
        predicates.push(`"${key}"=${parameter(value.slice(3))}`);
      } else if (
        key === "status" &&
        value === "in.(included,reverted)" &&
        table === "strata_signer_jobs"
      ) {
        predicates.push("status IN ('included','reverted')");
      } else throw new Error("Unsupported storage filter");
    }
    const order = url.searchParams.get("order");
    let suffix = "";
    if (order) {
      const match = /^(nonce|created)\.(asc|desc)$/.exec(order);
      if (!match || !allowed.includes(match[1]))
        throw new Error("Unsupported storage ordering");
      suffix += ` ORDER BY "${match[1]}" ${match[2].toUpperCase()}`;
    }
    const limit = url.searchParams.get("limit");
    if (limit !== null) {
      const count = Number(limit);
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
        throw new Error("Unsupported storage limit");
      suffix += ` LIMIT ${parameter(count)}`;
    }
    return (await query(
      `SELECT ${selected.map((s) => (["updated_at", "expires_at"].includes(s) ? `"${s}"::text AS "${s}"` : `"${s}"`)).join(",")} FROM ${table}${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""}${suffix}`,
      values,
    )) as T;
  }
  if (method !== "POST" || !input)
    throw new Error("Unsupported storage method");
  if (table === "strata_state") {
    if (
      input.id !== "trading-wake" ||
      !(
        input.value &&
        typeof input.value === "object" &&
        "at" in input.value &&
        Number.isFinite(input.value.at)
      )
    )
      throw new Error("Only a trading wake can bypass the worker lease");
    await query(
      "INSERT INTO strata_state(id,value,updated_at) VALUES($1,$2::jsonb,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at",
      [input.id, JSON.stringify(input.value)],
    );
  } else if (table === "strata_proofs") {
    await query(
      "INSERT INTO strata_proofs(id,value) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value",
      [input.id, JSON.stringify(input.value)],
    );
  } else if (table === "strata_transactions") {
    await query(
      "INSERT INTO strata_transactions(domain,hash,account,created,value) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(domain,hash) DO UPDATE SET value=EXCLUDED.value",
      [
        input.domain,
        input.hash,
        input.account,
        input.created,
        JSON.stringify(input.value),
      ],
    );
  } else throw new Error("Direct storage writes require the worker lease");
  return [] as T;
}

let sql: NeonQueryFunction<false, false> | undefined;
export async function requestNeon<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const endpoint = process.env.STRATA_STATE_DATABASE_URL;
  if (!endpoint) throw new Error("Neon storage is not configured");
  sql ??= neon(endpoint);
  try {
    return await neonStoreRequest<T>(
      (text, params) =>
        sql!.query(text, params, {
          fetchOptions: { signal: AbortSignal.timeout(15000) },
        }),
      path,
      method,
      body,
    );
  } catch {
    // Database errors may carry connection credentials or stored signed envelopes.
    throw new Error("Neon storage operation failed");
  }
}
