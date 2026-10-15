# Public Monad testnet demo

Verified 13 October 2026 UTC.

## Open the demo

Website: https://strata-xyz.vercel.app (the original https://strata-monad-demo.vercel.app still works). API health: https://strata-xyz.vercel.app/api/health. Chain 10143, RPC `https://testnet-rpc.monad.xyz`.

Connect an injected browser wallet, switch to Monad testnet, and keep native testnet MON for gas. The account menu offers the rate-limited dUSDC faucet and native WMON wrapping. Start with 0.1 contracts on an active MON book. Review approvals, funding and execution in the wallet. The public service does not sign customer orders or expose local demo mutation endpoints.

Thirteen assets are listed: MON, BTC, ETH, XAU, SOL, XRP, DOGE, BNB, HYPE, QQQ, TSLA, XAG and EUR/USD. The manifest retains 45 series, with 43 unexpired contracts across the 16/23 October shelf. Eighteen new capped bull/bear spreads cover the nine additional assets. Scheduled markets open only during their recorded Pyth sessions; QQQ and TSLA remain paused outside US regular trading hours. MON puts target 50 contracts per side, native-backed calls one, older capped spreads up to three and the new spreads five, subject to shared funding/risk limits. Actual fractional depth is shown.

The selector searches every listed asset and displays its actual contracts, prices and funded depth. The compact overview scrolls horizontally on larger shelves. Two expired MON instruments remain for history/exits. Future demonstrations must list a fresh shelf and preserve old claim routes. Price history contains authenticated observed prices, without invented candles or fills.

Current hosting/storage and the October30 renewal are documented in [judging-window operations](judging-window.md). The sections below retain the original deployment history.

## Hosting and worker operation

- Vercel project `strata-monad-demo`, scope `rogermas05s-projects`: static terminal and Node API, HTTP polling, Node 24.
- Supabase project `ygdhgcbnsekoabmkrxzf`, name `Strata Demo`, region us-west-1: private service state, signer journals, receipts, proof archive and distributed worker lease. RLS and privilege revocation exclude browser roles from these tables.
- Supabase cron `strata-public-worker` runs every five seconds. It calls the bearer-protected Vercel worker; overlapping requests return `already-running` under a renewable lease. Each successful pass updates prices, rotates one maker book, checks expired custody and persists its read model.
- A confirmed Supabase snapshot is served quickly. A snapshot over 15 seconds old disables new exposure. Oracle or RPC outages also pause new exposure; existing venue orders require actual cancellation transactions.
- `STRATA_PUBLIC_WORKERS=1` explicitly enables role-scoped backend worker signing. `API_READ_ONLY=1` disables workers. Neither setting permits customer impersonation.
- Public repricing waits for half the configured spread. Books replenish below 70% of target depth and immediately remove size beyond current risk limits. Notional-capped bids are initially placed at 90% of the hard dollar cap, preventing tiny BTC spot changes from replacing whole books. Size, backing, risk and stale-oracle checks still run each cycle. Live Hermes feeds share one authenticated signed accumulator packet per relay. Before public maker transactions, prices within20 seconds of their immutable age limit are refreshed using genuine signed evidence and checked again. Long funding passes also relay before publishing their final snapshot. Worker failures are persisted and exposed in health and the liquidity console. Native gas must be replenished for keeper and maker accounts. MON call inventory is backed by actual wrapping. dUSDC is a test token, and liquidity is project-funded.

Backend credentials live only in ignored `.env`, `.runtime/cloud/supabase.env` and Vercel production environment variables. Never copy private keys, service-role credentials, provider tokens or signed worker bearer tokens into frontend variables, manifests or documentation. Vault stores the scheduler endpoint/token. Runtime artifacts and scheduler SQL are private ignored files.

Inspect scheduler status without revealing its command:

```sh
npx --yes supabase@latest db query --project-ref ygdhgcbnsekoabmkrxzf --linked "select jobname,schedule,active from cron.job where jobname='strata-public-worker';"
```

Before using an operator CLI that signs with either worker account, pause this job and wait for the worker lease to be released. A local process lock cannot coordinate with a hosted signer. Resume the job after the CLI receipts are reconciled.

```sql
select cron.alter_job((select jobid from cron.job where jobname='strata-public-worker'), active := false);
-- After the operator's work completes:
select cron.alter_job((select jobid from cron.job where jobname='strata-public-worker'), active := true);
```

## Deployment and evidence

