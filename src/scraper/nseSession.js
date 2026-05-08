const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const NSE_BASE = 'https://www.nseindia.com';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: `${NSE_BASE}/`,
  Connection: 'keep-alive',
  'X-Requested-With': 'XMLHttpRequest',
};

let clientPromise = null;
let lastWarmup = 0;
const WARMUP_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildClient() {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      baseURL: NSE_BASE,
      jar,
      withCredentials: true,
      timeout: 20000,
      headers: BROWSER_HEADERS,
    })
  );

  await client.get('/', { headers: { Accept: 'text/html' } });
  await client.get('/option-chain');
  lastWarmup = Date.now();
  return client;
}

async function getNseClient(forceRewarm = false) {
  if (forceRewarm || !clientPromise || Date.now() - lastWarmup > WARMUP_TTL_MS) {
    clientPromise = buildClient().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function nseGet(path, { retries = 3 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < retries) {
    attempt += 1;
    try {
      const client = await getNseClient(attempt > 1);
      const res = await client.get(path);
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      if (status && ![401, 403, 429, 500, 502, 503, 504].includes(status)) {
        throw err;
      }
      const backoff = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

module.exports = { getNseClient, nseGet, NSE_BASE };
