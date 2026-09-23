const { requestJson, providerMessage } = require("./http");

let cachedToken = null;

function requiredSettings() {
  return ["AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET"].filter((name) => !process.env[name]);
}

function baseUrl() {
  return process.env.AIRTEL_BASE_URL || "https://openapiuat.airtel.africa";
}

function country() {
  return process.env.AIRTEL_COUNTRY || "UG";
}

function currency() {
  return process.env.AIRTEL_CURRENCY || "UGX";
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const result = await requestJson(`${baseUrl()}/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "*/*" },
    body: JSON.stringify({
      client_id: process.env.AIRTEL_CLIENT_ID,
      client_secret: process.env.AIRTEL_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!result.ok || !result.body?.access_token) {
    const error = new Error(
      providerMessage(result.body, "Airtel did not issue an access token")
    );
    error.statusCode = 502;
    throw error;
  }

  const expiresIn = Number(result.body.expires_in || 180);
  cachedToken = {
    value: result.body.access_token,
    expiresAt: Date.now() + Math.max(expiresIn - 30, 20) * 1000,
  };
  return cachedToken.value;
}

async function requestToPay({ amount, localMsisdn, reference }) {
  const token = await accessToken();
  const result = await requestJson(`${baseUrl()}/merchant/v1/payments/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
      "X-Country": country(),
      "X-Currency": currency(),
    },
    body: JSON.stringify({
      reference: "Smart Pool game",
      subscriber: {
        country: country(),
        currency: currency(),
        msisdn: localMsisdn,
      },
      transaction: {
        amount,
        country: country(),
        currency: currency(),
        id: reference,
      },
    }),
  });

  const accepted = result.ok && result.body?.status?.success !== false;
  if (accepted) return { status: "pending", reason: null };
  return {
    status: "failed",
    reason: providerMessage(result.body, "Airtel rejected the payment request"),
  };
}

async function getStatus(reference) {
  const token = await accessToken();
  const result = await requestJson(
    `${baseUrl()}/standard/v1/payments/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        "X-Country": country(),
        "X-Currency": currency(),
      },
    }
  );

  const code = String(result.body?.data?.transaction?.status || "").toUpperCase();
  if (code === "TS") return { status: "successful", reason: null };
  if (code === "TF" || code === "TE") {
    return {
      status: "failed",
      reason: result.body?.data?.transaction?.message || "Airtel reported the payment as failed",
    };
  }
  return { status: "pending", reason: null };
}

module.exports = { requiredSettings, requestToPay, getStatus };
