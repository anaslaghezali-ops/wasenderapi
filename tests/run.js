// Tests : npm test
// Lance un faux serveur WasenderAPI, démarre la plateforme dessus, et vérifie
// l'envoi complet d'une campagne (pauses, 429, erreurs, doublons, numéros invalides).

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { normalizePhone } = require('../lib/phone');
const { render, variablesIn } = require('../lib/template');

let failures = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('  ok  ' + name))
    .catch((e) => {
      failures++;
      console.log('  ÉCHEC  ' + name + '\n        ' + e.message);
    });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('Numéros');
  await t('06 -> +212', () => assert.strictEqual(normalizePhone('06 12 34 56 78'), '+212612345678'));
  await t('07 -> +212', () => assert.strictEqual(normalizePhone('0712345678'), '+212712345678'));
  await t('zéro perdu par Excel', () => assert.strictEqual(normalizePhone('612345678'), '+212612345678'));
  await t('212 sans +', () => assert.strictEqual(normalizePhone('212612345678'), '+212612345678'));
  await t('00212', () => assert.strictEqual(normalizePhone('00212612345678'), '+212612345678'));
  await t('+33 étranger', () => assert.strictEqual(normalizePhone('+33612345678'), '+33612345678'));
  await t('notation scientifique', () => assert.strictEqual(normalizePhone('2.12612345678E11'), '+212612345678'));
  await t('trop court rejeté', () => assert.strictEqual(normalizePhone('06123'), null));
  await t('marocain mauvaise longueur rejeté', () => assert.strictEqual(normalizePhone('+2126123456789'), null));
  await t('texte rejeté', () => assert.strictEqual(normalizePhone('abc'), null));

  console.log('Messages');
  await t('variable', () => assert.strictEqual(render('Salut {prenom} !', { Prénom: 'Karim' }), 'Salut Karim !'));
  await t('variable absente -> vide propre', () => assert.strictEqual(render('Salut {prenom}, ça va ?', {}), 'Salut, ça va ?'));
  await t('variantes', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) seen.add(render('{A|B|C}', {}));
    assert.deepStrictEqual([...seen].sort(), ['A', 'B', 'C']);
  });
  await t('variable dans variante', () => assert.strictEqual(render('{Salut {prenom}|Salut {prenom}}', { prenom: 'Sara' }), 'Salut Sara'));
  await t('espace avant ! conservé', () => assert.strictEqual(render('Bonjour !', {}), 'Bonjour !'));
  await t('liste des variables', () => assert.deepStrictEqual(variablesIn('{prenom} {Ville} {a|b}'), ['prenom', 'ville']));

  console.log('Campagne de bout en bout (faux WasenderAPI)');
  const received = [];
  let rateLimitedOnce = false;
  let mode = 'normal';
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'disconnected' || req.headers.authorization !== 'Bearer test-key') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ success: false, message: 'Session disconnected' }));
      }
      if (!rateLimitedOnce && received.length === 1) {
        rateLimitedOnce = true;
        res.statusCode = 429;
        res.setHeader('Retry-After', '1');
        return res.end(JSON.stringify({ success: false, message: 'Too many' }));
      }
      if (j.to === '+212600000003') {
        res.statusCode = 422;
        return res.end(JSON.stringify({ success: false, message: 'Number not on WhatsApp' }));
      }
      received.push({ ...j, at: Date.now() });
      res.end(JSON.stringify({ success: true, data: { msgId: received.length, jid: j.to, status: 'in_progress' } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_PASSWORD: 'secret',
      WASENDER_API_KEY: 'test-key',
      WASENDER_BASE_URL: `http://127.0.0.1:${mockPort}`,
      DATA_DIR: dataDir,
      DRY_RUN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80 && !log.includes('prête'); i++) await wait(100);
  if (!log.includes('prête')) {
    console.log('Serveur non démarré :\n' + log);
    process.exit(1);
  }

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };
  const waitDone = async (id, ms) => {
    let c;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      c = (await call(`/api/campaigns/${id}`)).json;
      if (c.status !== 'running') break;
      await wait(250);
    }
    return c;
  };

  try {
    await t('accès refusé sans connexion', async () => assert.strictEqual((await call('/api/campaigns')).status, 401));
    await t('mauvais mot de passe refusé', async () => assert.strictEqual((await call('/api/login', { body: { password: 'x' } })).status, 401));
    await t('connexion', async () => assert.strictEqual((await call('/api/login', { body: { password: 'secret' } })).status, 200));

    let id;
    await t('création : doublons et invalides filtrés', async () => {
      const r = await call('/api/campaigns', {
        body: {
          name: 'Test',
          template: '{Salut|Bonjour} {prenom}, offre du jour !',
          contacts: [
            { phone: '0600000001', prenom: 'Karim' },
            { phone: '+212 6 00 00 00 01', prenom: 'Karim bis' },
            { phone: '0600000002', prenom: 'Salma' },
            { phone: '0600000003', prenom: 'Pas WhatsApp' },
            { phone: '123', prenom: 'Invalide' },
            { phone: '0600000004', prenom: '' },
          ],
          settings: { minDelay: 1, maxDelay: 1, batchSize: 0 },
        },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.campaign.stats.total, 4);
      assert.strictEqual(r.json.duplicates, 1);
      assert.deepStrictEqual(r.json.invalid, ['123']);
      id = r.json.campaign.id;
    });

    await t('lancement', async () => assert.strictEqual((await call(`/api/campaigns/${id}/start`, { body: {} })).json.status, 'running'));
    await t('pas deux campagnes en même temps', async () => {
      const r2 = await call('/api/campaigns', { body: { template: 'x', contacts: [{ phone: '0611111111' }] } });
      const r = await call(`/api/campaigns/${r2.json.campaign.id}/start`, { body: {} });
      assert.strictEqual(r.status, 400);
      await call(`/api/campaigns/${r2.json.campaign.id}`, { method: 'DELETE' });
    });

    const c = await waitDone(id, 30000);

    await t('campagne terminée', () => assert.strictEqual(c.status, 'done', String(c.lastError)));
    await t('3 envoyés, 1 échec', () => {
      assert.strictEqual(c.stats.sent, 3);
      assert.strictEqual(c.stats.failed, 1);
    });
    await t('429 respecté puis renvoyé (aucun message perdu ni doublé)', () => {
      assert.ok(rateLimitedOnce);
      assert.deepStrictEqual(received.map((r) => r.to), ['+212600000001', '+212600000002', '+212600000004']);
    });
    await t('pause entre messages respectée (≥ 1 s)', () => {
      for (let i = 1; i < received.length; i++) assert.ok(received[i].at - received[i - 1].at >= 950, 'écart trop court');
    });
    await t('prénom inséré, prénom vide propre', () => {
      assert.match(received[0].text, /^(Salut|Bonjour) Karim, offre du jour !$/);
      assert.match(received[2].text, /^(Salut|Bonjour), offre du jour !$/);
    });
    await t('erreur WhatsApp conservée', () => {
      const f = c.contacts.find((x) => x.status === 'failed');
      assert.strictEqual(f.phone, '+212600000003');
      assert.match(f.error, /not on WhatsApp/);
    });
    await t('export CSV', async () => {
      const r = await call(`/api/campaigns/${id}/export.csv`);
      assert.strictEqual(r.status, 200);
      assert.match(r.text, /telephone/);
      assert.strictEqual(r.text.trim().split('\r\n').length, 5);
    });

    await t('session déconnectée => pause, message non perdu', async () => {
      mode = 'disconnected';
      const r = await call('/api/campaigns', { body: { template: 'x', contacts: [{ phone: '0622222222' }], settings: { minDelay: 1, maxDelay: 1 } } });
      const cid = r.json.campaign.id;
      await call(`/api/campaigns/${cid}/start`, { body: {} });
      const cc = await waitDone(cid, 8000);
      assert.strictEqual(cc.status, 'paused');
      assert.match(cc.lastError, /session WhatsApp déconnectée/);
      assert.strictEqual(cc.stats.pending, 1);
      mode = 'normal';
    });

    await t('pause puis reprise', async () => {
      const r = await call('/api/campaigns', {
        body: {
          template: 'y',
          contacts: [{ phone: '0633333331' }, { phone: '0633333332' }, { phone: '0633333333' }],
          settings: { minDelay: 2, maxDelay: 2, batchSize: 0 },
        },
      });
      const cid = r.json.campaign.id;
      const before = received.length;
      await call(`/api/campaigns/${cid}/start`, { body: {} });
      await wait(700);
      assert.strictEqual((await call(`/api/campaigns/${cid}/pause`, { body: {} })).json.status, 'paused');
      await wait(2500);
      assert.strictEqual(received.length - before, 1, 'aucun envoi pendant la pause');
      await call(`/api/campaigns/${cid}/start`, { body: {} });
      const cc = await waitDone(cid, 15000);
      assert.strictEqual(cc.status, 'done');
      assert.strictEqual(received.length - before, 3);
    });
  } finally {
    srv.kill();
    mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests passent.');
  process.exit(failures ? 1 : 0);
})();
