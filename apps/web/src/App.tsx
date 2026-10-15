import { lazy, Suspense, useEffect, useState, useRef } from "react";
import {
  NavLink,
  Routes,
  Route,
  useNavigate,
  useSearchParams,
  Navigate,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Layers,
  ChartNoAxesCombined,
  ArrowDownUp,
  Wallet,
  SquareStack,
  ChartSpline,
  Activity,
  ShieldCheck,
  Search,
  ChevronDown,
  HelpCircle,
  X,
  CheckCircle2,
  AlertCircle,
  LoaderCircle,
  Menu,
  ExternalLink,
  Landmark,
  Sparkles,
  Zap,
} from "lucide-react";
import { api, ActionRequestError } from "./api.ts";
import { MarketSelector } from "./MarketSelector.tsx";
import { connectWallet, signAction, authorizeRecovery } from "./wallet.ts";
import type { RecoveryPacket } from "../../../packages/core/src/recovery.ts";
import {
  requiresLiveMarket,
  SNAPSHOT_MAX_AGE_MS,
} from "../../../packages/core/src/readiness.ts";
import type { Address } from "viem";
import { Context, type Action } from "./context.ts";
import { Button, Modal, Badge, usd, num, short } from "./ui.tsx";
const Trade = lazy(() =>
  import("./Trade.tsx").then((module) => ({ default: module.Trade })),
);
const Markets = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Markets })),
);
const Portfolio = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Portfolio })),
);
const Writer = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Writer })),
);
const Analytics = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Analytics })),
);
const Settlements = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({
    default: module.Settlements,
  })),
);
const Maker = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Maker })),
);
const Status = lazy(() =>
  import("./Workspaces.tsx").then((module) => ({ default: module.Status })),
);
const Strategies = lazy(() =>
  import("./Strategies.tsx").then((module) => ({ default: module.Strategies })),
);
const Recovery = lazy(() =>
  import("./Recovery.tsx").then((module) => ({ default: module.Recovery })),
);
const OracleProofs = lazy(() =>
  import("./OracleProofs.tsx").then((module) => ({
    default: module.OracleProofs,
  })),
);
const House = lazy(() =>
  import("./House.tsx").then((module) => ({ default: module.House })),
);
const Rewards = lazy(() =>
  import("./House.tsx").then((module) => ({ default: module.Rewards })),
);
const nav = [
  ["/markets", "Markets", ChartNoAxesCombined],
  ["/trade", "Trade", ArrowDownUp],
  ["/strategies", "Strategies", Layers],
  ["/portfolio", "Portfolio", Wallet],
  ["/write", "Write options", SquareStack],
  ["/analytics", "Analytics", ChartSpline],
  ["/settlements", "Settlements", ShieldCheck],
  ["/maker", "Maker console", Activity],
  ["/house", "House", Landmark],
  ["/rewards", "Rewards", Sparkles],
] as const;
/** House pages appear only on deployments that include the vault. */
const housePaths = new Set(["/house", "/rewards"]);
export function App() {
  const qc = useQueryClient(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams();
  const [walletOpen, setWalletOpen] = useState(false),
    [help, setHelp] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState<{
      message: string;
      error?: boolean;
      hash?: string;
    } | null>(null);
  const [walletAddress, setWalletAddress] = useState<Address | null>(null);
  const walletIntent = useRef(false);
  const initialMarket = useRef<{ domain: string; id: number } | null>(null);
  function rememberWallet(value: boolean) {
    walletIntent.current = value;
    try {
      localStorage.setItem("strata-wallet-connected", value ? "1" : "0");
    } catch {
      /* Storage is optional; the current connection still works. */
    }
  }
  useEffect(() => {
    let mounted = true;
    try {
      walletIntent.current =
        localStorage.getItem("strata-wallet-connected") === "1";
    } catch {
      return;
    }
    if (walletIntent.current && window.ethereum)
      void window.ethereum
        .request({ method: "eth_accounts" })
        .then((value) => {
          const accounts = value as string[];
          if (
            mounted &&
            walletIntent.current &&
            Array.isArray(accounts) &&
            /^0x[0-9a-fA-F]{40}$/.test(accounts[0] ?? "")
          )
            setWalletAddress(accounts[0] as Address);
        })
        .catch(() => {
          /* Passive restoration never requests new wallet permission. */
        });
    return () => {
      mounted = false;
    };
  }, []);
  const {
    data: confirmedSnapshot,
    dataUpdatedAt,
    error,
    refetch,
  } = useQuery({
    queryKey: ["snapshot"],
    queryFn: api.snapshot,
    refetchInterval: (query) =>
      query.state.data?.trading?.mode === "display" &&
      query.state.data.trading.awakeUntil <= Date.now()
        ? 10_000
        : 3_000,
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const transportFresh = !error && now - dataUpdatedAt <= SNAPSHOT_MAX_AGE_MS;
  const snapshot =
    confirmedSnapshot &&
    (transportFresh
      ? confirmedSnapshot
      : {
          ...confirmedSnapshot,
          service: {
            ...confirmedSnapshot.service,
            status: "offline" as const,
            newExposureAllowed: false,
            reason:
              "Connection interrupted. Displaying the last confirmed state.",
          },
          markets: confirmedSnapshot.markets.map((market) => ({
            ...market,
            healthy: false,
          })),
        });
  const account =
    walletAddress ??
    (snapshot?.manifest.mode === "testnet"
      ? undefined
      : snapshot?.manifest.demoUser);
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio", account],
    queryFn: () => api.portfolio(account!),
    enabled: !!account,
    refetchInterval: 3000,
  });
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    const changed = (accounts: Address[]) =>
      setWalletAddress((current) => (current ? (accounts[0] ?? null) : null));
    const network = () =>
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
    provider.on("accountsChanged", changed);
    provider.on("chainChanged", network);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", network);
    };
  }, [qc]);
  useEffect(() => {
    if (import.meta.env.VITE_LIVE_TRANSPORT === "poll") return;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`,
    );
    ws.onmessage = () => {
      void qc.invalidateQueries({ queryKey: ["snapshot"] });
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
    };
    return () => ws.close();
  }, [qc]);
  async function connect() {
    try {
      setWalletAddress(await connectWallet());
      rememberWallet(true);
      setToast({
        message: "Wallet connected. Transactions will request your signature.",
      });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : String(error),
        error: true,
      });
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((x) => !x);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setWalletOpen(false);
        setHelp(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(
      () => setToast(null),
      toast.error ? 18000 : 8000,
    );
    return () => clearTimeout(timeout);
  }, [toast]);
  function select(id: number, side?: "buy" | "sell") {
    navigate(`/trade?market=${id}${side ? `&side=${side}` : ""}`);
    setSearchOpen(false);
  }
  // Asleep: some open markets wait for on-chain price relays. Feeds that
  // others already push on-chain stay tradable regardless.
  const sleeping =
    !!snapshot?.trading &&
    snapshot.trading.mode === "display" &&
    (!snapshot.service.newExposureAllowed ||
      snapshot.markets.some(
        (m) => m.active && !m.healthy && snapshot.underlyings[m.asset]?.open,
      ));
  const waking =
    !!snapshot?.trading && snapshot.trading.awakeUntil > Date.now();
  async function wake() {
    try {
      await api.wake();
      await qc.invalidateQueries({ queryKey: ["snapshot"] });
      setToast({
        message: "Waking on-chain trading. Orders open in about 20 seconds.",
      });
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : String(e),
        error: true,
      });
    }
  }
  async function act(action: Action) {
    if (busy) return false;
    if (snapshot?.manifest.mode === "testnet" && !walletAddress) {
      setWalletOpen(true);
      setToast({
        message: "Connect your wallet to transact on Monad testnet.",
        error: true,
      });
      return false;
    }
    const touched = [
      action.marketId,
      ...(action.legs?.map((leg) => leg.marketId) ?? []),
    ];
    const stale = snapshot?.markets.some(
      (m) => touched.includes(m.id) && !m.healthy,
    );
    if (
      requiresLiveMarket(action.action) &&
      (!snapshot?.service.newExposureAllowed || (sleeping && stale))
    ) {
      if (sleeping && !snapshot!.trading!.gasLow) {
        if (!waking) await wake();
        else
          setToast({
            message:
              "On-chain trading is waking up. Try again in a few seconds.",
          });
        return false;
      }
      setToast({
        message: snapshot?.service.reason ?? "Waiting for current market data",
        error: true,
      });
      return false;
    }
    setBusy(true);
    setToast({
      message: walletAddress
        ? "Preparing wallet transaction…"
        : "Submitting local-chain transaction…",
    });
    try {
      const result = walletAddress
        ? await signAction(snapshot!, walletAddress, action, (message, hash) =>
            setToast({ message, hash }),
          )
        : await api.action(action);
      setToast({
        message:
          "readModelUpdated" in result && result.readModelUpdated === false
            ? "Transaction included. Account data is awaiting a confirmed refresh."
            : "Transaction included. Account state updated.",
        hash: result.hashes.at(-1),
      });
      return true;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const submitted =
        e instanceof ActionRequestError
          ? e.hashes
          : Array.isArray((e as { hashes?: unknown[] })?.hashes)
            ? (e as { hashes: unknown[] }).hashes.filter(
                (h): h is string =>
                  typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h),
              )
            : [];
      setToast({
        message:
          (submitted.length
            ? "Some steps were submitted. Review Portfolio balances before retrying. "
            : "") +
          (
            raw.match(/following reason:\s*([^\n]+)/)?.[1] ??
            raw.split("\n").filter(Boolean).slice(0, 2).join(" ")
          ).slice(0, 350),
        error: true,
        hash: submitted.at(-1),
      });
      return false;
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["snapshot"] }),
        qc.invalidateQueries({ queryKey: ["portfolio"] }),
      ]);
      setBusy(false);
    }
  }
  async function authorize(packet: RecoveryPacket): Promise<RecoveryPacket> {
    if (busy || !snapshot)
      throw new Error("Wait for the current operation to finish");
    setBusy(true);
    setToast({
      message: walletAddress
        ? "Review authorization in your wallet…"
        : "Signing with the local demo account…",
    });
    try {
      const signed = walletAddress
        ? await authorizeRecovery(snapshot, walletAddress, packet)
        : await api.signRecovery(packet);
      setToast({ message: "Authorization signed. No transaction was sent." });
      return signed;
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : String(e),
        error: true,
      });
      throw e;
    } finally {
      setBusy(false);
    }
  }
  if (!snapshot)
    return (
      <div className="boot-screen">
        <img src="/strata.svg" alt="Strata" />
        <h1>Strata</h1>
        {error ? (
          <>
            <p>Unable to reach the protocol service.</p>
            <Button onClick={() => void refetch()}>Retry connection</Button>
            <small>
              Start the chain, seed contracts, then run npm run dev.
            </small>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={18} />
            <p>Reading deployed markets…</p>
          </>
        )}
      </div>
    );
  const publicPrimary =
    snapshot.manifest.mode === "testnet"
      ? snapshot.markets
          .filter(
            (market) =>
              market.active && market.asset === "MON" && market.kind === "put",
          )
          .sort(
            (a, b) =>
              a.expiry - b.expiry ||
              Math.abs(a.strike - snapshot.spot) -
                Math.abs(b.strike - snapshot.spot),
          )[0]
      : undefined;
  const marketDomain = `${snapshot.manifest.chainId}:${snapshot.manifest.engine}`;
  if (!initialMarket.current || initialMarket.current.domain !== marketDomain)
    initialMarket.current = {
      domain: marketDomain,
      id:
        publicPrimary?.id ??
        snapshot.markets.find((market) => market.id === 15 && market.active)
          ?.id ??
        snapshot.markets.find((market) => market.active)?.id ??
        snapshot.markets[0].id,
    };
  const selected =
    snapshot.markets.find((m) => m.id === Number(params.get("market"))) ||
    snapshot.markets.find((m) => m.id === initialMarket.current!.id) ||
    publicPrimary ||
    (snapshot.manifest.mode !== "testnet" &&
      snapshot.markets.find((m) => m.id === 15 && m.active)) ||
    snapshot.markets.find((m) => m.active && m.kind === "call") ||
    snapshot.markets.find((m) => m.active) ||
    snapshot.markets[0];
  return (
    <Context.Provider
      value={{
        snapshot,
        portfolio,
        selected,
        select,
        act,
        busy,
        walletAddress,
        authorize,
        notify: (message) => setToast({ message }),
        openSearch: () => setSearchOpen(true),
      }}
    >
      <div className="app-shell exchange-shell">
        <header className="topbar">
          <NavLink className="brand" to="/trade">
            <img src="/strata-mark.svg" alt="" />
            <span>Strata</span>
          </NavLink>
          <nav className="primary-nav" aria-label="Main navigation">
            {nav
              .filter(([path]) => snapshot.house || !housePaths.has(path))
              .map(([path, label]) => (
                <NavLink
                  key={path}
                  to={path}
                  onClick={() => setMobileNav(false)}
                >
                  {label === "Write options"
                    ? "Write"
                    : label === "Maker console"
                      ? "Liquidity"
                      : label}
                </NavLink>
              ))}
          </nav>
          <div className="topbar-right">
            <button
              className="command-trigger"
              aria-label="Find a market"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={12} />
              <span>Search markets</span>
              <kbd>⌘K</kbd>
            </button>
            <button
              className="account-button"
              aria-label={
                walletAddress
                  ? short(walletAddress)
                  : snapshot.manifest.mode === "testnet"
                    ? "Connect wallet"
                    : "Demo account"
              }
              onClick={() => setWalletOpen(true)}
            >
              <span className="account-balance">
                {portfolio
                  ? portfolio.usdc.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  : "—"}
                <small>dUSDC</small>
              </span>
              <span className="account-name">
                {walletAddress
                  ? short(walletAddress)
                  : snapshot.manifest.mode === "testnet"
                    ? "Connect wallet"
                    : "Demo"}
              </span>
              <ChevronDown size={12} />
            </button>
          </div>
        </header>
        <main className="workspace">
          {sleeping ? (
            <div className="service-notice trading-notice" role="status">
              <Zap size={15} />
              <span>
                {snapshot.trading!.gasLow
                  ? "Live prices from Pyth. On-chain trading is paused: the demo's testnet gas wallet is empty."
                  : waking
                    ? "Waking on-chain trading: relaying signed prices and refreshing books, usually about 20 seconds."
                    : "Live prices from Pyth. Some markets sleep to save testnet gas; enabling trading relays their on-chain prices."}
              </span>
              {!snapshot.trading!.gasLow && !waking && (
                <button onClick={() => void wake()}>Enable trading</button>
              )}
            </div>
          ) : (
            !snapshot.service.newExposureAllowed && (
              <div className="service-notice" role="status">
                <AlertCircle size={15} />
                <span>
                  {snapshot.service.reason} New orders and issuance are paused.
                  Contract exits remain available.
                </span>
                <button onClick={() => void refetch()}>Retry</button>
              </div>
            )
          )}
          <Suspense
            fallback={
              <div className="workspace-loading" role="status">
                <LoaderCircle className="spin" size={16} /> Loading workspace…
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<Navigate to="/trade" replace />} />
              <Route
                path="/trade"
                element={<Trade key={`${selected.id}-${params.get("side")}`} />}
              />
              <Route path="/markets" element={<Markets />} />
              <Route path="/strategies" element={<Strategies />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/write" element={<Writer key={selected.id} />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settlements" element={<Settlements />} />
              <Route path="/recovery" element={<Recovery />} />
              <Route path="/oracle" element={<OracleProofs />} />
              <Route path="/maker" element={<Maker />} />
              <Route path="/house" element={<House />} />
              <Route path="/rewards" element={<Rewards />} />
              <Route path="/status" element={<Status />} />
              <Route path="*" element={<Markets />} />
            </Routes>
          </Suspense>
        </main>
        <footer className="statusbar">
          <span>
            <i
              className={`dot ${snapshot.service.status === "ready" ? "mint" : "amber"}`}
            />{" "}
            {snapshot.manifest.mode === "testnet"
              ? "Monad testnet"
              : snapshot.manifest.mode === "local-fork"
                ? "Local Monad fork"
                : "Local chain"}{" "}
            <span className="status-separator">/</span>{" "}
            {snapshot.service.status === "ready"
              ? "Connected"
              : snapshot.service.status === "offline"
                ? "Reconnecting"
                : "Market paused"}{" "}
            <span className="status-separator">/</span> Block {snapshot.block}
          </span>
          <span>
            {snapshot.manifest.venueMode === "kuru"
              ? "Kuru onchain execution"
              : "Development order book"}{" "}
            <span className="status-separator">/</span>{" "}
            {snapshot.manifest.oracleMode === "demo"
              ? "Controlled demo oracle"
              : "Pyth price oracle"}{" "}
            <span className="status-separator">/</span> Test assets
          </span>
          <button onClick={() => navigate("/status")}>
            System status <Activity size={12} />
          </button>
        </footer>
        {toast && (
          <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
            <span>
              {toast.error ? (
                <AlertCircle size={17} />
              ) : busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <CheckCircle2 size={17} />
              )}
            </span>
            <div>
              <strong>{toast.message}</strong>
              {toast.hash && (
                <button
                  className="text-link"
                  onClick={() =>
                    void navigator.clipboard.writeText(toast.hash!)
                  }
                >
                  Copy transaction {short(toast.hash)}
                </button>
              )}
            </div>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {searchOpen && <MarketSelector onClose={() => setSearchOpen(false)} />}
        {walletOpen && (
          <Modal
            title={
              walletAddress
                ? "Connected wallet"
                : snapshot.manifest.mode === "testnet"
                  ? "Monad testnet wallet"
                  : "Local demo account"
            }
            onClose={() => setWalletOpen(false)}
          >
            <div className="account-detail">
              <span className="account-avatar large" />
              <strong>
                {account ? short(account) : "Connect your wallet"}
              </strong>
              <p>
                {walletAddress
                  ? "Your browser wallet signs each transaction. Verify the requested network and contract in your wallet."
                  : snapshot.manifest.mode === "testnet"
                    ? "Connect an EVM wallet on Monad testnet. Claim dUSDC here and obtain testnet MON for gas from the Monad faucet."
                    : "This funded development account signs real transactions on the local fork. It holds test assets only."}
              </p>
            </div>
            <dl className="review-list">
              <div>
                <dt>Available dUSDC</dt>
                <dd>{num(portfolio?.usdc ?? 0)}</dd>
              </div>
              <div>
                <dt>Available WMON</dt>
                <dd>{num(portfolio?.wmon ?? 0, 4)}</dd>
              </div>
              <div>
                <dt>Native test MON</dt>
                <dd>{num(portfolio?.native ?? 0, 4)}</dd>
              </div>
            </dl>
            <div className="account-actions">
              {walletAddress ? (
                <Button
                  onClick={() => {
                    rememberWallet(false);
                    setWalletAddress(null);
                  }}
                >
                  {snapshot.manifest.mode === "testnet"
                    ? "Disconnect wallet"
                    : "Use funded demo account"}
                </Button>
              ) : (
                <Button onClick={() => void connect()}>
                  Connect browser wallet
                </Button>
              )}
            </div>
            <div className="account-actions">
              <Button
                busy={busy}
                disabled={
                  snapshot.manifest.mode === "testnet" && !walletAddress
                }
                onClick={() => void act({ action: "faucet" })}
              >
                Claim 10,000 demo USDC
              </Button>
              <Button
                busy={busy}
                disabled={
                  snapshot.manifest.mode === "testnet" && !walletAddress
                }
                onClick={() =>
                  void act({
                    action: "wrap",
                    quantity: snapshot.manifest.mode === "testnet" ? "1" : "10",
                  })
                }
              >
                Wrap {snapshot.manifest.mode === "testnet" ? "1" : "10"} test
                MON
              </Button>
            </div>
            <p className="caption">
              Faucet cooldown: one hour. Wallet actions require the deployment’s
              chain.{" "}
              {snapshot.manifest.mode === "testnet"
                ? "Monad testnet uses chain 10143; all collateral and quote assets here are test assets."
                : "The local fork uses chain 31337 and test assets."}
            </p>
          </Modal>
        )}
        {help && (
          <Modal
            title="Start with a defined view"
            onClose={() => setHelp(false)}
          >
            <div className="help-cards">
              <button
                onClick={() => {
                  setHelp(false);
                  select(
                    snapshot.markets.find(
                      (m) => m.kind === "call" && m.strike === 1.05 && m.active,
                    )?.id ?? selected.id,
                  );
                }}
              >
                <h3>Expect MON to rise?</h3>
                <p>
                  Buy a call. Your maximum loss is the premium. At expiry, an
                  in-the-money call pays WMON.
                </p>
              </button>
              <button
                onClick={() => {
                  setHelp(false);
                  select(
                    snapshot.markets.find(
                      (m) => m.kind === "put" && m.strike === 1.05 && m.active,
                    )?.id ?? selected.id,
                  );
                }}
              >
                <h3>Want downside protection?</h3>
                <p>
                  Buy a put. It pays dUSDC if MON settles below your strike.
                </p>
              </button>
              <button
                onClick={() => {
                  setHelp(false);
                  navigate("/write");
                }}
              >
                <h3>Want to earn option premium?</h3>
                <p>
                  Lock full backing, issue claims, then sell them. You retain
                  the funded writer obligation.
                </p>
              </button>
            </div>
          </Modal>
        )}
      </div>
    </Context.Provider>
  );
}
