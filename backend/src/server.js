const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { checkConnection, listTables } = require("./db");
const {
  createPayment,
  paymentMessage,
  refreshPayment,
  listPayments,
  listGames,
  completeGame,
} = require("./payments");
const { paymentMode } = require("./providers");
const { gameScore, recordPocket, syncPockets } = require("./scoring");
const { securityHeaders, requireAdmin, rateLimit } = require("./security");
const { addClient } = require("./live");
const { overview } = require("./admin");
const { startInstall, testPocket, finishInstall } = require("./install");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(securityHeaders);
app.use(cors());
app.use(express.json());
const distDir = path.join(__dirname, "..", "..", "frontend", "dist");

function deskHtml() {
  const built = path.join(distDir, "index.html");
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, "..", "public", "index.html");
}

app.use(express.static(distDir, { index: false }));
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

async function sendHealth(res) {
  try {
    const database = await checkConnection();
    res.json({
      success: true,
      message: "Smart Pool API is running",
      version: "1.0.0",
      database,
      payment_mode: paymentMode(),
    });
  } catch (error) {
    console.error("Database check failed:", error.message);
    res.status(503).json({
      success: false,
      message: "Smart Pool API is running, but the database is unavailable",
      database: null,
    });
  }
}

app.get("/health", (req, res) => sendHealth(res));

app.get("/overview", requireAdmin, async (req, res) => {
  try {
    const floor = await overview();
    res.json({ success: true, ...floor });
  } catch (error) {
    console.error("Failed to load overview:", error.message);
    res.status(503).json({ success: false, message: "Could not load the floor overview" });
  }
});

app.get("/", async (req, res) => {
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    res.sendFile(deskHtml());
    return;
  }
  sendHealth(res);
});

app.get("/admin", (req, res) => {
  res.sendFile(deskHtml());
});

function wholeNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

app.post("/tables/:id/install", requireAdmin, async (req, res) => {
  const tableId = wholeNumber(req.params.id);
  if (!tableId) {
    res.status(400).json({ success: false, message: "Table id must be a positive whole number" });
    return;
  }
  try {
    const table = await startInstall(tableId);
    res.json({
      success: true,
      message: `${table.name} is ready for pocket tests.`,
      table,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error("Failed to start install:", error.message);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not start installation" : error.message,
    });
  }
});

app.post("/tables/:id/pockets/:number/test", requireAdmin, async (req, res) => {
  const tableId = wholeNumber(req.params.id);
  const pocketNumber = wholeNumber(req.params.number);
  if (!tableId || !pocketNumber || pocketNumber > 6) {
    res.status(400).json({ success: false, message: "Pocket number must be from 1 to 6" });
    return;
  }
  try {
    const table = await testPocket(tableId, pocketNumber);
    const fitted = table.pockets.filter((pocket) => pocket.installed).length;
    res.json({
      success: true,
      message: `Pocket ${pocketNumber} on ${table.name} is fitted. ${fitted} of 6 confirmed.`,
      table,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error("Failed to test pocket:", error.message);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not confirm the pocket" : error.message,
    });
  }
});

app.post("/tables/:id/ready", requireAdmin, async (req, res) => {
  const tableId = wholeNumber(req.params.id);
  if (!tableId) {
    res.status(400).json({ success: false, message: "Table id must be a positive whole number" });
    return;
  }
  try {
    const table = await finishInstall(tableId);
    res.json({
      success: true,
      message: `${table.name} is open for games.`,
      table,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error("Failed to finish install:", error.message);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not open the table" : error.message,
    });
  }
});

app.get("/tables", async (req, res) => {
  try {
    const tables = await listTables();
    res.json({ success: true, tables });
  } catch (error) {
    console.error("Failed to list tables:", error.message);
    res.status(503).json({
      success: false,
      message: "Could not read pool tables from the database",
    });
  }
});

