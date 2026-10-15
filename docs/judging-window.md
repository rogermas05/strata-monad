# Two-week judging window

Gas correction, 15 October UTC: the ten-minute global wake loop has been removed.
**Enable trading** requests one pass for the selected book (up to four explicit
strategy legs). Only their assets' signed prices are relayed. The request is
consumed before any signing, so cron retries cannot keep spending. Requested
maker passes no longer cancel unrelated stale books; automatic House quoting,
shelf rotation and expired-maker cleanup are excluded from a trading request.
Display prices and expiry/vault lifecycle maintenance remain scheduled.

Each role's hosted signer now reserves the complete signed transaction's maximum
native cost against a durable **0.3 MON per UTC day** ceiling, including gas and
Pyth fees. Reservations survive cold starts and are idempotent by signed hash.
They are conservative and are not refunded for unused gas. A 0.25 MON balance
floor also applies. Rejected requests never become pending signed jobs. A budget
pause appears in the UI and resets at 00:00 UTC; existing funded books with fresh
prices remain tradable, but maintenance may pause at the ceiling.

At the start of this correction the keeper held **6.923440298 MON**, and the maker
held **7.024557592 MON**, including the latest five-MON top-ups to each. Fifteen
UTC daily allowances cost at most 4.5 MON per role, below these balances. Daily
faucet funding is not the operating plan. The earlier 16/4 refill recommendation
below is superseded. Do not repeat deployment or initial funding operations.

Current status,15 October UTC: the live site uses Neon Free for state. All28 new
October30 contracts are deployed and verified; all24 currently open fresh books
have funded bids and asks. Four new QQQ/TSLA books are session-closed and receive
missing-depth priority when open. The five-second scheduler is active. Trading
has been returned to display mode to preserve gas; visitors click **Enable
trading** to wake the live relays and maker.

Final read-only checks passed at block71122845: all unexpired series were fully
backed, aggregate custody covered escrow, maker risk bounds were respected,
public portfolio claims matched the0.1-contract verification, receipt history
included its canonical transaction, and health was HTTP200 without worker errors.
Autonomous display maintenance was subsequently confirmed without errors.

After returning to sleep, native balances were approximately1.9234 MON keeper and
2.0246 MON maker. These are operating reserves, not a fourteen-day guarantee under
arbitrary traffic. At the next faucet reset, add16 MON to the keeper and four to
the maker for more judging reserve. Do not repeat contract deployment, wrapping,
the2.5-MON gas rebalance, or the completed verification purchase.

The chronological preparation and migration notes follow; their older blocking
conditions have been resolved by the Neon migration and completed renewal.


Prepared on 13 October 2026 (America/Los_Angeles), through 27 October local time.

The live demo is https://strata-xyz.vercel.app. Browsing uses real offchain Pyth
display prices while signed trading updates sleep. Visitors can click **Enable
trading**, which wakes signed price relays and market-making for ten minutes.
Wallet trades require Monad testnet MON for gas and the account-menu dUSDC faucet.

## Completed upkeep

- The Supabase worker schedule is active every five seconds.
- Idle workers run expiry settlement and vault launch/roll maintenance at most
  every thirty seconds when the keeper has sufficient gas. They do not replenish
  trading quotes while sleeping.
- Historical vault-log backfill progress is persisted in the cloud read model.
  Cold starts can resume interrupted backfills and avoid replaying completed ones.
- Unit/service tests cover idle expiry maintenance and interrupted backfill recovery.

## Funding prerequisite and market renewal

The existing nine additional assets only have contracts expiring 16 October.
MON/BTC/ETH/XAU also have contracts expiring 23 October. Wallet top-ups alone
therefore do not keep every asset tradable for the judging window.

`scripts/testnet-renew-shelf.ts proposal` prepares an unsigned shelf of 28 new
contracts: MON calls/puts plus bull/bear spreads across all 13 admitted assets.
The contracts expire 30 October, respecting each asset's scheduled session close.
Old contracts remain listed for exits and historical claims.

The proposal is at `.runtime/testnet/judging-window/proposal.json`. It is not a
signed execution plan; its nonces are provisional. The estimate uses 0.5 MON per
new contract, based on prior public deployment costs, plus two MON of keeper
reserve. Required initial balances are 16 MON keeper and four MON maker.

The user has a 20-MON-per-day faucet limit and has exhausted today's allowance.
At reset, allocate the next 20 MON as:

- 16 to keeper `0xF77E7BBfa05cBBc749C62F5dF6d47e9BE6961224`.
- Four to maker `0x7619e4Fad38aedE07aBFcA6c9ce85Aeaa4535103`.

The maker currently also has about 0.704 MON. One MON will be wrapped for the new
covered-call inventory. All funding is native **Monad testnet** MON.

These are deployment and initial operating reserves, not a guarantee of fourteen
days of gas under arbitrary traffic. Further faucet allowances can build reserves.

