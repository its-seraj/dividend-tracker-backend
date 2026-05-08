const mongoose = require('mongoose');

const DividendSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true },
    companyName: String,
    series: String,
    subject: String,
    dividendAmount: { type: Number, default: null },
    dividendIsPercent: { type: Boolean, default: false },
    dividendPercent: { type: Number, default: null },
    dividendType: { type: String, default: 'Unknown' },
    exDate: { type: Date, required: true },
    recordDate: Date,
    paymentDate: Date,
    bcStartDate: Date,
    bcEndDate: Date,
    lastPrice: Number,
    dividendOnExPct: Number,
    sector: String,
    industry: String,
    marketCap: Number,
    faceValue: Number,
    sources: { type: [String], default: [] },
    primarySource: { type: String, default: 'NSE' },
    bseScripCode: String,
    mismatchFields: { type: [String], default: [] },
    bseVariant: {
      dividendAmount: Number,
      recordDate: Date,
      dividendType: String,
      subject: String,
    },
    scrapedAt: { type: Date, default: () => new Date() },
    enrichedAt: Date,
  },
  { timestamps: true }
);

DividendSchema.index({ symbol: 1, exDate: 1 }, { unique: true });
DividendSchema.index({ exDate: 1 });

const ScrapeRunSchema = new mongoose.Schema(
  {
    startedAt: Date,
    finishedAt: Date,
    success: Boolean,
    inserted: Number,
    updated: Number,
    skipped: Number,
    errors: [String],
    source: String,
  },
  { timestamps: true }
);

const Dividend = mongoose.model('Dividend', DividendSchema);
const ScrapeRun = mongoose.model('ScrapeRun', ScrapeRunSchema);

function sameDay(a, b) {
  if (!a || !b) return a === b;
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

async function migrateLegacyRows() {
  const indexes = await Dividend.collection.indexes();

  for (const idx of indexes) {
    if (
      idx.key &&
      idx.key.symbol === 1 &&
      idx.key.exDate === 1 &&
      idx.key.source === 1
    ) {
      await Dividend.collection.dropIndex(idx.name);
      console.log(`[db] dropped legacy index ${idx.name}`);
    }
  }

  const legacy = await Dividend.collection
    .find({ source: { $exists: true } })
    .toArray();
  if (legacy.length === 0) return;

  console.log(`[db] migrating ${legacy.length} legacy rows`);
  const grouped = new Map();
  for (const r of legacy) {
    const key = `${r.symbol}|${new Date(r.exDate).toISOString().slice(0, 10)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  await Dividend.collection.deleteMany({ source: { $exists: true } });

  const docs = [];
  for (const variants of grouped.values()) {
    const nse = variants.find((v) => v.source === 'NSE');
    const bse = variants.find((v) => v.source === 'BSE');
    const primary = nse || bse;
    const sources = variants.map((v) => v.source);

    const mismatchFields = [];
    let bseVariant = null;
    if (nse && bse) {
      if (nse.dividendAmount !== bse.dividendAmount) mismatchFields.push('dividendAmount');
      if (!sameDay(nse.recordDate, bse.recordDate)) mismatchFields.push('recordDate');
      if (nse.dividendType !== bse.dividendType) mismatchFields.push('dividendType');
      bseVariant = {
        dividendAmount: bse.dividendAmount,
        recordDate: bse.recordDate,
        dividendType: bse.dividendType,
        subject: bse.subject,
      };
    }

    const { _id, source, ...rest } = primary;
    docs.push({
      ...rest,
      sources,
      primarySource: nse ? 'NSE' : 'BSE',
      bseScripCode: bse ? bse.bseScripCode : null,
      mismatchFields,
      bseVariant,
    });
  }

  if (docs.length) {
    await Dividend.collection.insertMany(docs, { ordered: false });
    console.log(`[db] inserted ${docs.length} merged rows`);
  }
}

async function ensureIndexes() {
  try {
    await migrateLegacyRows();
  } catch (err) {
    console.warn('[db] migration skipped:', err.message);
  }
  await Dividend.syncIndexes();
}

module.exports = { Dividend, ScrapeRun, ensureIndexes };
