import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { ShieldCheck, Plus, Info, ChevronDown } from "lucide-react";
import { TradingChart } from "./TradingChart.tsx";
import { OptionChain } from "./OptionChain.tsx";
import { TradeDock } from "./TradeDock.tsx";
import { chartTheme, tooltipStyle } from "./chart-theme.ts";
import { useApp } from "./context.ts";
import {
  underlyingOf,
  underlyingKeys,
  sessionLabel,
  Panel,
  Metric,
  Badge,
  Modal,
  Button,
  Empty,
  usd,
  num,
  expiry,
  remaining,
  time,
} from "./ui.tsx";
import type { Market } from "../../../packages/core/src/index.ts";
import { quoteDepth, kinds } from "../../../packages/core/src/index.ts";

const CHANGE_WINDOW_SECONDS = 7200;
const MARKET_SLIPPAGE = 0.005;
const QUICK_SIZES = [5, 10, 25, 50];

const kindLabel = (m: Market) =>
  m.kind === "call"
    ? "Call"
    : m.kind === "put"
      ? "Put"
      : m.kind === "bull-spread"
        ? "Bull spread"
        : "Bear spread";

function payoffAt(m: Market, price: number) {
  if (m.kind === "call") return Math.max(price - m.strike, 0);
  if (m.kind === "put") return Math.max(m.strike - price, 0);
  const width = m.upperStrike - m.strike;
  return m.kind === "bull-spread"
    ? Math.min(Math.max(price - m.strike, 0), width)
    : Math.min(Math.max(m.upperStrike - price, 0), width);
}

// Underlying price at which a long position's expiry payoff equals its cost.
function breakeven(m: Market, premium: number) {
  if (m.kind === "call" || m.kind === "bull-spread") return m.strike + premium;
  if (m.kind === "put") return m.strike - premium;
  return m.upperStrike - premium;
}

