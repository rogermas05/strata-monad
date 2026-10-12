# Deployment configuration and operations

The public Monad testnet demo is deployed on Vercel with Supabase persistence and scheduling. Signed deployment/bootstrap, scoped public maker/keeper signing, authenticated Pyth admission and actual public purchase/payout checks have passed. See [the current testnet runbook](testnet-demo.md) for hosting, receipts and operating instructions. Local-fork procedures below remain available for development.

## Separate browser and service endpoints

`manifest.rpcUrl` is public configuration sent to every browser. Use a credential-free endpoint. The manifest parser rejects user-info authentication, query credentials, fragments, unknown fields, inconsistent network modes, duplicate series/token IDs and invalid payoff terms. Opaque path credentials cannot be inferred reliably: never put a provider's private path token in this field.

`SERVICE_RPC_URL` overrides the API's transport only. It can carry a provider path or query credential in the ignored `.env`; it is not copied into snapshots, manifests or the frontend bundle. When the service and browser URLs differ, startup checks their chain IDs and a shared canonical block. A disagreement fails startup. Known provider credentials, transport URLs and bearer values are removed from exposed diagnostics and service error logs, including failed startup.

`RPC_URL` still selects the **local seeding/bootstrap** endpoint. It must remain a credential-free loopback URL. `FORK_RPC_URL` selects Anvil's upstream provider and is not the browser endpoint.

| Configuration                  | Behavior                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local mode / local fork        | Chain 31337 and an explicit loopback browser port.                                                                                                                  |
| Public testnet manifest        | Chain 10143 and an HTTPS browser endpoint. The public RPC's chain ID was checked read-only during this implementation.                                              |
| `API_READ_ONLY=1`              | No unlocked transactions, demo signatures, local mutation endpoints or background local workers. Browser wallets can still submit their own contract transactions.  |
| Default local signer mode      | Unlocked signing is available only when both endpoints are loopback and the chain is 31337.                                                                         |
| Public/remote service endpoint | Unlocked signing is disabled, even if it reports chain 31337. Explicit role-scoped public workers require `STRATA_PUBLIC_WORKERS=1` and configured backend signers. |

Do not place private keys or API keys in frontend environment variables, deployment manifests, command descriptions or transaction packages. Funded public account addresses are public configuration; their signing credentials are not.

## Read-only deployment check

With a compiled and deployed local environment:

```sh
npm run deployment:check
```

For another explicit manifest or report destination:

```sh
npm run deployment:check -- --manifest .runtime/testnet-manifest.json --report .runtime/testnet-check.json
```

The command checks both endpoints at a shared block and verifies:

- Code at the engine, oracle, router, assets, factory, custody, claim tokens, books and adapters; it records runtime code hashes.
- Engine/router bindings, the listed series count, asset decimals and the engine's immutable freshness window.
- Every listed token, underlying, collateral, feed, expiry, kind, strike, spread bound and registered route against onchain terms.
- Kuru base/quote and custody bindings, expiry, 0.001 MON lots, six-decimal prices, admitted tick/minimum/maximum sizes and zero fees.
- Active-series escrow against maximum required backing, and aggregate engine token balances against all recorded escrow. Expired series are not compared with pre-expiry maximum funding after payouts have begun.
- For a Pyth adapter, its fixed unique-update policy, configured verifier code and readable live price status.
- Block canonicality on both endpoints again after the checks.

Reports are atomically retained under `.runtime/deployment-checks/` by default with private file permissions. They contain contract metadata and custody, not service URLs or credentials. A malformed address/code reference and changed strike were rejected in the local negative drills.

The output separates contract/configuration verification from live-oracle health. A report can describe an otherwise valid deployment during an oracle outage; it does not approve new exposure. Proxy runtime code hashes do not certify the current implementation or upgrade policy. This command does not authenticate a historical payload, simulate a fill, prove maker profitability or broadcast a transaction. The separate `pyth:check` and deployed Kuru fork tests cover their own admission scopes.

## Service boundary drill

With the local deployment running, outside any browser checkpoint:

