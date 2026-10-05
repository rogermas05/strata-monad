import { Fragment, useState, useEffect } from "react";
import { useApp } from "./context.ts";
import { Panel, num, expiry, remaining, underlyingOf } from "./ui.tsx";
import type { Market } from "../../../packages/core/src/index.ts";

// Premiums carry a fixed precision per column so digits never reflow.
// Low-priced underlyings (MON) need finer premiums than index-level ones.
const LOW_PRICE = 10;
const priceDigits = (market: Market) =>
  market.strike < 0.5 ? 6 : market.strike < LOW_PRICE ? 5 : 3;
const strikeDigits = (strike: number) =>
  strike < 0.5 ? 4 : strike < LOW_PRICE ? 2 : 0;
const DELTA_DIGITS = 3;
const SIDE_COLUMNS = 7;

const fixed = (n: number | null, digits: number) =>
  n === null ? "—" : n.toFixed(digits);

function QuoteCell({
  market,
  side,
  isItm,
}: {
  market: Market;
  side: "bid" | "ask";
  isItm: boolean;
}) {
  const { selected, select } = useApp();
  const price = market[side];
  return (
    <td
      className={`quote-cell ${side} ${market.id === selected.id ? "selected-cell" : ""} ${isItm ? "itm" : ""}`}
    >
      <button
        disabled={!market.active || price === null}
        title={`${side === "ask" ? "Buy" : "Sell"} ${market.symbol}`}
        onClick={() => select(market.id, side === "bid" ? "sell" : "buy")}
      >
        {fixed(price, priceDigits(market))}
      </button>
    </td>
  );
}

function SideCells({
  market,
  isItm,
  mirrored,
}: {
  market: Market;
  isItm: boolean;
  mirrored: boolean;
}) {
  const cls = isItm ? "itm" : "";
  const cells = [
    <td key="oi" className={`opt ${cls}`}>
      {num(market.openInterest, 3)}
    </td>,
    <td key="delta" className={cls}>
      {market.greeks.delta.toFixed(DELTA_DIGITS)}
    </td>,
    <td key="mark" className={`opt ${cls}`}>
      {market.mark.toFixed(priceDigits(market))}
    </td>,
    <td key="bid-size" className={`size ${cls}`}>
      {market.bids[0] ? num(market.bids[0].quantity, 3) : "—"}
    </td>,
    <QuoteCell key="bid" market={market} side="bid" isItm={isItm} />,
    <QuoteCell key="ask" market={market} side="ask" isItm={isItm} />,
    <td key="ask-size" className={`size ${cls}`}>
      {market.asks[0] ? num(market.asks[0].quantity, 3) : "—"}
    </td>,
  ];
  // Puts mirror only the outer statistics; bid stays left of ask on both sides.
  return (
    <>
      {mirrored ? [...cells.slice(3), ...cells.slice(0, 3).reverse()] : cells}
    </>
  );
}

const callHeaders = [
  "Open int.",
  "Delta",
  "Mark",
  "Size",
  "Bid",
  "Ask",
  "Size",
];
const putHeaders = ["Size", "Bid", "Ask", "Size", "Mark", "Delta", "Open int."];
const optionalHeaders = new Set(["Open int.", "Mark"]);

