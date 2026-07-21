const { fetchForthcomingDividends } = require('./scraper/nseScraper');
const { fetchBseDividends } = require('./scraper/bseScraper');
const { getQuote } = require('./scraper/nseQuote');
const { fetchStockPricesWithGemini } = require('./services/geminiPrice');
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

/**
 * Sweeps MongoDB records missing `lastPrice` and fetches stock prices via Gemini Flash.
 * Recalculates dividendOnExPct and updates database.
 */
async function backfillMissingPrices({ scope = 'all', limit = 100, batchSize = 25 } = {}) {
  const today = startOfDay(new Date());
  const query = {
    $or: [{ lastPrice: null }, { lastPrice: { $exists: false } }],
  };

  if (scope === 'historical') {
    query.exDate = { $lt: today };
  } else if (scope === 'upcoming') {
    query.exDate = { $gte: today };
  }

  const docs = await Dividend.find(query)
    .sort({ exDate: -1 })
    .limit(limit)
    .lean();

  if (docs.length === 0) {
    return { totalTargeted: 0, updated: 0, failed: 0, scope, message: 'No records found missing lastPrice' };
  }

  let updatedCount = 0;
  let failedCount = 0;
  const totalBatches = Math.ceil(docs.length / batchSize);
  console.log(`[backfill] Starting backfill for ${docs.length} records in ${totalBatches} batches (batch size: ${batchSize})...`);

  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs.slice(i, i + batchSize);
    const items = chunk.map((doc) => ({
      symbol: doc.symbol,
      companyName: doc.companyName,
    }));

    const prices = await fetchStockPricesWithGemini(items);

    for (const doc of chunk) {
      const price = prices[doc.symbol];
      if (price && typeof price === 'number' && price > 0) {
        const dividendOnExPct =
          doc.dividendAmount && price
            ? Number(((doc.dividendAmount / price) * 100).toFixed(3))
            : null;

        await Dividend.updateOne(
          { _id: doc._id },
          {
            $set: {
              lastPrice: price,
              dividendOnExPct,
              enrichedAt: new Date(),
            },
          }
        );
        updatedCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }

  return {
    totalTargeted: docs.length,
    updated: updatedCount,
    failed: failedCount,
    scope,
  };
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

    // Perform Gemini stock price backfill for rows missing lastPrice
    try {
      const backfillRes = await backfillMissingPrices({ scope: 'all', limit: 50 });
      if (backfillRes.updated > 0) {
        totalUpdated += backfillRes.updated;
      }
    } catch (gErr) {
      allErrors.push(`Gemini backfill: ${gErr.message}`);
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

module.exports = { refreshDividends, backfillMissingPrices };

