CREATE TABLE IF NOT EXISTS strata_state (
  id text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS strata_worker_leases (
  id text PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS strata_signer_jobs (
  domain text NOT NULL,
  id text NOT NULL,
  nonce bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared','submitted','included','reverted')),
  value jsonb NOT NULL,
  PRIMARY KEY (domain,id),
  UNIQUE (domain,nonce)
);
CREATE UNIQUE INDEX IF NOT EXISTS strata_signer_hashes ON strata_signer_jobs(domain,(value->>'hash'));
CREATE TABLE IF NOT EXISTS strata_proofs (
  id text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS strata_transactions (
  domain text NOT NULL,
  hash text NOT NULL,
  account text NOT NULL,
  created bigint NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (domain,hash)
);
CREATE INDEX IF NOT EXISTS strata_transaction_accounts ON strata_transactions(domain,account,created DESC);

CREATE OR REPLACE FUNCTION strata_claim_worker(lease_name text, owner_id uuid)
RETURNS boolean LANGUAGE sql AS $$
  WITH claimed AS (
    INSERT INTO strata_worker_leases(id,owner,expires_at)
    VALUES(lease_name,owner_id,clock_timestamp()+interval '300 seconds')
    ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
    WHERE strata_worker_leases.expires_at <= clock_timestamp()
    RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM claimed);
$$;
CREATE OR REPLACE FUNCTION strata_renew_worker(lease_name text, owner_id uuid)
RETURNS boolean LANGUAGE sql AS $$
  WITH renewed AS (
    UPDATE strata_worker_leases SET expires_at=clock_timestamp()+interval '300 seconds'
    WHERE id=lease_name AND owner=owner_id AND expires_at>clock_timestamp()
    RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM renewed);
$$;
CREATE OR REPLACE FUNCTION strata_release_worker(lease_name text, owner_id uuid)
RETURNS boolean LANGUAGE sql AS $$
  WITH released AS (
    DELETE FROM strata_worker_leases WHERE id=lease_name AND owner=owner_id RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM released);
$$;
CREATE OR REPLACE FUNCTION strata_save_state(state_id text, state_value jsonb, owner_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM strata_worker_leases
  WHERE id='strata-public-worker' AND owner=owner_id AND expires_at>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker lease lost'; END IF;
  INSERT INTO strata_state(id,value,updated_at) VALUES(state_id,state_value,clock_timestamp())
  ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION strata_save_signer_job(job_domain text, job_id text, job_value jsonb, owner_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE previous jsonb;
BEGIN
  PERFORM 1 FROM strata_worker_leases
  WHERE id='strata-public-worker' AND owner=owner_id AND expires_at>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker lease lost'; END IF;
  SELECT value INTO previous FROM strata_signer_jobs WHERE domain=job_domain AND id=job_id FOR UPDATE;
  IF FOUND AND (previous - 'status' - 'block' - 'block_hash')
    IS DISTINCT FROM (job_value - 'status' - 'block' - 'block_hash')
  THEN RAISE EXCEPTION 'Signed envelope is immutable'; END IF;
  INSERT INTO strata_signer_jobs(domain,id,nonce,status,value)
  VALUES(job_domain,job_id,(job_value->>'nonce')::bigint,job_value->>'status',job_value)
  ON CONFLICT(domain,id) DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value;
  RETURN true;
END;
$$;

-- No browser-facing database API or anonymous role is used. Credentials remain
-- in the Vercel backend; functions and tables are unavailable to PUBLIC.
REVOKE ALL ON strata_state,strata_worker_leases,strata_signer_jobs,strata_proofs,strata_transactions FROM PUBLIC;
REVOKE ALL ON FUNCTION strata_claim_worker(text,uuid),strata_renew_worker(text,uuid),strata_release_worker(text,uuid),strata_save_state(text,jsonb,uuid),strata_save_signer_job(text,text,jsonb,uuid) FROM PUBLIC;
