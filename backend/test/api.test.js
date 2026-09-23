const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const app = require("../src/server");
const { pool } = require("../src/db");

let server;
let base;

async function api(path, { method = "GET", body, admin = false, rawBody = null } = {}) {
  const headers = {};
  if (body || rawBody) headers["Content-Type"] = "application/json";
  if (admin) headers["x-admin-key"] = process.env.ADMIN_KEY;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody || (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload, headers: response.headers };
}

async function floorTables() {
  const result = await pool.query(`
    SELECT
      pool_tables.id,
      pool_tables.name,
      pool_tables.status,
      COUNT(pockets.installed_at)::int AS installed_count
    FROM pool_tables
    LEFT JOIN pockets ON pockets.table_id = pool_tables.id
    GROUP BY pool_tables.id
    ORDER BY pool_tables.id
  `);
  return result.rows;
}

function spareTable(tables, usedIds) {
  return tables.find(
    (table) =>
      table.status === "available" &&
      table.installed_count === 0 &&
      !usedIds.has(table.id)
  );
}

before(async () => {
  assert.ok(process.env.ADMIN_KEY, "ADMIN_KEY is missing from backend/.env");
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe("security", () => {
  it("answers health JSON and sends security headers", async () => {
    const response = await api("/health");
    assert.equal(response.status, 200);
    assert.equal(response.payload.success, true);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  it("locks the floor office, sync, and ending a game", async () => {
    const overview = await api("/overview");
    assert.equal(overview.status, 401);
    assert.equal(overview.payload.message, "Admin key required");

    const opened = await api("/overview", { admin: true });
    assert.equal(opened.status, 200);
    assert.equal(opened.payload.success, true);
    assert.ok(opened.payload.summary.table_count >= 1);

    const sync = await api("/sync", { method: "POST", body: { events: [{ game_id: 1 }] } });
    assert.equal(sync.status, 401);

    const ended = await api("/games/2/complete", { method: "POST" });
    assert.equal(ended.status, 401);
  });

  it("rejects a payment body that is not JSON", async () => {
    const response = await api("/payments", { method: "POST", rawBody: "{" });
    assert.equal(response.status, 400);
    assert.equal(response.payload.message, "Request body must be valid JSON");
  });

  it("slows a pocket route after 30 calls in a minute", async () => {
    let last = null;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      last = await api("/games/999999/pockets", {
        method: "POST",
        body: { pocket_number: 1, ball_label: "1" },
      });
    }
    assert.equal(last.status, 429);
    assert.match(last.payload.message, /Too many requests/);
  });
});

describe("installation", () => {
  it("fits six pockets before the table can take money", async () => {
    const tables = await floorTables();
    const table = spareTable(tables, new Set());
    assert.ok(table, "Need an available table with no pockets fitted");

    try {
      const locked = await api(`/tables/${table.id}/install`, { method: "POST" });
      assert.equal(locked.status, 401);

      const started = await api(`/tables/${table.id}/install`, { method: "POST", admin: true });
      assert.equal(started.status, 200);
      assert.equal(started.payload.table.status, "installing");

      const blocked = await api("/payments", {
        method: "POST",
        body: { table_id: table.id, provider: "mtn", phone: "0772000001", amount: 1000 },
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.payload.message, /being installed/);

      const early = await api(`/tables/${table.id}/ready`, { method: "POST", admin: true });
      assert.equal(early.status, 409);
      assert.match(early.payload.message, /still needs pocket/);

      for (let pocket = 1; pocket <= 6; pocket += 1) {
        const tested = await api(`/tables/${table.id}/pockets/${pocket}/test`, {
          method: "POST",
          admin: true,
        });
        assert.equal(tested.status, 200);
        assert.equal(
          tested.payload.table.pockets.filter((item) => item.installed).length,
          pocket
        );
      }

      const ready = await api(`/tables/${table.id}/ready`, { method: "POST", admin: true });
      assert.equal(ready.status, 200);
      assert.equal(ready.payload.table.status, "available");
    } finally {
      await pool.query("UPDATE pockets SET installed_at = NULL WHERE table_id = $1", [table.id]);
      await pool.query(
        "UPDATE pool_tables SET status = 'available' WHERE id = $1 AND status = 'installing'",
        [table.id]
      );
    }
  });

  it("refuses installation on a table that has a game", async () => {
    const tables = await floorTables();
    const busy = tables.find((table) => table.status === "in_game");
    assert.ok(busy, "Need one table in a game");
    const response = await api(`/tables/${busy.id}/install`, { method: "POST", admin: true });
    assert.equal(response.status, 409);
    assert.match(response.payload.message, /game in progress/);
  });
});

describe("a paid game", () => {
  it("scores a pocket once, syncs a retry, and ends the game", async () => {
    const tables = await floorTables();
    const table = spareTable(tables, new Set());
    assert.ok(table, "Need an available table with no pockets fitted");
    const paymentIds = [];
    let gameId = null;

    try {
      const declined = await api("/payments", {
        method: "POST",
        body: { table_id: table.id, provider: "airtel", phone: "0772000000", amount: 1500 },
      });
      assert.equal(declined.status, 402);
      assert.equal(declined.payload.payment.status, "failed");
      paymentIds.push(declined.payload.payment.id);

      const paid = await api("/payments", {
        method: "POST",
        body: { table_id: table.id, provider: "mtn", phone: "0772000001", amount: 2000 },
      });
      assert.equal(paid.status, 201);
      assert.equal(paid.payload.payment.status, "successful");
      gameId = paid.payload.payment.game_id;
      paymentIds.push(paid.payload.payment.id);
      assert.ok(gameId);

      const again = await api("/payments", {
        method: "POST",
        body: { table_id: table.id, provider: "mtn", phone: "0772000002", amount: 2000 },
      });
      assert.equal(again.status, 409);

      const pocket = await api(`/games/${gameId}/pockets`, {
        method: "POST",
        body: { pocket_number: 3, ball_label: "7" },
      });
      assert.equal(pocket.status, 201);
      assert.equal(pocket.payload.score.total, 7);

      const duplicate = await api(`/games/${gameId}/pockets`, {
        method: "POST",
        body: { pocket_number: 1, ball_label: "7" },
      });
      assert.equal(duplicate.status, 409);
      assert.match(duplicate.payload.message, /already pocketed/);

      const eventId = `test-${gameId}-ball-4`;
      const synced = await api("/sync", {
        method: "POST",
        admin: true,
        body: {
          events: [
            {
              game_id: gameId,
              pocket_number: 2,
              ball_label: "4",
              client_event_id: eventId,
              recorded_at: new Date().toISOString(),
            },
          ],
        },
      });
      assert.equal(synced.status, 200);
      assert.equal(synced.payload.results[0].success, true);
      assert.equal(synced.payload.results[0].total, 11);

      const replay = await api(`/games/${gameId}/pockets`, {
        method: "POST",
        body: {
          pocket_number: 2,
          ball_label: "4",
          client_event_id: eventId,
        },
      });
      assert.equal(replay.status, 201);
      assert.equal(replay.payload.score.total, 11);
      assert.equal(replay.payload.score.pockets.length, 2);

      const locked = await api(`/games/${gameId}/complete`, { method: "POST" });
      assert.equal(locked.status, 401);

      const ended = await api(`/games/${gameId}/complete`, { method: "POST", admin: true });
      assert.equal(ended.status, 200);
      assert.equal(ended.payload.game.status, "completed");

      const late = await api(`/games/${gameId}/pockets`, {
        method: "POST",
        body: { pocket_number: 1, ball_label: "1" },
      });
      assert.equal(late.status, 409);
    } finally {
      if (gameId) {
        await pool.query("DELETE FROM pocket_events WHERE game_id = $1", [gameId]);
        await pool.query("DELETE FROM payments WHERE game_id = $1 OR id = ANY($2::int[])", [
          gameId,
          paymentIds,
        ]);
        await pool.query("DELETE FROM games WHERE id = $1", [gameId]);
      } else if (paymentIds.length > 0) {
        await pool.query("DELETE FROM payments WHERE id = ANY($1::int[])", [paymentIds]);
      }
      await pool.query(
        `
          UPDATE pool_tables
          SET status = 'available'
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM games WHERE table_id = $1 AND status = 'active'
            )
        `,
        [table.id]
      );
    }
  });
});
