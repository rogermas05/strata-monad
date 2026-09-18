# Multi-asset markets and settlement oracles

Strata lists crypto and real-world assets (RWAs) on the same engine. Both use Pyth.
What differs per asset class is the settlement rule, the market-hours gate and the
option kinds that can be fully funded.

## Design summary

|                          | Crypto (MON, BTC, ETH)                                    | Scheduled RWAs (SPY, QQQ, AAPL, NVDA, XAU)                                                            |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Price source             | Pyth crypto feed                                          | Pyth regular-session feed (`Equity.US.*`, `Metal.*`)                                                  |
| Expiry                   | Weekly, Friday 08:00 UTC                                  | Last session close of each week, from Pyth's own schedule                                             |
| Settlement               | First Pyth update at or after expiry (`PythExpiryOracle`) | Latest Pyth update at or before the close, permissionless challenge window (`PythSessionCloseOracle`) |
| New exposure when closed | Not applicable (24/7)                                     | Blocked automatically: router live age is 120 s, so a closed session reads as unavailable             |
| Option kinds             | Calls deliver WMON; puts and spreads pay dUSDC            | Cash-settled puts, bull spreads (capped calls) and bear spreads                                       |

No continuous off-hours price is needed. Options here are fully funded and European
with no liquidations, so a price matters at two moments only: when new exposure is
taken (blocked while the underlying is closed) and at expiry (a session close).
Off-hours sources such as Pyth Pro extended sessions, Blue Ocean overnight or an own
relayer can later feed maker quoting off-chain; they are not part of settlement.

## Contracts

- **`OracleRouter`** occupies the engine's single immutable oracle slot. The owner
  binds each asset once to an adapter and a live-price age (`bind`). Bindings can
  never change, so existing claims keep their settlement policy permanently. Prices
  older than the asset's live age are reported as `0`, which makes `healthy()` false
  and blocks writes and new trades while exits, burns and claims stay available.
- **`PythExpiryOracle`** (existing) settles 24/7 assets on the unique first update at
  or after expiry.
- **`PythSessionCloseOracle`** settles scheduled assets. After expiry, anyone may
  `propose` a Pyth-verified update published in `[expiry − lookback, expiry]`; only a
  strictly later update can replace the current candidate. After `challengeWindow`,
  `finalize` without a proof fixes the candidate. The result is the last print before
  the close, and no caller can select a convenient earlier one. With no candidate the
  series stays unresolved and the bilateral unwind route remains open.
  Proposed defaults: lookback 4 days (covers weekends and holidays), challenge window
  2 hours.
- **`OptionsEngine`** lists cash-settled kinds with `underlying = address(0)`. Uncapped
  calls still require an approved deliverable token, because a cash call has no
  maximum payout to fund.

## Off-chain listing rules

`packages/core/src/assets.ts` is the single registry: Pyth symbol and feed ID, asset
class, the Pyth market-hours schedule, settlement policy, allowed kinds, live age,
expiry rule and listing status. `market-schedule.ts` parses Pyth's schedule format
(America/New_York, Monday-first weekly sessions, `MMDD` holiday and early-close
overrides) and derives each week's last real session close, including holidays,
early closes and daylight-saving changes. `validateListing` rejects listings the
engine would accept but the asset policy does not allow: candidate assets, uncapped
calls without a deliverable token, wrong strikes, and expiries that are not a
session close. Listings are limited to 26 weeks, which keeps every expiry inside the
year-long holiday window of the schedule snapshot.

Adding an RWA is therefore a registry entry plus one `bind` call; no contract changes.

## Status and admission gates

Only MON is `listed`. Every other asset is a `candidate` until these pass:

1. **Pyth access.** Hermes now returns 401 for price updates without an API key, both
   latest and historical. Feed metadata and schedules are public.
2. **Monad verification.** Simulate `parsePriceFeedUpdates` on the Monad Pyth contract
   (`0x2880aB155794e7179c9eE2e38200202908C17B43` on testnet) with a real update for
   each feed.
3. **Closing-print behaviour.** Confirm with real updates that each regular-session
   feed's last update before the close lands at the close, and measure its lag. Equity
   settlement is Pyth's regular-session price at the close, not the official closing
   auction; disclose this.
4. **Keeper.** After each close the keeper records the latest update (it stays the
   latest until the next open) and proposes it within the challenge window, so
   historical access is not strictly required for scheduled assets.
5. **Corporate actions.** Single-name equities have immutable terms; do not list across
   a known split or special-dividend date.

## Integration

The stack is multi-asset end to end on the local fork:

- **Deployment.** `seed.ts` and the unsigned deployment package always deploy the
  router with both adapters and bind each asset once, so a later scheduled listing
  is one `bind`. Package intents take optional `assets` (registry key, controlled
  reference, volatility), a per-series `asset` and optional `session` windows.
  Scheduled series must expire at a real session close, and candidate assets are
  rejected on any public chain. `checkDeployment` verifies each router binding and,
  in Pyth mode, each adapter's settlement policy and shared verifier.
- **Manifest.** `assets` records every binding (adapter, policy, live age, challenge
  window, schedule) and each series names its asset. Manifests without `assets` are
  read as a single MON oracle.
