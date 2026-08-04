require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PRODUCTS = require('./products');
const store = require('./store');
const LESSONS = require('./lessons');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || 'edgetradingco.myshopify.com';
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || '';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const TOKEN_FILE = path.join(__dirname, 'shopify_token.json');

let SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || '';
if (!SHOPIFY_TOKEN && fs.existsSync(TOKEN_FILE)) {
  try { SHOPIFY_TOKEN = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''; }
  catch { /* ignore corrupt token file, fall back to dev mode */ }
}

const COURSE_TEXT = fs.readFileSync(path.join(__dirname, 'course_text.txt'), 'utf8');

if (IS_PROD && JWT_SECRET === 'dev-only-secret-change-me') {
  console.error('FATAL: refusing to start in production with the default JWT_SECRET. Set a real one in .env.');
  process.exit(1);
}

// --- Shopify order lookup ---------------------------------------------------

const purchaseCache = new Map();
const CACHE_MS = 60 * 1000;

async function findPurchasedHandlesForEmail(email) {
  if (!SHOPIFY_TOKEN) {
    console.log('[dev mode] No SHOPIFY_ADMIN_API_TOKEN set — using mock purchase data for', email);
    return new Set([
      'asset-pack-89298370562-example-product-1',
      'asset-pack-89298370562-example-product-3',
      'the-ledger',
      'risk-console',
      'learn-everything-about-markets-and-trading',
      'trading-journal-template-excel',
      'position-size-amp-risk-calculator-excel',
    ]);
  }
  const cached = purchaseCache.get(email);
  if (cached && cached.expiresAt > Date.now()) return cached.handles;

  const query = `
    query($query: String!) {
      orders(first: 50, query: $query) {
        nodes {
          cancelledAt
          displayFinancialStatus
          lineItems(first: 50) { nodes { product { handle } } }
        }
      }
    }
  `;
  const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { query: `email:${email}` } }),
  });
  if (!res.ok) throw new Error(`Shopify orders lookup failed: ${res.status}`);
  const data = await res.json();
  const handles = new Set();
  for (const order of data.data?.orders?.nodes || []) {
    if (order.cancelledAt) continue;
    if (order.displayFinancialStatus !== 'PAID' && order.displayFinancialStatus !== 'PARTIALLY_REFUNDED') continue;
    for (const item of order.lineItems?.nodes || []) {
      if (item.product?.handle) handles.add(item.product.handle);
    }
  }
  purchaseCache.set(email, { handles, expiresAt: Date.now() + CACHE_MS });
  return handles;
}

// --- Magic-link auth ---------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function sendMagicLink(email, req) {
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '15m' });
  const link = `${req.protocol}://${req.get('host')}/auth/verify?token=${token}`;
  console.log(`\n[magic link] ${email} -> ${link}\n`);

  if (!RESEND_API_KEY) return { link, sent: false };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Edge Trading Co. <onboarding@resend.dev>',
      to: [email],
      subject: 'Your login link',
      html: `<p>Click below to access your Edge Trading Co. account. This link expires in 15 minutes.</p><p><a href="${link}">${link}</a></p>`,
    }),
  });
  if (!res.ok) {
    console.error('Resend send failed:', res.status, await res.text());
    return { link, sent: false };
  }
  return { link, sent: true };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/auth/request', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.redirect('/?error=invalid-email');
  const { link, sent } = await sendMagicLink(email, req);
  const devHint = sent ? '' : `&devLink=${encodeURIComponent(link)}`;
  res.redirect(`/check-email?email=${encodeURIComponent(email)}${devHint}`);
});