## 14 October funding and database restriction

Funding has arrived: keeper20.051225356 MON and maker5.174408948 MON. No renewal
transaction has been sent. Supabase REST currently returnsHTTP402 with
`exceed_egress_quota`, which also prevents the required distributed signing lease.
The user said they will restore project access in the dashboard. Await actual
REST recovery before signing or declaring the live demo restored.

Deployed data-transfer changes at `dpl_8cfWHd694C4frrYA2bSQRXXNzKsG`:

- Large snapshots and read models use gzip/base64 envelopes; legacy raw rows
  remain readable. A saved snapshot measured75% smaller including base64.
- Warm processes check `updated_at` and only download changed large state.
  Writers retain their confirmed state locally after a successful save.
- Health reads use compact worker metadata once the next worker pass completes.
- Idle browser polling is10 seconds; waking/active trading keeps3-second polling.
-155 unit/service tests, TypeScript and frontend build passed. Live database
  integration remains blocked by the quota restriction.

All state consumers must use `loadCloudState` to decode compressed rows. A raw
REST read of `public-snapshot` or `read-model:*` may now return an envelope.

The renewal command also supports `deploy`, which prepares and executes the
immutable plan under one continuous worker lease. This avoids a signing gap
between the two commands. It can resume an existing plan. Never force-release an
active worker lease. Supabase management CLI currently has no access token in this
session; if cron cannot be paused, the same distributed lease must remain held for
the entire operator deployment while scheduled invocations return already-running.

## Execution after funding

Pause `strata-public-worker` cron and wait until the signing lease is released.
Do not force-release an active lease or race the hosted signer.

```sh
npx tsx scripts/testnet-renew-shelf.ts prepare
npx tsx scripts/testnet-renew-shelf.ts execute
npx tsx scripts/testnet-renew-shelf.ts fund
npx tsx scripts/verify-expansion-sources.ts .runtime/testnet/judging-window
npx vercel --prod --yes --force
npx tsx scripts/run-hosted-liquidity.ts 28 45 .runtime/testnet/judging-window
```

The liquidity tool wakes trading deliberately. Before using cursor 45, verify the
actual active shelf ordering; expired original books change its length. Funding
passes must cover every new book and respect existing inventory/collateral limits.
Inspect the result rather than treating a fixed number of passes as certification.

Resume cron, confirm fresh HTTP 200 health samples and funded depth on all
open-session new books, then verify one small wallet trade and its receipt.
QQQ/TSLA remain session-paused outside regular US trading hours.

The renewal plan and journals are immutable and resumable. Never overwrite a
completed plan, redeploy the existing engine, or repeat a completed verification
trade to guess whether an earlier transaction landed. Backend keys, scheduler
tokens and signed journals stay private and ignored.


## Neon migration (15 October UTC / 14 October local)

Supabase REST remains restricted by its data-transfer quota. The user's Neon
Marketplace terms are accepted. Vercel's `strata-state` resource uses the Neon
Free plan in `iad1`; no paid upgrade or spend-cap removal was performed.

The backend now prefers `STRATA_STATE_DATABASE_URL`. It does not fall back to
Supabase when Neon fails: signing has exactly one durable authority. Credentials
stay in the backend. Tables/functions are revoked from PUBLIC, and the optional
browser Data API and Neon Auth are disabled.

Direct Supabase Postgres remained accessible with the existing database password
and verified Supabase CA. It provided a consistent export after the scheduler was
paused and the old lease expired. All seven state rows, 756 signed journal rows,
3,726 oracle archives and eight transaction records were copied. Every table's
row count and SHA-256 digest matched the transformed source. Signed bytes,
receipt records and proof payloads were preserved. Only saved chart observations
were sampled to one per minute and large state compressed. Reports and the
private source export are in ignored `.runtime/cloud/` files with mode 0600.
The initial Neon database occupied about 32 MB.

Idle workers perform a full display/maintenance pass once a minute. The existing
five-second scheduler still checks for a wake, which bypasses the idle throttle.
Active trading retains the 15-second confirmed-view gate and the engine's
60-second oracle freshness limit. The idle change does not authorize trades from
stale prices. Gzip plus minute chart observations reduced a representative saved
snapshot from 201,224 bytes to 26,521 bytes.

The scheduler still runs in Supabase (`pg_cron`/`pg_net`) and calls the stable
Vercel worker URL. It uses no Supabase REST state. Operator commands can control
it through the verified direct connection:

```sh
npx tsx scripts/set-worker-schedule.ts off
# Wait for the live worker lease to expire or be released; never force it.
npx tsx scripts/set-worker-schedule.ts on
```

Current operator tools load `.env`, then ignored Supabase credentials, then only
`STRATA_STATE_*` values from `.runtime/cloud/neon.env`. Do not load unrelated
redacted values from an integration environment pull over working signer keys.
Do not run the one-time source migration again after new trading/signing activity.

Schema and recovery commands:

