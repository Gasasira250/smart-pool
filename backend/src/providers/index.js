const mtn = require("./mtn");
const airtel = require("./airtel");

function paymentMode() {
  return String(process.env.PAYMENT_MODE || "simulate").toLowerCase() === "live"
    ? "live"
    : "simulate";
}

function countryCode() {
  return process.env.PAYMENT_COUNTRY_CODE || "256";
}

function toMsisdn(phone) {
  const digits = String(phone).replace(/\D/g, "");
  const code = countryCode();
  if (digits.startsWith(code)) return digits;
  if (digits.startsWith("0")) return `${code}${digits.slice(1)}`;
  return `${code}${digits}`;
}

function toLocalMsisdn(msisdn) {
  const code = countryCode();
  return msisdn.startsWith(code) ? msisdn.slice(code.length) : msisdn;
}

function missingSettings(provider) {
  return provider === "mtn" ? mtn.requiredSettings() : airtel.requiredSettings();
}

async function requestToPay({ provider, phone, amount, reference, externalId }) {
  const msisdn = toMsisdn(phone);
  if (provider === "mtn") {
    return mtn.requestToPay({ amount, msisdn, reference, externalId });
  }
  return airtel.requestToPay({
    amount,
    localMsisdn: toLocalMsisdn(msisdn),
    reference,
  });
}

async function getStatus(provider, reference) {
  if (provider === "mtn") return mtn.getStatus(reference);
  return airtel.getStatus(reference);
}

module.exports = {
  paymentMode,
  missingSettings,
  requestToPay,
  getStatus,
};
