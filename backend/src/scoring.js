const { pool } = require("./db");
const { publish } = require("./live");

const NUMBERED_BALLS = new Set(Array.from({ length: 15 }, (_, index) => String(index + 1)));

function pointsFor(ballLabel) {
  if (ballLabel === "cue") return 0;
  return Number(ballLabel);
}

function readPocketRequest(body) {
  const pocketNumber = Number(body.pocket_number);
  const ballLabel = String(body.ball_label || "").trim().toLowerCase();
  if (!Number.isInteger(pocketNumber) || pocketNumber < 1 || pocketNumber > 6) {
    const error = new Error("pocket_number must be from 1 to 6");
    error.statusCode = 400;
    throw error;
  }
  if (ballLabel !== "cue" && !NUMBERED_BALLS.has(ballLabel)) {
    const error = new Error("ball_label must be cue or a ball from 1 to 15");
    error.statusCode = 400;
    throw error;
  }
  const clientEventId = body.client_event_id
    ? String(body.client_event_id).trim().slice(0, 80)
    : null;
  let recordedAt = new Date();
  if (body.recorded_at) {
    recordedAt = new Date(body.recorded_at);
    if (Number.isNaN(recordedAt.getTime())) {
      const error = new Error("recorded_at must be a valid time");
      error.statusCode = 400;
      throw error;
    }
  }
  return { pocketNumber, ballLabel, clientEventId, recordedAt };
}

async function gameScore(gameId) {
  const result = await pool.query(
    `
      SELECT
        pocket_events.id,
        pocket_events.ball_label,
        pocket_events.recorded_at,
        pockets.pocket_number
      FROM pocket_events
      JOIN pockets ON pockets.id = pocket_events.pocket_id
      WHERE pocket_events.game_id = $1
      ORDER BY pocket_events.id
    `,
    [gameId]
  );
  const pockets = result.rows.map((row) => ({
    ...row,
    points: pointsFor(row.ball_label),
  }));
  const total = pockets.reduce((sum, row) => sum + row.points, 0);
  return { game_id: gameId, total, pockets };
}

async function recordPocket(gameId, body) {
  const { pocketNumber, ballLabel, clientEventId, recordedAt } = readPocketRequest(body);
  const client = await pool.connect();
  let alreadySaved = false;
  try {
    await client.query("BEGIN");
    const gameResult = await client.query(
      "SELECT id, table_id, status FROM games WHERE id = $1 FOR UPDATE",
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

    const pocketResult = await client.query(
      "SELECT id FROM pockets WHERE table_id = $1 AND pocket_number = $2",
      [game.table_id, pocketNumber]
    );
    if (pocketResult.rowCount === 0) {
      const error = new Error("That pocket is not on this table");
      error.statusCode = 404;
      throw error;
    }

    if (clientEventId) {
      const existing = await client.query(
        "SELECT 1 FROM pocket_events WHERE client_event_id = $1",
        [clientEventId]
      );
      if (existing.rowCount > 0) alreadySaved = true;
    }

    if (!alreadySaved && ballLabel !== "cue") {
      const duplicate = await client.query(
        "SELECT 1 FROM pocket_events WHERE game_id = $1 AND ball_label = $2",
        [gameId, ballLabel]
      );
      if (duplicate.rowCount > 0) {
        const error = new Error(`Ball ${ballLabel} is already pocketed in this game`);
        error.statusCode = 409;
        throw error;
      }
    }

    if (!alreadySaved) {
      await client.query(
        `
          INSERT INTO pocket_events (game_id, pocket_id, ball_label, recorded_at, client_event_id)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [gameId, pocketResult.rows[0].id, ballLabel, recordedAt, clientEventId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const score = await gameScore(gameId);
  if (alreadySaved) return score;
  const latest = score.pockets[score.pockets.length - 1];
  publish({
    type: "pocket",
    game_id: gameId,
    ball_label: latest.ball_label,
    pocket_number: latest.pocket_number,
    points: latest.points,
    total: score.total,
  });
  return score;
}

async function syncPockets(events) {
  const results = [];
  for (const event of events) {
    const gameId = Number(event.game_id);
    try {
      const score = await recordPocket(gameId, event);
      results.push({
        client_event_id: event.client_event_id || null,
        success: true,
        total: score.total,
      });
    } catch (error) {
      results.push({
        client_event_id: event.client_event_id || null,
        success: false,
        message: error.message,
      });
    }
  }
  return results;
}

module.exports = { gameScore, recordPocket, syncPockets };
