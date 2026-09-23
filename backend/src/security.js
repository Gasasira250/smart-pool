const crypto = require("crypto");

const hits = new Map();

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY || "";
  const provided = req.get("x-admin-key") || "";
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  const matches =
    expected.length > 0 &&
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!matches) {
    res.status(401).json({ success: false, message: "Admin key required" });
    return;
  }
  next();
}

function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const recent = (hits.get(key) || []).filter((time) => now - time < 60000);
    if (recent.length >= maxPerMinute) {
      res.status(429).json({
        success: false,
        message: "Too many requests. Wait a minute and try again.",
      });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

module.exports = { securityHeaders, requireAdmin, rateLimit };