app.get('/check-email', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check-email.html')));

app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const sessionToken = jwt.sign({ email: payload.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('session', sessionToken, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/dashboard');
  } catch (err) {
    res.redirect('/?error=expired-link');
  }
});

app.get('/logout', (req, res) => { res.clearCookie('session'); res.redirect('/'); });

// --- Shopify OAuth (one-time, to obtain a real Admin API access token) -----

const oauthStates = new Map(); // state -> expiry, so /callback can't be forged

app.get('/auth/shopify', (req, res) => {
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    return res.status(500).send('Missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET in .env');
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 5 * 60 * 1000);
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/shopify/callback`;
  const authUrl = `https://${SHOP_DOMAIN}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=read_orders&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/shopify/callback', async (req, res) => {
  const { code, state, shop, hmac } = req.query;
  const expiry = oauthStates.get(state);
  if (!expiry || expiry < Date.now()) return res.status(403).send('Invalid or expired OAuth state.');
  oauthStates.delete(state);
  if (shop !== SHOP_DOMAIN) return res.status(403).send('Shop mismatch.');

  const { hmac: _drop, signature: _drop2, ...rest } = req.query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
  if (digest !== hmac) return res.status(403).send('HMAC verification failed.');

  try {
    const tokenRes = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const data = await tokenRes.json();
    SHOPIFY_TOKEN = data.access_token;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken: SHOPIFY_TOKEN, obtainedAt: new Date().toISOString() }, null, 2));
    purchaseCache.clear();
    res.send('<h1>Shopify connected</h1><p>Real purchase verification is now active. You can close this tab.</p>');
  } catch (err) {
    console.error('Shopify OAuth callback error:', err);
    res.status(502).send('Something went wrong connecting to Shopify: ' + err.message);
  }
});

function requireSession(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.redirect('/');
  try { req.member = jwt.verify(token, JWT_SECRET); next(); }
  catch (err) { res.redirect('/'); }
}

function safeRoute(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (err) {
      console.error('Route error:', err);
      res.status(502).send(shell('Something went wrong', 'dashboard', `
        <h1>Couldn't verify your account</h1>
        <p class="muted">We couldn't reach the store to check your purchases. Try again in a moment.</p>
        <p><a href="/dashboard">Retry</a></p>
      `));
    }
  };
}

async function requireProduct(req, res, handle) {
  const purchased = await findPurchasedHandlesForEmail(req.member.email);
  return purchased.has(handle);
}

// --- Dashboard ---------------------------------------------------------

app.get('/dashboard', requireSession, safeRoute(async (req, res) => {
  const purchased = await findPurchasedHandlesForEmail(req.member.email);
  const owned = PRODUCTS.filter(p => purchased.has(p.handle));
  const notOwned = PRODUCTS.filter(p => !purchased.has(p.handle));
  const member = store.loadMember(req.member.email);
  res.send(renderDashboard(req.member.email, owned, notOwned, member));
}));

// --- Course (reader with sidebar + progress) --------------------------

const MODULES = COURSE_TEXT
  .split(/\n(?=Module \d+ — )/i)
  .map(m => {
    const lines = m.trim().split('\n');
    return { title: lines[0], body: lines.slice(1).join('\n').trim() };
  })
  // drops the intro/preamble chunk and the header-only lines from the table of contents,
  // keeping only chunks that have an actual module body after the heading
  .filter(m => /^Module \d+ — /i.test(m.title) && m.body.length > 150);

app.get('/course', requireSession, safeRoute(async (req, res) => {
  if (!(await requireProduct(req, res, 'asset-pack-89298370562-example-product-1'))) return res.status(403).send(renderLocked());
  const member = store.loadMember(req.member.email);
  res.send(renderCourse(member.courseProgress || []));
}));

app.post('/api/course/progress', requireSession, express.json(), (req, res) => {
  const member = store.loadMember(req.member.email);
  const idx = req.body.index;
  const done = new Set(member.courseProgress || []);
  if (req.body.complete) done.add(idx); else done.delete(idx);
  member.courseProgress = Array.from(done);
  store.saveMember(req.member.email, member);
  res.json({ ok: true, progress: member.courseProgress });
});