app.get("/payments", async (req, res) => {
  try {
    const payments = await listPayments();
    res.json({ success: true, payments });
  } catch (error) {
    console.error("Failed to list payments:", error.message);
    res.status(503).json({
      success: false,
      message: "Could not read payments from the database",
    });
  }
});

app.get("/payments/:id", async (req, res) => {
  const paymentId = Number(req.params.id);
  if (!Number.isInteger(paymentId) || paymentId < 1) {
    res.status(400).json({ success: false, message: "Payment id must be a positive whole number" });
    return;
  }

  try {
    const payment = await refreshPayment(paymentId);
    res.json({ success: payment.status === "successful", message: paymentMessage(payment), payment });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error("Failed to refresh payment:", error.message);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not refresh the payment" : error.message,
    });
  }
});

app.post("/payments", rateLimit(30), async (req, res) => {
  try {
    const payment = await createPayment(req.body || {});
    const statusCode = payment.status === "failed" ? 402 : payment.status === "pending" ? 202 : 201;
    res.status(statusCode).json({
      success: payment.status === "successful",
      message: paymentMessage(payment),
      payment,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) {
      console.error("Failed to create payment:", error.message);
    }
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not create the payment" : error.message,
    });
  }
});

app.get("/games", async (req, res) => {
  try {
    const games = await listGames();
    res.json({ success: true, games });
  } catch (error) {
    console.error("Failed to list games:", error.message);
    res.status(503).json({
      success: false,
      message: "Could not read games from the database",
    });
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("data: {\"type\":\"ready\"}\n\n");
  addClient(res);
});

app.get("/games/:id/score", async (req, res) => {
  const gameId = Number(req.params.id);
  if (!Number.isInteger(gameId) || gameId < 1) {
    res.status(400).json({ success: false, message: "Game id must be a positive whole number" });
    return;
  }

  try {
    const score = await gameScore(gameId);
    res.json({ success: true, score });
  } catch (error) {
    console.error("Failed to read score:", error.message);
    res.status(500).json({ success: false, message: "Could not read the score" });
  }
});

app.post("/sync", requireAdmin, rateLimit(30), async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!events || events.length < 1 || events.length > 50) {
    res.status(400).json({
      success: false,
      message: "events must be an array of 1 to 50 pocket events",
    });
    return;
  }

  try {
    const results = await syncPockets(events);
    res.json({ success: true, results });
  } catch (error) {
    console.error("Failed to sync pockets:", error.message);
    res.status(500).json({ success: false, message: "Could not sync pocket events" });
  }
});

app.post("/games/:id/pockets", rateLimit(30), async (req, res) => {
  const gameId = Number(req.params.id);
  if (!Number.isInteger(gameId) || gameId < 1) {
    res.status(400).json({ success: false, message: "Game id must be a positive whole number" });
    return;
  }

  try {
    const score = await recordPocket(gameId, req.body || {});
    const latest = score.pockets[score.pockets.length - 1];
    res.status(201).json({
      success: true,
      message: `Ball ${latest.ball_label} scored ${latest.points} in pocket ${latest.pocket_number}. Total is ${score.total}.`,
      score,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error("Failed to record pocket:", error.message);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not record the pocket" : error.message,
    });
  }
});

app.post("/games/:id/complete", requireAdmin, async (req, res) => {
  const gameId = Number(req.params.id);
  if (!Number.isInteger(gameId) || gameId < 1) {
    res.status(400).json({ success: false, message: "Game id must be a positive whole number" });
    return;
  }

  try {
    const game = await completeGame(gameId);
    res.json({
      success: true,
      message: `${game.table_name} is available again.`,
      game,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) {
      console.error("Failed to complete game:", error.message);
    }
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Could not complete the game" : error.message,
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    res.status(400).json({
      success: false,
      message: "Request body must be valid JSON",
    });
    return;
  }
  next(error);
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Smart Pool API running on http://localhost:${PORT}`);
  });
}
