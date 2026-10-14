# House vault, points and STRATA

The house vault lets anyone deposit dUSDC and share the book that sells options to traders. Points reward depositors and losing traders, and convert to STRATA, which can be staked for the vault's performance fee. It runs on the local Monad fork and on Monad testnet: the vault is at `0x4E6537315026f2Fb85857B38A1dFe749F47bC683`, with genesis deposits open until launch at 2026-10-14 22:15:46 UTC.

## Contracts

| Contract | File | Role |
| --- | --- | --- |
| `HouseVault` | `contracts/src/HouseVault.sol` | Pooled writer. Holds deposits, writes fully funded puts and spreads, quotes them on Kuru, settles weekly. Issues non-transferable `sHOUSE` shares (6 decimals). |
| `StrataToken` | `contracts/src/Strata.sol` | STRATA (18 decimals, 1B cap). Transfers stay locked until the owner calls `enableTransfers`; only the staking and distributor contracts can move it before then. |
| `StrataStaking` | `contracts/src/Strata.sol` | Stake STRATA, earn any dUSDC sent to the contract (the vault's performance fee). Unstaking stops rewards immediately, then a cooldown applies. |
| `StrataDistributor` | `contracts/src/Strata.sol` | Cumulative Merkle claims that mint STRATA, optionally straight into staking. |

The options engine, router and Kuru adapters are unchanged. The vault is an ordinary writer and Kuru maker from their point of view.

## Epochs

- **Epoch 0 is genesis.** Deposits queue and can be cancelled. No trading happens. The first `roll` at or after `launchTime` prices genesis deposits at 1 dUSDC per share.
- **Each roll** settles every series the vault traded in the finished epoch. It withdraws Kuru balances, redeems held claims and settles writer positions. It then computes the share price from cash only, takes a 10% performance fee on profit, processes queued deposits and withdrawals, and admits the next epoch's series.
- **Series selection** (`packages/core/src/house-epoch.ts`): every cash-settled series (puts, bull and bear spreads, across all assets) expiring within six days of the nearest eligible expiry. MON calls need WMON backing and stay with the project maker. Each series can only be traded in one epoch.
- **Withdrawals** are requested during an epoch and paid at the next roll's share price. Depositors therefore always bear the epoch they were in.

Because every traded position has settled before the share price is computed, no model valuation is needed. The terminal's mid-epoch "estimated" figures mark positions at model prices for display only.

## Operator and trust

The maker key is the vault operator. It can write, close, move funds between the vault and its own Kuru margin account, quote post-only orders on admitted books and cancel them. No operator function sends funds anywhere except the vault, engine escrow or the vault's own Kuru account. The contract also stops the operator from spending queued deposits or reserved withdrawals.

The operator still sets prices. A malicious operator could quote badly against an account it controls. This is the same trust model as a market-making vault like Hyperliquid's HLP and should be stated plainly to depositors.

Safety valves:

- `excludeSeries` (owner) lets a roll proceed without a series whose settlement never resolved, three days after its expiry. `settleLegacySeries` recovers its value later.
- After 14 days without a roll, anyone can roll into an idle epoch.
- New quotes stop 60 seconds before expiry on-chain. The worker pulls them 5 minutes before.

## Points

Implemented in `packages/core/src/points.ts`, computed only from on-chain events:

| Activity | Points |
| --- | --- |
| Genesis deposit | 5 per dUSDC, scaled 1×–2× by how early in the window. Cancellations remove the latest deposits first. |
| Vault deposit | 1 per dUSDC of share value for each completed epoch. |
| Losing trade against the house | 10 per dUSDC of net loss on settled contracts bought from the vault or project maker. |

Every rate falls 10% per epoch. Only losses paid to the house count, so trading with yourself earns nothing. After each roll, the API publishes a cumulative Merkle root of STRATA (1 point = 1 STRATA) to the distributor. Cumulative amounts never decrease.

## Running locally

`npm run local:up` deploys the house automatically on a fresh Kuru fork. To add it to an existing local deployment:

```sh
npm run house:deploy          # genesis opens now, launch in 30 minutes
HOUSE_LAUNCH_IN=86400 npm run house:deploy
```

Restart the API afterwards. `HOUSE_REDEPLOY=1` replaces an existing vault in the manifest. `MANIFEST_PATH` targets an isolated stack. `STRATA_COOLDOWN` sets the unstaking cooldown in seconds (default one day).

The API worker launches the vault, rolls it once every epoch reference settles, publishes reward roots and quotes up to four vault books per pass. It obeys the maker's pause switch. The local-only `POST /api/demo/house-cycle` runs one pass on demand.

| Endpoint | Returns |
| --- | --- |
| `GET /api/snapshot` | `house`: epoch, assets, share price, max loss, admitted series, roll history |
| `GET /api/house/:address` | Shares, value, pending deposit, queued withdrawal |
| `GET /api/rewards/:address` | Points breakdown, claimable STRATA and proof, staking balances |

## Tests

- `contracts/test/HouseVault.t.sol`: deposits, rolls, fees, losses, withdrawals, operator scope, reserved funds, timeouts, exclusion, and a cash-conservation fuzz test.
- `contracts/test/Strata.t.sol`: transfer lock, minting cap, pro-rata fees, cooldown, cumulative Merkle claims.
- `packages/core/src/{points,merkle,house-epoch,house-actions}.test.ts` and `apps/api/src/worker-policy.test.ts`.
- `tests/house.spec.ts`: browser lifecycle from genesis deposit to staked STRATA.

## Not done

- An audit. `scripts/testnet-house.ts` performed the testnet deployment (journals and receipts in `.runtime/testnet/house`).
- The vault takes dUSDC only; it does not write MON calls.
- STRATA has no market, and the fee-sharing token design has regulatory implications that need review before any real launch.
