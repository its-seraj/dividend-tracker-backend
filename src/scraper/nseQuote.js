const pLimit = require('p-limit');
const { nseGet } = require('./nseSession');

const limit = pLimit(2);
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

function jitter() {
  return new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
}

async function fetchQuoteRaw(symbol) {
  return nseGet(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
}

async function getQuote(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  return limit(async () => {
    await jitter();
    try {
      const raw = await fetchQuoteRaw(symbol);
      const lastPrice = raw && raw.priceInfo ? Number(raw.priceInfo.lastPrice) : null;
      const sector = raw && raw.industryInfo ? raw.industryInfo.sector || null : null;
      const industry = raw && raw.industryInfo ? raw.industryInfo.industry || null : null;
      const issuedSize = raw && raw.securityInfo ? Number(raw.securityInfo.issuedSize) : null;
      const faceValue = raw && raw.securityInfo ? Number(raw.securityInfo.faceValue) : null;
      const marketCap =
        lastPrice && issuedSize ? Math.round(lastPrice * issuedSize) : null;
      const value = { lastPrice, sector, industry, marketCap, faceValue };
      cache.set(symbol, { at: Date.now(), value });
      return value;
    } catch (err) {
      const value = { lastPrice: null, sector: null, industry: null, marketCap: null, faceValue: null, error: err.message };
      cache.set(symbol, { at: Date.now(), value });
      return value;
    }
  });
}

module.exports = { getQuote };
