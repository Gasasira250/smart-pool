const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config();

const connection = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  connectionTimeoutMillis: 5000,
};

function quoteLiteral(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Refusing to use a database password with unsupported characters");
  }
  return `'${value}'`;
}

async function createRoleAndDatabase() {
  const admin = new Client({
    ...connection,
    user: "postgres",
    database: "postgres",
  });
  await admin.connect();

  const password = quoteLiteral(process.env.PGPASSWORD || "");
  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'smart_pool'");
  if (role.rowCount === 0) {
    await admin.query(`CREATE ROLE smart_pool LOGIN PASSWORD ${password}`);
  } else {
    await admin.query(`ALTER ROLE smart_pool WITH LOGIN PASSWORD ${password}`);
  }

  const database = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = 'smart_pool'"
  );
  if (database.rowCount === 0) {
    await admin.query("CREATE DATABASE smart_pool OWNER smart_pool");
  }

  await admin.end();
}

async function applySchema() {
  const client = new Client({
    ...connection,
    database: process.env.PGDATABASE || "smart_pool",
    user: process.env.PGUSER || "smart_pool",
    password: process.env.PGPASSWORD,
  });
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await client.connect();
  await client.query(schema);
  await client.end();
}

async function main() {
  if (process.argv.includes("--create")) {
    await createRoleAndDatabase();
    console.log("Database role and database are ready");
  }
  await applySchema();
  console.log("Schema applied to smart_pool");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