// --- Discord / Mentor ----------------------------------------------------

app.get('/discord', requireSession, safeRoute(async (req, res) => {
  const product = PRODUCTS.find(p => p.kind === 'discord');
  if (!(await requireProduct(req, res, product.handle))) return res.status(403).send(renderLocked());
  res.send(shell('Private Trading Community', 'discord', `
    <h1>Private Trading Community</h1>
    <p class="muted">You're in. This link is for your access only — please don't share it publicly.</p>
    <a class="btn" href="${product.discordUrl}" target="_blank" rel="noopener">Join the Discord server &rarr;</a>
  `));
}));

app.get('/mentor', requireSession, safeRoute(async (req, res) => {
  const product = PRODUCTS.find(p => p.kind === 'mentor');
  if (!(await requireProduct(req, res, product.handle))) return res.status(403).send(renderLocked());
  res.send(shell('AI Trading Mentor', 'mentor', `
    <h1>AI Trading Mentor</h1>
    <p class="muted">Coaching, not signals — trained on your Advanced Trading Course.</p>
    <a class="btn" href="${product.mentorUrl}" target="_blank" rel="noopener">Open AI Mentor &rarr;</a>
  `));
}));

// --- The Ledger (real interactive trade journal) ------------------------

app.get('/ledger', requireSession, safeRoute(async (req, res) => {
  if (!(await requireProduct(req, res, 'the-ledger'))) return res.status(403).send(renderLocked());
  res.send(renderLedger());
}));

app.get('/api/trades', requireSession, (req, res) => {
  const member = store.loadMember(req.member.email);
  res.json(member.trades || []);
});

