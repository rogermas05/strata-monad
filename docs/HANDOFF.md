# Strata implementation handoff

Updated 15 October 2026 UTC. Workspace `/Users/rogermas/.t3/projects/metropolis`.

The user authorized fixing issues and deploying the full demo on Monad testnet, with Vercel and Supabase. Public credentials and funded accounts were supplied through ignored backend configuration. Do not ask again for deployment authorization. Never print secrets. Do not spawn agents unless separately authorized. Most source was already untracked; preserve it. No commit or PR was created during this deployment.

## Current deployment

Public website/API: https://strata-xyz.vercel.app. Engine `0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C`, chain 10143, 73 retained series, 71 unexpired contracts across 13 assets: MON/BTC/ETH/XAU/SOL/XRP/DOGE/BNB/HYPE/QQQ/TSLA/XAG/EUR. Scheduled books pause outside their Pyth sessions. Deployer/keeper `0xF77E7BBfa05cBBc749C62F5dF6d47e9BE6961224`, maker `0x7619e4Fad38aedE07aBFcA6c9ce85Aeaa4535103`.

Vercel project `strata-monad-demo` in `rogermas05s-projects`, Node24. Neon Free `strata-state` in `iad1` now stores private state, journals, receipts, oracle archives and the signing lease. Supabase `ygdhgcbnsekoabmkrxzf` supplies the existing scheduler; its restricted REST API is no longer used for state. See [judging-window operations](judging-window.md) for the current configuration and renewal records.

The original 52 reviewed signed transactions completed, were reconciled with canonical exact transactions and passed deployment checks. Four additional signed steps added short MON series 11, followed by manifest re-verification. Twenty-two signed maker bootstrap transactions funded the MON shelf; hosted worker passes funded remaining books. Real 0.1-contract weekly MON purchase passed. A separate funded expired claim handoff and authenticated settlement paid exactly 478 micro-dUSDC and burned holder claims. Do not call this a single instrument purchase-to-expiry drill.

Seven core contracts and all 73 adapters have exact Sourcify creation/runtime matches. Etherscan mirroring hit submission limits. The series-11 adapter also has an exact match in `.runtime/testnet/source-verification-extra.json`.

## Implementation completed

- Managed signer uses offline account signing, exact role/target/calldata/value authorization, backend-only configured keys, cost/nonce bounds and signed-envelope-before-broadcast persistence. Cloud journals load pending jobs and latest canonical receipts under the worker lease. Restart reconciles original hashes; it does not repeat issuance/quotes to guess whether the old transaction landed.
- Signed deployment/bootstrap executors reconstruct reviewed plans against trusted artifacts and pinned dependencies. Local rehearsal and public receipts validate actual signing; local fork gas estimates did not predict public gas adequately.
- Runtime separates local unlocked customer actions from opt-in public role signers. Public customer/local demo mutation endpoints reject with 403. Browser wallets sign their own actions. Keys never enter `VITE_*` or manifests.
- Pyth keeper authenticates actual public verifier updates, archives payloads before broadcast, relays live prices, and finalizes listed expiries with their immutable policies. MON is last-before pushed evidence with five-minute challenge; BTC/ETH unique first-after; XAU session-close last-before. Engine maximum live age is 60 seconds.
- Neon persists read model, observed charts, receipts, worker state and signed journals. Vercel uses HTTP polling and Node HTTP Fastify serving. Generated TypeScript ABIs avoid Vercel's JSON-import-attribute transpilation issue.
- Public RPC transport is paced; logs are fetched in at most 100-block inclusive ranges. Viem multicall batches public reads.
- Confirmed public snapshots are served from Neon quickly; views older than 15 seconds pause new exposure. Independent frontend connection and onchain oracle checks remain enforced. API degradation does not fabricate prices or receipts.
- Public disconnected portfolio no longer impersonates a local demo account. Public order/writing defaults are small quantities; strike precision and actual Pyth chart labels are preserved.

## Local environments to preserve

Controlled local fork: terminal5173, API3001, RPC8546, chain31337,64 instruments across MON/SPY/XAU. Separate authenticated Pyth local environment: terminal5174, API3002, RPC8547,80 instruments. `.runtime/manifest.json` belongs to the controlled local environment; `.runtime/testnet/manifest.json` is the public manifest. Do not replace local state with public/rehearsal manifests or reseed unnecessarily.

## Validation

