import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";

/** Keep existing signer secrets; the integration pull may redact unrelated values. */
export function loadCloudEnvironment() {
  config({ quiet: true });
  config({ path: ".runtime/cloud/supabase.env", quiet: true });
  const path = ".runtime/cloud/neon.env";
  if (existsSync(path))
    for (const [key, value] of Object.entries(parse(readFileSync(path))))
      if (key.startsWith("STRATA_STATE_") && value && value !== "[SENSITIVE]")
        process.env[key] = value;
}
