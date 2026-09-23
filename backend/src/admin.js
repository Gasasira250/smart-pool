const { pool } = require("./db");

async function overview() {
  const tablesResult = await pool.query(`
    SELECT
      pool_tables.id,
      pool_tables.name,
      pool_tables.status,
      COUNT(pockets.id)::int AS pocket_count,
      COUNT(pockets.installed_at)::int AS installed_count,
      active_game.id AS game_id,
      active_game.started_at
    FROM pool_tables
    LEFT JOIN pockets ON pockets.table_id = pool_tables.id
    LEFT JOIN games AS active_game
      ON active_game.table_id = pool_tables.id
      AND active_game.status = 'active'
    GROUP BY pool_tables.id, active_game.id
    ORDER BY pool_tables.id
  `);

  const pocketsResult = await pool.query(`
    SELECT table_id, pocket_number, installed_at IS NOT NULL AS installed
    FROM pockets
    ORDER BY table_id, pocket_number
  `);
  const pocketsByTable = new Map();
  for (const row of pocketsResult.rows) {
    const pockets = pocketsByTable.get(row.table_id) || [];
    pockets.push({ pocket_number: row.pocket_number, installed: row.installed });
    pocketsByTable.set(row.table_id, pockets);
  }

  const gameIds = tablesResult.rows.map((row) => row.game_id).filter(Boolean);
  const scores = new Map();
  if (gameIds.length > 0) {
    const scoreResult = await pool.query(
      `
        SELECT
          game_id,
          COALESCE(SUM(
            CASE
              WHEN ball_label ~ '^[0-9]+$' THEN ball_label::integer
              ELSE 0
            END
          ), 0)::int AS total
        FROM pocket_events
        WHERE game_id = ANY($1::int[])
        GROUP BY game_id
      `,
      [gameIds]
    );
    for (const row of scoreResult.rows) scores.set(row.game_id, row.total);
  }

  const summaryResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'successful')::int AS successful_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'successful'), 0)::int AS successful_amount,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
    FROM payments
  `);

  const paymentsResult = await pool.query(`
    SELECT
      payments.id,
      payments.table_id,
      pool_tables.name AS table_name,
      payments.provider,
      payments.phone,
      payments.amount,
      payments.currency,
      payments.status,
      payments.created_at
    FROM payments
    JOIN pool_tables ON pool_tables.id = payments.table_id
    ORDER BY payments.id DESC
    LIMIT 8
  `);

  const tables = tablesResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    pocket_count: row.pocket_count,
    installed_count: row.installed_count,
    pockets: pocketsByTable.get(row.id) || [],
    game_id: row.game_id,
    started_at: row.started_at,
    score: row.game_id ? scores.get(row.game_id) || 0 : null,
  }));

  return {
    summary: {
      table_count: tables.length,
      in_game: tables.filter((table) => table.status === "in_game").length,
      available: tables.filter((table) => table.status === "available").length,
      installing: tables.filter((table) => table.status === "installing").length,
      ...summaryResult.rows[0],
    },
    tables,
    payments: paymentsResult.rows,
  };
}

module.exports = { overview };