Original deployment validation: 117 unit/service tests,31 contract tests, one explicit external Kuru fork skip, TypeScript and frontend build passed. All 23 local browser regression cases passed in 6.7 minutes (`.runtime/final-browser.log`); the workspace/dialog/mobile case also passed after the final UI polish (`.runtime/final-ui-polish.log`). The earlier run passed22 and failed one oracle fixture, then the corrected fixture's focused two cases passed. Fixtures test interfaces and wallet behavior; public signed Pyth checks supply separate authentic evidence.

Public purchase/payout and desktop/mobile rendering passed. No public wallet extension was attached in the preview, so a presenter still connects their wallet. CLI success is not a particular wallet-extension test. User visual design acceptance has not been assumed. The October30 renewal now covers the judging window. Old contracts remain listed for exits and claims.

## Operations

Follow [testnet-demo.md](testnet-demo.md). Backend secrets live in ignored `.env` and `.runtime/cloud/supabase.env`; scheduled SQL also contains a bearer token and must remain ignored/private. Use `npx --yes supabase@latest` for management SQL; the old globally installed CLI had region issues.

Scheduled worker signing and operator CLI signing must not race. Pause cron and wait for the lease to be released before signing operator transactions. Native maker/keeper gas needs monitoring and top-ups; API readiness and worker errors provide current status. Funding is testnet MON, not real assets. Keep project-funded liquidity labels.

For an interrupted local browser run, inspect `/api/health` and stop the suite before `npm run local:restore`. Restore rolls back all chain changes since its checkpoint. Avoid API hot reloads, manual local trading and parent fork rehearsals during checkpoint tests. `caffeinate -i` prevents Mac idle sleep from interrupting long regressions.

## Funding follow-up

Both requested top-ups were confirmed: maker10.6487 MON, deployer/keeper11.2895 MON at the follow-up check. Scheduler active every five seconds; service ready, no worker errors, all nine active markets funded on both sides. See `.runtime/testnet/funding-confirmation.json`. No funding request remains pending.

## Selector, tighter design and expanded depth

The user requested a Hyperliquid-like market selector, more markets and more contract volume, then said the terminal looked dead and asked for a better, tighter design. Implemented `MarketSelector.tsx` with search, favorites scoped by chain/engine, asset/type/UTC-expiry filters, sorting, live quote/depth/OI rows and keyboard selection. The compact market overview uses observed prices only. Default public selection chooses the near-money weekly MON put once and retains it as prices move. Contract headings are readable; cash-settled contracts have a dense table that includes bear spreads. Expired instruments are hidden from the normal active shelf while preserved for explicit history/exits. Presets scale with actual funded book depth. No user design acceptance is assumed.

Sixteen new contracts deployed in64 exact signed transactions with original eleven retained.25 active books across MON/BTC/ETH/XAU, expiries16/23 October2026. All16 new exact adapters passed Sourcify exact matching. Operator tooling: `testnet-expand.ts`, `verify-expansion-sources.ts`, `run-hosted-liquidity.ts`, `verify-expanded-depth.ts`; evidence in `.runtime/testnet/expansion`. Native-backed calls target1 contract, MON puts50 and capped spreads up to3; the100k underlying-notional cap still limits BTC sizing. Config has asset/kind targets plus shared risk/issuance budgets. Do not weaken portfolio or oracle guards to increase display numbers.

Expansion funding used15k dUSDC transfer and4 real native MON wrapped.25 hosted passes produced funded bids/asks on all25 active books, approximately333.879 total outstanding claim units. An actual5-contract purchase on MON series13 passed exact delivery and0.5% premium protection. Label it a project verification trade; do not imply organic volume. Hash `0x869e3a5ee10e2a1a4f32b44a6bae4904afe26768c7aade99f0d5913d546445b3`. Scheduler was resumed after the operator verification.

118 unit/service tests and TypeScript/build/format passed. Focused post-design browser cases passed for workspaces/dialogs/mobile, selector behavior and scheduled-asset lifecycle. Three selector cases subsequently passed, including public-selection stability under an explicit UI transport fixture. The previous23-case full browser and31-case contract regressions remain separate earlier evidence. Final logs use `.runtime/tighter-design-*`, `.runtime/selector-stability-browser.log`, `.runtime/expansion-final-*`. Native balances after expansion were approximately2.6115 MON keeper and1.8469 maker; monitor ongoing gas.

## Final receipt API correction

