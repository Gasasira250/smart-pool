const { requestJson, providerMessage } = require("./http");

let cachedToken = null;

function requiredSettings() {
  return ["MTN_SUBSCRIPTION_KEY", "MTN_API_USER", "MTN_API_KEY"].filter(
    (name) => !process.env[name]
  );
}

function baseUrl() {
  return process.env.MTN_BASE_URL || "https://sandbox.momodeveloper.mtn.com";
}

function subscriptionKey() {
  return process.env.MTN_SUBSCRIPTION_KEY;
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const user = process.env.MTN_API_USER;
  const key = process.env.MTN_API_KEY;
  const credentials = Buffer.from(`${user}:${key}`).toString("base64");
  const result = await requestJson(`${baseUrl()}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Ocp-Apim-Subscription-Key": subscriptionKey(),
    },
  });

  if (!result.ok || !result.body?.access_token) {
    const error = new Error(
      providerMessage(result.body, "MTN did not issue an access token")
    );
    error.statusCode = 502;
    throw error;
  }

  const expiresIn = Number(result.body.expires_in || 3600);
  cachedToken = {
    value: result.body.access_token,
    expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1000,
  };
  return cachedToken.value;
}

async function requestToPay({ amount, msisdn, reference, externalId }) {
  const token = await accessToken();
  const result = await requestJson(`${baseUrl()}/collection/v1_0/requesttopay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": subscriptionKey(),
      "X-Reference-Id": reference,
      "X-Target-Environment": process.env.MTN_TARGET_ENVIRONMENT || "sandbox",
    },
    body: JSON.stringify({
      amount: String(amount),
      currency: process.env.MTN_CURRENCY || "EUR",
      externalId: String(externalId),
      payer: { partyIdType: "MSISDN", partyId: msisdn },
      payerMessage: "Smart Pool game",
      payeeNote: "Smart Pool table",
    }),
  });

  if (result.status === 202) {
    return { status: "pending", reason: null };
  }

  return {
    status: "failed",
    reason: providerMessage(result.body, "MTN rejected the payment request"),
  };
}

async function getStatus(reference) {
  const token = await accessToken();
  const result = await requestJson(
    `${baseUrl()}/collection/v1_0/requesttopay/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": subscriptionKey(),
        "X-Target-Environment": process.env.MTN_TARGET_ENVIRONMENT || "sandbox",
      },
    }
  );

  const rawStatus = String(result.body?.status || "").toUpperCase();
  if (rawStatus === "SUCCESSFUL") return { status: "successful", reason: null };
  if (rawStatus === "FAILED") {
    return {
      status: "failed",
      reason: result.body?.reason || "MTN reported the payment as failed",
    };
  }
  if (!result.ok) {
    return {
      status: "pending",
      reason: providerMessage(result.body, "Waiting for MTN to report the payment"),
    };
  }
  return { status: "pending", reason: null };
}

module.exports = { requiredSettings, requestToPay, getStatus };
