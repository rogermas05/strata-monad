import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowDown, Search, Star, X } from "lucide-react";
import { useApp } from "./context.ts";
import { Modal, expiry, num, underlyingKeys } from "./ui.tsx";
import type { Market } from "../../../packages/core/src/index.ts";

const labels = {
  call: "Call",
  put: "Put",
  "bull-spread": "Bull spread",
  "bear-spread": "Bear spread",
};
const expiryDay = (timestamp: number) =>
  new Date(timestamp * 1000).toISOString().slice(0, 10);
const expiryLabel = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const price = (value: number | null, market: Market) =>
  value === null ? "—" : num(value, market.strike < 10 || value < 0.01 ? 6 : 3);
const depth = (market: Market) =>
  Math.min(
    market.bids.reduce((sum, level) => sum + level.quantity, 0),
    market.asks.reduce((sum, level) => sum + level.quantity, 0),
  );

export function MarketSelector({ onClose }: { onClose: () => void }) {
  const { snapshot, selected, select } = useApp();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [kind, setKind] = useState("all");
  const [term, setTerm] = useState("all");
  const [sort, setSort] = useState("contract");
  const [includeExpired, setIncludeExpired] = useState(!selected.active);
  const [cursor, setCursor] = useState(0);
  const storageKey = `strata-market-favorites:${snapshot.manifest.chainId}:${snapshot.manifest.engine.toLowerCase()}`;
  const [favorites, setFavorites] = useState<number[]>([]);
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "[]",
      );
      setFavorites(
        Array.isArray(value)
          ? value
              .filter((id): id is number => Number.isSafeInteger(id) && id > 0)
              .slice(0, 500)
          : [],
      );
    } catch {
      setFavorites([]);
    }
  }, [storageKey]);
  function favorite(id: number) {
    const next = favorites.includes(id)
      ? favorites.filter((value) => value !== id)
      : [...favorites, id];
    setFavorites(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Favorites still work without browser storage. */
    }
  }
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return snapshot.markets
      .filter((market) => {
        const name =
          snapshot.manifest.assets?.find((asset) => asset.key === market.asset)
            ?.name ?? market.asset;
        const text =
          `${market.symbol} ${market.asset} ${name} ${labels[market.kind]} ${market.strike} ${market.upperStrike || ""} ${expiry(market.expiry)} ${new Date(market.expiry * 1000).toISOString().slice(0, 10)}`.toLowerCase();
        return (
          (includeExpired || market.active) &&
          (category === "All" ||
            (category === "Favorites"
              ? favorites.includes(market.id)
              : market.asset === category)) &&
          (kind === "all" ||
            market.kind === kind ||
            (kind === "spreads" && market.kind.endsWith("spread"))) &&
          (term === "all" || expiryDay(market.expiry) === term) &&
          words.every((word) => text.includes(word))
        );
      })
      .sort((a, b) => {
        if (sort === "depth") return depth(b) - depth(a) || a.id - b.id;
        if (sort === "interest")
          return b.openInterest - a.openInterest || a.id - b.id;
        if (sort === "volume") return b.volume - a.volume || a.id - b.id;
        const keys = underlyingKeys(snapshot);
        return (
          keys.indexOf(a.asset) - keys.indexOf(b.asset) ||
          a.expiry - b.expiry ||
          a.strike - b.strike ||
          a.kind.localeCompare(b.kind)
        );
      });
  }, [snapshot, query, category, kind, term, sort, includeExpired, favorites]);
  useEffect(
    () => setCursor(0),
    [query, category, kind, term, sort, includeExpired],
  );
  const activeCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  useEffect(() => {
    document
      .getElementById(`market-selector-${rows[activeCursor]?.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeCursor, query, category]);
  const terms = [
    ...new Set(
      snapshot.markets
        .filter((market) => includeExpired || market.active)
        .map((market) => expiryDay(market.expiry)),
    ),
  ].sort();
  const anchor = document
    .querySelector(".asset-title")
    ?.getBoundingClientRect();
  const selectorTop = Math.min(
    (anchor?.bottom ?? 40) + 4,
    window.innerHeight * 0.3,
  );
  return (
    <Modal
      title="Select market"
      className="market-selector"
      onClose={onClose}
      backdropStyle={
        {
          paddingTop: selectorTop,
          "--selector-top": `${selectorTop}px`,
        } as CSSProperties
      }
    >
      <label className="market-selector-search">
        <Search size={16} />
        <input
          autoFocus
          aria-label="Find market"
          placeholder="Search markets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) =>
                Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    value + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (event.key === "Enter" && rows[activeCursor]) {
              event.preventDefault();
              select(rows[activeCursor].id);
            }
          }}
        />
        <kbd>⌘K</kbd>
        <button
          className="icon-button"
          type="button"
          aria-label="Close market selector"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </label>
      <div
        className="market-selector-categories"
        role="tablist"
        aria-label="Market categories"
      >
        {["All", "Favorites", ...underlyingKeys(snapshot)].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={category === value}
            onClick={() => setCategory(value)}
          >
            {value === "Favorites" && <Star size={12} />}
            {value}
          </button>
        ))}
      </div>
      <div className="market-selector-filters">
        <select
          aria-label="Contract type"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="all">All contracts</option>
          <option value="call">Calls</option>
          <option value="put">Puts</option>
          <option value="spreads">Capped spreads</option>
        </select>
        <select
          aria-label="Contract expiry"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        >
          <option value="all">All expiries · UTC</option>
          {terms.map((value) => (
            <option key={value} value={value}>
              {expiryLabel(Date.parse(`${value}T12:00:00Z`) / 1000)}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort markets"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="contract">Contract order</option>
          <option value="depth">Funded depth</option>
          <option value="interest">Open interest</option>
          <option value="volume">Traded volume</option>
        </select>
      </div>
      <div className="market-selector-head">
        <span>Contract</span>
        <span>Mark</span>
        <span>Bid / Ask</span>
        <span>Depth {sort === "depth" && <ArrowDown size={10} />}</span>
        <span>{sort === "volume" ? "Volume" : "OI"}</span>
      </div>
      <div className="market-selector-results" aria-label="Matching markets">
        {rows.map((market, index) => (
          <div
            key={market.id}
            id={`market-selector-${market.id}`}
            className={`market-selector-row ${index === activeCursor ? "highlighted" : ""} ${market.id === selected.id ? "current" : ""}`}
          >
            <button
              className={`market-favorite ${favorites.includes(market.id) ? "starred" : ""}`}
              aria-label={`${favorites.includes(market.id) ? "Remove" : "Add"} ${market.symbol} ${favorites.includes(market.id) ? "from" : "to"} favorites`}
              aria-pressed={favorites.includes(market.id)}
              onClick={() => favorite(market.id)}
            >
              <Star
                size={14}
                fill={favorites.includes(market.id) ? "currentColor" : "none"}
              />
            </button>
            <button
              className="market-select-row"
              aria-label={`Select ${market.symbol}`}
              aria-current={market.id === selected.id ? "true" : undefined}
              onClick={() => select(market.id)}
            >
              <span className="market-selector-contract">
                <strong>
                  {market.asset}{" "}
                  <span
                    className={`market-kind ${market.kind === "call" || market.kind === "bull-spread" ? "positive" : "negative"}`}
                  >
                    {labels[market.kind]}
                  </span>
                  {market.id === selected.id && (
                    <span className="market-selected">Selected</span>
                  )}
                </strong>
                <small>
                  {expiryLabel(market.expiry)} · {num(market.strike, 8)}
                  {market.upperStrike ? ` / ${num(market.upperStrike, 8)}` : ""}
                  {!market.active
                    ? " · Expired"
                    : !market.healthy
                      ? " · Paused"
                      : ""}
                </small>
              </span>
              <span>{price(market.mark, market)}</span>
              <span className="market-selector-quotes">
                <span className="positive">{price(market.bid, market)}</span>
                <span className="negative">{price(market.ask, market)}</span>
              </span>
              <span>{num(depth(market), 3)}</span>
              <span
                title={
                  sort === "volume"
                    ? "Observed premium volume in dUSDC, including project trades"
                    : "Outstanding funded contracts"
                }
              >
                {num(
                  sort === "volume" ? market.volume : market.openInterest,
                  sort === "volume" ? 6 : 3,
                )}
              </span>
            </button>
          </div>
        ))}
        {!rows.length && (
          <div className="market-selector-empty">
            <strong>
              {category === "Favorites"
                ? "No matching favorites"
                : "No matching contracts"}
            </strong>
            <p>
              {category === "Favorites"
                ? "Star contracts in All to keep them here."
                : "Try another asset, expiry or search."}
            </p>
            <button
              onClick={() => {
                setQuery("");
                setCategory("All");
                setKind("all");
                setTerm("all");
              }}
            >
              Reset filters
            </button>
          </div>
        )}
      </div>
      <footer className="market-selector-footer">
        <label>
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(event) => setIncludeExpired(event.target.checked)}
          />
          Include expired
        </label>
        <span>
          {underlyingKeys(snapshot).length} assets · {rows.length} contracts ·
          Depth per side
        </span>
        <span className="market-selector-keyboard">
          ↑↓ navigate · Enter select
        </span>
      </footer>
    </Modal>
  );
}
