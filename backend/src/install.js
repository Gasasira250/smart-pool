const { pool } = require("./db");
const { publish } = require("./live");

async function loadInstall(tableId) {
  const result = await pool.query(
    `
      SELECT
        pool_tables.id,
        pool_tables.name,
        pool_tables.status,
        pockets.pocket_number,
        pockets.installed_at
      FROM pool_tables
      JOIN pockets ON pockets.table_id = pool_tables.id
      WHERE pool_tables.id = $1
      ORDER BY pockets.pocket_number
    `,
    [tableId]
  );
  if (result.rowCount === 0) {
    const error = new Error("Pool table not found");
    error.statusCode = 404;
    throw error;
  }
  const first = result.rows[0];
  return {
    id: first.id,
    name: first.name,
    status: first.status,
    pockets: result.rows.map((row) => ({
      pocket_number: row.pocket_number,
      installed: Boolean(row.installed_at),
    })),
  };
}

function refuseUnlessInstalling(table) {
  if (table.status === "installing") return;
  const error = new Error(`${table.name} is not in installation`);
  error.statusCode = 409;
  throw error;
}

async function startInstall(tableId) {
  const current = await loadInstall(tableId);
  if (current.status === "in_game") {
    const error = new Error(`${current.name} has a game in progress`);
    error.statusCode = 409;
    throw error;
  }
  if (current.status !== "installing") {
    await pool.query("UPDATE pool_tables SET status = 'installing' WHERE id = $1", [tableId]);
  }
  publish({ type: "install", table_id: tableId });
  return loadInstall(tableId);
}

async function testPocket(tableId, pocketNumber) {
  const current = await loadInstall(tableId);
  refuseUnlessInstalling(current);
  const updated = await pool.query(
    `
      UPDATE pockets
      SET installed_at = COALESCE(installed_at, NOW())
      WHERE table_id = $1 AND pocket_number = $2
      RETURNING pocket_number
    `,
    [tableId, pocketNumber]
  );
  if (updated.rowCount === 0) {
    const error = new Error("That pocket is not on this table");
    error.statusCode = 404;
    throw error;
  }
  publish({ type: "install", table_id: tableId, pocket_number: pocketNumber });
  return loadInstall(tableId);
}

async function finishInstall(tableId) {
  const current = await loadInstall(tableId);
  refuseUnlessInstalling(current);
  const missing = current.pockets.filter((pocket) => !pocket.installed).map((pocket) => pocket.pocket_number);
  if (missing.length > 0) {
    const error = new Error(`${current.name} still needs pocket ${missing.join(", ")}`);
    error.statusCode = 409;
    throw error;
  }
  await pool.query("UPDATE pool_tables SET status = 'available' WHERE id = $1", [tableId]);
  publish({ type: "install", table_id: tableId, status: "available" });
  return loadInstall(tableId);
}

module.exports = { startInstall, testPocket, finishInstall };
