import pg from "pg";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { loadCloudEnvironment } from "./lib/cloud-env.ts";
import {
  decodeCloudState,
  encodeCloudState,
} from "../apps/api/src/cloud-state-codec.ts";
import {
  minutePrices,
  retainedSnapshot,
} from "../apps/api/src/cloud-retention.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";

loadCloudEnvironment();
if (existsSync(".runtime/cloud/neon-migration.json"))
  throw new Error(
    "The source migration is complete; do not overwrite the live Neon state",
  );
if (
  !process.env.STRATA_DATABASE_PASSWORD ||
  !process.env.STRATA_STATE_DATABASE_URL_UNPOOLED
)
  throw new Error("Source and destination backend credentials are required");
const source = new pg.Client({
  host: "db.ygdhgcbnsekoabmkrxzf.supabase.co",
  user: "postgres",
  database: "postgres",
  password: process.env.STRATA_DATABASE_PASSWORD,
  ssl: {
    rejectUnauthorized: true,
    ca: readFileSync(".runtime/cloud/supabase-ca.crt", "utf8"),
  },
  connectionTimeoutMillis: 10000,
});
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({
  connectionString: process.env.STRATA_STATE_DATABASE_URL_UNPOOLED,
});
const owner = randomUUID();
const tables = [
  ["strata_state", "id text,value jsonb,updated_at timestamptz", "id"],
  [
    "strata_signer_jobs",
    "domain text,id text,nonce bigint,status text,value jsonb",
    "domain,id",
  ],
  ["strata_proofs", "id text,value jsonb", "id"],
  [
    "strata_transactions",
    "domain text,hash text,account text,created bigint,value jsonb",
    "domain,hash",
  ],
] as const;
const stable = (value: any): any =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object" && !(value instanceof Date)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const digest = (rows: unknown[]) =>
  createHash("sha256")
    .update(JSON.stringify(stable(rows)))
    .digest("hex");
await source.connect();
const target = await pool.connect();
try {
  // Quiesce the old scheduler and keep it paused until the new deployment is verified.
  await source.query(
    "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='strata-public-worker'), active := false)",
  );
  const active = await source.query(
    "SELECT 1 FROM strata_worker_leases WHERE expires_at>clock_timestamp()",
  );
  if (active.rowCount)
    throw new Error(
      "Old worker lease is still active; wait without forcing it",
    );
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const exported: Record<string, any[]> = {};
  for (const [table] of tables) {
    const projection =
      table === "strata_signer_jobs"
        ? "domain,id,nonce,value->>'status' AS status,value"
        : "*";
    const order =
      table === "strata_signer_jobs"
        ? "domain,id"
        : table === "strata_transactions"
          ? "domain,hash"
          : "id";
    exported[table] = (
      await source.query(`SELECT ${projection} FROM ${table} ORDER BY ${order}`)
    ).rows;
  }
  await source.query("COMMIT");
  const manifest = exported.strata_state.find(
    (row) => row.id === "public-manifest",
  )?.value;
  if (
    !isDeepStrictEqual(
      manifest,
      JSON.parse(readFileSync(".runtime/testnet/manifest.json", "utf8")),
    )
  )
    throw new Error(
      "Source manifest differs from the verified local deployment",
    );
  writeFileSync(
    ".runtime/cloud/supabase-export.json",
    JSON.stringify(exported),
    { mode: 0o600 },
  );
  for (const row of exported.strata_state) {
    let value = decodeCloudState<any>(row.value);
    if (row.id === "public-snapshot") value = retainedSnapshot(value);
    if (row.id.startsWith("read-model:") && value.charts)
      value = {
        ...value,
        charts: Object.fromEntries(
          Object.entries(value.charts).map(([key, prices]) => [
            key,
            minutePrices(prices as any),
          ]),
        ),
      };
    row.value = encodeCloudState(row.id, value);
  }
  await target.query("BEGIN");
  const claimed = await target.query(
    "SELECT strata_claim_worker('strata-public-worker',$1::uuid) AS acquired",
    [owner],
  );
  if (!claimed.rows[0].acquired)
    throw new Error("Neon worker lease is active; wait without forcing it");
  const report = [];
  for (const [table, definition, conflict] of tables) {
    const columns = definition.split(",").map((column) => column.split(" ")[0]);
    const rows = exported[table];
    for (let at = 0; at < rows.length; at += 50) {
      const updates = columns
        .filter((column) => !conflict.split(",").includes(column))
        .map((column) => `${column}=EXCLUDED.${column}`)
        .join(",");
      await target.query(
        `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_to_recordset($1::jsonb) AS data(${definition}) ON CONFLICT(${conflict}) DO UPDATE SET ${updates}`,
        [JSON.stringify(rows.slice(at, at + 50))],
      );
    }
    const actual = (
      await target.query(
        `SELECT ${columns.join(",")} FROM ${table} ORDER BY ${conflict}`,
      )
    ).rows;
    if (actual.length !== rows.length || digest(actual) !== digest(rows))
      throw new Error(`Migration verification failed for ${table}`);
    report.push({ table, rows: rows.length, sha256: digest(actual) });
    console.log(JSON.stringify(report.at(-1)));
  }
  await target.query(
    "SELECT strata_release_worker('strata-public-worker',$1::uuid)",
    [owner],
  );
  await target.query("COMMIT");
  writeDeploymentJson(".runtime/cloud/neon-migration.json", {
    migrated: true,
    at: new Date().toISOString(),
    verified: report,
  });
} catch (error) {
  await target.query("ROLLBACK");
  // Do not include driver error detail: parameters can contain signed envelopes.
  console.error(
    error instanceof Error && /lease|manifest|verification/.test(error.message)
      ? error.message
      : "Database migration failed; source remains intact and scheduler is paused",
  );
  process.exitCode = 1;
} finally {
  target.release();
  await pool.end();
  await source.end();
}
