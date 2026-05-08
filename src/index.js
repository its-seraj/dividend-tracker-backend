require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { connectDb } = require('./db');
const dividendsRouter = require('./routes/dividends');
const { startDailyRefresh } = require('./jobs/dailyRefresh');
const { ScrapeRun, ensureIndexes } = require('./models/Dividend');

const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dividend_tracker';
const ENABLE_CRON = process.env.ENABLE_CRON !== 'false';
const CRON_SCHEDULES = (process.env.CRON_SCHEDULES || '0 7 * * *,30 18 * * *')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  await connectDb(MONGO_URI);
  console.log(`[db] connected to ${MONGO_URI}`);
  await ensureIndexes();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev'));

  app.get('/api/health', async (_req, res) => {
    const lastRun = await ScrapeRun.findOne().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, lastRun: lastRun || null });
  });

  app.use('/', dividendsRouter);

  app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));

  if (ENABLE_CRON) startDailyRefresh(CRON_SCHEDULES);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
