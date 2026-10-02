import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
} from "lightweight-charts";
import { Maximize2, RotateCcw } from "lucide-react";
import { chartTheme } from "./chart-theme.ts";
type Observation = { timestamp: number; price: number };
const VISIBLE_BARS = 120;
export function TradingChart({
  symbol,
  digits,
  observations,
  now,
  source,
}: {
  symbol: string;
  /** Price decimals; fixed for the lifetime of the chart. */
  digits: number;
  observations: Observation[];
  now: number;
  source: string;
}) {
  const container = useRef<HTMLDivElement>(null),
    wrapper = useRef<HTMLDivElement>(null),
    chart = useRef<IChartApi | null>(null),
    series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [interval, setInterval] = useState(60),
    [hover, setHover] = useState<CandlestickData | null>(null),
    previous = useRef<CandlestickData[]>([]),
    initial = useRef(true);
  const candles = useMemo(() => {
    const buckets = new Map<number, CandlestickData>();
    // Prices are sampled every few seconds, so a candle opens where the last
    // one closed; opening at its own first sample leaves gaps between candles.
    let previousClose: number | undefined;
    for (const p of [...observations].sort(
      (a, b) => a.timestamp - b.timestamp,
    )) {
      if (p.timestamp < now - 7200 || !Number.isFinite(p.price) || p.price <= 0)
        continue;
      const time = Math.floor(p.timestamp / interval) * interval,
        old = buckets.get(time);
      if (old) {
        old.high = Math.max(old.high, p.price);
        old.low = Math.min(old.low, p.price);
        old.close = p.price;
      } else {
        const open = previousClose ?? p.price;
        buckets.set(time, {
          time: time as UTCTimestamp,
          open,
          high: Math.max(open, p.price),
          low: Math.min(open, p.price),
          close: p.price,
        });
      }
      previousClose = p.price;
    }
    return [...buckets.values()];
  }, [observations, interval, now]);
  useEffect(() => {
    if (!container.current) return;
    const api = createChart(container.current, {
      width: container.current.clientWidth,
      height: container.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: chartTheme.surface },
        textColor: chartTheme.text,
        fontFamily: chartTheme.font,
        fontSize: 11,
        // TradingView's own attribution link; theme.css presents it as the
        // classic round badge in the bottom-left corner.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: chartTheme.grid },
        horzLines: { color: chartTheme.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: chartTheme.crosshair,
          labelBackgroundColor: chartTheme.crosshairLabel,
        },
        horzLine: {
          color: chartTheme.crosshair,
          labelBackgroundColor: chartTheme.crosshairLabel,
        },
      },
      rightPriceScale: {
        borderColor: chartTheme.axis,
        scaleMargins: { top: 0.15, bottom: 0.12 },
      },
      timeScale: {
        borderColor: chartTheme.axis,
        timeVisible: true,
        secondsVisible: interval < 60,
        rightOffset: 8,
        barSpacing: 6,
        minBarSpacing: 2,
        fixLeftEdge: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    const prices = api.addSeries(CandlestickSeries, {
      upColor: chartTheme.buy,
      downColor: chartTheme.sell,
      wickUpColor: chartTheme.buy,
      wickDownColor: chartTheme.sell,
      borderVisible: false,
      priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits },
      priceLineVisible: true,
      lastValueVisible: true,
    });
    api.subscribeCrosshairMove((event) => {
      const value = event.seriesData.get(prices);
      setHover(value && "open" in value ? (value as CandlestickData) : null);
    });
    chart.current = api;
    series.current = prices;
    // Defer canvas sizing to avoid feedback into the current observer cycle.
    let resizeFrame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        api.resize(
          Math.floor(entry.contentRect.width),
          Math.floor(entry.contentRect.height),
        );
      });
    });
    observer.observe(container.current);
    initial.current = true;
    previous.current = [];
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      api.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);
  useEffect(() => {
    const api = chart.current,
      s = series.current;
    if (!api || !s) return;
    const prior = previous.current;
    if (
      !prior.length ||
      prior[0]?.time !== candles[0]?.time ||
      prior.length > candles.length
    ) {
      s.setData(candles);
    } else {
      const start = Math.max(0, prior.length - 1);
      for (let i = start; i < candles.length; i++) s.update(candles[i]);
    }
    api.applyOptions({ timeScale: { secondsVisible: interval < 60 } });
    if (initial.current && candles.length) {
      api.timeScale().setVisibleLogicalRange({
        // A wide default window keeps candle bodies proportionate on sparse data.
        from: candles.length - VISIBLE_BARS,
        to: candles.length + 5,
      });
      initial.current = false;
    }
    previous.current = candles;
  }, [candles, interval]);
  const value = hover ?? candles.at(-1);
  return (
    <div className="tradingview-chart" ref={wrapper}>
      <div className="tv-toolbar">
        <div className="tv-intervals">
          {[15, 60, 300, 900].map((i) => (
            <button
              key={i}
              className={interval === i ? "active" : ""}
              onClick={() => {
                setInterval(i);
                initial.current = true;
                previous.current = [];
              }}
            >
              {i < 60 ? `${i}s` : `${i / 60}m`}
            </button>
          ))}
        </div>
        <span className="tv-source">{source} · UTC</span>
        <button
          aria-label="Reset chart view"
          title="Reset chart view"
          onClick={() => chart.current?.timeScale().fitContent()}
        >
          <RotateCcw size={13} />
        </button>
        <button
          aria-label="Expand chart"
          title="Expand chart"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void wrapper.current?.requestFullscreen();
          }}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="tv-ohlc">
        <strong>{symbol}</strong>
        {value && (
          <>
            <span>
              O <b>{value.open.toFixed(digits)}</b>
            </span>
            <span>
              H <b>{value.high.toFixed(digits)}</b>
            </span>
            <span>
              L <b>{value.low.toFixed(digits)}</b>
            </span>
            <span>
              C{" "}
              <b
                className={value.close >= value.open ? "positive" : "negative"}
              >
                {value.close.toFixed(digits)}
              </b>
            </span>
          </>
        )}
      </div>
      <div
        ref={container}
        className="tv-canvas"
        aria-label={`TradingView ${symbol} price chart`}
      />
      {!candles.length && (
        <div className="tv-empty">Waiting for oracle observations</div>
      )}
    </div>
  );
}
