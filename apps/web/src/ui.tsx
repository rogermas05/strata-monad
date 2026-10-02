import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { X, Copy, Check, LoaderCircle } from "lucide-react";
import type {
  Snapshot,
  UnderlyingState,
  ManifestAsset,
} from "../../../packages/core/src/index.ts";
export const usd = (n: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
export const num = (n: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export const expiry = (n: number) =>
  new Date(n * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
export const time = (n: number) =>
  new Date(n * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
export const remaining = (expiry: number, now: number) => {
  const s = Math.max(0, expiry - now);
  return s > 86400
    ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    : s > 3600
      ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      : s > 60
        ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
        : `${Math.floor(s)}s`;
};
export function Panel({
  title,
  extra,
  children,
  className = "",
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-title">
          <h2>{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}
export function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="metric">
      <span className="muted">{label}</span>
      <strong className={tone}>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">—</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Modal({
  title,
  children,
  onClose,
  className = "",
  backdropStyle,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  backdropStyle?: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const selector =
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';
    const controls = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(selector) ?? [],
      ).filter((x) => x.offsetParent !== null);
    if (!ref.current?.contains(document.activeElement)) controls()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key === "Tab") {
        const list = controls(),
          first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      style={backdropStyle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <section
        ref={ref}
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Button({
  children,
  onClick,
  disabled = false,
  busy = false,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      className={`button ${className}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function AddressText({
  value,
  full = false,
}: {
  value: string;
  full?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1800);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  return (
    <button
      className={`address-link ${full ? "full-address" : ""}`}
      type="button"
      title={`Copy ${value}`}
      aria-label={`Copy ${value}`}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => setCopied(true))
      }
    >
      <span>{full ? value : short(value)}</span>{" "}
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** State of an underlying; legacy snapshots expose only the single MON price. */
export function underlyingOf(snapshot: Snapshot, key: string): UnderlyingState {
  return (
    snapshot.underlyings?.[key] ?? {
      key,
      spot: snapshot.spot,
      publishedAt: snapshot.pricePublishedAt,
      live: snapshot.service.newExposureAllowed,
      open: true,
      nextChange: null,
      prices: snapshot.prices,
    }
  );
}

const sessionTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "24/7", "Open · closes Fri 16:00 ET" or "Closed · opens Mon 09:30 ET". */
export function sessionLabel(state: UnderlyingState, now: number) {
  if (state.nextChange === null) return state.open ? "24/7" : "Closed";
  const when = sessionTime.format(new Date(state.nextChange * 1000));
  const soon =
    state.nextChange - now < 86400 ? when.replace(/^\w+ /, "") : when;
  return state.open ? `Open · closes ${soon} ET` : `Closed · opens ${soon} ET`;
}

/** Plain-language settlement rule of a listed underlying. */
export function settlementRule(binding: ManifestAsset | undefined): string {
  if (binding?.policy !== "pyth-latest-before-close")
    return "First price after expiry";
  return binding.assetClass === "crypto"
    ? "Last price before expiry"
    : "Last price at the session close";
}

/** Underlyings in listing order (MON first), with their option markets. */
export function underlyingKeys(snapshot: Snapshot): string[] {
  const keys = snapshot.manifest.assets?.map((a) => a.key) ?? [];
  const fromSeries = snapshot.markets.map((m) => m.asset ?? "MON");
  return [...new Set([...keys, ...fromSeries])].filter((k) =>
    snapshot.markets.some((m) => (m.asset ?? "MON") === k),
  );
}
