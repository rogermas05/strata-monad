# Strata

A Monad options terminal with fully funded European calls, puts and native capped spreads. The public demo runs on **Monad testnet (10143)** with real Kuru execution, fully funded collateral and authenticated Pyth prices. A separate local fork remains available for controlled development drills.

The connected interface includes TradingView price charts, an executable options chain, market and post-only limit orders, atomic strategies, portfolio custody balances, funded writing and burns, analytics, expiry claims, maker settings, recovery authorizations, oracle evidence and protocol status. The working name is Strata.

## Public testnet demo

Open **https://strata-monad-demo.vercel.app**. The terminal and API run on Vercel; Supabase stores the private read model, transaction journals and signed oracle evidence and schedules the maker/keeper worker.

1. Connect an injected browser wallet and select Monad testnet (chain 10143). The wallet needs testnet MON for gas.
2. Open the account menu and request dUSDC from the test faucet. For writing calls, wrap native MON into WMON.
3. Start with **0.1 contracts** on an active MON series. Project liquidity targets 50 contracts per side on MON puts, one on WMON-backed calls and up to three on capped spreads, subject to collateral and notional limits. Order-size presets follow available funded depth. Review and sign each wallet transaction.
4. Portfolio shows wallet claims, venue custody, orders and receipts. Settlements shows finalized references and claim/recovery actions.

Twenty-five active instruments cover MON, BTC, ETH and XAU across two weekly expiries. Two expired MON drill instruments remain in the manifest for historical positions and exits. Quotes are project-funded test liquidity. Prices and charts use recorded authenticated Pyth observations. The weekly shelf expires on **16 and 23 October 2026**; later demos need a newly listed shelf while retaining old instruments for exits.