```sh
npm run service:check
```

This starts a temporary credentialed loopback proxy and an observer API on an ephemeral port. It checks use of the private transport, preservation of the public browser manifest, HTTP 403 for unlocked actions, readiness degradation during a forced transport failure, recovery, and credential-free snapshots/error logs. A second observer startup fails against the broken transport and must exit without printing the marker. The script stops its temporary processes and writes `.runtime/service-rpc-drill.json`. Its credential marker is synthetic; no provider access or public transaction is involved.

The observer shares the local read-model database and performs read-only chain requests. Run this drill separately from transaction suites and manual deployment changes. It does not prove public-provider availability or rate limits.

## Deployment package and rehearsal

`deployment:package` takes a strict intent JSON containing public addresses and listing terms. Preparation is read-only:

```sh
npm run deployment:package -- prepare --input .runtime/deployment-intent.json --out .runtime/deployment-review
```

The output includes `package.json` with exact calldata and creation code, plus `review.md` with the nonce range, constructor arguments, expected addresses and artifact/dependency hashes. The manifest inside the package is **expected configuration**, not proof that contracts exist. Every transaction has zero native value; deployment gas is separate. Maker wrapping, quote funding, approvals, inventory issuance and live/expiry keeper operations are separate stages.

| Intent field                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                       | `1`. Unknown fields, including credentials, are rejected.                                                                                                                                                                                                                                                                                                                              |
| `chainId`, `rpcUrl`             | 31337 with loopback for local work, or 10143 with a credential-free HTTPS endpoint for unsigned public preparation.                                                                                                                                                                                                                                                                    |
| `deployer`, `maker`, `demoUser` | Public account addresses. Deployment requires an EOA or EIP-7702 EOA. Never use publicly known Anvil keys for public accounts.                                                                                                                                                                                                                                                         |
| `factory`, `margin`             | Explicit admitted Kuru deployment addresses.                                                                                                                                                                                                                                                                                                                                           |
| `oracle`                        | Local `{ "mode": "demo", "price": "1.03" }`, or `{ "mode": "pyth", "verifier": "0x…" }`. Public native-MON packages require Pyth and the documented MON/USD feed.                                                                                                                                                                                                                      |
| `feed`, `maxPriceAge`           | Exact bytes32 reference ID and an explicitly selected engine freshness window. Public admission/latency testing remains required.                                                                                                                                                                                                                                                      |
| `assets`, `session`             | Optional. `assets` lists underlyings beside MON as `{ key, reference, volatility }`, where `key` is a registry asset; registry `candidate` assets are accepted on chain 31337 only. `session` overrides the session-close `lookback` and `challengeWindow` (defaults 4 days and 2 hours).                                                                                              |
| `series`                        | Array of `symbol`, optional `asset` (default `MON`; the symbol must start with it), future Unix `expiry`, `kind`, decimal-string `strike`, optional spread `upperStrike`, and raw-unit `cap`. Caps are 18-decimal WMON backing for calls and 6-decimal dUSDC backing for puts/capped spreads. Scheduled assets list cash-settled kinds only and must expire at a weekly session close. |

Initial expiries must leave at least five minutes and stay within one year of the anchor. Symbols identify native MON instruments; duplicate numeric terms such as `1.05` and `1.050` are rejected. The sender must have no pending transactions, and its nonce must remain unchanged during preparation.

Every package deploys an `OracleRouter` in the engine's oracle slot with a 24/7 adapter and a session-close adapter, then binds each listed asset once. See `docs/multi-asset-oracles.md`.

The builder predicts top-level CREATE addresses from the sender nonce, option-token CREATE addresses from the engine, and Kuru CREATE2 addresses through the actual factory's address calculator. It records the factory's ERC-1967 implementation slot, implementation pointers and dependency code hashes. A change requires fresh review rather than silently retargeting the package. The actual deployed factory calculator passed the local rehearsal; the public source's [deployment/address methods](https://github.com/Kuru-Labs/Kuru-contracts-dex-public/blob/main/contracts/Router.sol) explain this mechanism but do not certify a future implementation.

