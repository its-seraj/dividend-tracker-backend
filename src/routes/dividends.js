const express = require('express');
const { Dividend, ScrapeRun } = require('../models/Dividend');
const { refreshDividends, backfillMissingPrices } = require('../refresh');

const router = express.Router();

const PAST_PAGE_SIZE = 10;
const UPCOMING_PAGE_SIZE = 30;

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function getLastRunPayload() {
  const lastRun = await ScrapeRun.findOne().sort({ createdAt: -1 }).lean();
  if (!lastRun) return null;
  return {
    at: lastRun.finishedAt || lastRun.startedAt,
    success: lastRun.success,
    inserted: lastRun.inserted,
    updated: lastRun.updated,
    errors: lastRun.errors,
    source: lastRun.source,
  };
}

router.get('/counts', async (_req, res) => {
  try {
    const today = startOfTodayUTC();
    const [upcoming, past] = await Promise.all([
      Dividend.countDocuments({ exDate: { $gte: today } }),
      Dividend.countDocuments({ exDate: { $lt: today } }),
    ]);
    res.json({ upcoming, past });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const direction = req.query.direction === 'past' ? 'past' : 'upcoming';
    const today = startOfTodayUTC();

    if (direction === 'past') {
      const before = parseDate(req.query.before) || today;
      const lastId = req.query.lastId || null;

      const pageQuery = lastId
        ? {
            $or: [
              { exDate: { $lt: before } },
              { exDate: before, _id: { $lt: lastId } },
            ],
          }
        : { exDate: { $lt: before } };

      const docs = await Dividend.find(pageQuery)
        .sort({ exDate: -1, _id: -1 })
        .limit(PAST_PAGE_SIZE + 1)
        .lean();

      const hasMore = docs.length > PAST_PAGE_SIZE;
      const page = hasMore ? docs.slice(0, PAST_PAGE_SIZE) : docs;
      const tail = page[page.length - 1];

      res.json({
        direction: 'past',
        rows: page.slice().reverse(),
        hasMore,
        nextCursor: tail
          ? { before: new Date(tail.exDate).toISOString(), lastId: String(tail._id) }
          : null,
      });
      return;
    }

    const after = parseDate(req.query.after) || today;
    const lastId = req.query.lastId || null;

    const pageQuery = lastId
      ? {
          $or: [
            { exDate: { $gt: after } },
            { exDate: after, _id: { $gt: lastId } },
          ],
        }
      : { exDate: { $gte: after } };

    const rows = await Dividend.find(pageQuery)
      .sort({ exDate: 1, _id: 1 })
      .limit(UPCOMING_PAGE_SIZE + 1)
      .lean();

    const hasMore = rows.length > UPCOMING_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, UPCOMING_PAGE_SIZE) : rows;
    const tail = page[page.length - 1];

    const includeLastRun = !req.query.after && !req.query.lastId;
    const lastRun = includeLastRun ? await getLastRunPayload() : undefined;

    res.json({
      direction: 'upcoming',
      rows: page,
      hasMore,
      nextCursor: tail
        ? { after: new Date(tail.exDate).toISOString(), lastId: String(tail._id) }
        : null,
      ...(includeLastRun ? { lastRun } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const result = await refreshDividends({ source: 'manual' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backfill-prices', async (req, res) => {
  try {
    const scope = req.body?.scope || req.query?.scope || 'all';
    const limit = Number(req.body?.limit || req.query?.limit) || 100;
    const result = await backfillMissingPrices({ scope, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

