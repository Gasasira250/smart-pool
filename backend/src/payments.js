const { randomUUID } = require("crypto");
const { pool } = require("./db");
const providers = require("./providers");
const { publish } = require("./live");

const PROVIDERS = ["mtn", "airtel"];

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

const paymentColumns = `
  payments.id,
  payments.table_id,
  pool_tables.name AS table_name,
  payments.game_id,
  payments.provider,
  payments.phone,
  payments.amount,
  payments.currency,
  payments.status,
  payments.mode,
  payments.reason,
  payments.reference,
  payments.created_at
`;

function buildReference(provider) {
  if (providers.paymentMode() === "live" && provider === "mtn") {
    return randomUUID();
  }
  if (providers.paymentMode() === "live") {
    return randomUUID().replace(/-/g, "").slice(0, 20);
  }
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SIM-${provider.toUpperCase()}-${suffix}`;
}

function paymentMessage(payment) {
  if (payment.status === "pending") {
    return "Payment request sent. Approve it on the phone. The table starts when the payment succeeds.";
  }
  if (payment.status === "failed") {
    return payment.mode === "live"
      ? payment.reason || "The mobile-money payment was declined."
      : "Payment was declined. No money moved, and no game was started.";
  }
  return payment.mode === "live"
    ? "Payment received. The table is now in a game."
    : "Simulated payment succeeded. The table is now in a game.";
}

function readPaymentRequest(body) {
  const tableId = Number(body.table_id);
  const provider = String(body.provider || "").trim().toLowerCase();
  const phone = String(body.phone || "").replace(/\s+/g, "");
  const amount = Number(body.amount);

  if (!Number.isInteger(tableId) || tableId < 1) {
    throw validationError("table_id must be a positive whole number");
  }
  if (!PROVIDERS.includes(provider)) {
    throw validationError("provider must be mtn or airtel");
  }
  if (!/^\d{10,12}$/.test(phone)) {
    throw validationError("phone must be 10 to 12 digits, such as 0772123456");
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw validationError("amount must be a positive whole number of shillings");
  }

  return { tableId, provider, phone, amount };
}

async function loadPayment(id, client = pool) {
  const result = await client.query(
    `
      SELECT ${paymentColumns}
      FROM payments
      JOIN pool_tables ON pool_tables.id = payments.table_id
      WHERE payments.id = $1
    `,
    [id]
  );
  return result.rows[0] || null;
}

async function startGameForPayment(client, payment) {
  const tableResult = await client.query(
    "SELECT id, name, status FROM pool_tables WHERE id = $1 FOR UPDATE",
    [payment.table_id]
  );
  const table = tableResult.rows[0];
  if (!table || table.status !== "available") {
    await client.query(
      "UPDATE payments SET status = 'successful', reason = $2 WHERE id = $1",
      [payment.id, "Paid, but the table was already in use"]
    );
    return loadPayment(payment.id, client);
  }

  const game = await client.query(
    "INSERT INTO games (table_id) VALUES ($1) RETURNING id",
    [payment.table_id]
  );
  await client.query("UPDATE pool_tables SET status = 'in_game' WHERE id = $1", [
    payment.table_id,
  ]);
  await client.query(
    "UPDATE payments SET status = 'successful', game_id = $2, reason = NULL WHERE id = $1",
    [payment.id, game.rows[0].id]
  );
  return loadPayment(payment.id, client);
}

async function applyProviderResult(paymentId, result) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, table_id, status FROM payments WHERE id = $1 FOR UPDATE",
      [paymentId]
    );
    const payment = current.rows[0];
    if (!payment || payment.status !== "pending") {
      await client.query("COMMIT");
      return loadPayment(paymentId);
    }

    if (result.status === "successful") {
      const updated = await startGameForPayment(client, payment);
      await client.query("COMMIT");
      publish({ type: "game", status: "active", table_id: payment.table_id });
      return updated;
    }

    if (result.status === "failed") {
      await client.query(
        "UPDATE payments SET status = 'failed', reason = $2 WHERE id = $1",
        [paymentId, result.reason]
      );
    }

    await client.query("COMMIT");
    return loadPayment(paymentId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function refreshPayment(id) {
  const payment = await loadPayment(id);
  if (!payment) {
    const error = new Error("Payment not found");
    error.statusCode = 404;
    throw error;
  }
  if (payment.status !== "pending" || payment.mode !== "live") return payment;

  const result = await providers.getStatus(payment.provider, payment.reference);
  if (result.status === "pending") return payment;
  return applyProviderResult(payment.id, result);
}

async function createPayment(body) {
  const request = readPaymentRequest(body);
  if (providers.paymentMode() === "live") return createLivePayment(request);
  return createSimulatedPayment(request);
}

async function createSimulatedPayment({ tableId, provider, phone, amount }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const tableResult = await client.query(
      "SELECT id, name, status FROM pool_tables WHERE id = $1 FOR UPDATE",
      [tableId]
    );
    if (tableResult.rowCount === 0) {
      const error = new Error("Pool table not found");
      error.statusCode = 404;
      throw error;
    }

    const table = tableResult.rows[0];
    if (table.status === "installing") {
      const error = new Error(`${table.name} is being installed`);
      error.statusCode = 409;
      throw error;
    }
    if (table.status !== "available") {
      const error = new Error(`${table.name} is already in use`);
      error.statusCode = 409;
      throw error;
    }

    const declined = phone.endsWith("0");
    let gameId = null;
    if (!declined) {
      const game = await client.query(
        "INSERT INTO games (table_id) VALUES ($1) RETURNING id",
        [tableId]
      );
      gameId = game.rows[0].id;
      await client.query(
        "UPDATE pool_tables SET status = 'in_game' WHERE id = $1",
        [tableId]
      );
    }

    const inserted = await client.query(
      `
        INSERT INTO payments (
          table_id, game_id, provider, phone, amount, status, mode, reason, reference
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'simulated', $7, $8)
        RETURNING id
      `,
      [
        tableId,
        gameId,
        provider,
        phone,
        amount,
        declined ? "failed" : "successful",
        declined ? "Simulated insufficient balance" : null,
        buildReference(provider),
      ]
    );

    await client.query("COMMIT");
    publish({ type: "game", status: gameId ? "active" : "payment", table_id: tableId });
    return loadPayment(inserted.rows[0].id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createLivePayment({ tableId, provider, phone, amount }) {
  const missing = providers.missingSettings(provider);
  if (missing.length > 0) {
    const error = new Error(
      `Live ${provider.toUpperCase()} payments need these values in backend/.env: ${missing.join(", ")}`
    );
    error.statusCode = 503;
    throw error;
  }

  const client = await pool.connect();
  let paymentId = null;
  try {
    await client.query("BEGIN");
    const tableResult = await client.query(
      "SELECT id, name, status FROM pool_tables WHERE id = $1 FOR UPDATE",
      [tableId]
    );
    if (tableResult.rowCount === 0) {
      const error = new Error("Pool table not found");
      error.statusCode = 404;
      throw error;
    }
    const table = tableResult.rows[0];
    if (table.status === "installing") {
      const error = new Error(`${table.name} is being installed`);
      error.statusCode = 409;
      throw error;
    }
    if (table.status !== "available") {
      const error = new Error(`${table.name} is already in use`);
      error.statusCode = 409;
      throw error;
    }

    const pending = await client.query(
      "SELECT 1 FROM payments WHERE table_id = $1 AND status = 'pending'",
      [tableId]
    );
    if (pending.rowCount > 0) {
      const error = new Error(`${table.name} already has a payment waiting for approval`);
      error.statusCode = 409;
      throw error;
    }

    const inserted = await client.query(
      `
        INSERT INTO payments (
          table_id, provider, phone, amount, status, mode, reference
        )
        VALUES ($1, $2, $3, $4, 'pending', 'live', $5)
        RETURNING id
      `,
      [tableId, provider, phone, amount, buildReference(provider)]
    );
    paymentId = inserted.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const payment = await loadPayment(paymentId);
  try {
    const result = await providers.requestToPay({
      provider,
      phone,
      amount,
      reference: payment.reference,
      externalId: payment.id,
    });
    if (result.status === "failed") return applyProviderResult(payment.id, result);
    return payment;
  } catch (error) {
    await applyProviderResult(payment.id, {
      status: "failed",
      reason: error.message,
    });
    throw error;
  }
}

async function listPayments() {
  const pending = await pool.query(
    "SELECT id FROM payments WHERE status = 'pending' AND mode = 'live'"
  );
  for (const row of pending.rows) {
    try {
      await refreshPayment(row.id);
    } catch (error) {
      console.error("Could not refresh payment", row.id, error.message);
    }
  }

  const result = await pool.query(`
    SELECT ${paymentColumns}
    FROM payments
    JOIN pool_tables ON pool_tables.id = payments.table_id
    ORDER BY payments.id
  `);
  return result.rows;
}

async function listGames() {
  const result = await pool.query(`
    SELECT
      games.id,
      games.table_id,
      pool_tables.name AS table_name,
      games.status,
      games.started_at,
      games.ended_at
    FROM games
    JOIN pool_tables ON pool_tables.id = games.table_id
    ORDER BY games.id
  `);
  return result.rows;
}

async function completeGame(gameId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gameResult = await client.query(
      `
        SELECT games.id, games.table_id, games.status, pool_tables.name AS table_name
        FROM games
        JOIN pool_tables ON pool_tables.id = games.table_id
        WHERE games.id = $1
        FOR UPDATE
      `,
      [gameId]
    );
    if (gameResult.rowCount === 0) {
      const error = new Error("Game not found");
      error.statusCode = 404;
      throw error;
    }

    const game = gameResult.rows[0];
    if (game.status !== "active") {
      const error = new Error("That game is already finished");
      error.statusCode = 409;
      throw error;
    }

    await client.query(
      `
        UPDATE games
        SET status = 'completed', ended_at = NOW()
        WHERE id = $1
      `,
      [gameId]
    );
    await client.query(
      "UPDATE pool_tables SET status = 'available' WHERE id = $1",
      [game.table_id]
    );
    await client.query("COMMIT");
    publish({ type: "game", status: "completed", game_id: game.id, table_id: game.table_id });
    return { id: game.id, table_id: game.table_id, table_name: game.table_name, status: "completed" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createPayment,
  paymentMessage,
  refreshPayment,
  listPayments,
  listGames,
  completeGame,
};
