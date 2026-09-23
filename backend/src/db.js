const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "smart_pool",
  user: process.env.PGUSER || "smart_pool",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});

async function checkConnection() {
  const result = await pool.query("SELECT current_database() AS database");
  return result.rows[0].database;
}

async function listTables() {
  const result = await pool.query(`
    SELECT
      pool_tables.id,
      pool_tables.name,
      pool_tables.status,
      pool_tables.created_at,
      COUNT(pockets.id)::int AS pocket_count
    FROM pool_tables
    LEFT JOIN pockets ON pockets.table_id = pool_tables.id
    GROUP BY pool_tables.id
    ORDER BY pool_tables.id
  `);
  return result.rows;
}

module.exports = { pool, checkConnection, listTables };