- **API and indexer.** The snapshot exposes `underlyings` (price, live state, session
  open/closed, next change, price history) and marks each market with its own
  asset's price and volatility. Pre-trade checks use the asset's live age.
- **Keeper (controlled mode).** Publishes each asset only while its session is open
  and finalizes every elapsed `(asset, expiry)`; scheduled assets wait for the
  challenge window.
- **Maker.** Quotes each market from its asset's volatility, only while that asset is
  live, and cancels its resting quotes when a session closes. Risk budgets are
  shared across the shelf. The fresh-state bootstrap funds the MON shelf only;
  other underlyings are issued by the inventory worker when their session opens.
- **Terminal.** Underlying selector with session state, per-asset chart, option
  chain (capped calls beside puts where no token is deliverable), closed-market
  order entry state, an underlyings table in Markets and settlements grouped by
  underlying and expiry. The strategy builder works on one underlying at a time.

Locally SPY and XAU are listed on controlled prices to exercise this path. They
remain `candidate` assets in the registry.

## Admission results with real Pyth data (13 October 2026)

Checked with a free-tier Pyth key against Hermes (`pyth.dourolabs.app/hermes`):

| Asset                | Free-tier access                         | Verifies on Monad testnet | Last print before close   |
| -------------------- | ---------------------------------------- | ------------------------- | ------------------------- |
| BTC, ETH             | Latest and historical                    | Yes                       | Not applicable (24/7)     |
| XAU (also XAG, FX)   | Latest and historical                    | Yes                       | 1 second before the close |
| MON                  | **Not entitled** (HTTP 403, crypto spot) | Not tested                | Not applicable            |
| SPY, QQQ, AAPL, NVDA | **Not entitled** (HTTP 403, equity)      | Not tested                | Not tested                |

- Both candidate verifiers (`0x2880aB155794e7179c9eE2e38200202908C17B43`, update fee 1 wei, and
  `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379`, fee 0) accepted the same real updates
  on the fork. Which one is canonical still needs confirming against Pyth's address list.
- Gold publishes every second in session. On Friday 9 October and Monday 12 October its
  last update landed at 16:59:59 New York, with none during the closed hour or weekend.
- `npm run pyth:rehearse` settles real data through the router on an isolated testnet
  fork: BTC on the unique first update after expiry, and XAU on its last print before
  the most recent close. It also shows an earlier print being replaced, a later attempt
  to move back being rejected, and finalization being refused inside the challenge
  window. Reports are kept under `.runtime/pyth-settlement-rehearsals/`.

The Pyth-mode keeper (`apps/api/src/pyth-keeper.ts`, logic in
`packages/core/src/settlement-keeper.ts`) runs these same steps for every elapsed
`(asset, expiry)` of a Pyth-mode deployment. It has only run through the rehearsal;
no Pyth-mode deployment exists yet.

## Free price sources and the real-price stack

Paying for a Pyth plan is not needed for MON. A third party already pushes signed
MON, BTC, ETH and SOL updates on Monad testnet (to `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379`,
about every 7 seconds; on mainnet the primary contract is also fresh for gold and
silver). Those payloads sit in public calldata and verify like any other Pyth update.

- `packages/core/src/pushed-updates.ts` finds the latest pushed update at or before a
  time, extracts it from the pusher's transaction and re-verifies it on the contract
  it was pushed to. Feeds listed in `PYTH_PUSHED_FEEDS` use this source; all others
  use Hermes.
- Updates at intervals cannot prove "first update after expiry", so such a feed is
  bound to the last-price adapter (`feedSettlement: "pyth-latest-before-close"` in a
  deployment intent): the latest update at or before expiry, with the same challenge
  window as scheduled assets.
- **Dependency:** if that pusher stops, the feed's live price goes stale (new exposure
  pauses) and its expiries stay unresolved until someone supplies a signed update.
  The pusher's identity is unknown, and on testnet it does not write to the contract
  Monad's docs list as primary.

`npm run pyth:up` starts a second local stack on these sources: a fresh fork of Monad
testnet on port 8547, API 3002 and terminal 5174, with MON (calls and puts), BTC,
ETH and XAU (puts and capped calls) at strikes around the real price. The relay
pushes each asset's newest update to the fork every few seconds, the maker quotes
from them, and the Pyth keeper settles expiries as they pass. It leaves the
controlled-price stack (8546 / 3001 / 5173) untouched. `npm run pyth:rehearse` now
also settles MON from a pushed update.

Limits found while running it:

- A Kuru book's price field tops out near 4,295 dUSDC per contract, so a deep
  in-the-money BTC put cannot be offered. The maker skips such quotes and the BTC
  shelf leans below spot.
- Quote size is capped at about $100,000 of underlying per side (1.2 BTC, 25 XAU).
- Chart history on this stack is what the service has observed since it started.

## Still required

- A source for US equities: a paid Pyth plan, or a RedStone adapter for single names
  (its public gateway serves signed AAPL, NVDA, TSLA and others; no SPY or QQQ).
  RedStone's historical access, off-hours values and terms are unchecked.
- Public operation of the real-price stack needs the managed signer.

- Per-asset maker spread and size settings. Volatility is per asset; spread, edge and
  inventory targets are still global.
- MON expiries on the local shelf are relative to seed time, not the registry's
  Friday 08:00 UTC rule.
