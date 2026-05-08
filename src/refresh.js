const { fetchForthcomingDividends } = require('./scraper/nseScraper');
const { fetchBseDividends } = require('./scraper/bseScraper');
const { getQuote } = require('./scraper/nseQuote');
const { Dividend, ScrapeRun } = require('./models/Dividend');

const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 365;

let inFlight = null;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameDay(a, b) {
  if (!a || !b) return a === b;
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

function findMismatches(primary, bse) {
  const fields = [];
  if (primary.dividendAmount !== bse.dividendAmount) fields.push('dividendAmount');
  if (!sameDay(primary.recordDate, bse.recordDate)) fields.push('recordDate');
  if (primary.dividendType !== bse.dividendType) fields.push('dividendType');
  return fields;
}

async function persistNseRows(rows) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const quote = await getQuote(row.symbol);
      const dividendOnExPct =
        row.dividendAmount && quote.lastPrice
          ? Number(((row.dividendAmount / quote.lastPrice) * 100).toFixed(3))
          : null;

      const { source, ...clean } = row;
      const update = {
        ...clean,
        lastPrice: quote.lastPrice,
        sector: quote.sector,
        industry: quote.industry,
        marketCap: quote.marketCap,
        faceValue: quote.faceValue,
        dividendOnExPct,
        primarySource: 'NSE',
        enrichedAt: new Date(),
        scrapedAt: new Date(),
      };

      const res = await Dividend.updateOne(
        { symbol: row.symbol, exDate: row.exDate },
        { $set: update, $addToSet: { sources: 'NSE' } },
        { upsert: true }
      );
      if (res.upsertedCount && res.upsertedCount > 0) inserted += 1;
      else if (res.modifiedCount && res.modifiedCount > 0) updated += 1;
      else skipped += 1;
    } catch (err) {
      errors.push(`NSE/${row.symbol}: ${err.message}`);
    }
  }

  return { inserted, updated, skipped, errors };
}

async function persistBseRows(rows) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const existing = await Dividend.findOne({
        symbol: row.symbol,
        exDate: row.exDate,
      }).lean();

      if (existing) {
        const mismatchFields = findMismatches(existing, row);
        const bseVariant = {
          dividendAmount: row.dividendAmount,
          recordDate: row.recordDate,
          dividendType: row.dividendType,
          subject: row.subject,
        };
        const res = await Dividend.updateOne(
          { _id: existing._id },
          {
            $set: {
              bseScripCode: row.bseScripCode || null,
              bseVariant,
              mismatchFields,
            },
            $addToSet: { sources: 'BSE' },
          }
        );
        if (res.modifiedCount && res.modifiedCount > 0) updated += 1;
        else skipped += 1;
      } else {
        const { source, ...clean } = row;
        await Dividend.create({
          ...clean,
          sources: ['BSE'],
          primarySource: 'BSE',
          mismatchFields: [],
          bseVariant: null,
          scrapedAt: new Date(),
        });
        inserted += 1;
      }
    } catch (err) {
      errors.push(`BSE/${row.symbol}: ${err.message}`);
    }
  }

  return { inserted, updated, skipped, errors };
}

async function runRefreshOnce({
  pastDays = DEFAULT_PAST_DAYS,
  futureDays = DEFAULT_FUTURE_DAYS,
  source = 'manual',
  sources = ['NSE', 'BSE'],
} = {}) {
  const startedAt = new Date();
  const today = startOfDay(new Date());
  const fromDate = new Date(today.getTime() - pastDays * 24 * 60 * 60 * 1000);
  const toDate = new Date(today.getTime() + futureDays * 24 * 60 * 60 * 1000);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const allErrors = [];
  let success = false;

  try {
    if (sources.includes('NSE')) {
      try {
        const nseRows = await fetchForthcomingDividends({ from: fromDate, to: toDate });
        const r = await persistNseRows(nseRows);
        totalInserted += r.inserted;
        totalUpdated += r.updated;
        totalSkipped += r.skipped;
        allErrors.push(...r.errors);
      } catch (err) {
        allErrors.push(`NSE scrape: ${err.message}`);
      }
    }

    if (sources.includes('BSE')) {
      try {
        const bseRows = await fetchBseDividends({ from: fromDate, to: toDate });
        const r = await persistBseRows(bseRows);
        totalInserted += r.inserted;
        totalUpdated += r.updated;
        totalSkipped += r.skipped;
        allErrors.push(...r.errors);
      } catch (err) {
        allErrors.push(`BSE scrape: ${err.message}`);
      }
    }

    success = true;
  } catch (err) {
    allErrors.push(`refresh: ${err.message}`);
  }

  await ScrapeRun.create({
    startedAt,
    finishedAt: new Date(),
    success,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors: allErrors,
    source,
  });

  return { success, inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped, errors: allErrors };
}

async function refreshDividends(opts) {
  if (inFlight) return inFlight;
  inFlight = runRefreshOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

module.exports = { refreshDividends };
