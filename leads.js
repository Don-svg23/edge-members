// Durable lead storage for the free-calculator email capture.
// Uses Postgres instead of a local JSON file because Render's filesystem is
// wiped on every redeploy — a file-based store would silently lose every
// signup the next time we ship a change.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

let ready = null;
function init() {
  if (!pool) return Promise.resolve(false);
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        source TEXT,
        signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        day3_sent_at TIMESTAMPTZ,
        day7_sent_at TIMESTAMPTZ
      );
    `).then(() => true).catch((e) => {
      console.error('leads: table init failed', e);
      return false;
    });
  }
  return ready;
}

async function addLead(email, source) {
  if (!(await init())) return false;
  try {
    await pool.query(
      'INSERT INTO leads (email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
      [email, source || 'free-calculator']
    );
    return true;
  } catch (e) {
    console.error('leads: insert failed', e);
    return false;
  }
}

module.exports = { addLead, pool, init };
