import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Landmark, Sparkles, Timer } from "lucide-react";
import { api } from "./api.ts";
import { useApp } from "./context.ts";
import {
  Badge,
  Button,
  Empty,
  Metric,
  Panel,
  num,
  remaining,
  time,
  usd,
} from "./ui.tsx";
import { POINTS_RULES } from "../../../packages/core/src/points.ts";
import type { HouseState } from "../../../packages/core/src/index.ts";

/** Accounts shown on house pages: the connected wallet, else the local demo account. */
function useAccount() {
  const { snapshot, walletAddress } = useApp();
  return (
    walletAddress ??
    (snapshot.manifest.mode === "testnet"
      ? undefined
      : snapshot.manifest.demoUser)
  );
}

const validAmount = (value: string, max: number) => {
  const n = Number(value);
  return /^\d+(\.\d{1,6})?$/.test(value) && n > 0 && n <= max;
};

function PhaseBadge({ house, now }: { house: HouseState; now: number }) {
  if (house.epoch === 0)
    return (
      <Badge tone="blue">
        <Timer size={12} /> Genesis ·{" "}
        {now >= house.launchTime
          ? "launching"
          : remaining(house.launchTime, now)}
      </Badge>
    );
  return <Badge tone="green">Epoch {house.epoch}</Badge>;
}