| Component       | Address                                      |
| --------------- | -------------------------------------------- |
| Options engine  | `0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C` |
| Strategy router | `0xb32F444cFA93EC088548ac5996b276648d501aAd` |
| Oracle router   | `0x41F93DB8cF7A00920139222883e5822B9dFCeEA1` |
| dUSDC           | `0x0A20AA723B6a49317709bC153a31Af4A7820e69c` |
| Wrapped MON     | `0x301f1ec8615580a6c691E437d7A42F5Cd26E2234` |
| Pyth verifier   | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |
| Deployer/keeper | `0xF77E7BBfa05cBBc749C62F5dF6d47e9BE6961224` |
| Project maker   | `0x7619e4Fad38aedE07aBFcA6c9ce85Aeaa4535103` |
| House vault     | `0x4E6537315026f2Fb85857B38A1dFe749F47bC683` |
| STRATA          | `0xd04fDfDC43368dEaC6379D6826E86C4C3fC85335` |
| STRATA staking  | `0x49Addcce2346b6598D167A706fbCd0B51e0D7bc6` |
| Distributor     | `0x904f18A3D4052AD2cbDBC9da8A2A18Cb03e0A896` |

The original 52 signed deployment transactions were reconciled against exact package targets/calldata/nonces and canonical successful receipts. Deployment checks passed. Four more signed steps added a short MON expiry instrument, bringing the manifest to eleven series. The original MON maker bootstrap passed 22 signed transactions; hosted workers subsequently funded all active asset books.

Core contracts and all twenty-seven exact-fill adapters have exact creation/runtime matches on Sourcify. Verification report: `.runtime/testnet/source-verifications.json`. Source: https://repo.sourcify.dev/10143/0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C. Etherscan mirroring hit its daily/rate limits; do not label this Etherscan verification.

Public purchase: 0.1 MON weekly put (series 2), exact claim delivery:
`0xe5e1e39894b8d533556692142ef5f932bec672fc08f02c90a2e6b0da391fea10`.

Separate funded short-expiry put (series 11): signed Pyth last-before candidate observed five seconds before expiry, challenge period completed and immutable reference finalized. A 0.1 claim was handed from maker to holder after expiry (`0x262b652af53673b5b82cc8c999ae731942ee507a36bf08daa7d7638a6f0626d2`). The holder then received exactly 478 micro-dUSDC and burned all its claims:
`0x6c3db8292def37944988912a4d39c3a5da740a5fe42b681d96d6444f92d54b9e`.
This proves a real venue purchase and a separate funded expiry payout, rather than purchase-to-expiry on the same instrument.

Private evidence: `.runtime/testnet/{manifest,verification,signed-journal,bootstrap-verification,demo-purchase,demo-transfer,demo-claim}.json`, `.runtime/public-health-samples.json` and cloud transaction/proof records. These contain runtime evidence, not instructions to repeat a completed deployment.

## Public execution tooling

Preparation admits authenticated updates and produces an unsigned reviewed package. Exact signed execution rejects changed artifacts, targets, factory dependencies, nonces and reorganized receipts. Durable signer journals retain the signed envelope before sending; restart reconciles its original hash instead of signing a replacement.

```sh
# For a deliberately new deployment only; do not overwrite the live package:
npx tsx scripts/testnet-prepare.ts
npm run deployment:package -- execute-signed --input .runtime/testnet/package.json --out .runtime/testnet
npm run deployment:check -- --manifest .runtime/testnet/manifest.json
npm run maker:bootstrap -- execute-signed --input .runtime/testnet/bootstrap.json --out .runtime/testnet
npx tsx scripts/cloud-publish.ts
npx vercel --prod --yes
```

The public RPC transport paces calls and reads logs in at most 100-block ranges. Fork gas estimates underpriced actual public gas; use current public fee estimates and sufficient balance. Operator scripts must not race scheduled worker signing.

MON expiry uses authenticated pushed evidence, last-before selection, a 3,600-second lookback and a 300-second challenge window. BTC/ETH use Pyth's unique first-after proof; XAU uses last-before session-close evidence. The engine's immutable live maximum age is 60 seconds. Provider errors never manufacture a price.

Actual public CLI signing/purchase/payout and public desktop/mobile rendering were checked. The local browser suite uses a real local injected wallet. A particular public wallet extension still needs the presenter to connect it; no wallet was attached to the public preview during validation.

## Final validation

117 unit/service tests and 31 contract tests passed, with one explicit external Kuru fork skip; TypeScript, frontend build and formatting passed. All 23 local browser cases passed, followed by a successful workspace/dialog/mobile check after UI polish. The final public health sample returned HTTP200 on all twelve checks with no worker errors, and both worker authorization and server-side customer-action probes returned403. No configured backend secret appeared in the built frontend bundles.

After restoration, the maker journal remained at nonce101 across repeated scheduled cycles, avoiding repeated replacement of unchanged quotes. A one-MON internal transfer replenished maker gas from the deployer reserve. The user subsequently topped up both accounts. At the follow-up check, maker held 10.6487 testnet MON and deployer/keeper 11.2895 MON. The five-second scheduler was active, health was ready with no worker errors, and all nine active markets had both funded sides. Continue monitoring native gas for sustained operation; evidence is retained in `.runtime/testnet/funding-confirmation.json`.

## Market-selector and liquidity expansion

