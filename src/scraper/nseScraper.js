const { nseGet } = require('./nseSession');

const DIVIDEND_RE = /(?:rs\.?|res?\.?|inr|₹)\s*-?\s*([\d]+(?:\.\d+)?)/i;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;

function parseDividendAmount(subject) {
  if (!subject) return { amount: null, isPercent: false, percent: null };
  const rsMatch = subject.match(DIVIDEND_RE);
  if (rsMatch) {
    return { amount: Number(rsMatch[1]), isPercent: false, percent: null };
  }
  const pctMatch = subject.match(PERCENT_RE);
  if (pctMatch) {
    return { amount: null, isPercent: true, percent: Number(pctMatch[1]) };
  }
  return { amount: null, isPercent: false, percent: null };
}

function classifyDividend(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('interim')) return 'Interim';
  if (s.includes('final')) return 'Final';
  if (s.includes('special')) return 'Special';
  return 'Unknown';
}

function parseDate(s) {
  if (!s) return null;
  const direct = new Date(s);
  if (!isNaN(direct.getTime())) return direct;
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
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

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatNseDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

async function fetchForthcomingDividends({ from, to, days } = {}) {
  const today = startOfDay(new Date());
  const fromDate = from ? startOfDay(from) : today;
  const toDate = to
    ? startOfDay(to)
    : startOfDay(new Date(fromDate.getTime() + (days || 365) * 24 * 60 * 60 * 1000));

  const qs = `index=equities&from_date=${formatNseDate(fromDate)}&to_date=${formatNseDate(toDate)}`;
  const data = await nseGet(`/api/corporates-corporateActions?${qs}`);
  const rows = Array.isArray(data) ? data : data.data || [];

  const dividends = [];
  for (const row of rows) {
    const subject = row.subject || row.purpose || '';
    if (!/dividend/i.test(subject)) continue;

    const exDate = parseDate(row.exDate || row.ex_date);
    if (!exDate) continue;
    if (exDate < fromDate || exDate > toDate) continue;

    const { amount, isPercent, percent } = parseDividendAmount(subject);
    const symbol = (row.symbol || '').trim();
    if (!symbol) continue;

    dividends.push({
      symbol,
      companyName: (row.comp || row.company || row.companyName || '').trim(),
      series: row.series || null,
      subject: subject.trim(),
      dividendAmount: amount,
      dividendIsPercent: isPercent,
      dividendPercent: percent,
      dividendType: classifyDividend(subject),
      exDate,
      recordDate: parseDate(row.recDate || row.record_date),
      paymentDate: null,
      bcStartDate: parseDate(row.bcStartDate),
      bcEndDate: parseDate(row.bcEndDate),
      source: 'NSE',
    });
  }

  const seen = new Map();
  for (const d of dividends) {
    const key = `${d.symbol}|${d.exDate.toISOString()}`;
    if (!seen.has(key)) seen.set(key, d);
  }
  return Array.from(seen.values());
}

module.exports = { fetchForthcomingDividends, parseDividendAmount, classifyDividend };
