const cron = require('node-cron');
const { refreshDividends } = require('../refresh');

function scheduleOne(schedule, label) {
  if (!cron.validate(schedule)) {
    console.warn(`[cron] invalid schedule "${schedule}", skipping ${label}`);
    return null;
  }
  const task = cron.schedule(
    schedule,
    async () => {
      console.log(`[cron] ${label} starting at ${new Date().toISOString()}`);
      try {
        const result = await refreshDividends({ source: `cron:${label}` });
        console.log(`[cron] ${label} result:`, result);
      } catch (err) {
        console.error(`[cron] ${label} failed:`, err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
  console.log(`[cron] ${label} scheduled "${schedule}" (Asia/Kolkata)`);
  return task;
}

function startDailyRefresh(schedules = ['0 7 * * *', '30 18 * * *']) {
  const list = Array.isArray(schedules) ? schedules : [schedules];
  return list.map((s, i) => scheduleOne(s, `refresh-${i + 1}`)).filter(Boolean);
}

module.exports = { startDailyRefresh };