The terminal has a searchable market selector with persistent favorites, asset/type/UTC-expiry filters, keyboard navigation, and sorting by funded depth, open interest or observed traded volume. Contract rows expose mark, bid/ask, two-sided depth and outstanding claims. The compact overview uses actual observed price sparklines. The selected instrument remains fixed when prices update. Cash-settled puts, bull spreads and bear spreads share a compact contract table; expired rows remain available through explicit selection and settlement/history routes.

Sixteen additional series were deployed through 64 exact signed transactions. The original eleven entries were retained, yielding27 total series and25 active books. All16 new adapters have exact Sourcify matches in `.runtime/testnet/expansion/source-verifications.json`. The prior seven core and eleven adapter verifications remain valid.

Expansion funding used a rate-limited public faucet, an exact15,000 dUSDC transfer to maker, and actual wrapping of4 native MON. Role-scoped cloud journals and the distributed worker lease coordinate operator commands with scheduled workers. Asset/kind inventory targets share the existing portfolio, expiry, issuance and underlying-notional limits; they never substitute for contract collateral.

Twenty-five bounded hosted passes funded every active book and increased outstanding claims to approximately333.879 aggregate option units, including existing holder claims. This count combines different underlyings and is not a dollar-notional measure. A separate five-contract verification purchase on new MON series13 delivered exactly5 claims with a0.5% premium limit, hash `0x869e3a5ee10e2a1a4f32b44a6bae4904afe26768c7aade99f0d5913d546445b3`. This is a project verification trade, not independent user demand. Actual traded volume remains separate from issued contracts and book depth.

New operator commands (pause cron and wait for the worker lease first):

```sh
npx tsx scripts/testnet-expand.ts fund
npx tsx scripts/testnet-expand.ts prepare
npx tsx scripts/testnet-expand.ts execute
npx tsx scripts/verify-expansion-sources.ts
npx tsx scripts/run-hosted-liquidity.ts 25
npx tsx scripts/verify-expanded-depth.ts
```

The expansion plan and immutable journals are retained under `.runtime/testnet/expansion`. Do not create another plan over completed evidence or repeat a completed verification purchase. `execute` resumes the original exact steps. The hosted-pass command rotates existing books and may spend gas; use it only for an intentional maintenance pass.

Validation after the expansion:119 unit/service tests, TypeScript, frontend build and formatting passed. Focused browser checks covered all workspaces, dialogs/mobile, search/favorites/keyboard/expiry filters and scheduled-asset trading/settlement. A separate browser fixture checked that public default selection stays fixed as refreshed prices cross a strike. Public signing and a five-contract fill supplied actual network evidence independently of these UI fixtures.

The final public receipt-registration check exposed an HTTP forwarding bug: an already-buffered request was marked incomplete, so Node destroyed its socket when the POST body ended. `forwardedRequest` now marks the message complete and removes chunked framing. A real HTTP regression passes with the fix and fails against the previous behavior. The public five-contract receipt subsequently registered as included with HTTP200. Public portfolio reads also passed. Evidence: `.runtime/http-forward-*` and `.runtime/testnet/expansion/depth-transaction-registration-fixed.json`.


## Asset expansion (13 October)

The user chose the 13 supported assets first after requesting 15–20. The current Pyth key authenticates SOL, XRP, DOGE, BNB, HYPE, QQQ, TSLA, XAG and EUR alongside the original four. AVAX, ADA, LINK, DOT, LTC, SUI and NEAR remain candidates: current provider grants deny their updates, and on-chain checks found no usable fresh pushed proof. Candidate registry entries do not create selector tabs or tradable markets.

The reviewed asset expansion added nine immutable oracle bindings and 18 fully cash-settled capped spreads in 81 exact signed transactions. Source, admission, canonical deployment and funding evidence lives under `.runtime/testnet/asset-expansion`. Archived history and live prices passed the actual deployed Pyth verifier. The 12 Hermes-backed live feeds also passed a single-packet verification call; MON continues to use authenticated pushed updates.

Operator tools: `testnet-expand-assets.ts proposal|prepare|execute`, `verify-expansion-sources.ts .runtime/testnet/asset-expansion`, and `run-hosted-liquidity.ts PASSES CURSOR .runtime/testnet/asset-expansion`. Prepare/execute require cron paused and the distributed signing lease; the unsigned proposal deliberately uses provisional nonces and cannot execute. Keep existing manifests and immutable signer journals intact. Redeploy the API after publishing any new manifest, then restore scheduled workers.

All18 new exact adapters have Sourcify creation/runtime matches. Fourteen completed hosted funding passes populated all39 open-session books, with approximately408.88 outstanding option units across assets. QQQ/TSLA's four books remain session-paused and are handled by the same scheduled maker once their session is open and worker gas remains funded. These units are not traded dollar volume.

An actual one-contract SOL bull-spread purchase delivered exactly1 claim with0.5% premium protection and a10-dUSDC absolute budget bound. Hash: `0x4793f87f2f6943a68d75ed667397cd4e7e3390ca9987b8631c486b3bd2821fd8`. Public receipt registration returned HTTP200, operation execute, included at block70634445. This was a project verification trade. Scheduled workers were restored after signing completed.
