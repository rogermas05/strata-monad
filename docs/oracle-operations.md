# Oracle evidence and activation

The running local deployment uses controlled observations. It does not require provider credentials, and its reference ledger is labelled accordingly. The separate public demo has passed genuine signed Pyth admission and actual expiry finalization against its verifier. See [testnet-demo.md](testnet-demo.md) for the deployed policies and evidence. Candidate/admission guidance below describes checks required for any new deployment.

## Candidate configuration

The official Pyth documentation lists the following candidates:

| Setting                     | Candidate                                                            | Evidence and boundary                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monad testnet Core verifier | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379`                         | [Core EVM contract addresses](https://docs.pyth.network/price-feeds/core/contract-addresses/evm). Code was present on the local Monad fork. This alone does not admit its implementation or historical verification behavior. |
| MON/USD feed                | `0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1` | [Pyth EVM push-feed catalogue](https://docs.pyth.network/price-feeds/core/push-feeds/evm). Catalogue presence does not establish a sponsored live feed on Monad testnet or compatible historical payloads.                    |
| Authenticated retrieval     | `https://pyth.dourolabs.app/hermes`                                  | [Fetch price updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates). Credentials belong only in the ignored server-side `.env`.                                                                             |

These are reference candidates, not silently enabled deployment settings. Core and Pro interfaces and payload generations must be reconciled with the selected verifier. A historical public documentation example was rejected by both parsing methods on the documented verifier during a read-only local-fork probe; that example is not a compatibility certificate.

Once authorized access exists, configure `PYTH_API_KEY`, `PYTH_VERIFIER`, `PYTH_FEED_ID`, and optionally `PYTH_CHECK_TIMESTAMP` and `CHECK_ACCOUNT`. Do not use frontend-prefixed environment variables. `npm run pyth:check` retrieves historical evidence, simulates the configured unique parser at a pinned canonical block, compares every returned field with provider metadata, and archives successful read-only admission evidence. It never broadcasts. A funded simulation account may be needed for payable calls even though `eth_call` does not spend its balance.

## Terminal workflow

Open **Settlements → Oracle evidence**. A Pyth deployment supports either a listed elapsed expiry reference or a current live update. Controlled deployments disable signed retrieval and show their own recorded references.

1. Retrieve a signed payload through the service, or import an exported JSON package.
2. Check it against the current deployment. Import alone does not verify a signature or authorize submission.
3. Review the feed, full engine/oracle/verifier addresses, policy, observation, payload hash and exact native verifier fee. Gas is separate.
4. Submit with the connected wallet. The wallet repeats contract checks and simulations directly against its RPC before broadcasting. A local unlocked demo submission is restricted to the loopback chain.

Expiry preparation uses `parsePriceFeedUpdatesUnique` and also simulates the actual expiry adapter's `finalize`. It requires the fixed first-update policy, a listed elapsed expiry and an unfinalized reference. Positive canonical expiry observations retain their confidence interval even when wide; they cannot be replaced with a more favorable later observation.

Live preparation uses the non-unique parser within the engine's immutable freshness window, rejects confidence above 1%, and simulates `updatePriceFeeds`. Pyth can ignore an update older than or equal to its stored observation; a successful transaction does not promise that the stored price changed. Read the resulting onchain live price and timestamp before treating it as fresh. This distinction follows the [update method](https://api-reference.pyth.network/price-feeds/evm/updatePriceFeeds).

Packages bind chain, engine, oracle, verifier, feed, policy, expiry, exact payload bytes, normalized verified observation, fee ceiling, code hashes and verification block. Submission rejects a changed verifier/code hash, changed observation, increased fee, finalized reference or stale live payload. Packages contain no provider key. Checks establish behavior of the configured contracts; deployment admission must establish trust in those contracts, including proxy implementation/version compatibility.

## Service and archive

| Endpoint                                      | Behavior                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/oracle`                             | Mode and provider/backup availability booleans; no credential values.                                                                             |
| `POST /api/oracle/prepare`                    | `{kind, expiry?, account}`; retrieval, pinned checks and atomic archive. At most four preparations run concurrently; identical requests coalesce. |
| `POST /api/oracle/inspect`                    | `{proof, account}`; read-only revalidation without requiring a provider key.                                                                      |
| `GET /api/oracle/archive/:kind/:expiry/:hash` | Deployment-scoped package lookup. Use `live` for a live package's expiry.                                                                         |

Prepared packages are stored under ignored `.runtime/oracle-proofs/<chain>/<oracle>/` with restrictive file permissions and atomic replacement. This is a local retained-payload archive, not replicated permanent availability or proof of a confirmed finalization. The onchain reference retains metadata and the Solidity-compatible `keccak256(abi.encode(bytes[]))` hash; keep the actual payload separately. Downloaded packages can be inspected and resubmitted by another account while their contract conditions remain valid.

Configure `HERMES_BACKUP_URL` and optionally `PYTH_BACKUP_API_KEY` for backup retrieval. An omitted backup key uses the primary key. Provider errors or invalid proofs never produce prepared packages; the service tries the configured backup and returns a generic failure if neither verifies. This is retrieval failover, not an independent signer/keeper. Payloads are limited to eight updates and 64 KiB of bytes, and package endpoints have a 160,000-byte request limit.

## Remaining activation work

Authentic latest/historical proof admission, retention and replay testing, automatic live/expiry proof keepers, replicated archive availability, public signer management, public deployment verification, and failure drills remain. A test-only Solidity interface double and synthetic client fixtures validate fees, state changes and plumbing locally; they do not authenticate a Pyth signature. Keep those scopes distinct in a demo or submission.
