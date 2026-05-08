const axios = require('axios');

const BSE_BASE = 'https://api.bseindia.com';
const BSE_PATH = '/BseIndiaAPI/api/DefaultData/w';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.bseindia.com',
  Referer: 'https://www.bseindia.com/',
};

const DIVIDEND_RE = /(?:rs\.?|res?\.?|inr|₹)\s*-?\s*([\d]+(?:\.\d+)?)/i;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;

function parseDividendAmount(subject) {
  if (!subject) return { amount: null, isPercent: false, percent: null };
  const rsMatch = subject.match(DIVIDEND_RE);
  if (rsMatch) return { amount: Number(rsMatch[1]), isPercent: false, percent: null };
  const pctMatch = subject.match(PERCENT_RE);
  if (pctMatch) return { amount: null, isPercent: true, percent: Number(pctMatch[1]) };
  return { amount: null, isPercent: false, percent: null };
}

function classifyDividend(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('interim')) return 'Interim';
  if (s.includes('final')) return 'Final';
  if (s.includes('special')) return 'Special';
  return 'Unknown';
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatBseDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function parseDate(s) {
  if (!s) return null;
  const direct = new Date(s);
  if (!isNaN(direct.getTime())) return direct;
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const mo = months[m[2].toLowerCase()];
    if (mo != null) return new Date(Number(m[3]), mo, Number(m[1]));
  }
  return null;
}

async function bseGet(params, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await axios.get(`${BSE_BASE}${BSE_PATH}`, {
        params,
        headers: BROWSER_HEADERS,
        timeout: 20000,
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      if (status && ![401, 403, 429, 500, 502, 503, 504].includes(status)) throw err;
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400)));
    }
  }
  throw lastErr;
}

async function fetchBseDividends({ from, to, days } = {}) {
  const today = startOfDay(new Date());
  const fromDate = from ? startOfDay(from) : today;
  const toDate = to
    ? startOfDay(to)
    : startOfDay(new Date(fromDate.getTime() + (days || 365) * 24 * 60 * 60 * 1000));

  const params = {
    Fdate: formatBseDate(fromDate),
    TDate: formatBseDate(toDate),
    Purposecode: '',
    strSearch: 'S',
    ddlcategorys: 'E',
    ddlindustrys: '',
    scripcode: '',
    segment: '0',
    strType: '0',
  };

  const data = await bseGet(params);
  const rows = Array.isArray(data) ? data : data.Table || data.data || [];

  const dividends = [];
  for (const row of rows) {
    const subject = row.Purpose || row.purpose || row.PURPOSE || '';
    if (!/dividend/i.test(subject)) continue;

    const exDate = parseDate(row.Ex_date || row.ExDate || row.ex_date);
    if (!exDate) continue;
    if (exDate < fromDate || exDate > toDate) continue;

    const symbol = (row.scrip_code_short_name || row.short_name || row.ShortName || row.scripcode || '')
      .toString()
      .trim()
      .toUpperCase();
    if (!symbol) continue;

    const { amount, isPercent, percent } = parseDividendAmount(subject);

    dividends.push({
      symbol,
      companyName: (row.long_name || row.LongName || row.scrip_name || '').trim(),
      series: null,
      subject: subject.trim(),
      dividendAmount: amount,
      dividendIsPercent: isPercent,
      dividendPercent: percent,
      dividendType: classifyDividend(subject),
      exDate,
      recordDate: parseDate(row.RD_Date || row.Record_Date || row.record_date),
      paymentDate: parseDate(row.Payment_Date || row.payment_date),
      bcStartDate: parseDate(row.BCRD_FROM || row.bc_start_date),
      bcEndDate: parseDate(row.BCRD_TO || row.bc_end_date),
      bseScripCode: row.scrip_code || row.scripcode || null,
      source: 'BSE',
    });
  }

  const seen = new Map();
  for (const d of dividends) {
    const key = `${d.symbol}|${d.exDate.toISOString()}`;
    if (!seen.has(key)) seen.set(key, d);
  }
  return Array.from(seen.values());
}

module.exports = { fetchBseDividends };
