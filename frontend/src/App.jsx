import { useEffect, useRef, useState } from "react";
import {
  completeGame,
  createPayment,
  flushQueuedPockets,
  getAdminKey,
  loadDesk,
  loadScore,
  queuePocket,
  queuedPockets,
  recordPocket,
  refreshPayment,
  saveAdminKey,
} from "./api";

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function money(amount, currency) {
  return `${Number(amount).toLocaleString()} ${currency}`;
}

function statusLabel(status) {
  if (status === "in_game") return "In game";
  if (status === "available") return "Available";
  if (status === "installing") return "Installing";
  return status;
}

export default function App() {
  const [tables, setTables] = useState([]);
  const [games, setGames] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [score, setScore] = useState(null);
  const [pocketNumber, setPocketNumber] = useState("1");
  const [ballLabel, setBallLabel] = useState("1");
  const [payments, setPayments] = useState([]);
  const [paymentMode, setPaymentMode] = useState("simulate");
  const [phone, setPhone] = useState("0772123456");
  const [amount, setAmount] = useState("5000");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState("");
  const [adminKey, setAdminKey] = useState(getAdminKey());
  const [queuedCount, setQueuedCount] = useState(queuedPockets().length);
  const [scoreNonce, setScoreNonce] = useState(0);

  const table = tables.find((item) => item.id === selectedId) || tables[0] || null;
  const game = games.find((item) => item.status === "active" && item.table_id === table?.id) || null;
  const visiblePayments = payments.filter((item) => item.table_id === table?.id);

  async function reload() {
    const desk = await loadDesk();
    setTables(desk.tables);
    setGames(desk.games);
    setPayments(desk.payments);
    setPaymentMode(desk.paymentMode || "simulate");
    setSelectedId((current) => current ?? desk.tables[0]?.id ?? null);
    setError("");
  }

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    reload().catch((loadError) => setError(loadError.message));
    const source = new EventSource("/events");
    source.onmessage = () => {
      reloadRef.current().catch((loadError) => setError(loadError.message));
      setScoreNonce((nonce) => nonce + 1);
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    async function syncQueue() {
      const left = await flushQueuedPockets();
      setQueuedCount(left);
      if (left < queuedCount) {
        reloadRef.current().catch(() => {});
        setScoreNonce((nonce) => nonce + 1);
      }
    }
    syncQueue().catch(() => {});
    const timer = setInterval(() => {
      syncQueue().catch(() => {});
    }, 5000);
    window.addEventListener("online", syncQueue);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", syncQueue);
    };
  }, [queuedCount]);

  useEffect(() => {
    if (!game) {
      setScore(null);
      return undefined;
    }
    let cancelled = false;
    loadScore(game.id)
      .then((nextScore) => {
        if (!cancelled) setScore(nextScore);
      })
      .catch((scoreError) => {
        if (!cancelled) setError(scoreError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [game?.id, scoreNonce]);

  useEffect(() => {
    if (!pendingId) return undefined;
    const timer = setInterval(async () => {
      try {
        const payload = await refreshPayment(pendingId);
        if (payload.payment.status === "pending") return;
        setNotice({ message: payload.message, ok: payload.success === true });
        setPendingId(null);
        await reload();
      } catch (pollError) {
        setNotice({ message: pollError.message, ok: false });
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [pendingId]);

  async function pay(provider) {
    setBusy(true);
    try {
      const payload = await createPayment({
        table_id: table?.id || 1,
        provider,
        phone: phone.trim(),
        amount: Number(amount),
      });
      setNotice({ message: payload.message, ok: payload.success === true });
      await reload();
      if (payload.payment?.status === "pending") setPendingId(payload.payment.id);
    } catch (payError) {
      setNotice({ message: payError.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function pocketBall(event) {
    event.preventDefault();
    if (!game) return;
    setBusy(true);
    try {
      const payload = await recordPocket(game.id, {
        pocket_number: Number(pocketNumber),
        ball_label: ballLabel,
      });
      setNotice({ message: payload.message, ok: true });
      setScore(payload.score);
    } catch (pocketError) {
      if (pocketError.offline) {
        const waiting = queuePocket(game.id, {
          pocket_number: Number(pocketNumber),
          ball_label: ballLabel,
        });
        setQueuedCount(waiting);
      }
      setNotice({ message: pocketError.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function endGame() {
    if (!game) return;
    setBusy(true);
    try {
      const payload = await completeGame(game.id);
      setNotice({ message: payload.message, ok: payload.success === true });
      await reload();
    } catch (endError) {
      setNotice({ message: endError.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  const live = paymentMode === "live";
  const hint = live
    ? "This sends a real mobile-money prompt. The table starts after the customer approves it."
    : "No money is sent until live API keys are added. In simulation, a phone number ending in 0 is declined.";

  return (
    <>
      <header className="top">
        <div>
          <p className="mark">Smart Pool</p>
          <h1>Table desk</h1>
        </div>
        <div className="header-side">
          <label className="key-field">
            Admin key
            <input
              type="password"
              value={adminKey}
              autoComplete="off"
              onChange={(event) => {
                setAdminKey(event.target.value);
                saveAdminKey(event.target.value);
              }}
            />
          </label>
          <a className="nav-link" href="/admin">Admin</a>
          <p className="live">
            {error ? "API unavailable" : table ? (live ? "Live MTN and Airtel" : "Simulated payments") : "Checking the API…"}
          </p>
        </div>
      </header>
      {queuedCount > 0 ? (
        <p className="offline-banner">
          Offline queue: {queuedCount} ball{queuedCount === 1 ? "" : "s"} waiting to sync.
        </p>
      ) : null}
      <main>
        <section className="table-panel" aria-live="polite">
          <div className="table-switch">
            {tables.map((item) => (
              <button
                key={item.id}
                type="button"
                className="table-chip"
                data-active={String(item.id === table?.id)}
                onClick={() => {
                  setSelectedId(item.id);
                  setNotice(null);
                }}
              >
                {item.name}
                <span>{statusLabel(item.status)}</span>
              </button>
            ))}
          </div>
          <div className="table-copy">
            <p className="eyebrow">Floor</p>
            <h2>{table?.name || "Table"}</h2>
            <p>
              {error ||
                (game
                  ? `Game ${game.id} started ${formatTime(game.started_at)}`
                  : table
                    ? "No game on this table"
                    : "Loading the table…")}
            </p>
            <div className="actions">
              <span className="pill" data-status={table?.status || "available"}>
                {table ? statusLabel(table.status) : "Available"}
              </span>
              {game ? (
                <button type="button" className="end-game" onClick={endGame} disabled={busy}>
                  End game
                </button>
              ) : null}
            </div>
          </div>
          {game ? (
            <form className="score-board" onSubmit={pocketBall}>
              <p className="eyebrow">Score</p>
              <p className="score-total">{score?.total ?? 0}</p>
              <label>
                Pocket
                <select value={pocketNumber} onChange={(event) => setPocketNumber(event.target.value)}>
                  {["1", "2", "3", "4", "5", "6"].map((number) => (
                    <option key={number} value={number}>
                      {number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ball
                <select value={ballLabel} onChange={(event) => setBallLabel(event.target.value)}>
                  {Array.from({ length: 15 }, (_, index) => String(index + 1)).map((ball) => (
                    <option key={ball} value={ball}>
                      {ball}
                    </option>
                  ))}
                  <option value="cue">Cue</option>
                </select>
              </label>
              <button type="submit" className="end-game" disabled={busy}>
                Pocket ball
              </button>
              <ul className="score-list">
                {(score?.pockets || []).map((pocket) => (
                  <li key={pocket.id}>
                    Ball {pocket.ball_label} in pocket {pocket.pocket_number} · {pocket.points} pts
                  </li>
                ))}
              </ul>
            </form>
          ) : null}
          <div className="rail" aria-hidden="true">
            <div className="felt">
              <span className="pocket corner tl" />
              <span className="pocket side top" />
              <span className="pocket corner tr" />
              <span className="pocket corner bl" />
              <span className="pocket side bottom" />
              <span className="pocket corner br" />
              <p className="felt-label">{table ? `${table.pocket_count} pockets` : "6 pockets"}</p>
            </div>
          </div>
        </section>

        <section className="desk">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const provider = event.nativeEvent.submitter?.dataset.provider || "mtn";
              pay(provider);
            }}
          >
            <p className="eyebrow">{live ? "Live payment" : "Simulated payment"}</p>
            <h2>Take money for a game</h2>
            <p className="hint">{hint}</p>
            <label>
              Phone
              <input
                value={phone}
                inputMode="numeric"
                autoComplete="off"
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <label>
              Amount (UGX)
              <input
                value={amount}
                inputMode="numeric"
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <div className="pay-buttons">
              <button type="submit" className="mtn" data-provider="mtn" disabled={busy || !table}>
                Pay with MTN
              </button>
              <button type="submit" className="airtel" data-provider="airtel" disabled={busy || !table}>
                Pay with Airtel
              </button>
            </div>
            {notice ? (
              <p className="notice" data-ok={String(notice.ok)}>
                {notice.message}
              </p>
            ) : null}
          </form>

          <section>
            <div className="section-head">
              <h2>Payments</h2>
            </div>
            <ul className="payments">
              {visiblePayments.length === 0 ? (
                <li className="empty">No payments for this table yet.</li>
              ) : (
                [...visiblePayments].reverse().map((payment) => (
                  <li key={payment.id}>
                    <div>
                      <p>{payment.provider.toUpperCase()}</p>
                      <p>
                        {payment.phone} · {formatTime(payment.created_at)}
                      </p>
                    </div>
                    <div>
                      <span className="amount">{money(payment.amount, payment.currency)}</span>
                      <span className="pill" data-status={payment.status}>
                        {payment.status}
                      </span>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>
        </section>
      </main>
    </>
  );
}
