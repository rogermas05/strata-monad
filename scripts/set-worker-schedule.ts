import pg from "pg";
import { readFileSync } from "node:fs";
import { loadCloudEnvironment } from "./lib/cloud-env.ts";

loadCloudEnvironment();
const mode = process.argv[2];
if (mode !== "on" && mode !== "off") throw new Error("Use on|off");
const client = new pg.Client({
  host: "aws-0-us-west-1.pooler.supabase.com",
  port: 5432,
  user: "postgres.ygdhgcbnsekoabmkrxzf",
  database: "postgres",
  password: process.env.STRATA_DATABASE_PASSWORD,
  ssl: {
    rejectUnauthorized: true,
    ca: readFileSync(".runtime/cloud/supabase-ca.crt", "utf8"),
  },
  connectionTimeoutMillis: 10000,
});
try {
  await client.connect();
  await client.query(
    "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='strata-public-worker'),active := $1)",
    [mode === "on"],
  );
  console.log(
    JSON.stringify(
      (
        await client.query(
          "SELECT jobname,schedule,active FROM cron.job WHERE jobname='strata-public-worker'",
        )
      ).rows,
    ),
  );
} catch {
  throw new Error("Worker schedule update failed");
} finally {
  await client.end();
}