app.post('/api/trades', requireSession, (req, res) => {
  const member = store.loadMember(req.member.email);
  const t = req.body;
  const trade = {
    id: Date.now(),
    symbol: String(t.symbol || '').slice(0, 20),
    direction: t.direction === 'short' ? 'short' : 'long',
    entry: Number(t.entry) || 0,
    stop: Number(t.stop) || 0,
    exit: Number(t.exit) || 0,
    riskAmount: Number(t.riskAmount) || 0,
    emotion: String(t.emotion || '').slice(0, 40),
    notes: String(t.notes || '').slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  member.trades = member.trades || [];
  member.trades.unshift(trade);
  store.saveMember(req.member.email, member);
  res.json({ ok: true, trade });
});

app.delete('/api/trades/:id', requireSession, (req, res) => {
  const member = store.loadMember(req.member.email);
  member.trades = (member.trades || []).filter(t => String(t.id) !== req.params.id);
  store.saveMember(req.member.email, member);
  res.json({ ok: true });
});

// --- Risk Console (real live calculator) --------------------------------

app.get('/calculator', requireSession, safeRoute(async (req, res) => {
  if (!(await requireProduct(req, res, 'risk-console'))) return res.status(403).send(renderLocked());
  res.send(renderCalculator());
}));

// --- Downloadable files (Excel templates) --------------------------------

const FILES_DIR = path.join(__dirname, 'files');

app.get('/download/:handle', requireSession, safeRoute(async (req, res) => {
  const product = PRODUCTS.find(p => p.handle === req.params.handle && p.kind === 'file');
  if (!product) return res.status(404).send('Not found');
  if (!(await requireProduct(req, res, product.handle))) return res.status(403).send(renderLocked());
  const filePath = path.join(FILES_DIR, product.file);
  res.download(filePath, `Edge Trading Co - ${product.name}.xlsx`);
}));

// --- Learn Everything (interactive lessons + quizzes) -------------------

app.get('/lessons', requireSession, safeRoute(async (req, res) => {
  if (!(await requireProduct(req, res, 'learn-everything-about-markets-and-trading'))) return res.status(403).send(renderLocked());
  const member = store.loadMember(req.member.email);
  res.send(renderLessons(member.lessonProgress || []));
}));

app.post('/api/lessons/progress', requireSession, (req, res) => {
  const member = store.loadMember(req.member.email);
  const done = new Set(member.lessonProgress || []);
  if (req.body.complete) done.add(req.body.index); else done.delete(req.body.index);
  member.lessonProgress = Array.from(done);
  store.saveMember(req.member.email, member);
  res.json({ ok: true });
});

// --- Shared shell / rendering --------------------------------------------

const NAV = [
  { key: 'dashboard', label: 'Your Desk', href: '/dashboard' },
  { key: 'course', label: 'Advanced Course', href: '/course' },
  { key: 'lessons', label: 'Learn Markets', href: '/lessons' },
  { key: 'ledger', label: 'The Ledger', href: '/ledger' },
  { key: 'calculator', label: 'Risk Console', href: '/calculator' },
  { key: 'discord', label: 'Community', href: '/discord' },
  { key: 'mentor', label: 'AI Mentor', href: '/mentor' },
];

function renderDashboard(email, owned, notOwned, member) {
  const ownedSet = new Set(owned.map(p => p.handle));
  const tiles = owned.map(p => {
    const linkMap = { course: '/course', discord: '/discord', mentor: '/mentor', ledger: '/ledger', calculator: '/calculator', lessons: '/lessons' };
    const link = p.kind === 'file' ? `/download/${p.handle}` : linkMap[p.kind];
    const goLabel = p.kind === 'file' ? 'Download &rarr;' : 'Open &rarr;';
    return `
      <a class="tile ${p.real ? '' : 'soon'}" href="${p.real ? link : '#'}">
        <span class="tile-kind">${p.kind}</span>
        <span class="tile-name">${p.name}</span>
        ${p.real ? `<span class="tile-go">${goLabel}</span>` : '<span class="tile-go muted">Coming soon</span>'}
      </a>`;
  }).join('');

  const shopTiles = notOwned.map(p => `
    <a class="tile ghost" href="https://edgetradingco.myshopify.com/products/${p.handle}" target="_blank">
      <span class="tile-name">${p.name}</span>
      <span class="tile-go">${p.price} &rarr;</span>
    </a>`).join('');

  const tradeCount = (member.trades || []).length;
  const courseDone = (member.courseProgress || []).length;

  return shell('Your Desk', 'dashboard', `
    <h1>Your desk</h1>
    <div class="stat-row">
      <div class="stat"><span class="stat-num">${owned.length}</span><span class="stat-label">Owned</span></div>
      <div class="stat"><span class="stat-num">${tradeCount}</span><span class="stat-label">Trades logged</span></div>
      <div class="stat"><span class="stat-num">${courseDone}/6</span><span class="stat-label">Modules read</span></div>
    </div>
    <h2>What you own</h2>
    <div class="grid">${tiles || '<p class="muted">Nothing yet — see what\'s below.</p>'}</div>
    <h2>Also on the desk</h2>
    <div class="grid">${shopTiles}</div>
  `);
}

function renderCourse(progress) {
  const doneSet = new Set(progress);
  const sidebar = MODULES.map((m, i) => `
    <button class="mod-link ${doneSet.has(i) ? 'done' : ''}" data-i="${i}">
      <span class="mod-num">${doneSet.has(i) ? '✓' : String(i + 1).padStart(2, '0')}</span>
      <span>${m.title.replace(/^Module \d+ — /i, '')}</span>
    </button>`).join('');
  const panes = MODULES.map((m, i) => `
    <div class="mod-pane" data-i="${i}" ${i === 0 ? '' : 'hidden'}>
      <h2>${m.title}</h2>
      <pre>${escapeHtml(m.body)}</pre>
      <label class="check"><input type="checkbox" class="complete-box" data-i="${i}" ${doneSet.has(i) ? 'checked' : ''}> Mark module complete</label>
    </div>`).join('');

  return shell('Advanced Trading Course', 'course', `
    <div class="course-layout">
      <nav class="course-nav">${sidebar}</nav>
      <div class="course-body">${panes}</div>
    </div>
    <script>
      document.querySelectorAll('.mod-link').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.mod-link').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const i = btn.dataset.i;
          document.querySelectorAll('.mod-pane').forEach(p => p.hidden = p.dataset.i !== i);
        });
      });
      document.querySelectorAll('.complete-box').forEach(box => {
        box.addEventListener('change', () => {
          fetch('/api/course/progress', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ index: Number(box.dataset.i), complete: box.checked }) });
          const link = document.querySelector('.mod-link[data-i="' + box.dataset.i + '"] .mod-num');
          link.textContent = box.checked ? '✓' : String(Number(box.dataset.i) + 1).padStart(2, '0');
        });
      });
      document.querySelector('.mod-link').classList.add('active');
    </script>
  `);
}

function renderLedger() {
  return shell('The Ledger', 'ledger', `
    <h1>The Ledger</h1>
    <p class="muted">Log every trade. Win rate, expectancy, and average R update as you go — the point isn't the winners, it's the pattern.</p>
    <div class="stat-row" id="ledgerStats">
      <div class="stat"><span class="stat-num" id="statCount">0</span><span class="stat-label">Trades</span></div>
      <div class="stat"><span class="stat-num" id="statWinrate">—</span><span class="stat-label">Win rate</span></div>
      <div class="stat"><span class="stat-num" id="statAvgR">—</span><span class="stat-label">Avg R</span></div>
      <div class="stat"><span class="stat-num" id="statExpectancy">—</span><span class="stat-label">Expectancy (R)</span></div>
    </div>

    <form id="tradeForm" class="grid-form">
      <input name="symbol" placeholder="Symbol (e.g. EURUSD)" required>
      <select name="direction"><option value="long">Long</option><option value="short">Short</option></select>
      <input name="entry" type="number" step="any" placeholder="Entry price" required>
      <input name="stop" type="number" step="any" placeholder="Stop price" required>
      <input name="exit" type="number" step="any" placeholder="Exit price" required>
      <select name="emotion">
        <option value="">Emotion / mistake tag</option>
        <option>Plan followed</option>
        <option>Revenge trade</option>
        <option>FOMO entry</option>
        <option>Moved stop</option>
        <option>Overtraded</option>
      </select>
      <input name="notes" placeholder="Notes" style="grid-column:1/-1;">
      <button type="submit" style="grid-column:1/-1;">Log trade</button>
    </form>

    <div id="tradeList"></div>

    <script>
      function computeR(t) {
        const risk = Math.abs(t.entry - t.stop);
        if (!risk) return 0;
        const move = t.direction === 'long' ? (t.exit - t.entry) : (t.entry - t.exit);
        return move / risk;
      }
      function renderStats(trades) {
        document.getElementById('statCount').textContent = trades.length;
        if (!trades.length) return;
        const rs = trades.map(computeR);
        const wins = rs.filter(r => r > 0);
        const losses = rs.filter(r => r <= 0);
        const winrate = (wins.length / trades.length * 100).toFixed(1) + '%';
        const avgR = (rs.reduce((a,b) => a+b, 0) / rs.length).toFixed(2) + 'R';
        const avgWin = wins.length ? wins.reduce((a,b)=>a+b,0)/wins.length : 0;
        const avgLoss = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0)/losses.length) : 0;
        const expectancy = ((wins.length/trades.length)*avgWin - (losses.length/trades.length)*avgLoss).toFixed(2) + 'R';
        document.getElementById('statWinrate').textContent = winrate;
        document.getElementById('statAvgR').textContent = avgR;
        document.getElementById('statExpectancy').textContent = expectancy;
      }
      function renderList(trades) {
        const el = document.getElementById('tradeList');
        if (!trades.length) { el.innerHTML = '<p class="muted">No trades logged yet.</p>'; return; }
        el.innerHTML = trades.map(t => {
          const r = computeR(t).toFixed(2);
          const cls = Number(r) > 0 ? 'pos' : 'neg';
          return '<div class="trade-row"><div><strong>' + t.symbol + '</strong> <span class="muted">' + t.direction + '</span>' +
            (t.emotion ? ' <span class="pill">' + t.emotion + '</span>' : '') + '</div>' +
            '<div class="r-badge ' + cls + '">' + r + 'R</div>' +
            '<button class="del" data-id="' + t.id + '">&times;</button></div>';
        }).join('');
        el.querySelectorAll('.del').forEach(btn => btn.addEventListener('click', async () => {
          await fetch('/api/trades/' + btn.dataset.id, { method: 'DELETE' });
          load();
        }));
      }
      async function load() {
        const trades = await (await fetch('/api/trades')).json();
        renderStats(trades);
        renderList(trades);
      }
      document.getElementById('tradeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        await fetch('/api/trades', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        e.target.reset();
        load();
      });
      load();
    </script>
  `);
}

function renderCalculator() {
  return shell('Risk Console', 'calculator', `
    <h1>Risk Console</h1>
    <p class="muted">Position sizing, calculated the moment you type — not after.</p>
    <div class="calc-layout">
      <form id="calcForm" class="grid-form" style="grid-template-columns:1fr 1fr;">
        <label>Account balance<input name="balance" type="number" step="any" value="10000"></label>
        <label>Risk % per trade<input name="riskPct" type="number" step="any" value="1"></label>
        <label>Entry price<input name="entry" type="number" step="any" value="100"></label>
        <label>Stop price<input name="stop" type="number" step="any" value="98"></label>
        <label>Target price (optional)<input name="target" type="number" step="any" value="106"></label>
      </form>
      <div class="calc-result">
        <div class="result-big"><span id="resPosition">—</span><span class="result-label">Position size (units)</span></div>
        <div class="stat-row">
          <div class="stat"><span class="stat-num" id="resRisk">—</span><span class="stat-label">$ at risk</span></div>
          <div class="stat"><span class="stat-num" id="resRR">—</span><span class="stat-label">Risk:reward</span></div>
        </div>
      </div>
    </div>
    <script>
      function calc() {
        const f = document.getElementById('calcForm');
        const balance = Number(f.balance.value) || 0;
        const riskPct = Number(f.riskPct.value) || 0;
        const entry = Number(f.entry.value) || 0;
        const stop = Number(f.stop.value) || 0;
        const target = Number(f.target.value) || 0;
        const riskAmount = balance * (riskPct / 100);
        const perUnitRisk = Math.abs(entry - stop);
        const position = perUnitRisk ? (riskAmount / perUnitRisk) : 0;
        const rr = (target && perUnitRisk) ? (Math.abs(target - entry) / perUnitRisk).toFixed(2) : '—';
        document.getElementById('resPosition').textContent = position ? position.toFixed(2) : '—';
        document.getElementById('resRisk').textContent = riskAmount ? '$' + riskAmount.toFixed(2) : '—';
        document.getElementById('resRR').textContent = rr === '—' ? '—' : rr + ':1';
      }
      document.getElementById('calcForm').addEventListener('input', calc);
      calc();
    </script>
  `);
}

function renderLessons(progress) {
  const doneSet = new Set(progress);
  const items = LESSONS.map((l, i) => `
    <div class="lesson">
      <h3>${i + 1}. ${l.title}</h3>
      <p>${l.body}</p>
      <div class="quiz" data-i="${i}">
        <p class="quiz-q">${l.quiz.q}</p>
        ${l.quiz.options.map((o, oi) => `<button class="quiz-opt" data-oi="${oi}">${o}</button>`).join('')}
        <p class="quiz-feedback" hidden></p>
      </div>
    </div>`).join('');
  return shell('Learn Everything About Markets & Trading', 'lessons', `
    <h1>Learn Markets & Trading</h1>
    <p class="muted">Short lessons, each with a check-up. Get it wrong and you'll see why before moving on.</p>
    ${items}
    <script>
      document.querySelectorAll('.quiz').forEach(quiz => {
        const i = Number(quiz.dataset.i);
        const correct = ${JSON.stringify(LESSONS.map(l => l.quiz.correct))}[i];
        const explain = ${JSON.stringify(LESSONS.map(l => l.quiz.explain))}[i];
        quiz.querySelectorAll('.quiz-opt').forEach(btn => {
          btn.addEventListener('click', () => {
            const oi = Number(btn.dataset.oi);
            const fb = quiz.querySelector('.quiz-feedback');
            quiz.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('right','wrong'));
            btn.classList.add(oi === correct ? 'right' : 'wrong');
            fb.hidden = false;
            fb.textContent = (oi === correct ? 'Correct — ' : 'Not quite — ') + explain;
            if (oi === correct) fetch('/api/lessons/progress', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ index: i, complete: true }) });
          });
        });
      });
    </script>
  `);
}

function renderLocked() {
  return shell('Locked', 'dashboard', `<h1>You don't own this yet</h1><p><a href="/dashboard">Back to your desk</a></p>`);
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function shell(title, active, body) {
  const nav = NAV.map(n => `<a class="nav-link ${n.key === active ? 'active' : ''}" href="${n.href}">${n.label}</a>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Edge Trading Co.</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff;--text:#191919;--text-2:#5e5e5f;--surface:#f4f3f3;--outline:#c4c7c7;--heading:'Fraunces',Georgia,serif;--body:'Inter',sans-serif;}
*{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--text);font-family:var(--body);display:flex;min-height:100vh;}
.sidebar{width:220px;flex-shrink:0;border-right:1px solid var(--outline);padding:24px 16px;position:sticky;top:0;height:100vh;overflow-y:auto;}
.brand{font-family:var(--heading);font-size:14px;padding:0 8px;margin-bottom:8px;}
.logout{display:block;padding:0 8px;font-size:11px;color:var(--text-2);text-decoration:none;margin-bottom:28px;}
.nav-link{display:block;padding:9px 10px;border-radius:8px;font-size:13.5px;color:var(--text-2);text-decoration:none;margin-bottom:2px;transition:background .15s;}
.nav-link:hover{background:var(--surface);}
.nav-link.active{background:var(--text);color:#fff;}
main{flex:1;padding:36px 44px;max-width:900px;}
h1{font-family:var(--heading);font-weight:500;margin:0 0 8px;}
h2{font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-2);margin:32px 0 12px;}
.muted{color:var(--text-2);font-size:14px;line-height:1.6;}
.stat-row{display:flex;gap:12px;margin:20px 0;flex-wrap:wrap;}
.stat{background:var(--surface);border:1px solid var(--outline);border-radius:10px;padding:14px 18px;min-width:100px;}
.stat-num{display:block;font-family:var(--heading);font-size:22px;}
.stat-label{font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.03em;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;}
.tile{display:flex;flex-direction:column;gap:6px;padding:16px;background:var(--surface);border:1px solid var(--outline);border-radius:12px;text-decoration:none;color:var(--text);transition:transform .15s,border-color .15s;}
.tile:hover{border-color:var(--text);transform:translateY(-2px);}
.tile.ghost{background:transparent;}
.tile.soon{opacity:.55;cursor:default;}
.tile-kind{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-2);}
.tile-name{font-family:var(--heading);font-size:16px;}
.tile-go{font-size:12px;margin-top:auto;}
.btn{display:inline-flex;background:var(--text);color:#fff;padding:10px 22px;border-radius:999px;font-size:13.5px;text-decoration:none;border:none;cursor:pointer;font-family:inherit;}
a.btn{display:inline-block;}
.course-layout{display:grid;grid-template-columns:220px 1fr;gap:32px;margin-top:24px;}
.course-nav{display:flex;flex-direction:column;gap:2px;}
.mod-link{display:flex;gap:10px;align-items:center;text-align:left;background:none;border:none;padding:9px 10px;border-radius:8px;font-size:13px;color:var(--text-2);cursor:pointer;font-family:inherit;}
.mod-link:hover{background:var(--surface);}
.mod-link.active{background:var(--surface);color:var(--text);font-weight:600;}
.mod-num{font-family:var(--heading);width:18px;flex-shrink:0;}
.mod-link.done .mod-num{color:var(--text);}
.mod-pane pre{white-space:pre-wrap;font-family:var(--body);font-size:14.5px;line-height:1.75;}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);margin-top:16px;}
.grid-form{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0;}
.grid-form input,.grid-form select,.grid-form label{font-family:inherit;font-size:13.5px;}
.grid-form label{display:flex;flex-direction:column;gap:4px;color:var(--text-2);font-size:12px;}
.grid-form input,.grid-form select{padding:10px 12px;border:1px solid var(--outline);border-radius:8px;}
.grid-form button{background:var(--text);color:#fff;border:none;border-radius:999px;padding:11px;font-size:13.5px;cursor:pointer;}
.trade-row{display:flex;align-items:center;gap:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--outline);border-radius:10px;margin-bottom:8px;}
.trade-row > div:first-child{flex:1;}
.r-badge{font-family:var(--heading);font-size:14px;padding:2px 10px;border-radius:999px;}
.r-badge.pos{background:#e8f5e9;color:#1b5e20;}
.r-badge.neg{background:#fdecea;color:#a33;}
.pill{font-size:10px;background:var(--outline);padding:2px 8px;border-radius:999px;margin-left:6px;}
.del{background:none;border:none;color:var(--text-2);font-size:18px;cursor:pointer;}
.calc-layout{display:grid;grid-template-columns:1.3fr 1fr;gap:24px;align-items:start;}
.calc-result{background:var(--text);color:#fff;border-radius:14px;padding:24px;}
.result-big{font-family:var(--heading);font-size:40px;display:flex;flex-direction:column;}
.result-label{font-size:12px;opacity:.7;font-family:var(--body);}
.calc-result .stat{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.2);color:#fff;}
.calc-result .stat-label{color:rgba(255,255,255,.6);}
.lesson{padding:20px 0;border-bottom:1px solid var(--outline);}
.lesson h3{font-family:var(--heading);font-weight:500;margin:0 0 8px;}
.lesson p{color:var(--text-2);font-size:14px;line-height:1.6;}
.quiz{margin-top:12px;}
.quiz-q{font-weight:600;color:var(--text);}
.quiz-opt{display:block;width:100%;text-align:left;padding:10px 14px;margin-bottom:6px;border:1px solid var(--outline);border-radius:8px;background:none;font-family:inherit;font-size:13.5px;cursor:pointer;}
.quiz-opt:hover{border-color:var(--text);}
.quiz-opt.right{background:#e8f5e9;border-color:#1b5e20;}
.quiz-opt.wrong{background:#fdecea;border-color:#a33;}
.quiz-feedback{font-size:13px;color:var(--text-2);margin-top:6px;}
@media (max-width:720px){body{flex-direction:column;} .sidebar{width:100%;height:auto;position:static;display:flex;flex-wrap:wrap;gap:4px;} .course-layout,.calc-layout{grid-template-columns:1fr;}}
</style></head><body>
<div class="sidebar">
  <div class="brand">EDGE TRADING CO.</div>
  <a class="logout" href="/logout">Log out</a>
  ${nav}
</div>
<main>${body}</main>
</body></html>`;
}

const PORT = process.env.PORT || 4200;
app.listen(PORT, () => console.log(`Edge Members running at http://localhost:${PORT}`));
