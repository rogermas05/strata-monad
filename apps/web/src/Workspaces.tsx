import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  Wallet,
  ArrowUpRight,
  ShieldCheck,
  ArrowRight,
  Download,
  ExternalLink,
  Activity,
  AlertCircle,
  Check,
  Copy,
  Pause,
  Play,
} from "lucide-react";
import { useApp } from "./context.ts";
import { chartTheme, tooltipStyle } from "./chart-theme.ts";
import { request } from "./api.ts";
import { TransactionHistory } from "./TransactionHistory.tsx";
import {
  Panel,
  Metric,
  Badge,
  Empty,
  Button,
  Modal,
  AddressText,
  usd,
  num,
  expiry,
  remaining,
  time,
  short,
  underlyingOf,
  underlyingKeys,
  sessionLabel,
  settlementRule,
} from "./ui.tsx";
import {
  collateral,
  priceOption,
  expiryPayoff,
  type Market,
} from "../../../packages/core/src/index.ts";

export function Markets() {
  const { snapshot, select } = useApp();
  const [filter, setFilter] = useState("All"),
    [search, setSearch] = useState(""),
    [includeExpired, setIncludeExpired] = useState(false);
  const markets = snapshot.markets.filter(
    (m) =>
      (includeExpired || m.active) &&
      (filter === "All" ||
        (filter === "Calls" && m.kind === "call") ||
        (filter === "Puts" && m.kind === "put") ||
        (filter === "Capped" && m.kind.includes("spread"))) &&
      m.symbol.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MARKET EXPLORER</span>
          <h1>Markets</h1>
          <p>
            Calls, puts and capped spreads on{" "}
            {underlyingKeys(snapshot).join(", ")}.
          </p>
        </div>
        <Badge tone="green">
          {snapshot.markets.filter((m) => m.active).length} active markets
        </Badge>
      </div>
      <div className="stats-grid">
        <Metric
          label="Underlyings"
          value={underlyingKeys(snapshot).length}
          sub={
            snapshot.manifest.oracleMode === "demo"
              ? "Controlled demo oracle"
              : "Pyth"
          }
        />
        <Metric
          label="Open contracts"
          value={num(snapshot.markets.reduce((s, m) => s + m.openInterest, 0))}
          sub="Aggregate option quantities"
        />
        <Metric
          label="Observed premium volume"
          value={usd(
            snapshot.trades.reduce((s, t) => s + t.quote, 0),
            4,
          )}
          sub="Includes project-provided liquidity"
        />
        <Metric
          label="Active expiries"
          value={
            new Set(
              snapshot.markets.filter((m) => m.active).map((m) => m.expiry),
            ).size
          }
          sub="European settlement"
        />
      </div>
      <Panel title="Underlyings">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Reference</th>
                <th>Session</th>
                <th>New positions</th>
                <th>Settlement</th>
                <th>Active markets</th>
              </tr>
            </thead>
            <tbody>
              {underlyingKeys(snapshot).map((key) => {
                const state = underlyingOf(snapshot, key);
                const binding = snapshot.manifest.assets?.find(
                  (a) => a.key === key,
                );
                return (
                  <tr key={key}>
                    <td>
                      <strong>{key}</strong> {binding?.name}
                    </td>
                    <td>{usd(state.spot, state.spot < 10 ? 4 : 2)}</td>
                    <td>{sessionLabel(state, snapshot.timestamp)}</td>
                    <td>
                      <Badge tone={state.live ? "green" : "amber"}>
                        {state.live ? "Open" : "Paused"}
                      </Badge>
                    </td>
                    <td>{settlementRule(binding)}</td>
                    <td>
                      {
                        snapshot.markets.filter(
                          (m) => m.active && m.asset === key,
                        ).length
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        title="All instruments"
        extra={
          <input
            className="search-input"
            placeholder="Search contracts…"
            aria-label="Search markets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <div className="filter-row tabs">
          {["All", "Calls", "Puts", "Capped"].map((f) => (
            <button
              key={f}
              className={filter === f ? "active" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <label className="market-history-toggle">
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(e) => setIncludeExpired(e.target.checked)}
            />
            Include expired
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Expiry</th>
                <th>Strike</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Model mark</th>
                <th>Open interest</th>
                <th>Payout</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr
                  key={m.id}
                  className="clickable"
                  onClick={() => select(m.id)}
                >
                  <td>
                    <strong>{m.symbol}</strong>
                    <small>{m.kind.replace("-", " ")}</small>
                  </td>
                  <td>
                    {expiry(m.expiry)}
                    <small>{remaining(m.expiry, snapshot.timestamp)}</small>
                  </td>
                  <td>
                    {usd(m.strike, m.asset === "MON" ? 8 : 2)}
                    {m.upperStrike > 0 &&
                      ` / ${usd(m.upperStrike, m.asset === "MON" ? 8 : 2)}`}
                  </td>
                  <td className="positive">
                    {m.bid === null ? "—" : m.bid.toFixed(5)}
                  </td>
                  <td className="negative">
                    {m.ask === null ? "—" : m.ask.toFixed(5)}
                  </td>
                  <td>{m.mark.toFixed(5)}</td>
                  <td>{num(m.openInterest)}</td>
                  <td>{m.kind === "call" ? "WMON" : "dUSDC"}</td>
                  <td>
                    <Badge
                      tone={
                        m.active
                          ? "green"
                          : m.settlementPrice
                            ? "blue"
                            : "amber"
                      }
                    >
                      {m.active
                        ? m.healthy
                          ? "Trading"
                          : "Paused"
                        : m.settlementPrice
                          ? "Settled"
                          : "Pending"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {markets.length === 0 && (
          <Empty title="No matching instruments">
            Try a different search or filter.
          </Empty>
        )}
      </Panel>
    </>
  );
}
export function Portfolio() {
  const { snapshot, portfolio: p, act, busy, select } = useApp();
  const [tab, setTab] = useState("Positions");
  if (!p) return <Empty title="Loading account" />;
  const owned = p.positions.filter(
    (x) =>
      x.quantity > 0 ||
      x.writerQuantity > 0 ||
      x.reserved > 0 ||
      x.venueFree > 0,
  );
  const assetValue = p.usdc + p.wmon * snapshot.spot;
  const claimValue = owned.reduce(
    (s, x) =>
      s +
      (x.quantity + x.reserved + x.venueFree) *
        (snapshot.markets.find((m) => m.id === x.marketId)?.mark ?? 0),
    0,
  );
  const delta = owned.reduce(
    (s, x) =>
      s +
      (x.quantity + x.reserved + x.venueFree - x.writerQuantity) *
        (snapshot.markets.find((m) => m.id === x.marketId)?.greeks.delta ?? 0),
    0,
  );
  function exportCsv() {
    const rows = [
      [
        "contract",
        "walletQuantity",
        "reservedQuantity",
        "venueFreeQuantity",
        "writerQuantity",
        "collateral",
      ],
      ...owned.map((x) => [
        snapshot.markets.find((m) => m.id === x.marketId)?.symbol,
        x.quantity,
        x.reserved,
        x.venueFree,
        x.writerQuantity,
        x.collateral,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "strata-positions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR ACCOUNT</span>
          <h1>Portfolio</h1>
          <p>Claims, trading balances, and writer obligations in one place.</p>
        </div>
        <Button onClick={exportCsv}>
          <Download size={14} /> Export positions
        </Button>
      </div>
      <div className="stats-grid">
        <Metric
          label="Available wallet assets"
          value={usd(assetValue)}
          sub={`${num(p.usdc)} dUSDC + ${num(p.wmon)} WMON`}
        />
        <Metric
          label="Long option model value"
          value={usd(claimValue, 4)}
          sub="Wallet + reserved + venue-free claims"
        />
        <Metric
          label="Net option delta"
          value={`${num(delta, 3)} MON`}
          sub="Model exposure; collateral excluded"
        />
        <Metric
          label="Native gas reserve"
          value={`${num(p.native, 4)} MON`}
          sub="Separate from wrapped collateral"
        />
      </div>
      <div className="balance-strip">
        <div>
          <i className="dot mint" />
          Wallet available <strong>{num(p.usdc)} dUSDC</strong>
        </div>
        <div>
          <i className="dot blue" />
          Reserved for bids{" "}
          <strong>
            {usd(
              p.orders
                .filter((o) => o.isBuy)
                .reduce((s, o) => s + o.reserved, 0),
              4,
            )}
          </strong>
        </div>
        <div>
          <i className="dot amber" />
          Writer collateral{" "}
          <strong>
            {owned.filter((x) => x.writerQuantity > 0).length} positions
          </strong>
        </div>
        <AddressText value={p.address} />
      </div>
      {p.venueUsdc > 0 && (
        <div className="notice">
          <Wallet size={16} />
          <p>
            {num(p.venueUsdc, 6)} dUSDC is available in venue custody. It can be
            withdrawn independently of resting orders.
          </p>
          <Button
            busy={busy}
            onClick={() =>
              void act({ action: "withdraw", marketId: snapshot.markets[0].id })
            }
          >
            Withdraw venue funds
          </Button>
        </div>
      )}
      <Panel
        title={
          <div className="tabs plain">
            {["Positions", "Open orders", "History", "Transactions"].map(
              (t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                  {t === "Open orders" && <span>{p.orders.length}</span>}
                </button>
              ),
            )}
          </div>
        }
      >
        {tab === "Positions" ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Wallet claims</th>
                    <th>Venue claims</th>
                    <th>Writer obligation</th>
                    <th>Locked collateral</th>
                    <th>Model value</th>
                    <th>Expiry</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {owned.map((x) => {
                    const m = snapshot.markets.find(
                      (m) => m.id === x.marketId,
                    )!;
                    return (
                      <tr key={x.marketId}>
                        <td>
                          <button
                            className="table-link"
                            onClick={() => select(m.id)}
                          >
                            {m.symbol}
                          </button>
                          <small>{m.kind.replace("-", " ")}</small>
                        </td>
                        <td>{num(x.quantity, 4)}</td>
                        <td>
                          {num(x.reserved + x.venueFree, 4)}
                          <small>{num(x.reserved)} reserved</small>
                        </td>
                        <td>{num(x.writerQuantity, 4)}</td>
                        <td>
                          {num(x.collateral, 4)}{" "}
                          {m.kind === "call" ? "WMON" : "dUSDC"}
                        </td>
                        <td>{usd(x.quantity * m.mark, 4)}</td>
                        <td>
                          <Badge
                            tone={
                              m.active
                                ? "neutral"
                                : m.settlementPrice
                                  ? "green"
                                  : "amber"
                            }
                          >
                            {m.active
                              ? remaining(m.expiry, snapshot.timestamp)
                              : m.settlementPrice
                                ? "Settled"
                                : "Awaiting proof"}
                          </Badge>
                        </td>
                        <td>
                          <div className="row-actions">
                            {x.venueFree > 0 && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void act({
                                    action: "withdraw",
                                    marketId: m.id,
                                  })
                                }
                              >
                                Withdraw claims
                              </button>
                            )}
                            {m.active && x.quantity > 0 && (
                              <button onClick={() => select(m.id)}>
                                Trade
                              </button>
                            )}
                            {m.active &&
                              x.quantity > 0 &&
                              x.writerQuantity > 0 && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act({
                                      action: "close",
                                      marketId: m.id,
                                      quantity: String(
                                        Math.min(x.quantity, x.writerQuantity),
                                      ),
                                    })
                                  }
                                >
                                  Burn / close
                                </button>
                              )}
                            {!m.active &&
                              m.settlementPrice &&
                              x.quantity > 0 && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act({
                                      action: "redeem",
                                      marketId: m.id,
                                      quantity: String(x.quantity),
                                    })
                                  }
                                >
                                  Claim payout
                                </button>
                              )}
                            {!m.active &&
                              m.settlementPrice &&
                              x.writerQuantity > 0 && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act({
                                      action: "settle-writer",
                                      marketId: m.id,
                                    })
                                  }
                                >
                                  Recover collateral
                                </button>
                              )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!owned.length && (
              <Empty title="No open positions">
                Your funded claims and writer obligations appear here after a
                transaction.
                <Link className="text-link" to="/trade">
                  Explore options →
                </Link>
              </Empty>
            )}
          </>
        ) : tab === "Open orders" ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Side</th>
                    <th>Limit price</th>
                    <th>Remaining</th>
                    <th>Reserved</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {p.orders.map((o) => (
                    <tr key={`${o.marketId}-${o.id}`}>
                      <td>
                        {
                          snapshot.markets.find((m) => m.id === o.marketId)
                            ?.symbol
                        }
                      </td>
                      <td className={o.isBuy ? "positive" : "negative"}>
                        {o.isBuy ? "Buy" : "Sell"}
                      </td>
                      <td>{usd(o.price, 5)}</td>
                      <td>{num(o.remaining)}</td>
                      <td>
                        {num(o.reserved, 5)} {o.isBuy ? "dUSDC" : "claims"}
                      </td>
                      <td>
                        <button
                          className="table-link"
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "cancel",
                              marketId: o.marketId,
                              orderId: o.id,
                            })
                          }
                        >
                          Cancel order
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!p.orders.length && (
              <Empty title="No resting orders">
                Place a post-only limit order from the trading ticket.
              </Empty>
            )}
          </>
        ) : tab === "Transactions" ? (
          <TransactionHistory
            manifest={snapshot.manifest}
            account={p.address}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Side</th>
                  <th>Quantity</th>
                  <th>Premium</th>
                  <th>Timestamp</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.trades
                  .filter(
                    (t) =>
                      t.taker.toLowerCase() === p.address.toLowerCase() ||
                      t.maker.toLowerCase() === p.address.toLowerCase(),
                  )
                  .reverse()
                  .map((t, i) => (
                    <tr key={t.hash + i}>
                      <td>
                        {
                          snapshot.markets.find((m) => m.id === t.marketId)
                            ?.symbol
                        }
                      </td>
                      <td
                        className={
                          (
                            t.taker.toLowerCase() === p.address.toLowerCase()
                              ? t.isBuy
                              : !t.isBuy
                          )
                            ? "positive"
                            : "negative"
                        }
                      >
                        {(
                          t.taker.toLowerCase() === p.address.toLowerCase()
                            ? t.isBuy
                            : !t.isBuy
                        )
                          ? "Buy"
                          : "Sell"}
                      </td>
                      <td>{num(t.quantity)}</td>
                      <td>{usd(t.quote, 5)}</td>
                      <td>{time(t.timestamp)}</td>
                      <td>
                        <AddressText value={t.hash} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="notice">
        <ShieldCheck size={16} />
        <p>
          Writer collateral stays in the options escrow. Reserved orders and
          free venue balances are held by the trading venue. Model values are
          estimates, not guaranteed exit prices.
        </p>
      </div>
    </>
  );
}
export function Writer() {
  const { snapshot, selected, portfolio: p, act, busy } = useApp();
  const [id, setId] = useState(selected.id),
    [quantity, setQuantity] = useState(
      snapshot.manifest.mode === "testnet" ? "0.1" : "10",
    ),
    [review, setReview] = useState(false);
  const m = snapshot.markets.find((m) => m.id === id) ?? selected,
    q = Number(quantity),
    backing = collateral(m.kind, q, m.strike, m.upperStrike);
  const balance = backing.currency === "WMON" ? (p?.wmon ?? 0) : (p?.usdc ?? 0);
  const valid =
    q > 0 &&
    Number.isFinite(q) &&
    Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6 &&
    balance >= backing.amount &&
    m.active &&
    m.healthy;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WRITER WORKSPACE</span>
          <h1>Write options</h1>
          <p>
            Issue funded options, manage inventory, and recover unused
            collateral.
          </p>
        </div>
        <Badge tone="green">
          <ShieldCheck size={12} /> Fully funded
        </Badge>
      </div>
      <div className="two-column">
        <Panel title="Issue option inventory">
          <div className="form-body">
            <label className="field">
              <span>Instrument</span>
              <select
                aria-label="Writer instrument"
                value={m.id}
                onChange={(e) => setId(Number(e.target.value))}
              >
                {snapshot.markets
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.symbol}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>
                Quantity <small>1 contract = 1 MON</small>
              </span>
              <div>
                <input
                  aria-label="Writer quantity"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <span>contracts</span>
              </div>
            </label>
            <div className="funding-card">
              <span>Required collateral</span>
              <strong>
                {num(backing.amount, 6)} <small>{backing.currency}</small>
              </strong>
              <p>
                {m.kind === "call"
                  ? "One WMON backs each MON call. The payout is a bounded quantity of underlying tokens."
                  : m.kind === "put"
                    ? "The full strike notional backs the put, including the maximum downside case."
                    : "Only the maximum capped payout is required. This is one native bounded claim."}
              </p>
            </div>
            <dl className="review-list">
              <div>
                <dt>Wallet available</dt>
                <dd>
                  {num(balance, 4)} {backing.currency}
                </dd>
              </div>
              <div>
                <dt>Claims you receive</dt>
                <dd>
                  {num(q)} {m.symbol}
                </dd>
              </div>
              <div>
                <dt>Premium received now</dt>
                <dd>None — sell the claims after issuance</dd>
              </div>
              <div>
                <dt>Expiry payout asset</dt>
                <dd>{m.kind === "call" ? "WMON" : "dUSDC"}</dd>
              </div>
              <div>
                <dt>Issuance fee</dt>
                <dd>0.00</dd>
              </div>
            </dl>
            <Button
              className="primary full"
              busy={busy}
              disabled={!valid}
              onClick={() => setReview(true)}
            >
              {balance < backing.amount
                ? "Insufficient collateral"
                : "Review issuance"}
            </Button>
          </div>
        </Panel>
        <div className="stack">
          <Panel title="How writing works">
            <div className="steps">
              {[
                [
                  "01",
                  "Lock backing",
                  "Your collateral enters an isolated series escrow.",
                ],
                [
                  "02",
                  "Receive funded claims",
                  "New option tokens are minted to your wallet.",
                ],
                [
                  "03",
                  "Sell or quote your inventory",
                  "Sell into existing bids, or post funded asks.",
                ],
                [
                  "04",
                  "Close or settle",
                  "Burn bought-back claims before expiry, or recover the writer residual after settlement.",
                ],
              ].map(([n, t, d]) => (
                <div key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{d}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Selected series">
            <dl className="review-list padded">
              <div>
                <dt>Escrow backing</dt>
                <dd>
                  {num(m.escrow)} {m.kind === "call" ? "WMON" : "dUSDC"}
                </dd>
              </div>
              <div>
                <dt>Open obligation</dt>
                <dd>{num(m.openInterest)} MON</dd>
              </div>
              <div>
                <dt>Issuance cap</dt>
                <dd>
                  {num(m.cap)} {m.kind === "call" ? "WMON" : "dUSDC"}
                </dd>
              </div>
              <div>
                <dt>Remaining time</dt>
                <dd>{remaining(m.expiry, snapshot.timestamp)}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
      <Panel title="Your writer positions">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Written quantity</th>
                <th>Locked backing</th>
                <th>Wallet inventory</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {p?.positions
                .filter((x) => x.writerQuantity > 0)
                .map((x) => {
                  const s = snapshot.markets.find((m) => m.id === x.marketId)!;
                  return (
                    <tr key={x.marketId}>
                      <td>{s.symbol}</td>
                      <td>{num(x.writerQuantity)}</td>
                      <td>
                        {num(x.collateral, 4)}{" "}
                        {s.kind === "call" ? "WMON" : "dUSDC"}
                      </td>
                      <td>{num(x.quantity)}</td>
                      <td>
                        {s.active ? (
                          <Button
                            disabled={busy || x.quantity === 0}
                            onClick={() =>
                              void act({
                                action: "close",
                                marketId: s.id,
                                quantity: String(
                                  Math.min(x.quantity, x.writerQuantity),
                                ),
                              })
                            }
                          >
                            Burn inventory & release
                          </Button>
                        ) : (
                          <Button
                            disabled={busy || !s.settlementPrice}
                            onClick={() =>
                              void act({
                                action: "settle-writer",
                                marketId: s.id,
                              })
                            }
                          >
                            Recover residual
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {!p?.positions.some((x) => x.writerQuantity > 0) && (
          <Empty title="No writer obligations yet">
            Issue a funded position to start managing inventory.
          </Empty>
        )}
      </Panel>
      {review && (
        <Modal title="Confirm funded issuance" onClose={() => setReview(false)}>
          <div className="review-instrument">
            <Badge tone="blue">WRITE</Badge>
            <h3>{m.symbol}</h3>
          </div>
          <dl className="review-list">
            <div>
              <dt>Locked collateral</dt>
              <dd>
                {num(backing.amount, 6)} {backing.currency}
              </dd>
            </div>
            <div>
              <dt>Claims minted</dt>
              <dd>{num(q)} contracts</dd>
            </div>
            <div>
              <dt>Maximum obligation</dt>
              <dd>Fully covered by deposited backing</dd>
            </div>
          </dl>
          <div className="notice">
            <AlertCircle size={16} />
            <p>
              Issuance creates a writer obligation. Selling the tokens is a
              separate trade. Cancelling an ask does not unlock collateral; burn
              matching inventory to close before expiry.
            </p>
          </div>
          <Button
            className="primary full"
            onClick={() => {
              setReview(false);
              void act({ action: "write", marketId: m.id, quantity });
            }}
            busy={busy}
          >
            Lock collateral & issue
          </Button>
        </Modal>
      )}
    </>
  );
}
export function Analytics() {
  const { snapshot } = useApp();
  const [date, setDate] = useState(
      snapshot.markets[10]?.expiry ?? snapshot.markets[0].expiry,
    ),
    [iv, setIv] = useState(85);
  const dates = [
    ...new Set(
      snapshot.markets.filter((m) => m.kind === "call").map((m) => m.expiry),
    ),
  ];
  const surface = snapshot.markets
    .filter((m) => m.kind === "call" && m.expiry === date)
    .map((m) => ({
      strike: m.strike,
      call: priceOption(
        "call",
        snapshot.spot,
        m.strike,
        0,
        Math.max(0, date - snapshot.timestamp) / 31536000,
        iv / 100,
      ).price,
      put: priceOption(
        "put",
        snapshot.spot,
        m.strike,
        0,
        Math.max(0, date - snapshot.timestamp) / 31536000,
        iv / 100,
      ).price,
      delta: priceOption(
        "call",
        snapshot.spot,
        m.strike,
        0,
        Math.max(0, date - snapshot.timestamp) / 31536000,
        iv / 100,
      ).delta,
    }));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MODEL LAB</span>
          <h1>Analytics</h1>
          <p>
            Transparent valuation assumptions, sensitivities, and market depth.
          </p>
        </div>
        <Badge tone="amber">Model estimates</Badge>
      </div>
      <div className="model-controls">
        <label>
          Expiry{" "}
          <select
            value={date}
            onChange={(e) => setDate(Number(e.target.value))}
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {expiry(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Annual volatility{" "}
          <input
            aria-label="Model volatility"
            type="range"
            min="10"
            max="200"
            value={iv}
            onChange={(e) => setIv(Number(e.target.value))}
          />
          <strong>{iv}%</strong>
        </label>
        <span>Rate: 0% · Carry: 0% · European Black–Scholes</span>
      </div>
      <div className="two-column">
        <Panel
          title="Option value by strike"
          extra={<span className="caption">dUSDC reference value</span>}
        >
          <div className="analytics-chart">
            <ResponsiveContainer>
              <LineChart data={surface}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis
                  dataKey="strike"
                  tickFormatter={(x) => usd(x)}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(x) => num(x, 3)}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Line
                  dataKey="call"
                  stroke={chartTheme.accent}
                  strokeWidth={1.5}
                  dot={false}
                />
                <Line
                  dataKey="put"
                  stroke={chartTheme.secondary}
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span>
              <i className="dot blue" /> Calls
            </span>
            <span>
              <i className="dot violet" /> Puts
            </span>
          </div>
        </Panel>
        <Panel title="Call delta by strike">
          <div className="analytics-chart">
            <ResponsiveContainer>
              <AreaChart data={surface}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis dataKey="strike" axisLine={false} tickLine={false} />
                <YAxis domain={[0, 1]} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  dataKey="delta"
                  stroke={chartTheme.accent}
                  fill="rgb(138 164 214 / 0.06)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <Panel title="Execution quality">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Spread</th>
                <th>Bid depth</th>
                <th>Ask depth</th>
                <th>Model delta</th>
                <th>Model gamma</th>
                <th>Vega / 1%</th>
                <th>Theta / day</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.markets
                .filter((m) => m.expiry === date)
                .map((m) => (
                  <tr key={m.id}>
                    <td>{m.symbol}</td>
                    <td>
                      {m.bid !== null && m.ask !== null
                        ? usd(m.ask - m.bid, 5)
                        : "—"}
                    </td>
                    <td>
                      {num(m.bids.reduce((s, l) => s + l.quantity, 0))} MON
                    </td>
                    <td>
                      {num(m.asks.reduce((s, l) => s + l.quantity, 0))} MON
                    </td>
                    <td>{m.greeks.delta.toFixed(4)}</td>
                    <td>{m.greeks.gamma.toFixed(4)}</td>
                    <td>{m.greeks.vega.toFixed(5)}</td>
                    <td>{m.greeks.theta.toFixed(5)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="notice">
        <AlertCircle size={16} />
        <p>
          The maker uses a configured{" "}
          {num(snapshot.maker.config.volatility * 100, 1)}% volatility
          assumption. These charts are a model lab, not an independently
          discovered volatility surface. Table Greeks use the maker model.
          Actual exit prices come from funded orders.
        </p>
      </div>
    </>
  );
}
export function Settlements() {
  const { snapshot, portfolio: p, act, busy } = useApp();
  // Two underlyings can share an expiry timestamp; each settles on its own reference.
  const groups = [
    ...new Map(
      snapshot.markets.map((m) => [
        `${m.asset}:${m.expiry}`,
        { asset: m.asset, expiry: m.expiry },
      ]),
    ).values(),
  ].sort((a, b) => a.expiry - b.expiry || a.asset.localeCompare(b.asset));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SETTLEMENT EXPLORER</span>
          <h1>Settlements</h1>
          <p>
            One finalized reference per underlying and expiry. Every claim
            follows its immutable payoff.
          </p>
        </div>
        <div className="row-actions">
          <Link className="text-link" to="/oracle">
            Oracle evidence →
          </Link>
          <Link className="text-link" to="/recovery">
            Recovery authorizations →
          </Link>
        </div>
      </div>
      <div className="stats-grid">
        <Metric
          label="Finalized expiries"
          value={snapshot.settlements.length}
          sub="Immutable after finalization"
        />
        <Metric
          label="Latest MON reference"
          value={usd(snapshot.spot, 5)}
          sub={`Published ${time(snapshot.pricePublishedAt)}`}
        />
        <Metric
          label="Settlement policy"
          value="Fixed per underlying"
          sub="Each series follows its underlying’s published oracle rule and challenge window"
        />
        <Metric
          label="Your claimable series"
          value={
            p?.positions.filter(
              (x) =>
                x.quantity > 0 &&
                snapshot.markets.find((m) => m.id === x.marketId)
                  ?.settlementPrice,
            ).length ?? 0
          }
        />
      </div>
      {groups.map(({ asset, expiry: d }) => {
        const binding = snapshot.manifest.assets?.find((a) => a.key === asset),
          assetId = (
            binding?.assetId ?? snapshot.manifest.assetId
          ).toLowerCase(),
          scheduled = binding?.policy === "pyth-latest-before-close";
        const markets = snapshot.markets.filter(
            (m) => m.expiry === d && m.asset === asset,
          ),
          proof = snapshot.settlements.find(
            (s) => s.expiry === d && s.asset.toLowerCase() === assetId,
          ),
          expired = d <= snapshot.timestamp,
          challenge =
            scheduled &&
            snapshot.timestamp < d + (binding?.challengeWindow ?? 0);
        return (
          <Panel
            key={`${asset}:${d}`}
            title={
              <>
                {asset} · {expiry(d)}{" "}
                <span className="muted">· {markets.length} instruments</span>
              </>
            }
            extra={
              <Badge tone={proof ? "green" : expired ? "amber" : "neutral"}>
                {proof
                  ? "Finalized"
                  : expired
                    ? challenge
                      ? "Challenge window"
                      : "Awaiting reference"
                    : remaining(d, snapshot.timestamp)}
              </Badge>
            }
          >
            <div className="settlement-detail">
              <div>
                <span>Expiry timestamp</span>
                <strong>{new Date(d * 1000).toLocaleString()}</strong>
              </div>
              <div>
                <span>Settlement rule</span>
                <strong>{settlementRule(binding)}</strong>
              </div>
              <div>
                <span>Finalized reference</span>
                <strong>{proof ? usd(proof.price, 5) : "—"}</strong>
              </div>
              <div>
                <span>Observation time</span>
                <strong>
                  {proof
                    ? new Date(proof.publishedAt * 1000).toLocaleTimeString()
                    : "—"}
                </strong>
              </div>
              <div>
                <span>Evidence</span>
                <strong>
                  {proof
                    ? snapshot.manifest.oracleMode === "demo"
                      ? "Recorded controlled observation"
                      : "Verified expiry update"
                    : "Not finalized"}
                </strong>
              </div>
            </div>
            {proof && (
              <div className="proof-row">
                <span>Finalization transaction</span>
                <AddressText value={proof.hash} />
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Payout / contract</th>
                    <th>Your wallet claims</th>
                    <th>Writer backing</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m) => {
                    const x = p?.positions.find((x) => x.marketId === m.id);
                    const value = proof
                      ? expiryPayoff(
                          m.kind,
                          proof.price,
                          m.strike,
                          m.upperStrike,
                        )
                      : null;
                    const payout =
                      m.kind === "call" && value !== null
                        ? value / proof!.price
                        : value;
                    return (
                      <tr key={m.id}>
                        <td>{m.symbol}</td>
                        <td>
                          {payout === null
                            ? "—"
                            : `${num(payout, 8)} ${m.kind === "call" ? "WMON" : "dUSDC"}`}
                        </td>
                        <td>{num(x?.quantity ?? 0)}</td>
                        <td>
                          {num(x?.collateral ?? 0, 5)}{" "}
                          {m.kind === "call" ? "WMON" : "dUSDC"}
                        </td>
                        <td>
                          {proof && x && x.quantity > 0 ? (
                            <Button
                              busy={busy}
                              onClick={() =>
                                void act({
                                  action: "redeem",
                                  marketId: m.id,
                                  quantity: String(x.quantity),
                                })
                              }
                            >
                              Claim payout
                            </Button>
                          ) : expired &&
                            !proof &&
                            snapshot.manifest.oracleMode === "pyth" ? (
                            <Link
                              className="text-link"
                              to={`/oracle?expiry=${m.expiry}`}
                            >
                              Review signed proof
                            </Link>
                          ) : expired && !proof ? (
                            <Button
                              busy={busy}
                              onClick={() =>
                                void act({ action: "finalize", marketId: m.id })
                              }
                            >
                              Finalize reference
                            </Button>
                          ) : (
                            <span className="muted">
                              {proof ? "No wallet claim" : "Pending expiry"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}
      <div className="notice">
        <AlertCircle size={16} />
        <p>
          {snapshot.manifest.oracleMode === "pyth"
            ? "Signed Pyth evidence determines the reference under each instrument’s immutable settlement rule. Claims pay only after finalization."
            : "Local demonstrations use a controllable oracle with recorded observations."}
        </p>
      </div>
    </>
  );
}
export function Maker() {
  const { snapshot, notify } = useApp();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false),
    [haltOpen, setHaltOpen] = useState(false);
  const maker = snapshot.maker;
  const config = maker.config;
  const initial = () => ({
    volatility: String(config.volatility * 100),
    spreadBps: String(config.spreadBps / 100),
    edge: String(config.edge),
    targetInventory: String(config.targetInventory),
    maxWritten: String(config.maxWritten),
    maxNetInventory: String(config.maxNetInventory),
    maxPortfolioInventory: String(config.maxPortfolioInventory),
    maxExpiryInventory: String(config.maxExpiryInventory),
    maxTotalWritten: String(config.maxTotalWritten),
    inventorySkewBps: String(config.inventorySkewBps / 100),
  });
  const [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [settingsError, setSettingsError] = useState("");
  useEffect(() => {
    if (!dirty) setDraft(initial());
  }, [
    config.volatility,
    config.spreadBps,
    config.edge,
    config.targetInventory,
    config.maxWritten,
    config.maxNetInventory,
    config.maxPortfolioInventory,
    config.maxExpiryInventory,
    config.maxTotalWritten,
    config.inventorySkewBps,
    dirty,
  ]);
  const local = snapshot.manifest.chainId === 31337;
  async function saveSettings() {
    setPending(true);
    setSettingsError("");
    try {
      await request("/demo/maker-config", {
        volatility: Number(draft.volatility) / 100,
        spreadBps: Math.round(Number(draft.spreadBps) * 100),
        edge: Number(draft.edge),
        targetInventory: Number(draft.targetInventory),
        maxWritten: Number(draft.maxWritten),
        maxNetInventory: Number(draft.maxNetInventory),
        maxPortfolioInventory: Number(draft.maxPortfolioInventory),
        maxExpiryInventory: Number(draft.maxExpiryInventory),
        maxTotalWritten: Number(draft.maxTotalWritten),
        inventorySkewBps: Math.round(Number(draft.inventorySkewBps) * 100),
      });
      await qc.invalidateQueries({ queryKey: ["snapshot"] });
      setDirty(false);
      notify("Maker settings saved. Funded quotes update on the next cycle.");
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  async function toggle() {
    setPending(true);
    try {
      await request("/demo/maker", { enabled: !maker.enabled });
      await qc.invalidateQueries({ queryKey: ["snapshot"] });
      notify(
        maker.enabled
          ? "Quote updates paused. Existing orders remain funded."
          : "Quote updates resumed.",
      );
    } catch (e) {
      notify(String(e));
    } finally {
      setPending(false);
    }
  }
  const makerOrders = snapshot.markets.flatMap((market) =>
    market.orders.filter(
      (order) => order.owner.toLowerCase() === maker.address.toLowerCase(),
    ),
  );
  const optionDelta = maker.inventory.reduce(
    (sum, position) => sum + position.optionDelta,
    0,
  );
  const optionVega = maker.inventory.reduce(
    (sum, position) => sum + position.optionVega,
    0,
  );
  async function halt() {
    setHaltOpen(false);
    setPending(true);
    try {
      await request("/demo/maker-halt", {});
      await qc.invalidateQueries({ queryKey: ["snapshot"] });
      notify(
        "Maker halted. Funded quotes cancelled and free venue funds returned.",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      await qc.invalidateQueries({ queryKey: ["snapshot"] });
      setPending(false);
    }
  }
  return (
    <>
      <div className="page-heading maker-heading">
        <div>
          <span className="eyebrow">LIQUIDITY OPERATIONS</span>
          <h1>Market making</h1>
          <p>
            Project-controlled liquidity. Funded orders, explicit budgets,
            visible inventory.
          </p>
        </div>
        <div className="row-actions">
          <Button
            disabled={
              !local ||
              pending ||
              (!maker.enabled && !makerOrders.length && maker.venueUsdc === 0)
            }
            onClick={() => setHaltOpen(true)}
          >
            Halt & withdraw quotes
          </Button>
          <Button
            disabled={!local}
            busy={pending}
            onClick={() => void toggle()}
          >
            {maker.enabled ? <Pause size={14} /> : <Play size={14} />}{" "}
            {maker.enabled ? "Pause updates" : "Resume updates"}
          </Button>
        </div>
      </div>
      <div className="stats-grid">
        <Metric
          label="Maker wallet dUSDC"
          value={usd(maker.usdc)}
          sub="Free wallet funds; venue balances separate"
        />
        <Metric
          label="Maker wallet WMON"
          value={num(maker.wmon, 4)}
          sub="Underlying available for issuance"
        />
        <Metric
          label="Active funded orders"
          value={snapshot.markets.reduce(
            (s, m) =>
              s +
              m.orders.filter(
                (o) => o.owner.toLowerCase() === maker.address.toLowerCase(),
              ).length,
            0,
          )}
        />
        <Metric
          label="Quote worker"
          value={
            maker.maintenance
              ? "Test session"
              : !snapshot.service.newExposureAllowed
                ? "Risk pause"
                : maker.enabled
                  ? "Running"
                  : "Paused"
          }
          sub={
            maker.maintenance
              ? "Workers suspended for a local checkpoint"
              : "Meaningful price moves trigger updates"
          }
          tone={maker.enabled ? "positive" : "muted"}
        />
      </div>
      {local && (
        <Panel title="Quote and inventory limits">
          <form
            className="maker-settings"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings();
            }}
          >
            <div className="maker-settings-fields">
              {(
                [
                  ["volatility", "Model volatility (%)", 10, 200, 1],
                  ["spreadBps", "Spread buffer (%)", 1, 50, 0.01],
                  ["edge", "Minimum edge (dUSDC)", 0, 0.1, 0.000001],
                  ["targetInventory", "Target depth (MON / side)", 1, 100, 1],
                  ["maxWritten", "Issuance cap (MON / series)", 1, 300, 1],
                  [
                    "maxNetInventory",
                    "Net inventory cap (MON / series)",
                    1,
                    300,
                    1,
                  ],
                  [
                    "maxPortfolioInventory",
                    "Portfolio exposure cap (MON)",
                    1,
                    50000,
                    1,
                  ],
                  [
                    "maxExpiryInventory",
                    "Expiry exposure cap (MON)",
                    1,
                    50000,
                    1,
                  ],
                  ["maxTotalWritten", "Total issuance cap (MON)", 1, 100000, 1],
                  ["inventorySkewBps", "Inventory skew (%)", 0, 50, 0.01],
                ] as const
              ).map(([key, label, min, max, step]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    type="number"
                    required
                    min={min}
                    max={max}
                    step={step}
                    value={draft[key]}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      setDirty(true);
                      setSettingsError("");
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="maker-settings-actions">
              <p className="caption">
                Exposure limits reserve worst-case fills across every series and
                expiry. A tighter limit cancels unsafe quotes on the next cycle;
                existing obligations remain fully backed. Total issuance limits
                replenishment across the shelf. Skew raises prices when short
                and lowers them when long. Pausing stops updates; resting orders
                remain executable. Halt cancels and withdraws project liquidity.
              </p>
              {dirty && (
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setDraft(initial());
                    setDirty(false);
                    setSettingsError("");
                  }}
                >
                  Reset changes
                </Button>
              )}
              <Button
                type="submit"
                className="primary"
                busy={pending}
                disabled={
                  !dirty ||
                  Number(draft.maxWritten) < Number(draft.targetInventory)
                }
              >
                Save settings
              </Button>
            </div>
            {Number(draft.maxWritten) < Number(draft.targetInventory) && (
              <p className="negative" role="alert">
                Issuance cap must cover target inventory.
              </p>
            )}
            {settingsError && (
              <p className="negative" role="alert">
                {settingsError}
              </p>
            )}
          </form>
        </Panel>
      )}
      <div className="notice">
        <Activity size={16} />
        <p>
          Maker account <AddressText value={maker.address} /> · Project-funded
          inventory follows each contract's allocation and the shared risk
          budgets. Net options = wallet claims + free venue claims + funded asks
          − writer obligations. Option Greeks exclude collateral and other
          underlying holdings. No spot hedge is active.
        </p>
      </div>
      {config.inventoryTargets && (
        <Panel title="Funded depth allocations">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Asset / contract</th>
                  <th>Target per side</th>
                  <th>Issuance limit</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.inventoryTargets).map(
                  ([key, allocation]) => (
                    <tr key={key}>
                      <td>{key.replace(":", " · ")}</td>
                      <td>{num(allocation.targetInventory)} contracts</td>
                      <td>{num(allocation.maxWritten)} contracts</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="caption">
            Targets are capped by actual collateral, venue lots and the existing
            underlying-notional and portfolio limits.
          </p>
        </Panel>
      )}
      <div className="maker-risk-strip">
        <div>
          <span>Net option delta</span>
          <strong>{num(optionDelta, 3)} MON</strong>
        </div>
        <div>
          <span>Option vega / 1%</span>
          <strong>{usd(optionVega, 4)}</strong>
        </div>
        <div>
          <span>Free venue dUSDC</span>
          <strong>{usd(maker.venueUsdc)}</strong>
        </div>
        <div>
          <span>Net inventory cap</span>
          <strong>±{config.maxNetInventory} MON / series</strong>
        </div>
      </div>
      <Panel title="Portfolio risk budgets">
        <div className="maker-risk-strip">
          <div>
            <span>Gross net options</span>
            <strong>{num(Number(maker.risk.grossClaims) / 1e18, 3)} MON</strong>
          </div>
          <div>
            <span>Including resting fills</span>
            <strong>
              {num(Number(maker.risk.reservedGrossClaims) / 1e18, 3)} /{" "}
              {num(config.maxPortfolioInventory)} MON
            </strong>
          </div>
          <div>
            <span>Issued claims</span>
            <strong>
              {num(Number(maker.risk.writtenClaims) / 1e18, 3)} /{" "}
              {num(config.maxTotalWritten)} MON
            </strong>
          </div>
          <div>
            <span>Budget status</span>
            <strong
              className={
                maker.risk.actualBreached ||
                maker.risk.reservationBreached ||
                maker.risk.issuanceBreached
                  ? "negative"
                  : "positive"
              }
            >
              {maker.risk.actualBreached
                ? "Reducing exposure"
                : maker.risk.reservationBreached
                  ? "Quotes need resize"
                  : maker.risk.issuanceBreached
                    ? "Issuance restricted"
                    : "Within limits"}
            </strong>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Expiry</th>
                <th>Gross net options</th>
                <th>Worst-case fills</th>
                <th>Expiry limit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {maker.risk.expiries.map((e) => (
                <tr key={e.expiry}>
                  <td>{expiry(e.expiry)}</td>
                  <td>{num(Number(e.grossClaims) / 1e18, 3)} MON</td>
                  <td>{num(Number(e.reservedGrossClaims) / 1e18, 3)} MON</td>
                  <td>{num(config.maxExpiryInventory)} MON</td>
                  <td>
                    {BigInt(e.reservedGrossClaims) >
                    BigInt(config.maxExpiryInventory) * 10n ** 18n
                      ? "Restricted"
                      : "Within limit"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="caption">
          Gross exposure adds absolute net claim quantities. Resting bids and
          asks reserve their worst-case partial fills; opposite strikes and
          expiries receive no hedge credit. Greeks are informational. Lower
          limits restrict new quotes and issuance without releasing collateral.
        </p>
      </Panel>
      <Panel title="Market coverage">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Spread</th>
                <th>Net options</th>
                <th>Price skew</th>
                <th>Bid depth</th>
                <th>Ask depth</th>
                <th>Writer collateral</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.markets.map((m) => {
                const position = maker.inventory.find(
                  (position) => position.marketId === m.id,
                )!;
                const owned = m.orders.filter(
                  (order) =>
                    order.owner.toLowerCase() === maker.address.toLowerCase(),
                );
                return (
                  <tr key={m.id}>
                    <td>{m.symbol}</td>
                    <td className="positive">
                      {m.bid === null ? "—" : m.bid.toFixed(5)}
                    </td>
                    <td className="negative">
                      {m.ask === null ? "—" : m.ask.toFixed(5)}
                    </td>
                    <td>
                      {m.bid !== null && m.ask !== null
                        ? (m.ask - m.bid).toFixed(5)
                        : "—"}
                    </td>
                    <td
                      className={
                        position.netQuantity < 0
                          ? "negative"
                          : position.netQuantity > 0
                            ? "positive"
                            : "muted"
                      }
                    >
                      {num(position.netQuantity, 3)}
                    </td>
                    <td>
                      {position.priceSkewBps > 0 ? "+" : ""}
                      {num(position.priceSkewBps / 100, 2)}%
                    </td>
                    <td
                      title={`Remaining buy capacity: ${num(position.bidCapacity, 3)} MON`}
                    >
                      {num(
                        owned
                          .filter((order) => order.isBuy)
                          .reduce((sum, order) => sum + order.remaining, 0),
                        3,
                      )}
                    </td>
                    <td
                      title={`Remaining sell capacity: ${num(position.askCapacity, 3)} MON`}
                    >
                      {num(
                        owned
                          .filter((order) => !order.isBuy)
                          .reduce((sum, order) => sum + order.remaining, 0),
                        3,
                      )}
                    </td>
                    <td>
                      {num(
                        Number(position.collateral) /
                          (m.kind === "call" ? 1e18 : 1e6),
                        3,
                      )}{" "}
                      {m.kind === "call" ? "WMON" : "dUSDC"}
                    </td>
                    <td>
                      <Badge
                        tone={
                          m.active && !m.healthy
                            ? "amber"
                            : m.active && m.bid !== null && m.ask !== null
                              ? "green"
                              : "neutral"
                        }
                      >
                        {!m.active
                          ? "Expired"
                          : !m.healthy
                            ? "Risk pause"
                            : m.bid !== null && m.ask !== null
                              ? "Two-sided"
                              : "Thin"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {haltOpen && (
        <Modal title="Halt maker liquidity" onClose={() => setHaltOpen(false)}>
          <p>
            Stop quote updates, cancel the project's funded orders, and return
            free venue funds to the maker wallet.
          </p>
          <div className="review-details">
            <div>
              <span>Maker account</span>
              <AddressText value={maker.address} full />
            </div>
            <div>
              <span>Funded orders</span>
              <strong>{makerOrders.length}</strong>
            </div>
            <div>
              <span>Estimated dUSDC returned</span>
              <strong>
                {usd(
                  maker.venueUsdc +
                    makerOrders
                      .filter((order) => order.isBuy)
                      .reduce((sum, order) => sum + order.reserved, 0),
                  4,
                )}
              </strong>
            </div>
          </div>
          <p className="caption">
            Writer collateral remains in series escrow. Quote updates stay
            paused across service restarts until resumed.
          </p>
          <Button className="danger full" onClick={() => void halt()}>
            Confirm halt & withdrawal
          </Button>
        </Modal>
      )}
      {maker.errors.length > 0 && (
        <Panel title="Worker diagnostics">
          <div className="diagnostics">
            {maker.errors.map((e, i) => (
              <pre key={i}>{e}</pre>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
export function Status() {
  const { snapshot, notify } = useApp();
  const [price, setPrice] = useState(String(snapshot.spot)),
    [seconds, setSeconds] = useState("360"),
    [pending, setPending] = useState(false);
  const m = snapshot.manifest;
  async function advance() {
    setPending(true);
    try {
      await request("/demo/advance", {
        seconds: Number(seconds),
        price: Number(price),
      });
      notify("Local scenario executed. Expired claims can now settle.");
    } catch (e) {
      notify(String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PROTOCOL STATUS</span>
          <h1>Protocol status</h1>
          <p>Contracts, indexing and oracle observations.</p>
        </div>
        <Badge tone={snapshot.service.status === "ready" ? "green" : "amber"}>
          {snapshot.service.status === "ready"
            ? "Services operational"
            : snapshot.service.status === "offline"
              ? "Connection interrupted"
              : "New exposure paused"}
        </Badge>
      </div>
      <div className="stats-grid">
        <Metric
          label="Network"
          value={`Chain ${m.chainId}`}
          sub={
            m.mode === "local-fork"
              ? "Local fork of Monad testnet"
              : "Local development"
          }
        />
        <Metric
          label="Execution venue"
          value={m.venueMode === "kuru" ? "Kuru contracts" : "Development book"}
          sub="Verified exact-fill integration"
        />
        <Metric
          label="Indexed block"
          value={snapshot.block}
          sub={`${snapshot.indexer.eventCount} decoded events`}
        />
        <Metric
          label="Oracle policy"
          value={
            m.oracleMode === "demo" ? "Controlled demo" : "Pyth unique update"
          }
          sub={
            snapshot.service.oracleValid
              ? `Freshness limit ${snapshot.service.maxPriceAge}s`
              : "Current observation unavailable"
          }
        />
      </div>
      <Panel
        title="Deployment manifest"
        extra={
          <Button
            onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(
                new Blob([JSON.stringify(m, null, 2)], {
                  type: "application/json",
                }),
              );
              a.download = "strata-manifest.json";
              a.click();
            }}
          >
            Download manifest <Download size={14} />
          </Button>
        }
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Address</th>
                <th>Responsibility</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  "Options engine",
                  m.engine,
                  "Isolated backing, issuance, payout and writer accounting",
                ],
                [
                  "Strategy router",
                  m.router,
                  "Atomic exact-quantity execution and premium limits",
                ],
                [
                  "Oracle",
                  m.oracle,
                  "Controlled first-post-expiry observations",
                ],
                [
                  "Demo USDC",
                  m.usdc,
                  "Six-decimal, clearly identified test asset",
                ],
                ["Wrapped test MON", m.wmon, "Native test MON backing"],
                ...(m.kuruFactory
                  ? [
                      [
                        "Kuru factory",
                        m.kuruFactory,
                        "External deployed router on the fork",
                      ],
                      [
                        "Kuru margin",
                        m.kuruMargin!,
                        "Venue custody; separate from writer escrow",
                      ],
                    ]
                  : []),
              ].map(([label, address, desc]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>
                    <AddressText value={address} />
                  </td>
                  <td className="muted">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="two-column">
        <Panel title="Local settlement scenario">
          <div className="form-body">
            <p className="muted">
              Advance the local chain and publish a controlled observation. This
              changes local expiry timing and may close markets.
            </p>
            <label className="field">
              <span>Advance seconds</span>
              <div>
                <input
                  aria-label="Advance seconds"
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                />
                <span>seconds</span>
              </div>
            </label>
            <label className="field">
              <span>Post-expiry MON reference</span>
              <div>
                <input
                  aria-label="Scenario price"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                <span>USD</span>
              </div>
            </label>
            <Button
              className="primary"
              busy={pending}
              onClick={() => void advance()}
            >
              Run local scenario
            </Button>
          </div>
        </Panel>
        <Panel title="Direct recovery">
          <div className="form-body">
            <h3>Claims do not require this interface.</h3>
            <p className="muted">
              Call the options engine directly using your own wallet. Claims
              remain available independently of pricing and the indexer once the
              expiry reference is finalized.
            </p>
            <pre className="code-block">
              redeemLong(seriesId, quantity, recipient)
              <br />
              settleWriter(seriesId, recipient)
              <br />
              closeWrite(seriesId, quantity)
            </pre>
            <p className="caption">
              Cancel and withdraw venue-held tokens before redeeming or burning
              them. Copy contract addresses above; verified ABI files are
              included in the repository.
            </p>
            <a
              className="text-link"
              href="/third-party-notices.txt"
              target="_blank"
              rel="noreferrer"
            >
              Third-party notices
            </a>
          </div>
        </Panel>
      </div>
    </>
  );
}
