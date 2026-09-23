const QUEUE_KEY = "smart-pool-offline-queue";
const ADMIN_KEY = "smart-pool-admin-key";

export function getAdminKey() {
  return sessionStorage.getItem(ADMIN_KEY) || "";
}

export function saveAdminKey(value) {
  sessionStorage.setItem(ADMIN_KEY, value.trim());
}

function adminHeaders(extra = {}) {
  return { ...extra, "x-admin-key": getAdminKey() };
}

export function queuedPockets() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function writeQueue(events) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(events));
}

export function queuePocket(gameId, body) {
  const events = queuedPockets();
  events.push({
    client_event_id: crypto.randomUUID(),
    game_id: gameId,
    pocket_number: body.pocket_number,
    ball_label: body.ball_label,
    recorded_at: new Date().toISOString(),
  });
  writeQueue(events);
  return events.length;
}

export async function flushQueuedPockets() {
  const events = queuedPockets();
  const remaining = [];
  for (const event of events) {
    try {
      const response = await fetch(`/games/${event.game_id}/pockets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok && response.status !== 409) remaining.push(event);
    } catch {
      remaining.push(event);
      break;
    }
  }
  writeQueue(remaining);
  return remaining.length;
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok && !payload.message) {
    throw new Error("The desk could not reach the API");
  }
  return payload;
}

export async function loadDesk() {
  const [tablesResponse, gamesResponse, paymentsResponse, healthResponse] = await Promise.all([
    fetch("/tables"),
    fetch("/games"),
    fetch("/payments"),
    fetch("/health"),
  ]);
  const tablesPayload = await readJson(tablesResponse);
  const gamesPayload = await readJson(gamesResponse);
  const paymentsPayload = await readJson(paymentsResponse);
  const health = await readJson(healthResponse);

  return {
    tables: tablesPayload.tables,
    games: gamesPayload.games,
    payments: paymentsPayload.payments,
    paymentMode: health.payment_mode,
  };
}

export async function loadScore(gameId) {
  const response = await fetch(`/games/${gameId}/score`);
  return (await readJson(response)).score;
}

function offlineError() {
  const offline = new Error("API is offline. This ball is saved on this computer.");
  offline.offline = true;
  return offline;
}

export async function recordPocket(gameId, body) {
  try {
    const response = await fetch(`/games/${gameId}/pockets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!payload) throw offlineError();
    if (!response.ok) throw new Error(payload.message || "The desk could not reach the API");
    return payload;
  } catch (error) {
    if (error.offline || error instanceof TypeError) throw error.offline ? error : offlineError();
    throw error;
  }
}

export async function createPayment(body) {
  const response = await fetch("/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function refreshPayment(id) {
  const response = await fetch(`/payments/${id}`);
  return readJson(response);
}

export async function completeGame(id) {
  const response = await fetch(`/games/${id}/complete`, {
    method: "POST",
    headers: adminHeaders(),
  });
  return readJson(response);
}

async function adminPost(path) {
  const response = await fetch(path, { method: "POST", headers: adminHeaders() });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "The office could not reach the API");
  return payload;
}

export function startInstall(tableId) {
  return adminPost(`/tables/${tableId}/install`);
}

export function testPocketInstall(tableId, pocketNumber) {
  return adminPost(`/tables/${tableId}/pockets/${pocketNumber}/test`);
}

export function finishInstall(tableId) {
  return adminPost(`/tables/${tableId}/ready`);
}
