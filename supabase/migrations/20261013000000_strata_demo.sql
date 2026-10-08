-- Backend-only state. No signer bytes, service keys or worker control are public.
create table public.strata_state (id text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table public.strata_worker_leases (id text primary key, owner text not null, expires_at timestamptz not null);
create table public.strata_signer_jobs (
  domain text not null, id text not null, nonce bigint not null, hash text not null, value jsonb not null,
  primary key(domain,id), unique(domain,nonce), unique(domain,hash)
);
create table public.strata_transactions (domain text not null, hash text not null, account text not null, created bigint not null, value jsonb not null, primary key(domain,hash));
create table public.strata_proofs (id text primary key, value jsonb not null);
alter table public.strata_transactions enable row level security;
alter table public.strata_proofs enable row level security;
revoke all on public.strata_transactions, public.strata_proofs from anon, authenticated;
grant all on public.strata_transactions, public.strata_proofs to service_role;
alter table public.strata_state enable row level security;
alter table public.strata_worker_leases enable row level security;
alter table public.strata_signer_jobs enable row level security;
revoke all on public.strata_state, public.strata_worker_leases, public.strata_signer_jobs from anon, authenticated;
grant all on public.strata_state, public.strata_worker_leases, public.strata_signer_jobs to service_role;

create function public.strata_claim_worker(lease_name text, owner_id text) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.strata_worker_leases values (lease_name,owner_id,clock_timestamp()+interval '120 seconds')
    on conflict(id) do update set owner=excluded.owner,expires_at=excluded.expires_at
    where public.strata_worker_leases.expires_at < clock_timestamp();
  return found;
end; $$;
create function public.strata_renew_worker(lease_name text, owner_id text) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.strata_worker_leases set expires_at=clock_timestamp()+interval '120 seconds'
    where id=lease_name and owner=owner_id and expires_at>clock_timestamp();
  return found;
end; $$;
create function public.strata_release_worker(lease_name text, owner_id text) returns void language sql security definer set search_path = '' as $$
  delete from public.strata_worker_leases where id=lease_name and owner=owner_id;
$$;
create function public.strata_save_state(state_id text, state_value jsonb, owner_id text) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.strata_worker_leases where id='strata-public-worker' and owner=owner_id and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Worker lease lost'; end if;
  insert into public.strata_state values(state_id,state_value,now()) on conflict(id) do update set value=excluded.value,updated_at=excluded.updated_at;
end; $$;
create function public.strata_save_signer_job(job_domain text, job_id text, job_value jsonb, owner_id text) returns void language plpgsql security definer set search_path = '' as $$
declare previous jsonb;
begin
  perform 1 from public.strata_worker_leases where id='strata-public-worker' and owner=owner_id and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Worker lease lost'; end if;
  select value into previous from public.strata_signer_jobs where domain=job_domain and id=job_id for update;
  if previous is not null and (previous - 'status' - 'block' - 'block_hash') is distinct from (job_value - 'status' - 'block' - 'block_hash') then
    raise exception 'Signed intent changed';
  end if;
  insert into public.strata_signer_jobs values(job_domain,job_id,(job_value->>'nonce')::bigint,job_value->>'hash',job_value)
    on conflict(domain,id) do update set value=excluded.value;
end; $$;
revoke all on function public.strata_claim_worker(text,text), public.strata_renew_worker(text,text), public.strata_release_worker(text,text), public.strata_save_state(text,jsonb,text), public.strata_save_signer_job(text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.strata_claim_worker(text,text), public.strata_renew_worker(text,text), public.strata_release_worker(text,text), public.strata_save_state(text,jsonb,text), public.strata_save_signer_job(text,text,jsonb,text) to service_role;