export function House() {
  const { snapshot, act, busy } = useApp();
  const house = snapshot.house;
  const account = useAccount();
  const { data: position } = useQuery({
    queryKey: ["house", account],
    queryFn: () => api.house(account!),
    enabled: !!account && !!house,
    refetchInterval: 3000,
  });
  const [deposit, setDeposit] = useState("1000"),
    [withdraw, setWithdraw] = useState("");
  if (!house)
    return (
      <Empty title="No house vault on this deployment">
        Deploy one locally with npm run house:deploy, then restart the API.
      </Empty>
    );
  const now = snapshot.timestamp;
  const genesis = house.epoch === 0;
  const markets = snapshot.markets.filter((m) => house.series.includes(m.id));
  const committed = house.epochStartAssets + house.pendingDeposits;
  const capLeft = Math.max(0, house.depositCap - committed);
  const canDeposit =
    !!position &&
    !house.depositsPaused &&
    validAmount(deposit, Math.min(position.usdc, capLeft));
  const canWithdraw = !!position && validAmount(withdraw, position.shares);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE HOUSE</span>
          <h1>House vault</h1>
          <p>
            Deposit dUSDC and own the house book. The vault writes fully funded
            puts and spreads on every cash-settled market, quotes them on Kuru
            and earns the premium traders pay.
          </p>
        </div>
        <PhaseBadge house={house} now={now} />
      </div>
      {genesis && (
        <div className="genesis-banner" role="status">
          <Sparkles size={18} />
          <div>
            <strong>
              Genesis pre-deposits are open: {usd(house.pendingDeposits)} from{" "}
              {house.depositors}{" "}
              {house.depositors === 1 ? "depositor" : "depositors"}
            </strong>
            <span>
              Trading starts {time(house.launchTime)} (
              {now >= house.launchTime
                ? "at the next roll"
                : `in ${remaining(house.launchTime, now)}`}
              ). The earliest deposits earn up to 2× genesis points, and
              pre-deposits become the vault's day-one liquidity. You can cancel
              until launch.
            </span>
          </div>
        </div>
      )}
      <div className="stats-grid">
        <Metric
          label="Vault assets"
          value={usd(genesis ? house.pendingDeposits : house.estimatedAssets)}
          sub={
            genesis
              ? "Pending genesis deposits"
              : "Estimate: cash plus positions at model prices"
          }
        />
        <Metric
          label="Share price"
          value={num(house.estimatedPricePerShare, 4)}
          sub={`Last roll ${num(house.lastPricePerShare, 4)} dUSDC per share`}
        />
        <Metric
          label="Max loss this epoch"
          value={usd(house.maxLoss)}
          sub={
            house.estimatedAssets > 0
              ? `${num((house.maxLoss / house.estimatedAssets) * 100, 1)}% of assets if every short pays in full`
              : "No open short positions"
          }
          tone={house.maxLoss > 0 ? "negative" : undefined}
        />
        <Metric
          label="Paid to stakers"
          value={usd(house.totalFees)}
          sub={`${num(house.performanceFeeBps / 100, 0)}% of each profitable epoch`}
        />
      </div>
      <div className="two-column">
        <div className="stack">
          <Panel title="Deposit">
            <div className="form-body">
              <label className="field">
                <span>
                  Amount <small>Enters at the next roll's share price</small>
                </span>
                <div>
                  <input
                    aria-label="Deposit amount"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                  />
                  <span>dUSDC</span>
                </div>
              </label>
              <dl className="review-list">
                <div>
                  <dt>Wallet</dt>
                  <dd>{usd(position?.usdc ?? 0)}</dd>
                </div>
                <div>
                  <dt>Pending this epoch</dt>
                  <dd>{usd(position?.pendingDeposit ?? 0)}</dd>
                </div>
                <div>
                  <dt>Remaining deposit cap</dt>
                  <dd>{usd(capLeft)}</dd>
                </div>
              </dl>
              <Button
                className="primary full"
                busy={busy}
                disabled={!canDeposit}
                onClick={() =>
                  void act({ action: "house-deposit", amount: deposit })
                }
              >
                {house.depositsPaused
                  ? "Deposits paused"
                  : "Deposit to the house"}
              </Button>
              {!!position?.pendingDeposit && (
                <Button
                  className="full"
                  disabled={busy}
                  onClick={() =>
                    void act({
                      action: "house-cancel-deposit",
                      amount: String(position.pendingDeposit),
                    })
                  }
                >
                  Cancel pending deposit
                </Button>
              )}
            </div>
          </Panel>
          <Panel title="Withdraw">
            <div className="form-body">
              <dl className="review-list">
                <div>
                  <dt>Your shares</dt>
                  <dd>{num(position?.shares ?? 0, 4)} sHOUSE</dd>
                </div>
                <div>
                  <dt>Estimated value</dt>
                  <dd>{usd(position?.value ?? 0)}</dd>
                </div>
                <div>
                  <dt>Queued withdrawal</dt>
                  <dd>
                    {position?.withdrawal.shares
                      ? position.withdrawal.ready
                        ? `${usd(position.withdrawal.assets)} ready`
                        : `${num(position.withdrawal.shares, 4)} shares at next roll`
                      : "None"}
                  </dd>
                </div>
              </dl>
              <label className="field">
                <span>
                  Shares <small>Paid at the next roll's share price</small>
                </span>
                <div>
                  <input
                    aria-label="Withdraw shares"
                    placeholder={num(position?.shares ?? 0, 4)}
                    value={withdraw}
                    onChange={(e) => setWithdraw(e.target.value)}
                  />
                  <span>sHOUSE</span>
                </div>
              </label>
              <Button
                className="full"
                busy={busy}
                disabled={!canWithdraw}
                onClick={() =>
                  void act({
                    action: "house-request-withdraw",
                    amount: withdraw,
                  })
                }
              >
                Request withdrawal
              </Button>
              {position?.withdrawal.ready && (
                <Button
                  className="primary full"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: "house-complete-withdraw" })
                  }
                >
                  Collect {usd(position.withdrawal.assets)}
                </Button>
              )}
            </div>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="How the house works">
            <div className="steps">
              {[
                [
                  "01",
                  "Deposit dUSDC",
                  "Deposits and withdrawals queue and settle at each weekly roll, so nobody exits while collateral backs live options.",
                ],
                [
                  "02",
                  "The vault writes and quotes",
                  "It locks full collateral for every put and spread it sells. It can never be liquidated or owe more than it locked.",
                ],
                [
                  "03",
                  "Everything settles to cash",
                  "Each epoch's contracts expire and settle before the roll, so the share price is computed from cash only.",
                ],
                [
                  "04",
                  "Earn premium and points",
                  "Profitable epochs raise the share price. Deposits earn STRATA points every epoch.",
                ],
              ].map(([n, t, d]) => (
                <div key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{d}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title={`Markets this epoch (${markets.length})`}>
            {markets.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Expiry</th>
                      <th>Bid / ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {markets.map((m) => (
                      <tr key={m.id}>
                        <td>{m.symbol}</td>
                        <td>
                          {m.expiry > now
                            ? remaining(m.expiry, now)
                            : "Expired"}
                        </td>
                        <td>
                          {m.bid === null ? "—" : num(m.bid, 4)} /{" "}
                          {m.ask === null ? "—" : num(m.ask, 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={genesis ? "Trading starts at launch" : "Idle epoch"}
              >
                {genesis
                  ? "The first roll admits every cash-settled contract in the nearest weekly window."
                  : "The vault rolls into new contracts once they are listed."}
              </Empty>
            )}
          </Panel>
          <Panel title="Share price history">
            {house.history.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Epoch</th>
                      <th>Share price</th>
                      <th>Assets after roll</th>
                      <th>Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...house.history].reverse().map((h) => (
                      <tr key={h.epoch}>
                        <td>{h.epoch === 0 ? "Genesis" : h.epoch}</td>
                        <td>{num(h.pricePerShare, 4)}</td>
                        <td>{usd(h.assets)}</td>
                        <td>{usd(h.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No rolls yet">
                The first roll happens at launch.
              </Empty>
            )}
          </Panel>
          <div className="notice">
            <AlertCircle size={16} />
            <p>
              The vault takes the other side of trader bets. It earns premium in
              most weeks and pays out in weeks with large moves, so the share
              price can fall. Losses are limited to the collateral locked for
              the epoch's contracts. The operator sets prices and is trusted not
              to misprice quotes. Test assets only.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

export function Rewards() {
  const { snapshot, act, busy } = useApp();
  const house = snapshot.house;
  const account = useAccount();
  const { data: rewards } = useQuery({
    queryKey: ["rewards", account],
    queryFn: () => api.rewards(account!),
    enabled: !!account && !!house,
    refetchInterval: 5000,
  });
  const [stake, setStake] = useState(""),
    [unstake, setUnstake] = useState("");
  if (!house)
    return (
      <Empty title="No rewards on this deployment">
        Points and STRATA need a house vault.
      </Empty>
    );
  const now = snapshot.timestamp;
  const decimals = (value: string, max: number) => {
    const n = Number(value);
    return /^\d+(\.\d{1,18})?$/.test(value) && n > 0 && n <= max;
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">REWARDS</span>
          <h1>Points & STRATA</h1>
          <p>
            Points become STRATA at each weekly roll. Staked STRATA earns the
            house's performance fee in dUSDC.
          </p>
        </div>
        <Badge tone="blue">
          <Landmark size={12} /> {num(rewards?.totalStaked ?? 0, 0)} STRATA
          staked
        </Badge>
      </div>
      <div className="stats-grid">
        <Metric
          label="Your points"
          value={num(rewards?.points.total ?? 0, 2)}
          sub={`${num(rewards?.unpublished ?? 0, 2)} not yet published`}
        />
        <Metric
          label="Claimable STRATA"
          value={num(rewards?.claimable ?? 0, 2)}
          sub={`${num(rewards?.claimed ?? 0, 2)} claimed so far`}
        />
        <Metric
          label="Staked STRATA"
          value={num(rewards?.staked ?? 0, 2)}
          sub={`${num(rewards?.strata ?? 0, 2)} in wallet`}
        />
        <Metric
          label="dUSDC earned"
          value={usd(rewards?.earned ?? 0)}
          sub="Performance fees from profitable epochs"
        />
      </div>
      <div className="two-column">
        <div className="stack">
          <Panel title="Your points">
            <dl className="review-list padded">
              <div>
                <dt>Genesis deposits</dt>
                <dd>{num(rewards?.points.genesis ?? 0, 2)}</dd>
              </div>
              <div>
                <dt>Vault deposits</dt>
                <dd>{num(rewards?.points.deposits ?? 0, 2)}</dd>
              </div>
              <div>
                <dt>Losing tickets</dt>
                <dd>{num(rewards?.points.losses ?? 0, 2)}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{num(rewards?.points.total ?? 0, 2)}</dd>
              </div>
            </dl>
            <div className="form-body">
              <Button
                className="primary full"
                busy={busy}
                disabled={!rewards?.claimable}
                onClick={() =>
                  void act({ action: "rewards-claim", stake: true })
                }
              >
                Claim & stake {num(rewards?.claimable ?? 0, 2)} STRATA
              </Button>
              <Button
                className="full"
                disabled={busy || !rewards?.claimable}
                onClick={() => void act({ action: "rewards-claim" })}
              >
                Claim to wallet
              </Button>
            </div>
          </Panel>
          <Panel title="Staking">
            <div className="form-body">
              <label className="field">
                <span>
                  Stake <small>{num(rewards?.strata ?? 0, 2)} available</small>
                </span>
                <div>
                  <input
                    aria-label="Stake amount"
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                  />
                  <span>STRATA</span>
                </div>
              </label>
              <Button
                className="full"
                busy={busy}
                disabled={!decimals(stake, rewards?.strata ?? 0)}
                onClick={() =>
                  void act({ action: "strata-stake", amount: stake })
                }
              >
                Stake
              </Button>
              <Button
                className="primary full"
                disabled={busy || !rewards?.earned}
                onClick={() => void act({ action: "strata-claim-usdc" })}
              >
                Collect {usd(rewards?.earned ?? 0)}
              </Button>
              <label className="field">
                <span>
                  Unstake{" "}
                  <small>Stops earning now, then a cooldown applies</small>
                </span>
                <div>
                  <input
                    aria-label="Unstake amount"
                    value={unstake}
                    onChange={(e) => setUnstake(e.target.value)}
                  />
                  <span>STRATA</span>
                </div>
              </label>
              <Button
                className="full"
                disabled={busy || !decimals(unstake, rewards?.staked ?? 0)}
                onClick={() =>
                  void act({
                    action: "strata-request-unstake",
                    amount: unstake,
                  })
                }
              >
                Request unstake
              </Button>
              {!!rewards?.cooling && (
                <Button
                  className="full"
                  disabled={busy || now < rewards.unlockAt}
                  onClick={() => void act({ action: "strata-withdraw" })}
                >
                  {now < rewards.unlockAt
                    ? `${num(rewards.cooling, 2)} unlocks in ${remaining(rewards.unlockAt, now)}`
                    : `Withdraw ${num(rewards.cooling, 2)} STRATA`}
                </Button>
              )}
            </div>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="How to earn">
            <div className="steps">
              {[
                [
                  "01",
                  "Pre-deposit at genesis",
                  `${POINTS_RULES.genesisPerUsdc} points per dUSDC, up to 2× for the earliest deposits.`,
                ],
                [
                  "02",
                  "Stay in the vault",
                  `${POINTS_RULES.depositPerUsdcEpoch} point per dUSDC of vault value for every epoch you hold.`,
                ],
                [
                  "03",
                  "Trade against the house",
                  `${POINTS_RULES.lossPerUsdc} points per dUSDC of premium lost to the house on settled contracts. Losses are partly refunded in STRATA.`,
                ],
                [
                  "04",
                  "Stake for real yield",
                  "Staked STRATA earns the vault's performance fee in dUSDC.",
                ],
              ].map(([n, t, d]) => (
                <div key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{d}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <div className="notice">
            <AlertCircle size={16} />
            <p>
              Every rate drops 10% each epoch, so early activity earns the most.
              Only losses paid to the house count, which makes trading with
              yourself worthless for points. STRATA is stake-only until
              transfers are enabled. One point converts to one STRATA. Test
              deployment only.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
