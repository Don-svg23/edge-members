// Posts one concept from the real Advanced Trading Course / Learn Everything
// lessons into Discord. Rotates through scripts/tips.json by day, so the same
// tip repeats roughly every 18 days. Nothing here is generated or fabricated —
// every line is drawn directly from course_text.txt or lessons.js.
const fetch = require('node-fetch');
const tips = require('./tips.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('Missing DISCORD_WEBHOOK_URL secret.');
  process.exit(1);
}

const dayIndex = Math.floor(Date.now() / 86400000);
const tip = tips[dayIndex % tips.length];

fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: `**Edge Trading Co. — Daily Concept**\n\n${tip}` }),
})
  .then(async (res) => {
    if (!res.ok) {
      console.error('Discord webhook failed:', res.status, await res.text());
      process.exit(1);
    }
    console.log('Posted tip:', tip);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