The `execute-local` executor is deliberately local-only. Use `execute-signed` for the public reviewed-package path:

```sh
npm run deployment:package -- execute-local --input .runtime/deployment-review/package.json --out .runtime/deployment-execution
```

Use a dedicated local chain; do not share the sender with running maker/price workers. Execution reconstructs the package from current trusted artifacts at its canonical anchor, rechecks dependencies, estimates bounded gas and checks the nonce before each new broadcast. A per-sender lock prevents competing executors in this workspace. Re-running with the same package and output directory resumes the journal. Included hashes are checked against their actual sender, nonce, calldata, target, value and canonical receipt; they are never rebroadcast.

The broadcast hash is written before receipt polling. If a crash loses the response-to-journal write, the executor can find the exact sender/nonce transaction within 256 anchored blocks and validate its bytes before adopting it. Older or unresolved missing hashes require inspection/manual evidence; the executor stops rather than guessing. A recorded revert, reorganization, changed nonce, mismatched journal entry, changed artifact or changed factory dependency stops execution. Remove a stale lock only after confirming its process is gone; malformed/live locks are not ignored.

Only after all steps and `deployment:check` pass does execution write a verified `manifest.json` and `verification.json`. It never replaces the app's active `.runtime/manifest.json` automatically.

```sh
npm run deployment:rehearse
```

With the multi-asset shelf the rehearsal deployed 62 markets across MON, SPY and XAU in 260 transactions, verified every router binding, and bootstrapped the MON shelf in 134. The parent chain cannot serve cold storage more than a few blocks behind its tip (`BlockOutOfRangeError`), so a long rehearsal needs parent block production paused: begin a local checkpoint, `cast rpc evm_setIntervalMining 0`, run the rehearsal, set the interval back to `1`, then restore the checkpoint.

The rehearsal forks the existing local chain on a separate ephemeral port, prepares all active listings, pauses after four steps, tests tampered package/journal rejection, removes one included journal hash and resumes. The validated run deployed 32 active markets in 135 actual transactions and recovered the missing hash without duplicate broadcasts. It stops the isolated node and retains intent, package, receipts, manifest and verification under `.runtime/deployment-rehearsals/`. The existing terminal deployment remains unchanged. Its controlled oracle and funded test quotes remain local fixtures.

## Funded maker bootstrap

For a newly verified deployment with no maker option inventory, obligations, venue balances or book order history, prepare an unsigned funding/quote package:

```sh
npm run maker:bootstrap -- prepare --input .runtime/deployment-execution/manifest.json --out .runtime/maker-bootstrap --quantity 90
```

The quantity is an integer from 1 to 100 contracts per series; it defaults to 90. Preparation reads the actual engine collateral requirement and caps, wallet assets, native balance, faucet cooldown, oracle window and empty custody. It totals native call backing, cash put/spread backing and the rounded bid reserve. It refuses an expired/near-expiry shelf, stale reference, insufficient native funds or insufficient test-faucet budget before producing transfer calldata.

The package wraps only the missing native MON, obtains a rate-limited dUSDC faucet allocation when necessary, approves exact backing/reserve amounts, issues funded claims and deposits them to the maker's own Kuru custody. A shared quote deposit funds all bids; each book receives an integer-lot post-only ladder. The initial model assumptions are 85% volatility, 12% edge around model value plus 0.001 dUSDC. They are declared parameters, not market-observed implied volatility or proven profitability.

```sh
npm run maker:bootstrap -- execute-local --input .runtime/maker-bootstrap/bootstrap.json --out .runtime/maker-bootstrap
```

Execution remains loopback/31337-only, uses the per-sender lock shared with deployment, reconstructs the plan from pinned initial state and journals each broadcast before receipt polling. Before further steps it checks freshness, expiry, nonce and a maximum 0.5% reference-price deviation from the reviewed package. It does not silently replace prices. Partial execution can leave wrapped funds, issued writer backing or free venue assets; inspect the journal and use ordinary withdrawals/burns before changing plans. Missing journal hashes require manual evidence; bootstrap never repeats a wrap or issuance to guess its way forward.

