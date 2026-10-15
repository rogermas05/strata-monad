import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { neonStoreRequest, type StoreQuery } from "./neon-store.ts";

const db = new PGlite();
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const query: StoreQuery = async (text, parameters) =>
  (await db.query<Record<string, any>>(text, parameters)).rows;
const request = <T = any>(path: string, method = "GET", body?: unknown) =>
  neonStoreRequest<T>(query, path, method, body);
const claim = (owner: string) =>
  request<boolean>("rpc/strata_claim_worker", "POST", {
    lease_name: "strata-public-worker",
    owner_id: owner,
  });
const save = (owner: string, value: unknown) =>
  request("rpc/strata_save_state", "POST", {
    state_id: "public-snapshot",
    state_value: value,
    owner_id: owner,
  });
const job = (
  owner: string,
  id: string,
  nonce: number,
  status = "prepared",
  raw = "0x1234",
) =>
  request("rpc/strata_save_signer_job", "POST", {
    owner_id: owner,
    job_domain: "10143:maker",
    job_id: id,
    job_value: { id, nonce, status, raw, hash: `0x${nonce.toString(16)}` },
  });

beforeAll(async () => {
  await db.exec(
    readFileSync(new URL("../sql/neon.sql", import.meta.url), "utf8"),
  );
}, 30000);
beforeEach(async () => {
  await db.exec(
    "TRUNCATE strata_state,strata_worker_leases,strata_signer_jobs,strata_proofs,strata_transactions",
  );
});
afterAll(async () => {
  await db.close();
});

it("grants only one competing worker and rejects stale-owner writes after takeover", async () => {
  expect(await Promise.all([claim(a), claim(b)])).toEqual([true, false]);
  await save(a, { block: 1 });
  await db.query(
    "UPDATE strata_worker_leases SET expires_at=clock_timestamp()-interval '1 second'",
  );
  expect(await claim(b)).toBe(true);
  await expect(save(a, { block: 2 })).rejects.toThrow("Worker lease lost");
  expect(
    await request("rpc/strata_release_worker", "POST", {
      lease_name: "strata-public-worker",
      owner_id: a,
    }),
  ).toBe(false);
  await save(b, { block: 3 });
  expect(
    (
      await request(
        "strata_state?id=eq.public-snapshot&select=value,updated_at",
      )
    )[0],
  ).toMatchObject({ value: { block: 3 }, updated_at: expect.any(String) });
});

it("preserves signed bytes and prevents a second job consuming the same nonce", async () => {
  await claim(a);
  await job(a, "buy", 5);
  await job(a, "buy", 5, "submitted");
  await expect(job(a, "buy", 5, "submitted", "0x9876")).rejects.toThrow(
    "Signed envelope is immutable",
  );
  await expect(job(a, "other", 5)).rejects.toThrow();
  await expect(
    request("rpc/strata_save_signer_job", "POST", {
      owner_id: a,
      job_domain: "10143:maker",
      job_id: "buy",
      job_value: {
        id: "buy",
        nonce: 5,
        status: "submitted",
        raw: "0x1234",
        hash: "0x5",
        to: "changed",
      },
    }),
  ).rejects.toThrow("Signed envelope is immutable");
  await db.query(
    "UPDATE strata_worker_leases SET expires_at=clock_timestamp()-interval '1 second'",
  );
  await expect(job(a, "expired", 6)).rejects.toThrow("Worker lease lost");
});

it("loads the exact pending and latest terminal jobs used by restart recovery", async () => {
  await claim(a);
  await job(a, "first", 1, "included");
  await job(a, "second", 2, "reverted");
  await job(a, "pending", 3);
  await job(a, "submitted", 4, "submitted");
  const rows = await request(
    "strata_signer_jobs?domain=eq.10143%3Amaker&select=value&or=(id.eq.first,status.in.(prepared,submitted))&order=nonce.asc",
  );
  expect(rows.map((r: any) => r.value.id)).toEqual([
    "first",
    "pending",
    "submitted",
  ]);
  const last = await request(
    "strata_signer_jobs?domain=eq.10143%3Amaker&select=value&status=in.(included,reverted)&order=nonce.desc&limit=1",
  );
  expect(last[0].value.id).toBe("second");
});

it("isolates receipt history by deployment/account and keeps proof retrieval exact", async () => {
  for (const [hash, account, created] of [
    ["0x1", "alice", 1],
    ["0x2", "bob", 2],
    ["0x3", "alice", 3],
  ] as const)
    await request("strata_transactions", "POST", {
      domain: "chain:engine",
      hash,
      account,
      created,
      value: { hash },
    });
  expect(
    await request(
      "strata_transactions?domain=eq.chain%3Aengine&account=eq.alice&select=value&order=created.desc&limit=100",
    ),
  ).toEqual([{ value: { hash: "0x3" } }, { value: { hash: "0x1" } }]);
  await request("strata_proofs", "POST", {
    id: "proof:1",
    value: { payload: "0x1234" },
  });
  expect(await request("strata_proofs?id=eq.proof%3A1&select=value")).toEqual([
    { value: { payload: "0x1234" } },
  ]);
});

it("parameterizes IDs and refuses arbitrary projections, RPCs and unleased state writes", async () => {
  expect(
    await request("strata_state?id=eq.%27%20OR%20true%3B--&select=value"),
  ).toEqual([]);
  await expect(
    request("strata_state?select=value;DROP TABLE strata_state"),
  ).rejects.toThrow();
  await expect(request("rpc/other_function", "POST", {})).rejects.toThrow();
  await expect(
    request("strata_state", "POST", { id: "public-manifest", value: {} }),
  ).rejects.toThrow("Only a trading wake");
  await request("strata_state", "POST", {
    id: "trading-wake",
    value: { at: 1000 },
  });
  expect(await request("strata_state?id=eq.trading-wake&select=value")).toEqual(
    [{ value: { at: 1000 } }],
  );
});
