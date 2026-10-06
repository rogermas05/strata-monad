import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, isAddress, parseUnits } from "viem";
import { Copy, Download, Upload, ShieldCheck } from "lucide-react";
import {
  parseRecovery,
  authorizationSigner,
  type RecoveryPacket,
} from "../../../packages/core/src/recovery.ts";
import { useApp } from "./context.ts";
import { api } from "./api.ts";
import {
  Panel,
  Button,
  Modal,
  AddressText,
  Badge,
  usd,
  num,
  expiry,
} from "./ui.tsx";

export function Recovery() {
  const { snapshot, portfolio, walletAddress, authorize, act, busy, notify } =
    useApp();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const manifest = snapshot.manifest;
  const account = walletAddress ?? manifest.demoUser;
  const local = manifest.chainId === 31337;
  const canSign = local || !!walletAddress;
  const first =
    Number(params.get("market")) ||
    snapshot.markets.find(
      (m) =>
        m.settlementPrice &&
        (portfolio?.positions.find((p) => p.marketId === m.id)?.quantity ?? 0) >
          0,
    )?.id ||
    snapshot.markets[0].id;
  const [kind, setKind] = useState<"claim" | "unwind">(
    params.get("mode") === "unwind" ? "unwind" : "claim",
  );
  const [marketId, setMarketId] = useState(first),
    [quantity, setQuantity] = useState("1"),
    [writer, setWriter] = useState(account as string),
    [holder, setHolder] = useState(account as string),
    [payment, setPayment] = useState("0"),
    [duration, setDuration] = useState("3600"),
    [packet, setPacket] = useState<RecoveryPacket | null>(null),
    [raw, setRaw] = useState(""),
    [error, setError] = useState(""),
    [preparing, setPreparing] = useState(false),
    [review, setReview] = useState<
      "sign" | "submit" | "revoke" | "approve" | null
    >(null);
  const file = useRef<HTMLInputElement>(null);
  // Async completions must only mark the packet they were started for.
  const currentPacket = useRef<RecoveryPacket | null>(null);
  const [completed, setCompleted] = useState<"submitted" | "revoked" | null>(
    null,
  );
  useEffect(() => {
    if (!packet) {
      setWriter(account);
      setHolder(account);
    }
  }, [account, packet]);
  currentPacket.current = packet;
  const market = snapshot.markets.find((m) => m.id === marketId)!;
  const { data: accountState } = useQuery({
    queryKey: ["authorization", manifest.engine, account],
    queryFn: () => api.nonce(account),
    refetchInterval: 3000,
  });
  const packetWriter =
    packet?.type === "unwind" ? packet.terms.writer : undefined;
  const { data: writerState } = useQuery({
    queryKey: ["authorization", manifest.engine, packetWriter],
    queryFn: () => api.nonce(packetWriter!),
    enabled: !!packetWriter,
    refetchInterval: 3000,
  });
  const { data: holderState } = useQuery({
    queryKey: ["authorization", manifest.engine, packet?.terms.holder],
    queryFn: () => api.nonce(packet!.terms.holder),
    enabled: !!packet && !completed,
    refetchInterval: 3000,
  });
  const participant = packet
    ? (() => {
        try {
          return authorizationSigner(packet, account);
        } catch {
          return null;
        }
      })()
    : null;
  const signedByAccount =
    packet?.type === "claim"
      ? !!packet.signature
      : participant === "writer"
        ? !!packet?.writerSignature
        : !!packet?.holderSignature;
  const complete =
    packet?.type === "claim"
      ? !!packet.signature
      : !!packet?.writerSignature && !!packet?.holderSignature;
  const editsPending = !!packet && raw !== JSON.stringify(packet, null, 2);
  const { data: effect, error: inspectionError } = useQuery({
    queryKey: ["recovery-effect", packet],
    queryFn: () => api.inspectRecovery(packet!),
    enabled: !!packet && !completed,
    refetchInterval: 3000,
    retry: false,
  });
  const packetMarket = packet
    ? snapshot.markets.find((m) => String(m.id) === packet.terms.seriesId)!
    : null;
  const expired = packet
    ? BigInt(packet.terms.deadline) < BigInt(snapshot.timestamp)
    : false;
  const changedNonce =
    !!packet &&
    ((holderState &&
      holderState.nonce !==
        (packet.type === "claim"
          ? packet.terms.nonce
          : packet.terms.holderNonce)) ||
      (packet.type === "unwind" &&
        writerState &&
        writerState.nonce !== packet.terms.writerNonce));
  const approved =
    packet?.type !== "unwind" ||
    (writerState &&
      BigInt(writerState.usdcAllowance) >= BigInt(packet.terms.payment));
  const unavailable =
    market.active ||
    (kind === "claim" ? !market.settlementPrice : !!market.settlementPrice);

  function updatePacket(p: RecoveryPacket) {
    setPacket(p);
    setRaw(JSON.stringify(p, null, 2));
    setCompleted(null);
    setKind(p.type);
    setMarketId(Number(p.terms.seriesId));
    setHolder(p.terms.holder);
    setQuantity(formatUnits(BigInt(p.terms.quantity), 18));
    if (p.type === "unwind") {
      setWriter(p.terms.writer);
      setPayment(formatUnits(BigInt(p.terms.payment), 6));
    }
    setError("");
  }
  async function prepare() {
    setPreparing(true);
    setError("");
    try {
      if (unavailable)
        throw new Error(
          kind === "claim"
            ? "Choose a finalized expiry"
            : "Choose an expired instrument with no finalized reference",
        );
      if (!isAddress(holder) || (kind === "unwind" && !isAddress(writer)))
        throw new Error("Enter valid participant addresses");
      const holderNonce = await api.nonce(holder),
        writerNonce = kind === "unwind" ? await api.nonce(writer) : null;
      const common = {
        version: 1,
        chainId: manifest.chainId,
        engine: manifest.engine,
        type: kind,
      };
      const terms = {
        seriesId: String(marketId),
        holder,
        quantity: parseUnits(quantity, 18).toString(),
        deadline: String(snapshot.timestamp + Number(duration)),
      };
      updatePacket(
        parseRecovery(
          kind === "claim"
            ? { ...common, terms: { ...terms, nonce: holderNonce.nonce } }
            : {
                ...common,
                terms: {
                  ...terms,
                  writer,
                  payment: parseUnits(payment, 6).toString(),
                  writerNonce: writerNonce!.nonce,
                  holderNonce: holderNonce.nonce,
                },
              },
          manifest,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  }
  function importPacket(text: string) {
    try {
      if (text.length > 16384) throw new Error("Authorization exceeds 16 KiB");
      updatePacket(parseRecovery(JSON.parse(text), manifest));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid authorization JSON");
    }
  }
  async function confirm() {
    const operation = review;
    setReview(null);
    setError("");
    try {
      if (operation === "sign" && packet) updatePacket(await authorize(packet));
      if (operation === "submit" && packet) {
        if (
          (await act({ action: "submit-recovery", packet })) &&
          currentPacket.current === packet
        )
          setCompleted("submitted");
      }
      if (operation === "approve" && packet)
        await act({ action: "approve-recovery", packet });
      if (operation === "revoke") {
        const target = packet;
        if (
          (await act({ action: "revoke-authorizations" })) &&
          participant &&
          currentPacket.current === target
        )
          setCompleted("revoked");
      }
      await qc.invalidateQueries({ queryKey: ["authorization"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function download() {
    if (!packet) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `strata-${packet.type}-${packet.terms.seriesId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const summary =
    packet && packetMarket ? (
      <dl className="review-list">
        <div>
          <dt>Operation</dt>
          <dd>
            {packet.type === "claim"
              ? "Delegated expiry claim"
              : "Bilateral unresolved unwind"}
          </dd>
        </div>
        <div>
          <dt>Instrument</dt>
          <dd>
            {packetMarket.symbol} · {expiry(packetMarket.expiry)}
          </dd>
        </div>
        <div>
          <dt>Contract quantity</dt>
          <dd>{formatUnits(BigInt(packet.terms.quantity), 18)} MON</dd>
        </div>
        {packet.type === "claim" && (
          <div>
            <dt>Expiry payout</dt>
            <dd>
              {effect
                ? `${formatUnits(BigInt(effect.amount), effect.asset === "WMON" ? 18 : 6)} ${effect.asset}`
                : "Awaiting onchain inspection"}
            </dd>
          </div>
        )}
        {packet.type === "unwind" && (
          <>
            <div>
              <dt>Writer</dt>
              <dd>
                <AddressText full value={packet.terms.writer} />
              </dd>
            </div>
            <div>
              <dt>Writer pays holder</dt>
              <dd>
                {usd(Number(formatUnits(BigInt(packet.terms.payment), 6)), 6)}{" "}
                dUSDC
              </dd>
            </div>
            <div>
              <dt>Collateral released</dt>
              <dd>
                {effect
                  ? `${formatUnits(BigInt(effect.amount), effect.asset === "WMON" ? 18 : 6)} ${effect.asset} → writer`
                  : "Awaiting onchain inspection"}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>
            {packet.type === "claim" ? "Payout recipient" : "Claim holder"}
          </dt>
          <dd>
            <AddressText full value={packet.terms.holder} />
          </dd>
        </div>
        <div>
          <dt>Authorization deadline</dt>
          <dd>
            {BigInt(packet.terms.deadline) > 8640000000000n
              ? `Unix timestamp ${packet.terms.deadline}`
              : new Date(Number(packet.terms.deadline) * 1000)
                  .toISOString()
                  .replace("T", " ")
                  .replace(".000Z", " UTC")}
          </dd>
        </div>
        <div>
          <dt>Verifying engine</dt>
          <dd>
            <AddressText full value={packet.engine} />
          </dd>
        </div>
        <div>
          <dt>Chain</dt>
          <dd>{packet.chainId}</dd>
        </div>
        <div>
          <dt>Holder nonce</dt>
          <dd>
            {packet.type === "claim"
              ? packet.terms.nonce
              : packet.terms.holderNonce}
          </dd>
        </div>
        {packet.type === "unwind" && (
          <div>
            <dt>Writer nonce</dt>
            <dd>{packet.terms.writerNonce}</dd>
          </div>
        )}
      </dl>
    ) : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Recovery</h1>
          <p>Review, sign and submit account-bound authorizations.</p>
        </div>
        <Link className="text-link" to="/settlements">
          Back to settlements →
        </Link>
      </div>
      <div className="two-column recovery-columns">
        <Panel title="Prepare terms">
          <div className="tabs recovery-tabs">
            {(["claim", "unwind"] as const).map((k) => (
              <button
                key={k}
                className={kind === k ? "active" : ""}
                onClick={() => {
                  setKind(k);
                  setError("");
                }}
              >
                {k === "claim" ? "Delegated claim" : "Unresolved unwind"}
              </button>
            ))}
          </div>
          <form
            className="form-body recovery-form"
            onSubmit={(e) => {
              e.preventDefault();
              void prepare();
            }}
          >
            <p className="caption">
              {kind === "claim"
                ? "Authorize another account to pay the gas for a finalized claim. The contract always sends the payout to the holder."
                : "The writer and holder must agree on a dUSDC payment. The transaction burns the holder's claims and releases matching writer collateral. Available only while the expired reference is unresolved."}
            </p>
            <label className="field">
              <span>Instrument</span>
              <select
                aria-label="Recovery instrument"
                value={marketId}
                onChange={(e) => setMarketId(Number(e.target.value))}
              >
                {snapshot.markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.symbol} ·{" "}
                    {m.active
                      ? "Active"
                      : m.settlementPrice
                        ? "Finalized"
                        : "Unresolved"}
                  </option>
                ))}
              </select>
            </label>
            {kind === "unwind" && (
              <label className="field">
                <span>Writer account</span>
                <input
                  aria-label="Writer account"
                  value={writer}
                  onChange={(e) => setWriter(e.target.value)}
                  required
                  spellCheck={false}
                />
              </label>
            )}
            <label className="field">
              <span>Holder account</span>
              <input
                aria-label="Holder account"
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
                required
                spellCheck={false}
              />
            </label>
            <div className="recovery-pair">
              <label className="field">
                <span>Claim quantity (MON)</span>
                <input
                  aria-label="Recovery quantity"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                  inputMode="decimal"
                />
              </label>
              <label className="field">
                <span>Validity</span>
                <select
                  aria-label="Authorization validity"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                >
                  <option value="900">15 minutes</option>
                  <option value="3600">1 hour</option>
                  <option value="86400">24 hours</option>
                </select>
              </label>
            </div>
            {kind === "unwind" && (
              <label className="field">
                <span>Writer payment (dUSDC)</span>
                <input
                  aria-label="Unwind payment"
                  value={payment}
                  onChange={(e) => setPayment(e.target.value)}
                  required
                  inputMode="decimal"
                />
              </label>
            )}
            {unavailable && (
              <p className="caption">
                {kind === "claim"
                  ? "This instrument requires a finalized expiry reference."
                  : "This instrument must be expired with no finalized reference."}
              </p>
            )}
            <Button type="submit" disabled={unavailable} busy={preparing}>
              Prepare authorization
            </Button>
          </form>
        </Panel>
        <Panel
          title="Authorization"
          extra={
            packet ? (
              <Badge>
                {completed
                  ? completed === "submitted"
                    ? "Completed"
                    : "Revoked"
                  : packet.type === "claim"
                    ? packet.signature
                      ? "Signature attached"
                      : "Unsigned"
                    : `${Number(!!packet.writerSignature) + Number(!!packet.holderSignature)} / 2 signatures`}
              </Badge>
            ) : undefined
          }
        >
          <div className="form-body recovery-form">
            {packet ? (
              <>
                {summary}
                <div className="recovery-actions">
                  <Button
                    className="primary"
                    busy={busy}
                    disabled={
                      !canSign ||
                      !!completed ||
                      !effect ||
                      editsPending ||
                      !participant ||
                      signedByAccount ||
                      expired ||
                      !!changedNonce
                    }
                    onClick={() => setReview("sign")}
                  >
                    {participant
                      ? `Sign as ${participant}`
                      : "Connect a participant wallet to sign"}
                  </Button>
                  {packet.type === "unwind" &&
                    participant === "writer" &&
                    !approved && (
                      <Button
                        busy={busy}
                        disabled={editsPending}
                        onClick={() => setReview("approve")}
                      >
                        Approve payment
                      </Button>
                    )}
                  <Button
                    busy={busy}
                    disabled={
                      !canSign ||
                      !!completed ||
                      !effect ||
                      editsPending ||
                      !complete ||
                      expired ||
                      !!changedNonce ||
                      !approved
                    }
                    onClick={() => setReview("submit")}
                  >
                    Review submission
                  </Button>
                </div>
                {completed && (
                  <p className="caption">
                    {completed === "submitted"
                      ? "Authorized recovery completed onchain."
                      : "This account revoked the pending authorization."}{" "}
                    Prepare new terms for another operation.
                  </p>
                )}
                {!completed && (expired || changedNonce) && (
                  <p className="negative" role="alert">
                    {expired
                      ? "Authorization expired."
                      : "Account nonce changed; this authorization is no longer valid."}{" "}
                    Prepare new terms.
                  </p>
                )}
                {!completed && packet.type === "unwind" && !approved && (
                  <p className="caption">
                    The writer must approve the displayed dUSDC payment before
                    anyone can submit this unwind.
                  </p>
                )}
                <div className="recovery-actions secondary-actions">
                  <Button onClick={download}>
                    <Download size={13} />
                    Download JSON
                  </Button>
                  <Button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          JSON.stringify(packet, null, 2),
                        );
                        notify("Authorization JSON copied.");
                      } catch {
                        setError(
                          "Clipboard unavailable; download the JSON instead.",
                        );
                      }
                    }}
                  >
                    <Copy size={13} />
                    Copy JSON
                  </Button>
                  <Button
                    onClick={() => {
                      setPacket(null);
                      setCompleted(null);
                      setRaw("");
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </>
            ) : (
              <p className="caption">
                Prepare terms or import the counterparty's authorization. Both
                signatures must cover the identical terms, chain and engine.
              </p>
            )}
            <label className="field">
              <span>Authorization JSON</span>
              <textarea
                aria-label="Authorization JSON"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                maxLength={16384}
                spellCheck={false}
                rows={7}
              />
            </label>
            {editsPending && (
              <p className="caption">
                JSON edits have not been loaded. Load the authorization to
                review the new terms.
              </p>
            )}
            <div className="recovery-actions">
              <Button disabled={!raw.trim()} onClick={() => importPacket(raw)}>
                Load authorization
              </Button>
              <Button onClick={() => file.current?.click()}>
                <Upload size={13} />
                Import file
              </Button>
            </div>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden-input"
              aria-label="Import authorization file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 16384) setError("Authorization exceeds 16 KiB");
                else importPacket(await f.text());
                e.target.value = "";
              }}
            />
            {error && (
              <p role="alert" className="negative recovery-error">
                {error}
              </p>
            )}
          </div>
        </Panel>
      </div>
      <Panel
        title="Pending authorization control"
        extra={
          <span className="caption">
            Current account nonce: {accountState?.nonce ?? "—"}
          </span>
        }
      >
        <div className="recovery-control">
          <p>
            Revoking increments your shared nonce. Every pending claim or unwind
            signed with the old nonce becomes invalid. Your collateral and
            claims stay in place.
          </p>
          <Button
            disabled={!canSign}
            busy={busy}
            onClick={() => setReview("revoke")}
          >
            Revoke pending authorizations
          </Button>
        </div>
      </Panel>
      {review && (
        <Modal
          title={
            review === "revoke"
              ? "Revoke authorizations"
              : review === "approve"
                ? "Approve unwind payment"
                : review === "sign"
                  ? "Review authorization"
                  : "Submit recovery"
          }
          onClose={() => setReview(null)}
        >
          {review === "revoke" ? (
            <dl className="review-list">
              <div>
                <dt>Account</dt>
                <dd>
                  <AddressText full value={account} />
                </dd>
              </div>
              <div>
                <dt>Action</dt>
                <dd>Increment shared authorization nonce</dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>
                  <AddressText full value={manifest.engine} />
                </dd>
              </div>
              <div>
                <dt>Asset movement</dt>
                <dd>None; network gas only</dd>
              </div>
            </dl>
          ) : (
            summary
          )}
          {!completed && inspectionError && (
            <p className="negative recovery-error" role="alert">
              {inspectionError.message}
            </p>
          )}
          <div className="notice">
            <ShieldCheck size={16} />
            <p>
              {review === "sign"
                ? "This signature authorizes the displayed terms. Anyone with the completed package can submit it before the deadline. A claim payout always goes to the holder. No transaction is sent by signing."
                : review === "submit"
                  ? "The engine verifies signatures, nonces, balances and expiry status atomically. The submitting account pays gas."
                  : review === "approve"
                    ? "This transaction grants the engine an allowance for the displayed dUSDC payment. The writer can reduce that allowance separately."
                    : "This transaction invalidates pending authorizations across every series for your account."}
            </p>
          </div>
          <Button className="primary full" onClick={() => void confirm()}>
            {review === "sign"
              ? "Confirm signature"
              : review === "submit"
                ? "Submit authorized recovery"
                : review === "approve"
                  ? "Confirm payment approval"
                  : "Confirm revocation"}
          </Button>
        </Modal>
      )}
    </>
  );
}
