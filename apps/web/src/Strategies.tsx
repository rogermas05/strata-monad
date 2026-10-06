import { useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Plus, X, Info, Layers } from "lucide-react";
import { useApp } from "./context.ts";
import { chartTheme, tooltipStyle } from "./chart-theme.ts";
import {
  Panel,
  Metric,
  Badge,
  Button,
  Modal,
  usd,
  num,
  expiry,
  underlyingOf,
} from "./ui.tsx";
import {
  expiryPayoff,
  quoteDepth,
  type Market,
} from "../../../packages/core/src/index.ts";

type Leg = { id: number; isBuy: boolean; quantity: string };
export function Strategies() {
  const { snapshot, selected, portfolio, act, busy } = useApp();
  const defaultQuantity = snapshot.manifest.mode === "testnet" ? "0.1" : "10";
  const [legs, setLegs] = useState<Leg[]>([
      { id: selected.id, isBuy: true, quantity: defaultQuantity },
    ]),
    [review, setReview] = useState(false);
  const [template, setTemplate] = useState("Custom");
  // A strategy is built on one underlying: the first leg's.
  const asset =
    snapshot.markets.find((m) => m.id === legs[0]?.id)?.asset ?? selected.asset;
  const reference = underlyingOf(snapshot, asset).spot;
  const active = snapshot.markets.filter((m) => m.active && m.asset === asset),
    atm = (kind: string) =>
      active
        .filter((m) => m.kind === kind)
        .sort(
          (a, b) =>
            Math.abs(a.strike - reference) - Math.abs(b.strike - reference) ||
            a.expiry - b.expiry,
        )[0];
  function preset(name: string) {
    setTemplate(name);
    const c = atm("call"),
      p = c
        ? active.find(
            (m) =>
              m.kind === "put" &&
              m.strike === c.strike &&
              m.expiry === c.expiry,
          )
        : undefined;
    if (name === "Long call" && c)
      setLegs([{ id: c.id, isBuy: true, quantity: defaultQuantity }]);
    if (name === "Long put" && p)
      setLegs([{ id: p.id, isBuy: true, quantity: defaultQuantity }]);
    if (name === "Straddle" && c && p)
      setLegs([
        { id: c.id, isBuy: true, quantity: defaultQuantity },
        { id: p.id, isBuy: true, quantity: defaultQuantity },
      ]);
    if (name === "Bull spread") {
      const bounded = active.find((m) => m.kind === "bull-spread");
      if (bounded)
        setLegs([{ id: bounded.id, isBuy: true, quantity: defaultQuantity }]);
      else if (c) {
        const upper = active.find(
          (m) =>
            m.kind === "call" && m.expiry === c.expiry && m.strike > c.strike,
        );
        if (upper)
          setLegs([
            { id: c.id, isBuy: true, quantity: defaultQuantity },
            { id: upper.id, isBuy: false, quantity: defaultQuantity },
          ]);
      }
    }
  }
  const computed = legs.map((l) => {
    const m = snapshot.markets.find((m) => m.id === l.id)!;
    const q = Number(l.quantity),
      quote = quoteDepth(l.isBuy ? m.asks : m.bids, q);
    return { ...l, m, q, quote };
  });
  const debit = computed.reduce(
      (s, l) => s + (l.isBuy ? l.quote.total : -l.quote.total),
      0,
    ),
    funding = computed
      .filter((l) => l.isBuy)
      .reduce((s, l) => s + l.quote.total * 1.005, 0),
    delta = computed.reduce(
      (s, l) => s + (l.isBuy ? 1 : -1) * l.q * l.m.greeks.delta,
      0,
    );
  const sameAsset = computed.every((l) => l.m.asset === asset);
  const valid =
    sameAsset &&
    new Set(computed.map((l) => l.id)).size === computed.length &&
    computed.length > 0 &&
    computed.every(
      (l) =>
        l.m.active &&
        l.m.healthy &&
        l.q > 0 &&
        Number.isFinite(l.q) &&
        Math.abs(l.q * 1000 - Math.round(l.q * 1000)) < 1e-6 &&
        l.quote.complete &&
        (l.isBuy ||
          (portfolio?.positions.find((p) => p.marketId === l.id)?.quantity ??
            0) >= l.q),
    ) &&
    (portfolio?.usdc ?? 0) >= funding;
  const graph = Array.from({ length: 81 }, (_, i) => {
    const spot = reference * (0.4 + (i / 80) * 1.2);
    return {
      spot,
      pnl:
        computed.reduce(
          (s, l) =>
            s +
            (l.isBuy ? 1 : -1) *
              l.q *
              expiryPayoff(l.m.kind, spot, l.m.strike, l.m.upperStrike),
          0,
        ) - debit,
    };
  });
  const sameExpiry = new Set(computed.map((l) => l.m.expiry)).size === 1;
  async function submit() {
    setReview(false);
    await act({
      action: "trade",
      legs: computed.map((l) => ({
        marketId: l.id,
        isBuy: l.isBuy,
        quantity: l.quantity,
        premiumLimit: (l.isBuy
          ? Math.ceil(l.quote.total * 1.005 * 1e6) / 1e6
          : Math.floor(l.quote.total * 0.995 * 1e6) / 1e6
        ).toFixed(6),
      })),
    });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">STRATEGY BUILDER</span>
          <h1>Strategy builder</h1>
          <p>
            Combine up to four funded instruments with protected atomic
            execution.
          </p>
        </div>
        <Badge tone="green">Exact fills or full rollback</Badge>
      </div>
      <div className="strategy-presets">
        {["Long call", "Long put", "Straddle", "Bull spread"].map((t) => (
          <button
            key={t}
            className={template === t ? "active" : ""}
            onClick={() => preset(t)}
          >
            <Layers size={14} />
            {t}
          </button>
        ))}
      </div>
      <div className="two-column strategy-layout">
        <Panel
          title="Strategy legs"
          extra={
            <Button
              disabled={legs.length >= 4 || !active.length}
              onClick={() => {
                setTemplate("Custom");
                setLegs([
                  ...legs,
                  { id: active[0].id, isBuy: true, quantity: defaultQuantity },
                ]);
              }}
            >
              <Plus size={13} /> Add leg
            </Button>
          }
        >
          <div className="strategy-legs">
            {legs.map((l, i) => (
              <div className="strategy-leg" key={i}>
                <span className="leg-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="leg-fields">
                  <div className="segmented">
                    <button
                      className={l.isBuy ? "active buy" : ""}
                      onClick={() =>
                        setLegs(
                          legs.map((x, k) =>
                            k === i ? { ...x, isBuy: true } : x,
                          ),
                        )
                      }
                    >
                      Buy
                    </button>
                    <button
                      className={!l.isBuy ? "active sell" : ""}
                      onClick={() =>
                        setLegs(
                          legs.map((x, k) =>
                            k === i ? { ...x, isBuy: false } : x,
                          ),
                        )
                      }
                    >
                      Sell owned
                    </button>
                  </div>
                  <select
                    aria-label={`Leg ${i + 1} instrument`}
                    value={l.id}
                    onChange={(e) =>
                      setLegs(
                        legs.map((x, k) =>
                          k === i ? { ...x, id: Number(e.target.value) } : x,
                        ),
                      )
                    }
                  >
                    {snapshot.markets.map((m) => (
                      <option key={m.id} disabled={!m.active} value={m.id}>
                        {m.symbol}
                        {!m.active ? " (expired)" : ""}
                      </option>
                    ))}
                  </select>
                  <label className="field">
                    <div>
                      <input
                        aria-label={`Leg ${i + 1} quantity`}
                        value={l.quantity}
                        onChange={(e) =>
                          setLegs(
                            legs.map((x, k) =>
                              k === i ? { ...x, quantity: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <span>contracts</span>
                    </div>
                  </label>
                  <div className="leg-price">
                    <span>
                      {computed[i].quote.complete
                        ? "Executable premium"
                        : "Insufficient depth"}
                    </span>
                    <strong className={l.isBuy ? "negative" : "positive"}>
                      {l.isBuy ? "−" : "+"}
                      {usd(computed[i].quote.total, 4)}
                    </strong>
                  </div>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Remove leg ${i + 1}`}
                  disabled={legs.length === 1}
                  onClick={() => setLegs(legs.filter((_, k) => k !== i))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="strategy-funding">
            <Metric
              label="Estimated net premium"
              value={`${debit >= 0 ? "Pay" : "Receive"} ${usd(Math.abs(debit), 4)}`}
            />
            <Metric label="Peak dUSDC funding" value={usd(funding, 4)} />
            <Metric
              label="Net model delta"
              value={`${num(delta, 3)} ${asset}`}
            />
          </div>
          <div className="padded">
            <>
              {!sameAsset && (
                <p className="caption amber">
                  All legs must share one underlying ({asset}). Trade other
                  underlyings as a separate strategy.
                </p>
              )}
              {new Set(computed.map((l) => l.id)).size !== computed.length && (
                <p className="caption amber">
                  Combine repeated instruments into one leg for an accurate
                  depth quote.
                </p>
              )}
            </>
            <Button
              className="primary full"
              disabled={!valid}
              busy={busy}
              onClick={() => setReview(true)}
            >
              Review atomic strategy
            </Button>
            {computed.some(
              (l) =>
                !l.isBuy &&
                (portfolio?.positions.find((p) => p.marketId === l.id)
                  ?.quantity ?? 0) < l.q,
            ) && (
              <p className="caption amber">
                A sell leg requires owned claims.{" "}
                <Link to="/write" className="text-link">
                  Issue fully backed inventory first →
                </Link>
              </p>
            )}
          </div>
        </Panel>
        <Panel
          title="Expiry profit / loss"
          extra={
            <Badge>{sameExpiry ? "Common expiry" : "Mixed expiries"}</Badge>
          }
        >
          <div className="payoff-chart">
            <ResponsiveContainer>
              <LineChart data={graph}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis
                  dataKey="spot"
                  tickFormatter={(x) => usd(x)}
                  minTickGap={35}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(x) => usd(x)}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(x) => `${asset} ${usd(Number(x))}`}
                />
                <ReferenceLine
                  y={0}
                  stroke={chartTheme.crosshair}
                  strokeDasharray="3 3"
                />
                <Line
                  dataKey="pnl"
                  stroke={chartTheme.accent}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="padded">
            <div className="notice">
              <Info size={15} />
              <p>
                {sameExpiry
                  ? "Payoff at expiry less estimated net premium. Calls pay WMON; this chart converts their receipt at the scenario reference price."
                  : "Mixed-expiry payoff is an illustrative scenario at a shared price, not a realizable single-expiry P&L."}
              </p>
            </div>
            <p className="caption">
              No portfolio margin. Short legs must already be fully backed. Gas
              is paid separately in MON.
            </p>
          </div>
        </Panel>
      </div>
      {review && (
        <Modal title="Review atomic strategy" onClose={() => setReview(false)}>
          <dl className="review-list">
            {computed.map((l, i) => (
              <div key={i}>
                <dt>
                  {l.isBuy ? "Buy" : "Sell"} {l.m.symbol}
                </dt>
                <dd>{num(l.q)} contracts</dd>
              </div>
            ))}
            <div>
              <dt>Maximum gross purchase funding</dt>
              <dd>{usd(funding, 6)} dUSDC</dd>
            </div>
            <div>
              <dt>Estimated net premium</dt>
              <dd>{usd(debit, 6)} dUSDC</dd>
            </div>
            <div>
              <dt>Per-leg price protection</dt>
              <dd>0.5%</dd>
            </div>
          </dl>
          <div className="notice">
            <Info size={15} />
            <p>
              All legs must fill the specified quantity. A failed fill reverts
              the strategy transaction. Separate token approvals may be required
              first.
            </p>
          </div>
          <Button
            className="primary full"
            busy={busy}
            onClick={() => void submit()}
          >
            Execute {legs.length}-leg strategy
          </Button>
        </Modal>
      )}
    </>
  );
}