`apps/api/src/node-request.ts` forwards buffered Vercel requests as complete HTTP messages and strips chunked framing. Previously POST body consumption marked the clone aborted and destroyed the response socket, causing public receipt registration500s while snapshot/health/GET routes remained usable. A real Node/Fastify HTTP regression fails with the old incomplete flag and passes after the fix. Public registration of the five-contract purchase returned200/included; public portfolio reads returned200. The API fix is deployed. Final unit/service count119 across26 files; TypeScript and formatting passed. Production design is the compact selector/ticker and readable cash-contract table, with mobile public checks passing.

Final public checks: scheduler resumed, three health samples ready without worker errors,25 active books with both funded sides. Outstanding claims were338.879 at the final snapshot after the verification fill and replenishment; this is an aggregate of option units across assets, not dollar volume. Receipt registration HTTP200 and public portfolio HTTP200 verified.


## Latest asset expansion

User requested 15–20 underlying assets, then explicitly chose the 13 provider-supported assets first. Nine new asset bindings plus eighteen cash-settled capped spread contracts completed in81 exact signed transactions. Evidence under `.runtime/testnet/asset-expansion`; CLI `scripts/testnet-expand-assets.ts`. Extra registry entries for AVAX/ADA/LINK/DOT/LTC/SUI/NEAR remain candidates and must not enter a live manifest without genuine authenticated historical/live admission and provider access.

Current larger-shelf UI keeps a horizontal compact overview and searchable selector;20-asset rendering fixture passes mobile width, search and selection checks. Real asset count always comes from the deployed manifest. FX is an explicit asset class; EUR is quoted in USD and expires at the recorded weekly FX close. New spread targets are5 contracts with maxWritten10 per book. Existing shared500-written/800-portfolio/600-expiry/100-series limits are retained.

Fixed quote churn from exact BTC notional-cap sizing: public target uses90% of the100k cap, keeps at least70% resting depth, and still removes quantities above current hard notional/inventory/custody capacities. Batched live Hermes updates authenticate twelve feeds through one4239-byte signed packet; actual deployed-verifier eth_call passed all twelve. Bulk metadata failure falls back to existing per-feed/backup sources. Proofs remain archived before signing. Hosted passes relay again after maker funding so long bootstrap operations publish fresh prices. Public send also refreshes signed evidence when the involved asset has20 seconds or less left in its immutable age window, then rechecks the same on-chain price conditions. XAG first funding stopped on the unchanged freshness guard; remaining liquidity resumed after this fix.

Latest local checks:122 unit/service tests and4 selector browser regressions (including20-asset rendering fixture), TypeScript/build passed. Solidity unchanged. All18 new adapters have exact Sourcify matches. All39 currently open-session books have funded bids and asks; four QQQ/TSLA books remain paused outside the regular US session. Final public checks are recorded in the asset-expansion readiness artifact. Historical earlier25-book reports remain evidence of prior stages, not current shelf counts.

Final new-asset verification: actual1-contract SOL bull-spread fill delivered exactly1 claim, hash `0x4793f87f2f6943a68d75ed667397cd4e7e3390ca9987b8631c486b3bd2821fd8`; public POST receipt registration HTTP200/included at block70634445. Treat it as a project verification trade. Supabase cron restored active at5 seconds. Never rerun `verify-asset-depth.ts` after its result file exists. Final read-only readiness samples are in `.runtime/testnet/asset-expansion/readiness.json`.

## House vault, points and STRATA (local only)

User asked for the GTM flywheel to be built: a pooled house vault, points, STRATA, staking and fee sharing. Implemented, tested locally and deployed to Monad testnet on 13 October with `scripts/testnet-house.ts` (vault `0x4E6537315026f2Fb85857B38A1dFe749F47bC683`, genesis until 2026-10-14 22:15:46 UTC). Production domain is now https://strata-xyz.vercel.app; the repo is `rogermas05/strata-monad`. See [house vault](house-vault.md).

The deployment also fixed a hosted outage: the keeper had run out of gas, and afterwards a 130k-block read-model catch-up could never finish inside one 300 s pass because progress was only saved at the end. `indexTo` now saves every 100 ranges while holding the lease, and `claimWorker` ignores an in-process owner whose database lease has expired (a killed invocation never released it). The deployer was refilled with 1.2 MON from the maker; both accounts need a faucet top-up soon. Use `vercel --prod --force` if a function serves stale code.

