const express = require('express');
const crypto = require('crypto');
const path = require('path');
const campaigns = require('./lib/campaigns');
const { render, variablesIn } = require('./lib/template');
const { normalizePhone } = require('./lib/phone');
const { sendText, DRY_RUN } = require('./lib/wasender');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';

if (!PASSWORD) {
  console.error('ERREUR : définissez APP_PASSWORD (mot de passe pour accéder à la plateforme).');
  process.exit(1);
}
if (!DRY_RUN && !process.env.WASENDER_API_KEY) {
  console.warn('ATTENTION : WASENDER_API_KEY non définie, les envois échoueront.');
}

// ---------- authentification simple par mot de passe ----------
const SECRET = crypto.createHash('sha256').update('wasender-bulk:' + PASSWORD).digest();
const TOKEN = crypto.createHmac('sha256', SECRET).update('session-v1').digest('hex');
const COOKIE = 'wsb_session';

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const isAuthed = (req) => safeEqual(readCookie(req, COOKIE) || '', TOKEN);

// Limite les tentatives de connexion (10 par 15 min et par IP)
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  if (!safeEqual(req.body?.password || '', PASSWORD)) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req), dryRun: DRY_RUN }));

// Tout ce qui suit nécessite d'être connecté
app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Non connecté.' })));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') {
      out.then((v) => v !== undefined && !res.headersSent && res.json(v)).catch((e) => res.status(400).json({ error: e.message }));
    } else if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

app.post(
  '/api/preview',
  wrap((req) => {
    const { template = '', contacts = [] } = req.body || {};
    const sample = contacts.slice(0, 3);
    return {
      variables: variablesIn(template),
      previews: (sample.length ? sample : [{}]).map((c) => ({ phone: normalizePhone(c.phone), text: render(template, c) })),
    };
  }),
);

app.post(
  '/api/test',
  wrap(async (req) => {
    const { phone, template, fields } = req.body || {};
    const to = normalizePhone(phone);
    if (!to) throw new Error('Numéro de test invalide.');
    if (!template || !String(template).trim()) throw new Error('Le message est vide.');
    const text = render(template, fields || {});
    const r = await sendText(to, text);
    return { ok: true, to, text, result: r };
  }),
);

app.get('/api/campaigns', wrap(() => campaigns.list()));
app.post('/api/campaigns', wrap((req) => campaigns.create(req.body || {})));
app.get(
  '/api/campaigns/:id',
  wrap((req, res) => {
    const c = campaigns.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
    return c;
  }),
);
app.post('/api/campaigns/:id/start', wrap((req) => campaigns.start(req.params.id)));
app.post('/api/campaigns/:id/pause', wrap((req) => campaigns.pause(req.params.id)));
app.post('/api/campaigns/:id/stop', wrap((req) => campaigns.stop(req.params.id)));
app.post('/api/campaigns/:id/retry-failed', wrap((req) => campaigns.retryFailed(req.params.id)));
app.delete('/api/campaigns/:id', wrap((req) => (campaigns.remove(req.params.id), { ok: true })));
app.get('/api/campaigns/:id/export.csv', (req, res) => {
  const csv = campaigns.toCsv(req.params.id);
  if (!csv) return res.status(404).send('Introuvable');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campagne-${req.params.id.slice(0, 8)}.csv"`);
  res.send(csv);
});

app.use(express.static(path.join(__dirname, 'public')));

campaigns.load();
app.listen(PORT, () => {
  console.log(`Plateforme prête sur http://localhost:${PORT}${DRY_RUN ? '  (MODE SIMULATION : aucun message réel)' : ''}`);
});
