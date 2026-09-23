import { useEffect, useRef, useState } from "react";
import { completeGame, finishInstall, getAdminKey, saveAdminKey, startInstall, testPocketInstall } from "./api";

function money(amount, currency) {
  return `${Number(amount).toLocaleString()} ${currency || "UGX"}`;
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function statusLabel(status) {
  if (status === "in_game") return "In game";
  if (status === "available") return "Available";
  if (status === "installing") return "Installing";
  return status;
}

export default function Admin() {
  const [floor, setFloor] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [adminKey, setAdminKey] = useState(getAdminKey());

  async function reload() {
    const response = await fetch("/overview", { headers: { "x-admin-key": getAdminKey() } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Could not load the floor");
    setFloor(payload);
    setError("");
  }

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    reload().catch((loadError) => setError(loadError.message));
    const source = new EventSource("/events");
    source.onmessage = () => {
      reloadRef.current().catch((loadError) => setError(loadError.message));
    };
    return () => source.close();
  }, []);

  async function endGame(gameId) {
    setBusyId(gameId);
    try {
      await completeGame(gameId);
      await reload();
    } catch (endError) {
      setError(endError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function runInstall(action) {
    setBusyId("install");
    try {
      await action();
      await reload();
      setError("");
    } catch (installError) {
      setError(installError.message);
    } finally {
      setBusyId(null);
    }
  }

  const summary = floor?.summary;

  return (
    <>
      <header className="top">
        <div>
          <p className="mark">Smart Pool</p>
          <h1>Floor office</h1>
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
          <button type="button" className="end-game" onClick={() => reload().catch((loadError) => setError(loadError.message))}>
            Unlock
          </button>
          <a className="nav-link" href="/">Table desk</a>
          <p className="live">{floor ? "Live floor" : error === "Admin key required" ? "Locked" : error ? "API unavailable" : "Checking the API…"}</p>
        </div>
      </header>
      <main className="admin-main">
        <section className="stats">
          <article>
            <p className="eyebrow">Tables</p>
            <strong>{summary ? summary.table_count : "–"}</strong>
          </article>
          <article>
            <p className="eyebrow">In game</p>
            <strong>{summary ? summary.in_game : "–"}</strong>
          </article>
          <article>
            <p className="eyebrow">Available</p>
            <strong>{summary ? summary.available : "–"}</strong>
          </article>
          <article>
            <p className="eyebrow">Takings</p>
            <strong>{summary ? money(summary.successful_amount) : "–"}</strong>
          </article>
        </section>

        {error ? <p className="notice" data-ok="false">{error}</p> : null}

        <section className="floor-grid">
          {(floor?.tables || []).map((table) => (
            <article key={table.id} className="floor-card">
              <div className="floor-card-head">
                <h2>{table.name}</h2>
                <span className="pill" data-status={table.status}>
                  {statusLabel(table.status)}
                </span>
              </div>
              <p className="score-total">
                {table.status === "installing"
                  ? `${table.installed_count}/6`
                  : table.score === null
                    ? "–"
                    : table.score}
              </p>
              <p className="hint">
                {table.status === "installing"
                  ? "Tap each pocket after its sensor sees a ball"
                  : table.game_id
                    ? `Game ${table.game_id} · ${table.pocket_count} pockets`
                    : table.installed_count === table.pocket_count
                      ? `${table.pocket_count} pockets fitted`
                      : `${table.pocket_count} pockets`}
              </p>
              {table.status === "installing" ? (
                <div className="pocket-fit">
                  {(table.pockets || []).map((pocket) => (
                    <button
                      key={pocket.pocket_number}
                      type="button"
                      data-installed={String(pocket.installed)}
                      disabled={busyId === "install" || pocket.installed}
                      onClick={() => runInstall(() => testPocketInstall(table.id, pocket.pocket_number))}
                    >
                      {pocket.pocket_number}
                    </button>
                  ))}
                </div>
              ) : null}
              {table.status === "available" ? (
                <button
                  type="button"
                  className="end-game"
                  disabled={busyId === "install"}
                  onClick={() => runInstall(() => startInstall(table.id))}
                >
                  Start install
                </button>
              ) : null}
              {table.status === "installing" && table.installed_count === table.pocket_count ? (
                <button
                  type="button"
                  className="end-game"
                  disabled={busyId === "install"}
                  onClick={() => runInstall(() => finishInstall(table.id))}
                >
                  Open table
                </button>
              ) : null}
              {table.game_id ? (
                <button
                  type="button"
                  className="end-game"
                  disabled={busyId === table.game_id}
                  onClick={() => endGame(table.game_id)}
                >
                  End game
                </button>
              ) : null}
            </article>
          ))}
        </section>

        <section className="desk-section">
          <h2>Recent payments</h2>
          <ul className="payments">
            {(floor?.payments || []).length === 0 ? (
              <li className="empty">No payments yet.</li>
            ) : (
              floor.payments.map((payment) => (
                <li key={payment.id}>
                  <div>
                    <p>
                      {payment.table_name} · {payment.provider.toUpperCase()}
                    </p>
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
      </main>
    </>
  );
}
