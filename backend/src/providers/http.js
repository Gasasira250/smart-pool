async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 300) };
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function providerMessage(body, fallback) {
  if (!body) return fallback;
  return (
    body.message ||
    body.error ||
    body.status?.message ||
    body.raw ||
    fallback
  );
}

module.exports = { requestJson, providerMessage };
