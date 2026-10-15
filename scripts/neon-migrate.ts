import { Pool, neonConfig } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadCloudEnvironment } from "./lib/cloud-env.ts";
import { writeDeploymentJson } from "./deployment-executor.ts";

loadCloudEnvironment();
const connectionString = process.env.STRATA_STATE_DATABASE_URL_UNPOOLED;
if (!connectionString || new URL(connectionString).hostname.includes("-pooler"))
  throw new Error("A direct Neon migration connection is required");
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString });
const schema = readFileSync("apps/api/sql/neon.sql", "utf8");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(schema);
  await client.query("COMMIT");
  const result = {
    applied: true,
    sha256: createHash("sha256").update(schema).digest("hex"),
    at: new Date().toISOString(),
  };
  writeDeploymentJson(".runtime/cloud/neon-schema.json", result);
  console.log(JSON.stringify(result));
} catch {
  await client.query("ROLLBACK");
  throw new Error("Neon schema migration failed");
} finally {
  client.release();
  await pool.end();
}