Engine: `0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C`. Core contracts and all twenty-seven adapters have exact creation/runtime matches on [Sourcify](https://repo.sourcify.dev/10143/0x4295487dcD487f9720a6d7b0Cd9d15645cF9745C). The Etherscan verification mirror hit its submission limit.

Actual public checks include a 0.1-contract Kuru purchase, authenticated short-expiry finalization, and an exact **0.000478 dUSDC** holder payout with the claims burned. The payout used a separate funded claim handoff; it was not the same instrument as the venue purchase. See [the testnet runbook](docs/testnet-demo.md) for receipts, hosting and operations. Public browser-wallet signing still requires a wallet attached by the presenter; CLI checks do not certify a particular wallet extension.

## Run locally

Prerequisites: Node.js 25.x (validated on 25.1.0), npm, Git, and Foundry's `forge`, `cast` and `anvil` on your PATH. A network connection is needed for dependency setup and for the default Monad fork. No funded account, private key or Pyth API key is needed for this local environment.

The tested Node version is pinned in `.nvmrc`; use `nvm use` if you manage Node with nvm. Package engines require Node 24 or newer.

```sh
npm ci
npm run setup
npm run local:up
```

`setup` pins forge-std and compiles the contracts. `local:up` starts Anvil on `127.0.0.1:8546`, forks Monad testnet, deploys and funds the environment if no live deployment exists, then starts the API and terminal. Initial seeding takes several minutes. Open **http://localhost:5173**. Ctrl+C stops processes started by that command; it does not stop an Anvil instance that was already running.

The local chain uses chain ID **31337**, not the public Monad testnet chain ID. The default terminal account is Anvil's third unlocked development account. Connecting a browser wallet switches state-changing actions to actual wallet signatures. The app checks the wallet chain and can add the local network.

For separate terminals:

```sh
npm run local:fork
```

```sh
npm run local:seed
npm run dev
```

To use an original development order book without a Monad fork, start `npm run local:chain` instead and set `VENUE_MODE=demo` when seeding and starting services. That venue is labelled as a development book, not Kuru. Default `VENUE_MODE=kuru` requires the fork.

Copy `.env.example` to an ignored `.env` file only if you need to override the defaults. Runtime manifests, event databases, maker settings and screenshots live under ignored `.runtime/`. Local seeding can replenish standard development accounts through Anvil when native test balances are too low; WMON is then created by actual native wrapping. This fixture funding is restricted to a loopback RPC on chain 31337. Stop the API before reseeding an existing chain, then restart it to load the new manifest. Reseeding creates another deployment; it does not migrate old positions or delete their contracts. Restarting Anvil creates a fresh chain unless you separately persist its state.

`RPC_URL`, `API_PORT` and `WEB_PORT` can isolate another local instance. Both services read the repository's `.env`; Vite proxies the configured API port and rejects an occupied web port instead of opening a different interface silently.

## Test and validate

```sh
npm run check
```

This checks TypeScript, numerical and service logic, protocol lifecycle/fuzz tests, and the frontend build. The normal contract suite explicitly skips the external Kuru fork test.

With the local fork running, validate the deployed Kuru integration:

```sh
RUN_KURU_FORK=true forge test --root contracts --match-test testKuruDeployedFork --fork-url http://127.0.0.1:8546 -vv
```

With the seeded chain, API and Vite running, install Chromium once and run the transaction/UI suite:

```sh
npx playwright install chromium
npm run test:e2e
```

The browser suite runs real local transactions, including an injected wallet provider that signs through Anvil. It checks exact fills across multiple levels, collateral issuance/burns, cancellation/withdrawals, invalid precision and insufficient depth, atomic strategies, maker controls, immutable expiry payouts, two-party unresolved unwinds, relayed claims, authorization revocation, keyboard dialogs and responsive pages. Oracle workspace tests additionally reject malformed/oversized packages without a transaction and exercise actual wallet live/expiry submissions against a separate test-only interface fixture. These fixtures do not authenticate a genuine Pyth payload. It takes a local chain checkpoint and suspends background workers while testing; its teardown restores chain state, maker settings and indexed events. Run one suite at a time and avoid manual transactions or code reloads during a run. The active weekly and monthly shelf must still have funded depth; reseed if the chain has been advanced past every expiry.

Screenshots and failure traces are written to `.runtime/` and `test-results/`. Public network transactions are never part of these commands.

If a browser suite is interrupted, its checkpoint survives an API restart and background workers remain suspended. Run `npm run local:restore` to restore that checkpoint and resume workers. This rolls back **all local chain transactions since the checkpoint**, so do not mix manual trading with an active test session. `/api/health` reports the checkpoint ID and worker suspension state.

## Collateral and execution

- **Calls:** one WMON of backing per MON of contracts. At expiry, an in-the-money claim pays `quantity × (settlement price − strike) / settlement price` in WMON. Calls are not cash-settled.
- **Puts:** `quantity × strike` in 6-decimal dUSDC backing. Expiry payout is `quantity × max(strike − settlement price, 0)` in dUSDC.
- **Capped bull/bear spreads:** cash-backed by their maximum strike-width payout. These are native bounded instruments, not permission to sell naked options.
- **Rounding:** funding and writer obligations round up; holder payouts round down. Fractional claims cannot increase total payout. Per-series escrow remains solvent regardless of claim order.
- **Kuru:** funded limit orders and price discovery onchain. An exact-fill adapter and strategy router enforce full quantity, per-leg budgets and atomic rollback. This integration currently admits zero-fee books with 18-decimal claims, 6-decimal quote tokens and a 0.001 MON lot.
- **Custody:** wallet assets, venue-free balances, resting order reserves and writer collateral are shown separately. Venue-held claims must be cancelled/withdrawn before burning or claiming through the engine.

The seed creates 30 vanilla markets across three expiries, two weekly capped markets and two short-lived capped settlement instruments. It funds project-controlled makers and a demo account using dUSDC test tokens and native-backed WMON. Test liquidity and observed volume do not represent independent customers or production capital. The short-lived markets can already be expired by the time you open an older session.

Maker settings control volatility, spread/edge, per-side depth, a per-series issuance cap, an absolute net option inventory cap and inventory price skew. Net option inventory is **wallet claims + free venue claims + funded asks − writer obligations**, read at the indexed block. Self-issuance changes both holdings and obligations; it cannot conceal the exposure created by a sale. A net short raises the quote center to encourage repurchases; a net long lowers it. The risk limit bounds the planned total size on each side, separately from the issuance limit and actual funded custody.

When replacing quotes, the worker cancels first, then rereads custody and obligations before sizing new orders. The admitted Kuru cancellation method tolerates a newly filled order; its behavior passed the deployed fork test. All quote sizes use integer lot arithmetic. If oracle pricing is readable but stale or invalid, the scheduled worker cancels project quotes and returns free venue assets even when quote updates were manually paused. A disconnected RPC or a hard-paused external venue can prevent cancellation; existing venue orders are not magically revoked by a frontend pause.

**Pause updates** leaves resting orders executable. **Halt & withdraw quotes** is a reviewed local operation that pauses updates, cancels project orders and withdraws free venue balances without changing funded writer obligations. The maker's enabled state persists per deployment across API restarts. Resuming updates permits the funded ladder to rebuild. This remains a development market maker with no automatic spot hedge or established profitability. The keeper separately finalizes demo expiries and recovers expired maker claims and residual collateral.

The liquidity console reports net option delta and vega; these exclude collateral and other underlying holdings and are not the maker's total portfolio Greeks. For deterministic local drills, `/api/demo/maker-cycle` can execute the same scheduler cycle for up to four selected market IDs inside a checkpoint. It does not run on public networks.

## House vault, points and STRATA

**House** lets anyone deposit dUSDC into a pooled, fully funded writer that the maker key operates. The vault writes puts and spreads on every cash-settled market, quotes them on Kuru and rolls weekly. Every position settles to cash before each roll, so share prices need no model valuation. Deposits open in a genesis window before launch. **Rewards** converts points from genesis deposits, vault deposits and losses paid to the house into STRATA. Staked STRATA earns the vault's 10% performance fee. It is live on Monad testnet (see [testnet demo](docs/testnet-demo.md)). `npm run local:up` deploys it on a fresh fork, and `npm run house:deploy` adds it to an existing local deployment. See [house vault](docs/house-vault.md) for the contracts, trust model, point rules and endpoints.

## Recovery authorizations

Open **Settlements → Recovery authorizations** to prepare or import a recovery package. The preview reads the exact payout or collateral release from the engine and shows full participant/engine addresses, chain, quantity, nonces and deadline.

For a delegated claim, the holder signs the quantity and deadline after the reference is finalized. The completed JSON can be downloaded or copied for a relayer. Anyone with gas can submit it, but the engine always pays the holder. Signing alone does not send a transaction or charge a fee.

For an unresolved expiry, a writer and holder negotiate a dUSDC payment for a quantity of claims. One participant prepares and signs the terms, hands the JSON to the counterparty, and the other participant loads and signs the same terms. The writer explicitly approves the payment amount if needed. Either participant or a third party may submit the completed package. The engine burns the holder's claims, pays the agreed cash amount and releases only the corresponding writer collateral in one transaction. A finalized reference disables this route; use the ordinary claim instead.

**Revoke pending authorizations** increments the current account's shared nonce. It invalidates every pending signed claim/unwind using the old nonce while leaving collateral and tokens in place. Executing a signed recovery also consumes that nonce, so separate packages using the same nonce cannot all execute. Direct ordinary claims remain available.

Local demo signing is limited to the named demo user on the loopback chain. Connected browser wallets sign their own terms. The engine supports EOA signatures, EIP-7702 EOA-key signatures and deployed ERC-1271 contract-wallet policies. It also accepts compact ECDSA signatures for EOAs. Counterfactual undeployed wallet signatures are not supported by the engine.

## Transaction receipts

**Portfolio → Transactions** shows each individual step, including approvals, venue deposits, trades, collateral actions and oracle submissions. A wallet broadcast is saved before receipt polling; a rejected later step preserves the earlier hashes and points back to the account history. A receipt timeout never rebroadcasts the transaction.

Browser records are scoped to chain, engine and account and retained in local storage where available. Storage failure falls back to memory without turning a successful broadcast into an action failure. The server separately reads the transaction from its RPC, validates the sender, chain and deployment target, derives the operation from calldata, and checks the receipt against its canonical block before recording it. Client-supplied operation/status labels are not accepted. Registration failures leave the browser record available for a later retry; retries are coalesced and bounded. If browser storage is disabled and server registration is unavailable, copy the displayed hash before leaving the page.

The history distinguishes browser observations, current chain checks and cached chain checks during an outage. **Included** means a mined receipt, not irreversible finality. Receipt reconciliation rotates through pending entries so older missing receipts cannot monopolize the worker. Local checkpoint rollback marks removed receipts orphaned; those records remain visible as audit history.

An already authorized browser wallet reconnects passively after reload through `eth_accounts`; no permission prompt is sent. Choosing the demo account clears that preference. History tracking is read-only and never resubmits a transaction.

## Market readiness and failure recovery

The API reports readiness in `/api/health` and each snapshot. A failed refresh or cache older than 15 seconds disables new orders and issuance. A node that stops advancing for 30 seconds also pauses new exposure; local test checkpoints have an explicit tip-progress exemption. Oracle validity and freshness follow the engine's immutable `maxPriceAge`, read from the deployment rather than duplicated in the service. The local deployment uses a 3,600-second window; the public demo uses a 60-second window.

The terminal retains the last confirmed view with a visible interruption notice. Browser connection failure independently disables cached trading controls. Live-price and expiry checks run before order funding and again before the execution/order transaction; the strategy router and issuance engine also enforce oracle freshness onchain. These guards do not revoke orders resting directly on an external venue. Burns, cancellations, withdrawals, settled claims, bilateral unresolved unwinds and nonce revocation remain callable independently of the new-exposure gate, subject to their contract conditions and available RPC access.

Health returns HTTP 503 when degraded or offline. A successful receipt is not reported as a failed transaction if subsequent indexing fails: the response identifies inclusion and reports whether the account read model was refreshed.

## Oracle and public deployment boundary

The local oracle publishes controlled observations. Charts display recorded observations, not imported live market history. Expiry selects the immutable first published observation at or after the expiry timestamp.

`PythExpiryOracle` implements an immutable verifier and `parsePriceFeedUpdatesUnique` settlement policy. Its interface tests use a test double; genuine signed Pyth payloads have also passed admission and public finalization for the demo. Confidence guards live issuance, while settlement retains the canonical positive first update even when confidence is wide. A later favorable update cannot replace that reference.

Finalization retains the observation timestamp, raw price, confidence, exponent and payload hash onchain, with a fixed policy identifier. That metadata makes the reference inspectable; it does not replace signed-payload availability.

A read-only integration checker is available:

```sh
npm run pyth:check
```

It requires `PYTH_VERIFIER`, `PYTH_FEED_ID`, `PYTH_API_KEY` and, where necessary, a funded simulation account in the ignored `.env`. It retrieves historical evidence and calls the verifier through `eth_call` at a pinned block; it does not broadcast a transaction. The checker compares the authenticated return values against provider metadata and rechecks block canonicality. Only a successful admission writes a JSON record under `.runtime/oracle-admission/<chain>/<verifier>/`, containing the exact payload, Solidity-compatible proof hash, verified observation, fee, verifier code hash and verification block. The record explicitly describes read-only simulation and must be re-simulated before finalization. The public worker additionally retains signed payloads in the private Supabase proof archive before broadcast. Keep provider keys on the service side, never in Vite environment variables or browser bundles.

The **Settlements → Oracle evidence** workspace can retrieve, inspect, import/export and review deployment-bound proof packages for a Pyth deployment. The service checks both verifier parsing and adapter finalization at a canonical pinned block and retains prepared payloads atomically; the wallet repeats checks before submission. Live updates have a separate freshness/confidence path. An optional provider backup handles retrieval failures. Controlled local deployments disable signed retrieval and show their recorded reference ledger. See [oracle operations](docs/oracle-operations.md) for endpoints, documented address/feed candidates and the remaining admission gates. Local interface fixtures validate actual fees and state changes; they do not authenticate genuine signatures.

The public demo has funded accounts, admitted signed feeds, a persistent proof archive, automatic live/expiry workers and verified signed deployment. MON selects the last authenticated pushed observation at or before expiry with a five-minute challenge window; BTC/ETH use the unique first update after expiry; XAU uses a session-close last-before policy. See [the testnet runbook](docs/testnet-demo.md). This testnet deployment does not certify production security or independent liquidity.

## Deployment configuration checks

`SERVICE_RPC_URL` is a backend-only transport override; `manifest.rpcUrl` remains the credential-free browser endpoint. `API_READ_ONLY=1` disables unlocked signing and local workers. Different service/browser endpoints must agree on chain and a shared block at startup.

```sh
npm run deployment:check
npm run service:check
```

The first command verifies the actual listed contracts, terms, routes, Kuru parameters and recorded custody at a canonical block. The second runs a temporary local observer/proxy outage and credential-redaction drill; run it outside browser checkpoints. Both are read-only onchain. See [deployment operations](docs/deployment-operations.md) for their scope, configuration and public operation commands.

Unsigned deployment packages and resumable local and signed public execution are available through `deployment:package`. `npm run deployment:rehearse` creates an isolated local fork, deploys the active market shelf, checks receipt recovery and writes a verified manifest without replacing the running app. Public execution uses backend-only configured signers and exact reviewed package authorization. See [deployment operations](docs/deployment-operations.md) for intent fields and exact commands.

A fresh verified deployment can prepare a funded maker package with `maker:bootstrap`: exact native wrapping, cash backing, bid reserves, claim issuance and post-only quote placement. Local and signed public executors resume from canonical recorded hashes. The isolated deployment rehearsal now includes this funding stage and a real router fill. See [deployment operations](docs/deployment-operations.md) for commands, required funding and model limitations.

The public demo lists 13 assets and 43 unexpired contracts; the searchable selector includes crypto, QQQ/TSLA, gold/silver and EUR/USD. Scheduled markets follow their Pyth sessions. See [testnet demo operations](docs/testnet-demo.md) for deployments, funding, source verification and current limitations.

## Repository

| Location            | Purpose                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `contracts/src`     | Options engine, claim tokens, oracle adapters, exact-fill adapter and strategy router                 |
| `contracts/test`    | Lifecycle, rounding, signatures, Pyth interface and deployed Kuru fork tests                          |
| `packages/core/src` | Pricing, Greeks, expiry valuation, depth quoting, maker ladders, receipt waiting and evidence parsing |
| `apps/api/src`      | SQLite event read model, API, serialized local transactions, maker and keeper workers                 |
| `apps/web/src`      | React terminal, browser wallet flows and TradingView Lightweight Charts                               |
| `scripts`           | Dependency setup, local deployment/seeding, adapter refresh and read-only Pyth checks                 |
| `tests`             | Playwright transaction and UI verification                                                            |

See [architecture](docs/architecture.md), [implementation ledger](docs/implementation.md), and [third-party notices](apps/web/public/third-party-notices.txt). The TradingView chart link and attribution are retained; bundled fonts and chart code include their licenses.