```sh
npx tsx scripts/neon-migrate.ts
npx tsx scripts/rebuild-cloud-state.ts
```

A recovery that needs MON's offchain display price also supplies the already
verified `PYTH_PUSHED_FEEDS=MON`, testnet RPC, and Pyth pushed contract settings
used by production. Recovery reads the chain and holds the state lease; it does
not run a signer. The judging-window maker profile raises only the total written
limit from 500 to 650 contracts so the old and fresh shelves can coexist. The
existing per-book allocations, 800-contract portfolio limit, 600-contract expiry
limit, native reserves, and full contract collateral remain enforced.

164 unit/service tests, TypeScript and the production build passed before the
Neon deployment (`dpl_CZNmyLHHrpyPuoh7xNYFASuJvEPk`). The public API returned HTTP
200 with all 13 assets, the House vault, and no worker errors after catch-up.
Market renewal and final liquidity/transaction checks are recorded below once
complete.


The28 new markets and112 reviewed transactions passed the public contract
configuration/custody checks. All28 new Kuru adapters have exact Sourcify matches;
73 series are retained. Fresh expiries run from30 October08:00 UTC (crypto) to
21:00 UTC (metals/FX), beyond29 October00:39 UTC. Actual wrapping added1 WMON for
the new covered call, hash `0xb75757e00d6797544e57a4da86913983056f4f8d54d5c58c93cae08ab09382f9`.

The larger shelf exposed a slow sequential vault-valuation loop. Custody reads
and underlying oracle reads now run concurrently at the same confirmed block.
Recent hosted passes fell from167 seconds to roughly50–75 seconds. Public health
has its own compact confirmed-view row, updated alongside snapshots, so a long
worker pass does not hide a more recent successful view. Empty books that can
be funded receive priority when sessions reopen; capped sold-out inventory does
not monopolize this priority. Public read routes run alongside maintenance and
public portfolio reads use larger multicall batches. Local forks retain their
small cold-storage read batches.165 unit/service tests passed after these changes.

Long HTTP connections occasionally close before the hosted worker returns. The
liquidity tool now waits for the actual distributed lease to end, checks durable
cursor progress, and only then retries or resumes. It never assumes that a lost
HTTP response means a signed transaction failed. `resume` preserves the cursor:

```sh
npx tsx scripts/run-hosted-liquidity.ts 10 resume .runtime/testnet/judging-window
```

QQQ and TSLA cannot be newly written or traded while their sessions are closed.
Verify all24 currently open fresh books, then verify scheduled quotes when their
sessions reopen. The paused scheduler must be restored after manual funding.


Project-funded verification purchase completed once:0.1 contracts of
`MON-1030-0.022/0.024-BULL` delivered exactly0.1 claims. Transaction
`0x76c3684799fe821b204bf87b15aa7ca4751d6e31a154c8dacf287e87622acb75`
was registered through the public transaction endpoint with HTTP200, operation
`execute`, included at block71119643. The premium budget was126 micro-dUSDC.
The baseline and result are retained privately; never repeat this completed
verification to check whether it landed.

An exact2.5 testnet MON transfer rebalanced keeper gas into the maker without a
new faucet claim: `0xc5cc7dd4b9b11e99acd7f56f3a718be48303f2f8a29948186d1942db69dde9e3`.
The guarded `gas` renewal mode requires the same worker lease and preserves a
two-MON keeper allocation before sending. Do not rerun its recorded transfer.

Deployment source was committed and pushed as `d7139eb`. An isolated checkout
passed165 tests, TypeScript and frontend build. The original local demo price
changes in `runtime.ts`, `workers.ts` and `demo-prices.ts` were preserved outside
this commit. Vercel's Git deployment `dpl_HJhQWNpJbMhLwY1E6JwX47LW1znu` is ready.
The public portfolio read measured3.5 seconds after batching, versus26 seconds
before. Native balances still need replenishing for sustained usage; idle display
passes and expiry maintenance continue without live repricing.


All24 currently open fresh books now have both funded sides; four QQQ/TSLA
books remain session-closed.166 tests pass, including explicit isolation of public
read requests from a live worker lease. Fast public reads cannot borrow or renew
the worker's lease. Final custody, canonical-block, portfolio, receipt and health
checks are performed against the live deployment before resuming judging.


## Final operating confirmation

The final report is `.runtime/testnet/judging-window/final-readiness.json`.
Contract custody was checked with exact integer reads at one canonical block.
The four session-closed new market IDs are66–69. The public receipt and portfolio
checks passed for the actual project verification trade. Original claim routes
and all73 retained series remain available.

Scheduler control now uses the verified TLS session pooler in us-west-1; the
OS resolver intermittently failed on Supabase's IPv6-only direct hostname.
The restored job was confirmed active every five seconds, and autonomous worker
success advanced to display mode with no errors. The idle snapshot HTTP route
continues returning200; trading readiness retains its strict freshness gate.
