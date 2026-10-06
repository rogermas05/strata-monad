import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Upload, Copy, ShieldCheck } from "lucide-react";
import { formatEther } from "viem";
import {
  parseOracleProof,
  type OracleProof,
} from "../../../packages/core/src/oracle-proof.ts";
import { useApp } from "./context.ts";
import { api } from "./api.ts";
function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
import {
  Panel,
  Badge,
  Button,
  Modal,
  AddressText,
  Empty,
  usd,
  expiry,
} from "./ui.tsx";

export function OracleProofs() {
  const { snapshot, walletAddress, act, busy, notify } = useApp();
  const [params] = useSearchParams();
  const manifest = snapshot.manifest,
    account = walletAddress ?? manifest.demoUser;
  const expiries = [
    ...new Set(manifest.series.map((series) => series.expiry)),
  ].sort((a, b) => a - b);
  const selectedExpiry = Number(params.get("expiry"));
  const [kind, setKind] = useState<"settlement" | "live">("settlement");
  const [chosenExpiry, setChosenExpiry] = useState(
    expiries.includes(selectedExpiry)
      ? selectedExpiry
      : (expiries.find((time) => time <= snapshot.timestamp) ?? expiries[0]),
  );
  const [proof, setProof] = useState<OracleProof | null>(null),
    [raw, setRaw] = useState(""),
    [error, setError] = useState("");
  const [pending, setPending] = useState(false),
    [checked, setChecked] = useState(false),
    [review, setReview] = useState<OracleProof | null>(null),
    [submitted, setSubmitted] = useState(false);
  const { data: service } = useQuery({
    queryKey: ["oracle-service"],
    queryFn: api.oracleStatus,
    refetchInterval: 15000,
  });
  const pyth = manifest.oracleMode === "pyth";
  const sessionPolicy =
    manifest.assets?.find((a) => a.assetId === manifest.assetId)?.policy ===
    "pyth-latest-before-close";
  useEffect(() => {
    setChecked(false);
    setReview(null);
  }, [account]);
  function load(text: string) {
    setRaw(text);
    setChecked(false);
    setSubmitted(false);
    setError("");
    try {
      if (text.length > 160000)
        throw new Error("Proof package exceeds the supported import size");
      const packet = parseOracleProof(JSON.parse(text), manifest);
      setProof(packet);
      setRaw(JSON.stringify(packet, null, 2));
      setKind(packet.kind);
      if (packet.expiry !== null) setChosenExpiry(packet.expiry);
    } catch (err) {
      setProof(null);
      setError(
        err instanceof Error && err.name !== "ZodError"
          ? err.message
          : "Invalid proof package. Check the fields, numeric values and payload size.",
      );
    }
  }
  async function prepare() {
    setPending(true);
    setError("");
    setChecked(false);
    setSubmitted(false);
    try {
      const packet = await api.prepareOracle({
        kind,
        ...(kind === "settlement" ? { expiry: chosenExpiry } : {}),
        account,
      });
      const parsed = parseOracleProof(packet, manifest);
      setProof(parsed);
      setRaw(JSON.stringify(parsed, null, 2));
      setChecked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retrieval failed");
    } finally {
      setPending(false);
    }
  }
  async function inspect() {
    if (!proof) return;
    setPending(true);
    setError("");
    setChecked(false);
    try {
      const current = await api.inspectOracle(proof, account);
      setProof(current);
      setRaw(JSON.stringify(current, null, 2));
      setChecked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Proof inspection failed");
    } finally {
      setPending(false);
    }
  }
  async function submit() {
    const packet = review;
    setReview(null);
    if (!packet) return;
    if (await act({ action: "submit-oracle-proof", proof: packet })) {
      setSubmitted(true);
      setChecked(false);
    }
  }
  const observation = proof?.observation;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Oracle evidence</h1>
          <p>
            Inspect the observation, verifier and payment before submitting an
            update.
          </p>
        </div>
        <Link className="text-link" to="/settlements">
          Expiry settlements →
        </Link>
      </div>
      <div className="oracle-proof-layout">
        <Panel
          title="Prepare a proof package"
          extra={
            <Badge tone={pyth ? "neutral" : "amber"}>
              {pyth ? "Pyth adapter" : "Controlled oracle"}
            </Badge>
          }
        >
          <div className="form-body">
            <div className="segmented">
              <button
                className={kind === "settlement" ? "active" : ""}
                onClick={() => {
                  setKind("settlement");
                  setProof(null);
                  setChecked(false);
                }}
              >
                Expiry reference
              </button>
              <button
                className={kind === "live" ? "active" : ""}
                onClick={() => {
                  setKind("live");
                  setProof(null);
                  setChecked(false);
                }}
              >
                Live price
              </button>
            </div>
            {kind === "settlement" && (
              <label className="field">
                <span>Option expiry</span>
                <select
                  aria-label="Proof expiry"
                  value={chosenExpiry}
                  onChange={(event) => {
                    setChosenExpiry(Number(event.target.value));
                    setProof(null);
                    setChecked(false);
                  }}
                >
                  {expiries.map((time) => (
                    <option key={time} value={time}>
                      {expiry(time)} ·{" "}
                      {time <= snapshot.timestamp ? "Elapsed" : "Upcoming"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="caption">
              {kind === "settlement"
                ? sessionPolicy
                  ? "Propose the latest signed update at or before expiry during the challenge window, then finalize the candidate after the window closes."
                  : "The verifier must confirm the first signed update at or after this expiry. Its confidence interval is retained with the fixed reference."
                : "Live updates must be recent and have a confidence interval within 1%. A newer price already stored by the verifier takes precedence."}
            </p>
            <Button
              className="primary full"
              busy={pending}
              disabled={
                !pyth ||
                !service?.providerConfigured ||
                busy ||
                (kind === "settlement" && chosenExpiry > snapshot.timestamp)
              }
              onClick={() => void prepare()}
            >
              Retrieve signed update
            </Button>
            <p className="caption">
              {!pyth
                ? "This deployment uses controlled observations. Signed packages require an admitted Pyth deployment."
                : !service?.providerConfigured
                  ? "Provider access is not configured. An existing package can still be imported and checked."
                  : service.backupConfigured
                    ? "Primary and backup retrieval are configured. Provider keys remain on the server."
                    : "Authenticated retrieval is configured. Provider keys remain on the server."}
            </p>
            <label className="field">
              <span>Existing proof package</span>
              <textarea
                aria-label="Oracle proof JSON"
                className="oracle-json"
                value={raw}
                placeholder="Paste a prepared JSON package"
                onChange={(event) => {
                  setRaw(event.target.value);
                  setChecked(false);
                  setSubmitted(false);
                }}
                spellCheck={false}
              />
            </label>
            <div className="row-actions">
              <Button
                disabled={!raw || pending || busy}
                onClick={() => load(raw)}
              >
                Load package
              </Button>
              <label className="button">
                <Upload size={13} /> Import JSON
                <input
                  aria-label="Import oracle proof"
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 160000) {
                      setError(
                        "Proof package exceeds the supported import size",
                      );
                      return;
                    }
                    void file.text().then(load);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            {error && (
              <p className="negative" role="alert">
                {error}
              </p>
            )}
          </div>
        </Panel>
        <Panel
          title="Observation and deployment"
          extra={
            proof && (
              <Badge tone={submitted ? "green" : checked ? "green" : "neutral"}>
                {submitted
                  ? "Submitted"
                  : checked
                    ? "Checks passed"
                    : "Needs inspection"}
              </Badge>
            )
          }
        >
          {proof && observation ? (
            <div className="form-body">
              <dl className="review-list oracle-review">
                <div>
                  <dt>Reference price</dt>
                  <dd>{usd(Number(observation.normalizedPrice) / 1e8, 8)}</dd>
                </div>
                <div>
                  <dt>Published at</dt>
                  <dd>
                    {new Date(
                      Number(observation.publishedAt) * 1000,
                    ).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>Raw price / exponent</dt>
                  <dd>
                    {observation.rawPrice} × 10^{observation.exponent}
                  </dd>
                </div>
                <div>
                  <dt>Raw confidence</dt>
                  <dd>{observation.confidence}</dd>
                </div>
                <div>
                  <dt>Reviewed oracle fee</dt>
                  <dd>{formatEther(BigInt(proof.maxFee))} MON</dd>
                </div>
                <div>
                  <dt>Verification block</dt>
                  <dd>{proof.verification.blockNumber}</dd>
                </div>
                <div>
                  <dt>Oracle</dt>
                  <dd>
                    <AddressText value={proof.oracle} full />
                  </dd>
                </div>
                <div>
                  <dt>Verifier</dt>
                  <dd>
                    <AddressText value={proof.verifier} full />
                  </dd>
                </div>
                <div>
                  <dt>Feed identifier</dt>
                  <dd>
                    <AddressText value={proof.feed} full />
                  </dd>
                </div>
                <div>
                  <dt>Payload hash</dt>
                  <dd>
                    <AddressText value={observation.proofHash} full />
                  </dd>
                </div>
              </dl>
              <p className="caption">
                Checks use the configured contracts at the displayed block. The
                wallet rechecks the deployment, observation and fee before
                sending. Verifier admission remains a deployment requirement;
                gas is separate from the oracle fee.
              </p>
              <div className="row-actions">
                <Button
                  disabled={
                    !proof ||
                    pending ||
                    busy ||
                    submitted ||
                    raw !== JSON.stringify(proof, null, 2)
                  }
                  onClick={() => void inspect()}
                >
                  <ShieldCheck size={13} /> Check against chain
                </Button>
                <Button
                  disabled={raw !== JSON.stringify(proof, null, 2)}
                  onClick={() =>
                    downloadJson(proof, "strata-oracle-proof.json")
                  }
                >
                  <Download size={13} /> Export
                </Button>
                <Button
                  disabled={raw !== JSON.stringify(proof, null, 2)}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(JSON.stringify(proof, null, 2))
                      .then(() => notify("Proof package copied."))
                  }
                >
                  <Copy size={13} /> Copy
                </Button>
              </div>
              <Button
                className="primary full"
                disabled={
                  !checked ||
                  submitted ||
                  pending ||
                  busy ||
                  raw !== JSON.stringify(proof, null, 2) ||
                  (manifest.mode === "testnet" && !walletAddress)
                }
                onClick={() => setReview(proof)}
              >
                Review oracle transaction
              </Button>
            </div>
          ) : (
            <Empty title="No proof selected">
              Retrieve a signed update or import a package to inspect the
              verified observation and exact target contracts.
            </Empty>
          )}
        </Panel>
      </div>
      {!pyth && (
        <Panel title="Recorded controlled references">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Expiry</th>
                  <th>Reference</th>
                  <th>Observation time</th>
                  <th>Finalization</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.settlements.map((reference) => (
                  <tr key={reference.expiry}>
                    <td>{expiry(reference.expiry)}</td>
                    <td>{usd(reference.price, 5)}</td>
                    <td>
                      {new Date(reference.publishedAt * 1000).toLocaleString()}
                    </td>
                    <td>
                      <AddressText value={reference.hash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!snapshot.settlements.length && (
            <Empty title="No finalized reference yet">
              Recorded observations appear here once an elapsed expiry has been
              finalized.
            </Empty>
          )}
        </Panel>
      )}
      {review && (
        <Modal title="Submit oracle evidence" onClose={() => setReview(null)}>
          <p>
            {review.kind === "settlement"
              ? review.action === "propose"
                ? "Propose this verified observation. A later observation at or before expiry can replace it during the challenge window; this transaction does not finalize payouts."
                : "Finalize the expiry reference. Every holder and writer claim will use this fixed observation."
              : "Submit the signed live update to the configured verifier. A newer stored observation retains priority."}
          </p>
          <dl className="review-list oracle-review">
            <div>
              <dt>Network</dt>
              <dd>Chain {review.chainId}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>
                <AddressText
                  value={
                    review.kind === "settlement"
                      ? review.oracle
                      : review.verifier
                  }
                  full
                />
              </dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>
                {usd(Number(review.observation.normalizedPrice) / 1e8, 8)}
              </dd>
            </div>
            <div>
              <dt>Maximum oracle fee</dt>
              <dd>{formatEther(BigInt(review.maxFee))} MON</dd>
            </div>
            <div>
              <dt>Payload hash</dt>
              <dd>
                <AddressText value={review.observation.proofHash} full />
              </dd>
            </div>
          </dl>
          <Button className="primary full" onClick={() => void submit()}>
            Confirm oracle submission
          </Button>
        </Modal>
      )}
    </>
  );
}
