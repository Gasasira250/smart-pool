const tableName = document.querySelector("#table-name");
const gameLine = document.querySelector("#game-line");
const tableStatus = document.querySelector("#table-status");
const feltLabel = document.querySelector("#felt-label");
const endGame = document.querySelector("#end-game");
const connection = document.querySelector("#connection");
const payments = document.querySelector("#payments");
const notice = document.querySelector("#notice");
const payHint = document.querySelector("#pay-hint");
const form = document.querySelector("#pay-form");
const phoneInput = document.querySelector("#phone");
const amountInput = document.querySelector("#amount");

let activeGameId = null;

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function money(amount, currency) {
  return `${Number(amount).toLocaleString()} ${currency}`;
}

function statusLabel(status) {
  if (status === "in_game") return "In game";
  if (status === "available") return "Available";
  return status;
}

function renderTable(table) {
  tableName.textContent = table.name;
  tableStatus.textContent = statusLabel(table.status);
  tableStatus.dataset.status = table.status;
  feltLabel.textContent = `${table.pocket_count} pockets`;
}

function renderGame(game) {
  activeGameId = game ? game.id : null;
  endGame.hidden = !game;
  gameLine.textContent = game
    ? `Game ${game.id} started ${formatTime(game.started_at)}`
    : "No game on this table";
}

function renderPayments(rows) {
  payments.replaceChildren();
  if (rows.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No payments yet.";
    payments.append(item);
    return;
  }

  rows
    .slice()
    .reverse()
    .forEach((payment) => {
      const item = document.createElement("li");
      const identity = document.createElement("div");
      const title = document.createElement("p");
      const meta = document.createElement("p");
      const result = document.createElement("div");
      const amount = document.createElement("span");
      const pill = document.createElement("span");

      title.textContent = payment.provider.toUpperCase();
      meta.textContent = `${payment.phone} · ${formatTime(payment.created_at)}`;
      amount.className = "amount";
      amount.textContent = money(payment.amount, payment.currency);
      pill.className = "pill";
      pill.dataset.status = payment.status;
      pill.textContent = payment.status;

      identity.append(title, meta);
      result.append(amount, pill);
      item.append(identity, result);
      payments.append(item);
    });
}

function showNotice(message, ok) {
  notice.hidden = false;
  notice.dataset.ok = String(ok);
  notice.textContent = message;
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok && !payload.message) {
    throw new Error("The desk could not reach the API");
  }
  return payload;
}

async function refresh() {
  const [tablesResponse, gamesResponse, paymentsResponse] = await Promise.all([
    fetch("/tables"),
    fetch("/games"),
    fetch("/payments"),
  ]);
  const tablesPayload = await readJson(tablesResponse);
  const gamesPayload = await readJson(gamesResponse);
  const paymentsPayload = await readJson(paymentsResponse);
  const table = tablesPayload.tables[0];
  const game = gamesPayload.games.find((item) => item.status === "active") || null;

  renderTable(table);
  renderGame(game);
  renderPayments(paymentsPayload.payments);
  const health = await fetch("/health").then((response) => response.json());
  const live = health.payment_mode === "live";
  connection.textContent = live ? "Live MTN and Airtel" : "Simulated payments";
  payHint.textContent = live
    ? "This sends a real mobile-money prompt. The table starts after the customer approves it."
    : "No money is sent until live API keys are added. In simulation, a phone number ending in 0 is declined.";
}

async function watchPayment(id) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const response = await fetch(`/payments/${id}`);
    const payload = await readJson(response);
    if (payload.payment.status !== "pending") {
      showNotice(payload.message, payload.success === true);
      await refresh();
      return;
    }
  }
}

async function pay(provider) {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const response = await fetch("/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table_id: 1,
        provider,
        phone: phoneInput.value.trim(),
        amount: Number(amountInput.value),
      }),
    });
    const payload = await readJson(response);
    showNotice(payload.message, payload.success === true);
    await refresh();
    if (payload.payment?.status === "pending") watchPayment(payload.payment.id);
  } catch (error) {
    showNotice(error.message, false);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const provider = event.submitter?.dataset.provider || "mtn";
  pay(provider);
});

endGame.addEventListener("click", async () => {
  if (!activeGameId) return;
  endGame.disabled = true;
  try {
    const response = await fetch(`/games/${activeGameId}/complete`, { method: "POST" });
    const payload = await readJson(response);
    showNotice(payload.message, payload.success === true);
    await refresh();
  } catch (error) {
    showNotice(error.message, false);
  } finally {
    endGame.disabled = false;
  }
});

refresh().catch((error) => {
  connection.textContent = "API unavailable";
  gameLine.textContent = error.message;
});
