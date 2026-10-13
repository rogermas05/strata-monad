# Strata implementation handoff

Updated 13 October 2026 UTC. Workspace `/Users/rogermas/.t3/projects/metropolis`.

The user authorized fixing issues and deploying the full demo on Monad testnet, with Vercel and Supabase. Public credentials and funded accounts were supplied through ignored backend configuration. Do not ask again for deployment authorization. Never print secrets. Do not spawn agents unless separately authorized. Most source was already untracked; preserve it. No commit or PR was created during this deployment.

## Current deployment

Public website/API: https://strata-monad-demo.vercel.app. Engine `0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C`, chain 10143, 45 retained series, 43 unexpired contracts across 13 assets: MON/BTC/ETH/XAU/SOL/XRP/DOGE/BNB/HYPE/QQQ/TSLA/XAG/EUR. Scheduled books pause outside their Pyth sessions. Deployer/keeper `0xF77E7BBfa05cBBc749C62F5dF6d47e9BE6961224`, maker `0x7619e4Fad38aedE07aBFcA6c9ce85Aeaa4535103`.

Vercel project `strata-monad-demo` in `rogermas05s-projects`, Node24. Supabase `Strata Demo`, `ygdhgcbnsekoabmkrxzf`, us-west-1. Private journal/read-model/receipt/proof tables, RLS and browser-role privilege revocation, renewable worker lease and Vault-backed scheduler. See [testnet demo operations](testnet-demo.md) for exact receipts and worker configuration.

The original 52 reviewed signed transactions completed, were reconciled with canonical exact transactions and passed deployment checks. Four additional signed steps added short MON series 11, followed by manifest re-verification. Twenty-two signed maker bootstrap transactions funded the MON shelf; hosted worker passes funded remaining books. Real 0.1-contract weekly MON purchase passed. A separate funded expired claim handoff and authenticated settlement paid exactly 478 micro-dUSDC and burned holder claims. Do not call this a single instrument purchase-to-expiry drill.

Seven core contracts and all 45 adapters have exact Sourcify creation/runtime matches. Etherscan mirroring hit submission limits. The series-11 adapter also has an exact match in `.runtime/testnet/source-verification-extra.json`.

## Implementation completed

- Managed signer uses offline account signing, exact role/target/calldata/value authorization, backend-only configured keys, cost/nonce bounds and signed-envelope-before-broadcast persistence. Cloud journals load pending jobs and latest canonical receipts under the worker lease. Restart reconciles original hashes; it does not repeat issuance/quotes to guess whether the old transaction landed.
- Signed deployment/bootstrap executors reconstruct reviewed plans against trusted artifacts and pinned dependencies. Local rehearsal and public receipts validate actual signing; local fork gas estimates did not predict public gas adequately.
- Runtime separates local unlocked customer actions from opt-in public role signers. Public customer/local demo mutation endpoints reject with 403. Browser wallets sign their own actions. Keys never enter `VITE_*` or manifests.
- Pyth keeper authenticates actual public verifier updates, archives payloads before broadcast, relays live prices, and finalizes listed expiries with their immutable policies. MON is last-before pushed evidence with five-minute challenge; BTC/ETH unique first-after; XAU session-close last-before. Engine maximum live age is 60 seconds.
- Supabase persists read model, observed charts, receipts, worker state and signed journals. Vercel uses HTTP polling and Node HTTP Fastify serving. Generated TypeScript ABIs avoid Vercel's JSON-import-attribute transpilation issue.
- Public RPC transport is paced; logs are fetched in at most 100-block inclusive ranges. Viem multicall batches public reads.
- Confirmed public snapshots are served from Supabase quickly; views older than 15 seconds pause new exposure. Independent frontend connection and onchain oracle checks remain enforced. API degradation does not fabricate prices or receipts.
- Public disconnected portfolio no longer impersonates a local demo account. Public order/writing defaults are small quantities; strike precision and actual Pyth chart labels are preserved.

## Local environments to preserve

Controlled local fork: terminal5173, API3001, RPC8546, chain31337,64 instruments across MON/SPY/XAU. Separate authenticated Pyth local environment: terminal5174, API3002, RPC8547,80 instruments. `.runtime/manifest.json` belongs to the controlled local environment; `.runtime/testnet/manifest.json` is the public manifest. Do not replace local state with public/rehearsal manifests or reseed unnecessarily.

## Validation

Final validation: 117 unit/service tests,31 contract tests, one explicit external Kuru fork skip, TypeScript and frontend build passed. All 23 local browser regression cases passed in 6.7 minutes (`.runtime/final-browser.log`); the workspace/dialog/mobile case also passed after the final UI polish (`.runtime/final-ui-polish.log`). The earlier run passed22 and failed one oracle fixture, then the corrected fixture's focused two cases passed. Fixtures test interfaces and wallet behavior; public signed Pyth checks supply separate authentic evidence.

Public purchase/payout and desktop/mobile rendering passed. No public wallet extension was attached in the preview, so a presenter still connects their wallet. CLI success is not a particular wallet-extension test. User visual design acceptance has not been assumed. The weekly public shelf expires16 October2026; later presentations require new series while retaining old exit routes.

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
