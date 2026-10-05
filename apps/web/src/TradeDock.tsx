import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.ts";
import { Panel, Empty, Badge, num, usd, time, remaining } from "./ui.tsx";

type DockTab = "Positions" | "Orders" | "Fills";

function Positions() {
  const { snapshot, portfolio, select } = useApp();
  const rows = (portfolio?.positions ?? []).filter(
    (p) =>
      p.quantity > 0 || p.writerQuantity > 0 || p.reserved + p.venueFree > 0,
  );
  if (!rows.length)
    return (
      <Empty title="No open positions">
        Purchased claims and funded writer obligations appear here.
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Long (wallet)</th>
            <th>Long (venue)</th>
            <th>Written</th>
            <th>Mark</th>
            <th>Model value</th>
            <th>Net premium</th>
            <th>Net delta</th>
            <th>Expiry</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const m = snapshot.markets.find((x) => x.id === p.marketId);
            if (!m) return null;
            const long = p.quantity + p.reserved + p.venueFree;
            const netPremium = p.proceeds - p.paidPremium;
            const delta = (long - p.writerQuantity) * m.greeks.delta;
            return (
              <tr key={p.marketId}>
                <td>
                  <button className="table-link" onClick={() => select(m.id)}>
                    {m.symbol}
                  </button>
                </td>
                <td>{num(p.quantity, 3)}</td>
                <td>{num(p.reserved + p.venueFree, 3)}</td>
                <td>{num(p.writerQuantity, 3)}</td>
                <td>{m.mark.toFixed(5)}</td>
                <td>{usd(long * m.mark, 4)}</td>
                <td className={netPremium >= 0 ? "positive" : "negative"}>
                  {netPremium >= 0 ? "+" : "−"}
                  {usd(Math.abs(netPremium), 4)}
                </td>
                <td>{delta.toFixed(3)}</td>
                <td>
                  {m.active ? (
                    remaining(m.expiry, snapshot.timestamp)
                  ) : (
                    <Badge tone={m.settlementPrice ? "green" : "amber"}>
                      {m.settlementPrice ? "Settled" : "Awaiting reference"}
                    </Badge>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    {m.active && p.quantity > 0 && (
                      <button onClick={() => select(m.id, "sell")}>Sell</button>
                    )}
                    {!m.active && (
                      <Link className="table-link" to="/settlements">
                        Settle
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Orders() {
  const { snapshot, portfolio, act, busy } = useApp();
  const orders = portfolio?.orders ?? [];
  if (!orders.length)
    return (
      <Empty title="No resting orders">
        Post-only limit orders reserve funds in Kuru until filled or cancelled.
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Side</th>
            <th>Limit price</th>
            <th>Remaining</th>
            <th>Reserved</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={`${o.marketId}-${o.id}`}>
              <td>
                {snapshot.markets.find((m) => m.id === o.marketId)?.symbol}
              </td>
              <td className={o.isBuy ? "positive" : "negative"}>
                {o.isBuy ? "Buy" : "Sell"}
              </td>
              <td>{o.price.toFixed(5)}</td>
              <td>{num(o.remaining, 3)}</td>
              <td>
                {num(o.reserved, 5)} {o.isBuy ? "dUSDC" : "claims"}
              </td>
              <td>
                <div className="row-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "cancel",
                        marketId: o.marketId,
                        orderId: o.id,
                      })
                    }
                  >
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fills() {
  const { snapshot, portfolio } = useApp();
  const account = (
    portfolio?.address ?? snapshot.manifest.demoUser
  ).toLowerCase();
  const fills = snapshot.trades
    .filter(
      (t) =>
        t.taker.toLowerCase() === account || t.maker.toLowerCase() === account,
    )
    .slice(-50)
    .reverse();
  if (!fills.length)
    return <Empty title="No account fills">Executed trades appear here.</Empty>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Contract</th>
            <th>Side</th>
            <th>Price</th>
            <th>Quantity</th>
            <th>Premium</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((t, i) => {
            // A resting maker order fills on the opposite side of the taker.
            const isBuy =
              t.taker.toLowerCase() === account ? t.isBuy : !t.isBuy;
            return (
              <tr key={t.hash + i}>
                <td className="muted">{time(t.timestamp)}</td>
                <td>
                  {snapshot.markets.find((m) => m.id === t.marketId)?.symbol}
                </td>
                <td className={isBuy ? "positive" : "negative"}>
                  {isBuy ? "Buy" : "Sell"}
                </td>
                <td>{t.price.toFixed(5)}</td>
                <td>{num(t.quantity, 3)}</td>
                <td>{usd(t.quote, 4)}</td>
                <td>
                  <Badge tone="green">Included</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TradeDock() {
  const { portfolio } = useApp();
  const [tab, setTab] = useState<DockTab>("Positions");
  const positionCount = (portfolio?.positions ?? []).filter(
    (p) =>
      p.quantity > 0 || p.writerQuantity > 0 || p.reserved + p.venueFree > 0,
  ).length;
  const counts: Record<DockTab, number | null> = {
    Positions: positionCount,
    Orders: portfolio?.orders.length ?? 0,
    Fills: null,
  };
  return (
    <Panel
      className="trade-dock"
      title={
        <div className="tabs plain">
          {(Object.keys(counts) as DockTab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t === "Orders" ? "Open orders" : t}
              {counts[t] !== null && <span>{counts[t]}</span>}
            </button>
          ))}
        </div>
      }
      extra={
        <Link className="text-link" to="/portfolio">
          Portfolio
        </Link>
      }
    >
      {tab === "Positions" ? (
        <Positions />
      ) : tab === "Orders" ? (
        <Orders />
      ) : (
        <Fills />
      )}
    </Panel>
  );
}
