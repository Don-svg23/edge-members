// Runs daily via GitHub Actions. Finds leads who signed up ~3 or ~7 days ago
// and haven't gotten that stage's email yet, sends it via Resend, and marks
// it sent. Real course-derived tips, same bank used for the Discord bot.
const { Client } = require('pg');
const fetch = require('node-fetch');
const TIPS = require('./tips.json');

const DATABASE_URL = process.env.DATABASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!DATABASE_URL || !RESEND_API_KEY) {
  console.error('Missing DATABASE_URL or RESEND_API_KEY secret.');
  process.exit(1);
}

function tipFor(offset) {
  return TIPS[(Math.floor(Date.now() / 86400000) + offset) % TIPS.length];
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Edge Trading Co. <login@edgetradingco.com>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

const STAGES = [
  {
    column: 'day3_sent_at',
    minDays: 3,
    subject: 'Another real concept (day 3)',
    html: (tip) => `<p>No pitch today — just another concept, same as the one you got when you signed up.</p><p><strong>${tip}</strong></p><p>If you want the tools that do this math automatically, they're at <a href="https://edgetradingco.myshopify.com">edgetradingco.myshopify.com</a> — still 40% off with WELCOME40 while it lasts.</p>`,
  },
  {
    column: 'day7_sent_at',
    minDays: 7,
    subject: "One more, and where things are if you're curious",
    html: (tip) => `<p><strong>${tip}</strong></p><p>That's the last of the free tips for now — if you found these useful, the paid tools (The Ledger, Risk Console, Strategy Lab, and the rest) do this kind of thing automatically from your own trade data. <a href="https://edgetradingco.myshopify.com">Worth a look</a>, still 40% off your first order with WELCOME40 (first 200 customers only).</p><p>Either way, no more emails unless you ask — this isn't a drip campaign that never ends.</p>`,
  },
];

async function run() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  for (const stage of STAGES) {
    const { rows } = await client.query(
      `select id, email from leads
       where ${stage.column} is null
       and signed_up_at <= now() - interval '${stage.minDays} days'`
    );
    for (const lead of rows) {
      try {
        await sendEmail(lead.email, stage.subject, stage.html(tipFor(rows.indexOf(lead))));
        await client.query(`update leads set ${stage.column} = now() where id = $1`, [lead.id]);
        console.log(`Sent ${stage.column} to ${lead.email}`);
      } catch (e) {
        console.error(`Failed to send ${stage.column} to ${lead.email}:`, e.message);
      }
    }
  }

  await client.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
