alter table public.strata_signer_jobs add column status text generated always as (value->>'status') stored;