- Contracts: `HouseVault.sol` (USDC-only, weekly epochs, cash-only share price, operator = maker key, 10% performance fee to staking), `Strata.sol` (`StrataToken` stake-only until enabled, `StrataStaking`, `StrataDistributor` cumulative Merkle claims). Engine, router and adapters are unchanged.
- Core: `points.ts`, `merkle.ts`, `house-epoch.ts`, `house-actions.ts`. API: `house.ts` (snapshot extension, account/rewards views, root publishing), `house-worker.ts` (launch, roll, quoting), routes `/api/house/:address`, `/api/rewards/:address`, local `/api/demo/house-cycle`. The worker policy admits vault/distributor calls for the maker role. Web: `House.tsx` (`/house`, `/rewards`).
- `seed.ts` now honors `MANIFEST_PATH`; `local:up` runs `house:deploy` on fresh Kuru forks; Playwright honors `E2E_BASE_URL`.
- Verification ran on an isolated stack (Anvil 8548, API 3011, web 5183, manifest `.runtime/house-it/manifest.json`); the default `.runtime/manifest.json` was not modified.

## Two-week judge availability (13 October local / 14 October UTC)

User wants the public site to work for judges over the next two weeks. They can
obtain only 20 testnet MON per day and have already exhausted today's allowance.
Funding is the remaining prerequisite; do not claim the full two-week live-trading
window is secured. At the next reset, the proposed split is 16 MON keeper and
four MON maker. Last checked balances were approximately0.0512/0.704 MON.

Implemented and deployed idle expiry/vault maintenance (without live price relays
or quote replenishment) and durable vault-log backfill checkpoints. A restart
exposed the prior repeated historical-vault replay; completed/incremental backfill
state now survives cold starts and resets on main-cursor reorg or a different
vault. Final production deployment `dpl_A3XtrCyQVQUmJ6cGC3TnsJjgY1gX`,
https://strata-xyz.vercel.app.152 tests, TypeScript and frontend build passed.
Four final public health samples returned200/ready, no worker errors; cloud state
confirmed complete vault backfill and advancing idle-maintenance timestamps.
Public terminal snapshot renders live prices with no browser console errors.
Evidence: `.runtime/testnet/judging-window/readiness-before-funding.json`.

Prepared `scripts/testnet-renew-shelf.ts proposal`:28 new October30 contracts,
112 transactions, all13 assets, MON vanilla call/put plus capped bull/bear spreads.
The unsigned proposal lives at `.runtime/testnet/judging-window/proposal.json`;
nonces are provisional. It has NOT been deployed, funded or source-verified.
Current additional-asset books expireOctober16; original core assets also have
October23 books. Top-ups alone do not renew contracts. See[judging-window.md](judging-window.md)
for reserve assumptions and exact prepare/execute/fund/verification instructions.
Pause cron and await its lease before signing. Current scheduler remains active.

Existing local demo-price changes in runtime/workers were preserved. Default local
chains/manifests were not reseeded. No commit or PR was created.

### 14 October funding confirmed; Supabase quota blocks continuation

User topped up keeper to20.051225356 MON and maker to5.174408948 MON, then asked to
continue. No renewal transactions have been sent. Public API is currently503
because Supabase REST returns402 `exceed_egress_quota` and instructs the owner to
upgrade/remove a spend cap. User explicitly said they will restore Supabase access.
They have not yet confirmed completion, and the last direct REST check still402.
Do not claim the site is healthy or the October30 markets deployed.

Data-transfer fix deployed to production at
`dpl_8cfWHd694C4frrYA2bSQRXXNzKsG`. New `cloud-state-codec.ts` compresses only large
snapshot/read-model state; old raw rows remain supported. `cloud-store.ts` checks
`updated_at` before downloading cached large rows, and caches successful writes.
Health reads compact worker metadata; idle UI polls10 seconds and active/waking
trading polls3 seconds. Saved snapshot sample transferred75% fewer bytes.
155 tests, TypeScript/build passed; live integration waits for restored database.

`testnet-renew-shelf.ts deploy` now prepares+executes under one worker lease,
resuming an existing immutable plan if needed. Supabase management CLI lacks an
access token in this session, so cron pause via CLI currently fails. Do not expose
secrets while restoring operator access. A continuous properly renewed worker
lease can serialize the operator while scheduled workers return already-running.
Next: verify database recovery, allow confirmed snapshots/indexing to recover,
deploy28 contracts, wrap call backing, verify sources, publish/redeploy, fund every
new open-session book, verify one small trade and final health/reserve balances.
Details and limitations are in[judging-window.md](judging-window.md).