This is a one-time fresh-state bootstrap. Existing inventory/order history must use the custody-aware maker worker and its net-risk policy. Use `execute-signed` for exact reviewed public bootstrap. Public signers and automatic Pyth updates are implemented; maker economics are not independently validated.

`deployment:rehearse` now also bootstraps the new shelf and executes a router purchase. Its local run used 135 deployment transactions plus 134 funding/quote transactions across 32 markets. Native wrapping, writer escrow, funded venue quotes, CLI pause/resume, exact holder claim delivery and preserved writer backing were checked on the isolated chain; no public liquidity or real-dollar capital is claimed.

## Public rollout prerequisites and order

The local seed intentionally refuses public chains. Public rollout must preserve the following dependency order rather than treating it as a public equivalent of `local:seed`:

1. Select funded testnet deployer and maker accounts, a credential-free browser RPC and a private service RPC. Reconcile the current Kuru factory/custody implementation and the exact quote/underlying tokens. Never use `anvil_setBalance` or local minting as a public funding mechanism.
2. Admit the actual Pyth verifier, MON feed, latest/historical access, fee behavior and retained payload format. Complete first-update rejection/replay/outage cases. Pick the immutable live-price window from measured operation, not the local 3,600-second fixture window. See [oracle operations](oracle-operations.md).
3. Deploy or select the assets, then the expiry oracle, `OptionsEngine(quoteToken, oracle, maxPriceAge)` and `StrategyRouter(engine)`. Record constructor arguments, bytecode/build identity, transaction receipts, deployer and governance owners. A dedicated test quote token must remain labelled dUSDC; native WMON requires actual wrapping. The development token's unrestricted mint is chain-31337-only; its public faucet is rate limited.
4. Approve the underlying, create the listed funded series, deploy the external Kuru books and one exact adapter per book, then register every adapter with the router. Match the admitted precision, lots, fees and custody parameters. Retain all old series needed for user exits when adding a new shelf.
5. Produce a strict credential-free manifest and run `deployment:check` against the actual public deployment. Verify contract source and proxy implementation/version separately. A local fork report cannot substitute for this public check.
6. Fund maker custody from actual test assets, issue fully backed inventory and quote only within measured issuance/net-risk budgets. Add an explicitly configured public maker signer and live/expiry proof keeper before advertising automatic liquidity or settlement. The current demo implements and exercises these signers/keepers; reconcile the selected deployment before reusing them.
7. Rehearse independent-wallet fills, cancellation/withdrawal, expiry proof finalization, holder payout, writer residual, outage recovery and archive handoff on the actual network. Present test assets, controlled liquidity and any controlled feed honestly. Do not activate a real-money release under this testnet runbook.

Foundry supports a separate simulation and broadcast stage and encrypted account aliases; its [scripting documentation](https://getfoundry.sh/forge/deploying) describes those mechanics. Public deployment automation must use an explicit reviewed broadcast stage and signer configuration. The current demo completed 52 original signed deployment transactions plus four new-series transactions; canonical exact receipts are retained in `.runtime/testnet`.

## Expired maker custody

The controlled local keeper cancels an expired series's maker orders, withdraws its claim tokens, redeems those claims and settles the writer position. It leaves free quote USDC in shared Kuru custody for active markets. Claim redemption and writer settlement remain separate permissionless exits for their respective owners. An interrupted cleanup rereads actual wallet/custody/position balances; completed cleanup requires no further transactions. The same cleanup routine is used by the isolated expiry rehearsal. The public hosted worker uses the same custody cleanup after authenticated Pyth finalization.

The validated isolated lifecycle run also advanced its own clock, published two controlled prices, retained the first expiry observation, redeemed buyer and maker claims, cleared the writer obligation and swept eligible dust. All 90 WMON of the tested call's backing was accounted for exactly; shared quote custody remained funded, and a repeated completed cleanup sent no transactions. The rehearsal uses local automining and is not a throughput benchmark.