function BookPanel() {
  const { selected: m, snapshot } = useApp();
  const [view, setView] = useState<"book" | "trades">("book");
  const max = Math.max(
    ...m.asks.map((l) => l.total),
    ...m.bids.map((l) => l.total),
    1,
  );
  const depthStyle = (total: number) =>
    ({ "--depth": `${(total / max) * 100}%` }) as React.CSSProperties;
  const trades = snapshot.trades
    .filter((t) => t.marketId === m.id)
    .slice(-30)
    .reverse();
  return (
    <Panel
      className="book-panel"
      title={
        <div className="tabs plain">
          <button
            className={view === "book" ? "active" : ""}
            onClick={() => setView("book")}
          >
            Order book
          </button>
          <button
            className={view === "trades" ? "active" : ""}
            onClick={() => setView("trades")}
          >
            Trades
          </button>
        </div>
      }
    >
      <div className="book-body">
        {view === "book" ? (
          <>
            <div className="depth-label">
              <span>Price</span>
              <span>Size</span>
              <span>Total</span>
            </div>
            <div className="depth-side asks">
              {[...m.asks].reverse().map((l) => (
                <div
                  key={l.price}
                  className="depth-row ask"
                  style={depthStyle(l.total)}
                >
                  <span>{l.price.toFixed(5)}</span>
                  <span>{num(l.quantity, 3)}</span>
                  <span>{num(l.total, 3)}</span>
                </div>
              ))}
            </div>
            <div className="spread-line">
              <strong>
                {m.bid !== null && m.ask !== null
                  ? ((m.bid + m.ask) / 2).toFixed(5)
                  : "—"}
              </strong>
              <span>
                Spread{" "}
                {m.bid !== null && m.ask !== null
                  ? `${(m.ask - m.bid).toFixed(5)} · ${num(((m.ask - m.bid) / ((m.ask + m.bid) / 2)) * 100, 1)}%`
                  : "—"}
              </span>
            </div>
            <div className="depth-side bids">
              {m.bids.map((l) => (
                <div
                  key={l.price}
                  className="depth-row bid"
                  style={depthStyle(l.total)}
                >
                  <span>{l.price.toFixed(5)}</span>
                  <span>{num(l.quantity, 3)}</span>
                  <span>{num(l.total, 3)}</span>
                </div>
              ))}
            </div>
            <div className="depth-footer">
              Kuru book · funded orders · zero venue fees
            </div>
          </>
        ) : (
          <div className="recent-trades">
            <div className="depth-label">
              <span>Price</span>
              <span>Size</span>
              <span>Time</span>
            </div>
            {trades.map((t, i) => (
              <div className="depth-row" key={t.hash + i}>
                <span className={t.isBuy ? "positive" : "negative"}>
                  {t.price.toFixed(5)}
                </span>
                <span>{num(t.quantity, 3)}</span>
                <span>{time(t.timestamp)}</span>
              </div>
            ))}
            {!trades.length && (
              <Empty title="No fills yet">
                Fills appear here after onchain inclusion.
              </Empty>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Ticket() {
  const {
    selected: m,
    portfolio,
    act,
    busy,
    snapshot,
    walletAddress,
  } = useApp();
  const [params] = useSearchParams();
  const [isBuy, setBuy] = useState(params.get("side") !== "sell"),
    [type, setType] = useState<"market" | "limit">("market"),
    [quantity, setQuantity] = useState(
      snapshot.manifest.mode === "testnet" ? "0.1" : "10",
    ),
    [limit, setLimit] = useState("0.03"),
    [review, setReview] = useState(false);
  const q = Number(quantity),
    quote = quoteDepth(isBuy ? m.asks : m.bids, q),
    premium = type === "market" ? quote.total : q * Number(limit),
    average = q > 0 ? premium / q : 0,
    balance = isBuy
      ? (portfolio?.usdc ?? 0)
      : (portfolio?.positions.find((p) => p.marketId === m.id)?.quantity ?? 0);
  const fundedDepth = (isBuy ? m.asks : m.bids).reduce(
    (sum, level) => sum + level.quantity,
    0,
  );
  const quickSizes =
    snapshot.manifest.mode !== "testnet"
      ? QUICK_SIZES
      : fundedDepth >= 50
        ? [5, 10, 25, 50]
        : fundedDepth >= 25
          ? [1, 5, 10, 25]
          : fundedDepth >= 5
            ? [0.5, 1, 2, 5]
            : fundedDepth >= 3
              ? [0.25, 0.5, 1, 3]
              : [0.1, 0.25, 0.5, 1];
  const valid =
    Number.isFinite(q) &&
    q > 0 &&
    Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6 &&
    m.active &&
    m.healthy &&
    (type === "limit" ? Number(limit) > 0 : quote.complete) &&
    balance >= (isBuy ? premium : q);
  const maxPayout =
    m.kind === "bull-spread" || m.kind === "bear-spread"
      ? m.upperStrike - m.strike
      : null;
  async function submit() {
    setReview(false);
    await act(
      type === "market"
        ? {
            action: "trade",
            marketId: m.id,
            isBuy,
            quantity,
            price: (isBuy
              ? Math.ceil(premium * (1 + MARKET_SLIPPAGE) * 1e6) / 1e6
              : Math.floor(premium * (1 - MARKET_SLIPPAGE) * 1e6) / 1e6
            ).toFixed(6),
          }
        : { action: "place", marketId: m.id, isBuy, quantity, price: limit },
    );
  }
  const session = underlyingOf(snapshot, m.asset);
  const closed = !session.open;
  const mid = m.bid !== null && m.ask !== null ? (m.bid + m.ask) / 2 : null;
  const priceChips: [string, number | null][] = [
    ["Bid", m.bid],
    ["Mid", mid],
    ["Ask", m.ask],
  ];
  return (
    <Panel
      title="Order entry"
      extra={<span className="caption">{kindLabel(m)} · European</span>}
      className="ticket"
    >
      <div className="ticket-body">
        <div className="contract-heading">
          <strong>{m.symbol}</strong>
          <span>{remaining(m.expiry, snapshot.timestamp)}</span>
        </div>
        <div className="segmented side-selector">
          <button
            className={isBuy ? "active buy" : ""}
            onClick={() => setBuy(true)}
          >
            Buy / Long
          </button>
          <button
            className={!isBuy ? "active sell" : ""}
            onClick={() => setBuy(false)}
          >
            Sell holdings
          </button>
        </div>
        <div className="tabs ticket-tabs">
          <button
            className={type === "market" ? "active" : ""}
            onClick={() => setType("market")}
          >
            Market
          </button>
          <button
            className={type === "limit" ? "active" : ""}
            onClick={() => {
              setType("limit");
              setLimit((isBuy ? (m.bid ?? 0.001) : (m.ask ?? 0.01)).toFixed(6));
            }}
          >
            Limit
          </button>
        </div>
        {type === "limit" && (
          <>
            <label className="field">
              <span>
                Limit price <small>per contract</small>
              </span>
              <div>
                <input
                  aria-label="Limit price"
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
                <span>dUSDC</span>
              </div>
            </label>
            <div className="price-chips">
              {priceChips.map(([label, value]) => (
                <button
                  key={label}
                  disabled={value === null}
                  onClick={() => value !== null && setLimit(value.toFixed(6))}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        <label className="field">
          <span>
            Size <small>1 contract = 1 {m.asset}</small>
          </span>
          <div>
            <input
              aria-label="Trade quantity"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <span>contracts</span>
          </div>
        </label>
        <div className="quick-sizes">
          {quickSizes.map((n) => (
            <button key={n} onClick={() => setQuantity(String(n))}>
              {n}
            </button>
          ))}
        </div>
        <div className="ticket-summary">
          <div>
            <span>Available</span>
            <span>
              {num(balance, 2)} {isBuy ? "dUSDC" : "contracts"}
            </span>
          </div>
          <div>
            <span>{type === "market" ? "Avg. fill price" : "Limit price"}</span>
            <span>{average > 0 ? average.toFixed(5) : "—"}</span>
          </div>
          {isBuy && (
            <div>
              <span>Breakeven at expiry</span>
              <span>{average > 0 ? usd(breakeven(m, average), 4) : "—"}</span>
            </div>
          )}
          <div>
            <span>{isBuy ? "Max loss" : "Min. proceeds"}</span>
            <span>
              {type === "market" && !isBuy
                ? usd(premium * (1 - MARKET_SLIPPAGE), 4)
                : usd(premium, 4)}
            </span>
          </div>
          {maxPayout !== null && (
            <div>
              <span>Max payout</span>
              <span>{usd(maxPayout * q, 4)}</span>
            </div>
          )}
          <div>
            <span>Fees (venue / protocol)</span>
            <span>0.00 / 0.00</span>
          </div>
          <div className="total">
            <span>{type === "market" ? "Premium" : "Order value"}</span>
            <strong>{usd(premium, 4)}</strong>
          </div>
        </div>
        <Button
          className={`full ${isBuy ? "buy" : "sell"}`}
          disabled={!valid}
          busy={busy}
          onClick={() => setReview(true)}
        >
          {snapshot.manifest.mode === "testnet" && !walletAddress
            ? "Connect wallet to trade"
            : !m.active
              ? "Expired"
              : !m.healthy
                ? closed
                  ? "Market closed"
                  : "Price unavailable"
                : !quote.complete && type === "market"
                  ? "Insufficient depth"
                  : balance < (isBuy ? premium : q)
                    ? "Insufficient balance"
                    : isBuy
                      ? "Review purchase"
                      : "Review sale"}
        </Button>
        {closed && m.active && (
          <p className="ticket-note">
            <Info size={12} />
            {m.asset} session: {sessionLabel(session, snapshot.timestamp)}. New
            orders resume at the open; cancellations and claims stay available.
          </p>
        )}
        <p className="ticket-note">
          <ShieldCheck size={12} />
          {isBuy
            ? "Fully backed claim. Maximum loss is the premium paid."
            : "Sells claims you already hold. No naked shorts."}
        </p>
      </div>
      <div className="ticket-specs">
        <h3>Contract</h3>
        <div>
          <span>Mark</span>
          <span>{m.mark.toFixed(5)}</span>
        </div>
        <div>
          <span>Model IV</span>
          <span>{num(m.iv * 100, 1)}%</span>
        </div>
        <div>
          <span>Delta</span>
          <span>{m.greeks.delta.toFixed(4)}</span>
        </div>
        <div>
          <span>Gamma</span>
          <span>{m.greeks.gamma.toFixed(4)}</span>
        </div>
        <div>
          <span>Vega 1%</span>
          <span>{m.greeks.vega.toFixed(5)}</span>
        </div>
        <div>
          <span>Theta 1d</span>
          <span>{m.greeks.theta.toFixed(5)}</span>
        </div>
        <div>
          <span>Strike</span>
          <span>
            {num(m.strike, 8)}
            {m.upperStrike > 0 && ` / ${num(m.upperStrike, 8)}`}
          </span>
        </div>
        <div>
          <span>Settles in</span>
          <span>{m.kind === "call" ? "WMON" : "dUSDC"}</span>
        </div>
        <div>
          <span>Expiry</span>
          <span>{expiry(m.expiry)}</span>
        </div>
        <div>
          <span>Open int.</span>
          <span>{num(m.openInterest, 3)}</span>
        </div>
      </div>
      <div className="ticket-links">
        <Link className="text-link" to={`/write?market=${m.id}`}>
          <Plus size={12} /> Write this series
        </Link>
        <Link className="text-link" to="/strategies">
          Multi-leg strategies
        </Link>
      </div>
      {review && (
        <Modal
          title={type === "limit" ? "Review limit order" : "Review trade"}
          onClose={() => setReview(false)}
        >
          <div className="review-instrument">
            <Badge tone={isBuy ? "green" : "red"}>
              {isBuy ? "BUY" : "SELL"}
            </Badge>
            <h3>{m.symbol}</h3>
          </div>
          <dl className="review-list">
            <div>
              <dt>Quantity</dt>
              <dd>
                {num(q)} {m.asset} contracts
              </dd>
            </div>
            <div>
              <dt>Premium {isBuy ? "payment" : "proceeds"}</dt>
              <dd>{usd(premium, 6)} dUSDC</dd>
            </div>
            <div>
              <dt>Price protection</dt>
              <dd>
                {type === "market"
                  ? "0.5% maximum slippage"
                  : "Post-only limit order"}
              </dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>{new Date(m.expiry * 1000).toUTCString()}</dd>
            </div>
            <div>
              <dt>Settlement asset</dt>
              <dd>
                {m.kind === "call" ? "WMON (underlying tokens)" : "dUSDC"}
              </dd>
            </div>
            <div>
              <dt>Network gas</dt>
              <dd>Paid separately in test MON</dd>
            </div>
          </dl>
          <div className="notice">
            <Info size={14} />
            <p>
              {type === "limit"
                ? "Funds are reserved in Kuru until the order fills or you cancel and withdraw."
                : "Exact quantity or the transaction reverts. Purchased claims are delivered to your wallet."}
            </p>
          </div>
          <Button
            className={`full ${isBuy ? "buy" : "sell"}`}
            busy={busy}
            onClick={() => void submit()}
          >
            Confirm {isBuy ? "purchase" : "sale"}
          </Button>
          <p className="caption center">
            {snapshot.manifest.mode === "testnet"
              ? "Monad testnet"
              : "Local fork"}{" "}
            · Project-provided test liquidity
          </p>
        </Modal>
      )}
    </Panel>
  );
}

function PayoffChart({ market: m }: { market: Market }) {
  const { snapshot } = useApp();
  const spot = underlyingOf(snapshot, m.asset).spot || m.strike;
  const points = Array.from({ length: 61 }, (_, i) => {
    const price = spot * (0.5 + i / 60);
    return { price, value: payoffAt(m, price) };
  });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={points}
        margin={{ top: 16, right: 8, bottom: 4, left: 8 }}
      >
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          dataKey="price"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(x) => usd(x)}
          minTickGap={48}
          tickLine={false}
          axisLine={{ stroke: chartTheme.axis }}
        />
        <YAxis
          domain={["auto", "auto"]}
          orientation="right"
          tickFormatter={(x) => num(x, 3)}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(x) => `${m.asset} ${usd(Number(x), 4)}`}
          formatter={(v) => [num(Number(v), 5), "Payoff / contract"]}
        />
        <Area
          type="linear"
          dataKey="value"
          stroke={chartTheme.accent}
          strokeWidth={1.5}
          fill="rgb(138 164 214 / 0.06)"
          isAnimationActive={false}
        />
        <ReferenceLine
          x={m.strike}
          stroke={chartTheme.axis}
          strokeDasharray="3 3"
        />
        <ReferenceLine x={spot} stroke={chartTheme.crosshair} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Decimal places for an underlying price: low-priced assets need more. */
const priceDigits = (price: number) => (price < 0.1 ? 5 : price < 10 ? 4 : 2);

function MarketOverview() {
  const { snapshot, selected, select } = useApp();
  const keys = underlyingKeys(snapshot);
  const overview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = overview.current;
    if (!strip || keys.length <= 4) return;
    const card = [...strip.children].find(
      (node) => node.getAttribute("aria-label") === selected.asset,
    ) as HTMLElement | undefined;
    if (!card) return;
    const left = card.offsetLeft - strip.offsetLeft;
    if (
      left < strip.scrollLeft ||
      left + card.offsetWidth > strip.scrollLeft + strip.clientWidth
    )
      strip.scrollTo({
        left: Math.max(0, left - (strip.clientWidth - card.offsetWidth) / 2),
      });
  }, [selected.asset, keys.length]);
  if (keys.length < 2) return null;
  // Switching underlying opens its nearest-expiry, at-the-money contract.
  function open(key: string) {
    const spot = underlyingOf(snapshot, key).spot;
    const candidates = snapshot.markets.filter(
      (m) => m.asset === key && m.active,
    );
    const nearest = Math.min(...candidates.map((m) => m.expiry));
    const pick = candidates
      .filter((m) => m.expiry === nearest)
      .sort(
        (a, b) =>
          Math.abs(a.strike - spot) - Math.abs(b.strike - spot) ||
          Math.min(
            b.bids.reduce((sum, level) => sum + level.quantity, 0),
            b.asks.reduce((sum, level) => sum + level.quantity, 0),
          ) -
            Math.min(
              a.bids.reduce((sum, level) => sum + level.quantity, 0),
              a.asks.reduce((sum, level) => sum + level.quantity, 0),
            ) ||
          kinds.indexOf(a.kind) - kinds.indexOf(b.kind),
      )[0];
    if (pick) select(pick.id);
  }
  return (
    <div
      ref={overview}
      className={`market-overview ${keys.length > 4 ? "market-overview-expanded" : ""}`}
      role="tablist"
      aria-label="Underlying"
      style={{ "--market-assets": keys.length } as React.CSSProperties}
    >
      {keys.map((key) => {
        const state = underlyingOf(snapshot, key);
        const points = state.prices.filter(
          (point) =>
            point.timestamp >= snapshot.timestamp - CHANGE_WINDOW_SECONDS &&
            point.price > 0,
        );
        const change =
          points.length > 1 ? (state.spot / points[0].price - 1) * 100 : null;
        const prices = points.slice(-40).map((point) => point.price);
        const low = Math.min(...prices),
          high = Math.max(...prices);
        const line = prices
          .map(
            (value, i) =>
              `${(i / Math.max(1, prices.length - 1)) * 66},${24 - ((value - low) / (high - low || 1)) * 20}`,
          )
          .join(" ");
        return (
          <button
            key={key}
            role="tab"
            aria-label={key}
            aria-selected={selected.asset === key}
            className={selected.asset === key ? "active" : ""}
            title={sessionLabel(state, snapshot.timestamp)}
            onClick={() => open(key)}
          >
            <span className="market-overview-name">
              <i className={`dot ${state.open ? "mint" : ""}`} />
              {key}
              <small>{state.open ? "Live index" : "Session closed"}</small>
            </span>
            <span className="market-overview-price">
              <strong>{num(state.spot, priceDigits(state.spot))}</strong>
              <small
                className={
                  change !== null && change < 0 ? "negative" : "positive"
                }
              >
                {change === null
                  ? "Awaiting history"
                  : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% · 2h`}
              </small>
            </span>
            {prices.length > 1 && (
              <svg
                className={
                  change !== null && change < 0 ? "negative" : "positive"
                }
                viewBox="0 0 66 28"
                aria-hidden="true"
              >
                <polyline
                  points={line}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

function InstrumentBar() {
  const { snapshot, selected: m, openSearch } = useApp();
  return (
    <div className="instrument-bar">
      <button
        className="asset-title"
        onClick={openSearch}
        aria-label="Change instrument"
        title={m.symbol}
      >
        <div className="instrument-contract">
          <h1>
            {m.asset} <span>{kindLabel(m)}</span>
          </h1>
          <small>
            {num(m.strike, 8)}
            {m.upperStrike ? ` / ${num(m.upperStrike, 8)}` : ""} ·{" "}
            {new Date(m.expiry * 1000).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </small>
        </div>
        <ChevronDown size={13} />
      </button>
      <Metric label="Mark" value={m.mark.toFixed(5)} />
      <Metric label="Model IV" value={`${num(m.iv * 100, 1)}%`} />
      <Metric
        label="Open interest"
        value={`${num(m.openInterest, 3)} contracts`}
      />
      <Metric
        label="Bid / ask depth"
        value={`${num(
          m.bids.reduce((sum, level) => sum + level.quantity, 0),
          3,
        )} / ${num(
          m.asks.reduce((sum, level) => sum + level.quantity, 0),
          3,
        )}`}
      />
      <Metric label="Expires" value={remaining(m.expiry, snapshot.timestamp)} />
    </div>
  );
}

export function Trade() {
  const { snapshot, selected: m } = useApp();
  const [chart, setChart] = useState<"underlying" | "payoff">("underlying");
  return (
    <>
      <MarketOverview />
      <InstrumentBar />
      <div className="trade-layout">
        <Panel
          title={
            <div className="tabs plain">
              <button
                className={chart === "underlying" ? "active" : ""}
                onClick={() => setChart("underlying")}
              >
                {m.asset} / USD
              </button>
              <button
                className={chart === "payoff" ? "active" : ""}
                onClick={() => setChart("payoff")}
              >
                Expiry payoff
              </button>
            </div>
          }
          extra={
            chart === "payoff" && (
              <span className="caption">{m.symbol} · per contract</span>
            )
          }
          className="price-panel"
        >
          <div className="chart">
            {chart === "underlying" ? (
              <TradingChart
                key={m.asset}
                symbol={`${m.asset} / USD`}
                digits={priceDigits(underlyingOf(snapshot, m.asset).spot) + 1}
                observations={underlyingOf(snapshot, m.asset).prices}
                now={snapshot.timestamp}
                source={
                  snapshot.manifest.oracleMode === "pyth"
                    ? "Pyth"
                    : "Controlled oracle"
                }
              />
            ) : (
              <PayoffChart market={m} />
            )}
          </div>
        </Panel>
        <BookPanel />
        <Ticket />
        <OptionChain />
      </div>
      <TradeDock />
    </>
  );
}