## 15 October UTC / 14 October local: Neon cutover

The user accepted Vercel Marketplace Neon terms and authorized continuing the
free migration after Supabase's egress restriction. `strata-state` (Neon Free,
`iad1`, project `sparkling-unit-46649760`) is connected to the Vercel backend.
`STRATA_STATE_DATABASE_URL` is the single storage/signing authority when set;
failed Neon requests must never fall back to the old Supabase journal.

The direct Supabase connection worked despite REST HTTP402. Using the existing
ignored database password and the official Supabase CA with hostname/certificate
verification, the migration paused `strata-public-worker`, waited for the old
lease to be inactive, took a consistent snapshot and copied all four data tables.
Seven state rows,756 signed journal records,3726 oracle archives and8 transaction
records passed count/digest verification. Private export and reports are under
`.runtime/cloud/`; do not print them or repeat the source migration after new
signing begins. Original engine/positions are unchanged.

Backend implementation: `apps/api/sql/neon.sql`, `neon-store.ts`, cloud-store's
Neon routing and `cloud-retention.ts`. Real Postgres/PGlite tests cover competing
leases, stale writers, immutable signed intent fields, unique nonce/hash,
parameterized filters, receipt/proof isolation and no fallback to Supabase.
164 tests, TypeScript and frontend build passed. Initial production deployment
`dpl_CZNmyLHHrpyPuoh7xNYFASuJvEPk` restored HTTP200 snapshots with13 assets and the
House vault. Full idle passes run once a minute; a trading wake bypasses the
throttle. Chart retention is one real observation per minute; active trading
still uses the15-second view gate and60-second oracle gate.

Operator tools load only Neon-prefixed values from ignored
`.runtime/cloud/neon.env`, preserving the existing signer secrets. Direct schema
migration: `scripts/neon-migrate.ts`. Read-only chain recovery under the state
lease: `scripts/rebuild-cloud-state.ts`. Scheduler control:
`scripts/set-worker-schedule.ts on|off`. Supabase still supplies `pg_cron`/`pg_net`
HTTP calls; state no longer uses its restricted REST API. Keep the scheduler
paused during operator deployment, then restore it and verify autonomous passes.

All112 transactions for28 October30 contracts are confirmed in the immutable
judging-window plan/journal. Configuration checks, manifest publication and all28
exact Sourcify matches passed. All24 currently open fresh books have funded bids
and asks. The four fresh QQQ/TSLA books wait for their sessions; missing-depth
priority will handle them when open. The new
maker profile is `.runtime/testnet/judging-window/maker-config.json`, with total
written limit650 (was500) so old and new funded books can coexist. Other risk
bounds and per-book allocations are preserved. Do not rerun a recorded
`scripts/verify-judging-depth.ts` trade after its result exists.


The 0.1-contract new MON spread verification delivered exact claims; public
receipt registration returned HTTP200/included at71119643, hash
`0x76c3684799fe821b204bf87b15aa7ca4751d6e31a154c8dacf287e87622acb75`.
An exact2.5-MON keeper-to-maker transfer funded the final books. Both operations
have completion records and must not be repeated. Public request async contexts
cannot acquire, renew, release or borrow a worker lease, even when served in the
same process.166 tests and TypeScript passed. Final schedule/readiness evidence
is retained in `.runtime/testnet/judging-window/final-readiness.json` once checked.


## Final completion (15 October01:39 UTC)

All24 open fresh books are funded; four QQQ/TSLA books are session-closed.
At block71122845, exact integer reads confirmed backing for every unexpired
series and aggregate engine custody. Public portfolio/receipt and ready health
checks passed without worker errors. Evidence:
`.runtime/testnet/judging-window/final-readiness.json`.

The five-second scheduler is restored and autonomous display passes are
confirmed. `set-worker-schedule.ts` now uses the TLS-verified us-west-1 session
pooler because OS resolution of the IPv6-only direct hostname intermittently
failed. Trading wake was reset to sleep deliberately. Judges click Enable trading;
customer wallets need Monad testnet MON and the in-app dUSDC faucet.

Post-sleep balances were1.923440298 MON keeper and2.024557592 maker. The next
20-MON faucet allowance should replenish16/4, increasing the operating reserve
for judging traffic. Do not claim a guarantee for14 days of unlimited live relays.
Source changes are committed/pushed; original local demo price work and the
CLI-installed Neon skill files are preserved outside these deployment commits.