export function OptionChain() {
  const { snapshot, selected, select } = useApp();
  const [date, setDate] = useState(selected.expiry);
  useEffect(() => setDate(selected.expiry), [selected.id, selected.expiry]);
  const asset = selected.asset;
  const listed = snapshot.markets.filter((m) => m.asset === asset);
  // Assets without a deliverable token list capped calls (bull spreads) instead.
  const callKind = listed.some((m) => m.kind === "call")
    ? "call"
    : "bull-spread";
  const deliverable = callKind === "call";
  const chain = listed.filter(
    (m) => !deliverable || m.kind === callKind || m.kind === "put",
  );
  const dates = [
    ...new Set(
      chain
        .filter((m) => m.active || m.expiry === selected.expiry)
        .map((m) => m.expiry),
    ),
  ].sort((a, b) => a - b);
  const activeDate = dates.includes(date) ? date : dates[0];
  const series = chain.filter((m) => m.expiry === activeDate);
  const capped = series.find((m) => m.kind === "bull-spread");
  const strikes = [...new Set(series.map((m) => m.strike))].sort(
    (a, b) => a - b,
  );
  const spot = underlyingOf(snapshot, asset).spot;
  // Index of the first strike above spot; the divider is drawn before it.
  const spotIndex = strikes.findIndex((strike) => strike > spot);
  const dividerAt = spotIndex === -1 ? strikes.length : spotIndex;
  const spotRow = (
    <tr className="spot-row" aria-hidden="true">
      <td colSpan={SIDE_COLUMNS * 2 + 1}>
        <span>Index {spot.toFixed(spot < LOW_PRICE ? 4 : 2)}</span>
      </td>
    </tr>
  );
  return (
    <Panel
      title={deliverable ? "Options chain" : "Cash-settled contracts"}
      extra={
        <div className="chain-meta">
          <span>
            Model IV{" "}
            <b>
              {num(
                (series[0]?.iv ?? snapshot.maker.config.volatility) * 100,
                1,
              )}
              %
            </b>
          </span>
          <span className="chain-note">
            Premiums in dUSDC · 1 contract = 1 {asset} · Fully backed
          </span>
        </div>
      }
      className="chain-panel"
    >
      <div className="chain-tools">
        <div className="tabs">
          {dates.map((d) => (
            <button
              key={d}
              className={d === activeDate ? "active" : ""}
              onClick={() => setDate(d)}
            >
              {expiry(d)} <span>{remaining(d, snapshot.timestamp)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="table-scroll">
        {!deliverable ? (
          <table className="cash-contract-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Strike / cap</th>
                <th className="cash-chain-stat">Mark</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Bid size</th>
                <th>Ask size</th>
                <th className="cash-chain-stat">OI</th>
              </tr>
            </thead>
            <tbody>
              {[...series]
                .sort(
                  (a, b) => a.strike - b.strike || a.kind.localeCompare(b.kind),
                )
                .map((market) => (
                  <tr
                    key={market.id}
                    className={
                      market.id === selected.id ? "selected-contract" : ""
                    }
                  >
                    <td>
                      {market.kind === "put"
                        ? "Put"
                        : market.kind === "bull-spread"
                          ? "Bull spread"
                          : "Bear spread"}
                    </td>
                    <td>
                      {num(market.strike, 8)}
                      {market.upperStrike
                        ? ` / ${num(market.upperStrike, 8)}`
                        : ""}
                    </td>
                    <td className="cash-chain-stat">
                      {market.mark.toFixed(priceDigits(market))}
                    </td>
                    <td>
                      <button
                        className="positive"
                        disabled={market.bid === null || !market.active}
                        onClick={() => select(market.id, "sell")}
                      >
                        {fixed(market.bid, priceDigits(market))}
                      </button>
                    </td>
                    <td>
                      <button
                        className="negative"
                        disabled={market.ask === null || !market.active}
                        onClick={() => select(market.id, "buy")}
                      >
                        {fixed(market.ask, priceDigits(market))}
                      </button>
                    </td>
                    <td>
                      {num(
                        market.bids.reduce(
                          (sum, level) => sum + level.quantity,
                          0,
                        ),
                        3,
                      )}
                    </td>
                    <td>
                      {num(
                        market.asks.reduce(
                          (sum, level) => sum + level.quantity,
                          0,
                        ),
                        3,
                      )}
                    </td>
                    <td className="cash-chain-stat">
                      {num(market.openInterest, 3)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <table className="chain-table">
            <thead>
              <tr>
                <th colSpan={SIDE_COLUMNS} className="call-head">
                  {capped
                    ? `CAPPED CALLS · PAYOUT UP TO ${num(capped.upperStrike - capped.strike, 0)}`
                    : "CALLS"}
                </th>
                <th className="strike-head">STRIKE</th>
                <th colSpan={SIDE_COLUMNS} className="put-head">
                  PUTS
                </th>
              </tr>
              <tr>
                {callHeaders.map((h, i) => (
                  <th
                    key={`c${i}`}
                    className={optionalHeaders.has(h) ? "opt" : ""}
                  >
                    {h}
                  </th>
                ))}
                <th className="strike-col">{asset} / USD</th>
                {putHeaders.map((h, i) => (
                  <th
                    key={`p${i}`}
                    className={optionalHeaders.has(h) ? "opt" : ""}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strikes.map((strike, index) => {
                const call = series.find(
                    (m) => m.strike === strike && m.kind === callKind,
                  ),
                  put = series.find(
                    (m) => m.strike === strike && m.kind === "put",
                  );
                if (!call || !put) return null;
                const isSelected =
                  call.id === selected.id || put.id === selected.id;
                return (
                  <Fragment key={strike}>
                    {index === dividerAt && spotRow}
                    <tr className={isSelected ? "selected-row" : ""}>
                      <SideCells
                        market={call}
                        isItm={strike < spot}
                        mirrored={false}
                      />
                      <td className="strike">
                        {strike.toFixed(strikeDigits(strike))}
                      </td>
                      <SideCells market={put} isItm={strike > spot} mirrored />
                    </tr>
                  </Fragment>
                );
              })}
              {dividerAt === strikes.length && spotRow}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel-foot">
        <span>
          <i className="dot mint" /> Project-funded maker quotes on Kuru
        </span>
        <span>
          Shaded cells are in the money · IV is a configured model input
        </span>
      </div>
    </Panel>
  );
}
