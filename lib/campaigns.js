// Gestion des campagnes : stockage JSON + file d'envoi séquentielle.
// Un seul numéro WhatsApp => une seule campagne envoie à la fois.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { render } = require('./template');
const { normalizePhone } = require('./phone');
const { sendText } = require('./wasender');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'campaigns.json');

const MAX_CONSECUTIVE_FAILURES = 5; // pause auto : numéro probablement déconnecté ou bloqué
const MAX_RETRIES = 3;

let campaigns = [];
const loops = new Set(); // campagnes dont la boucle d'envoi tourne encore
let wakeUp = null; // pour interrompre une pause en cours

// ---------- stockage ----------
function load() {
  try {
    campaigns = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    campaigns = [];
  }
  // Une campagne "en cours" au moment d'un redémarrage repasse en pause
  for (const c of campaigns) {
    if (c.status === 'running') {
      c.status = 'paused';
      c.lastError = 'Serveur redémarré : campagne mise en pause. Relancez-la pour continuer.';
    }
  }
  save();
}

let saveTimer = null;
function save(now = true) {
  if (!now) {
    if (!saveTimer) saveTimer = setTimeout(() => ((saveTimer = null), save()), 1000);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(campaigns));
  fs.renameSync(tmp, FILE);
}

// ---------- utilitaires ----------
const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wakeUp = null;
      resolve();
    }
    wakeUp = done;
  });

const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function stats(c) {
  const s = { total: c.contacts.length, pending: 0, sent: 0, failed: 0 };
  for (const x of c.contacts) s[x.status] = (s[x.status] || 0) + 1;
  return s;
}

function summary(c) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    nextSendAt: c.nextSendAt,
    lastError: c.lastError,
    settings: c.settings,
    stats: stats(c),
  };
}

function cleanSettings(s = {}) {
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  const minDelay = num(s.minDelay, 10, 1, 600);
  const maxDelay = Math.max(minDelay, num(s.maxDelay, 25, 1, 900));
  return {
    minDelay,
    maxDelay,
    batchSize: num(s.batchSize, 40, 0, 10000), // 0 = pas de grande pause
    batchPauseMin: num(s.batchPauseMin, 5, 0, 120), // minutes
  };
}

// ---------- API publique ----------
function create({ name, template, contacts, settings }) {
  if (!template || !String(template).trim()) throw new Error('Le message est vide.');
  if (String(template).length > 4000) throw new Error('Message trop long (4000 caractères max).');
  if (!Array.isArray(contacts) || !contacts.length) throw new Error('Aucun contact.');

  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;

  for (const raw of contacts) {
    const { phone, ...fields } = raw || {};
    const p = normalizePhone(phone);
    if (!p) {
      invalid.push(String(phone ?? ''));
      continue;
    }
    if (seen.has(p)) {
      duplicates++;
      continue;
    }
    seen.add(p);
    valid.push({ phone: p, fields, status: 'pending', error: null, sentAt: null, msgId: null, text: null });
  }
  if (!valid.length) throw new Error('Aucun numéro valide dans la liste.');

  const c = {
    id: crypto.randomUUID(),
    name: String(name || '').trim() || 'Campagne du ' + new Date().toLocaleString('fr-FR'),
    template: String(template),
    settings: cleanSettings(settings),
    contacts: valid,
    status: 'ready',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    nextSendAt: null,
    lastError: null,
  };
  campaigns.unshift(c);
  save();
  return { campaign: summary(c), invalid, duplicates };
}

function list() {
  return campaigns.map(summary);
}

function get(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) return null;
  return { ...summary(c), template: c.template, contacts: c.contacts };
}

function start(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campagne introuvable.');
  if (c.status === 'running') return summary(c);
  if (loops.has(id)) throw new Error('Mise en pause en cours (un envoi se termine). Réessayez dans quelques secondes.');
  if (loops.size) throw new Error('Une autre campagne est déjà en cours. Mettez-la en pause d’abord.');
  if (!['ready', 'paused'].includes(c.status)) throw new Error('Cette campagne ne peut pas être relancée.');
  if (!c.contacts.some((x) => x.status === 'pending')) throw new Error('Plus aucun message à envoyer.');
  c.status = 'running';
  c.lastError = null;
  c.startedAt = c.startedAt || new Date().toISOString();
  loops.add(id);
  save();
  run(c)
    .catch((e) => {
      c.status = 'paused';
      c.lastError = 'Erreur interne : ' + e.message;
    })
    .finally(() => {
      loops.delete(id);
      c.nextSendAt = null;
      save();
    });
  return summary(c);
}

function pause(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campagne introuvable.');
  if (c.status === 'running') {
    c.status = 'paused';
    c.nextSendAt = null;
    if (wakeUp) wakeUp();
    save();
  }
  return summary(c);
}

function stop(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campagne introuvable.');
  if (['running', 'paused', 'ready'].includes(c.status)) {
    c.status = 'stopped';
    c.nextSendAt = null;
    c.finishedAt = new Date().toISOString();
    if (loops.has(id) && wakeUp) wakeUp();
    save();
  }
  return summary(c);
}

function remove(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campagne introuvable.');
  if (c.status === 'running') throw new Error('Mettez la campagne en pause avant de la supprimer.');
  campaigns = campaigns.filter((x) => x.id !== id);
  save();
}

function retryFailed(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campagne introuvable.');
  if (c.status === 'running') throw new Error('Campagne en cours.');
  let n = 0;
  for (const x of c.contacts) {
    if (x.status === 'failed') {
      x.status = 'pending';
      x.error = null;
      n++;
    }
  }
  if (n && ['done', 'stopped'].includes(c.status)) {
    c.status = 'paused';
    c.finishedAt = null;
  }
  save();
  return { reset: n, campaign: summary(c) };
}

function toCsv(id) {
  const c = campaigns.find((x) => x.id === id);
  if (!c) return null;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const keys = [...new Set(c.contacts.flatMap((x) => Object.keys(x.fields)))];
  const head = ['telephone', ...keys, 'statut', 'envoye_le', 'erreur', 'message'];
  const rows = c.contacts.map((x) =>
    [x.phone, ...keys.map((k) => x.fields[k]), x.status, x.sentAt, x.error, x.text].map(esc).join(','),
  );
  return '﻿' + [head.map(esc).join(','), ...rows].join('\r\n');
}

// ---------- boucle d'envoi ----------
async function run(c) {
  const isLive = () => c.status === 'running';
  let consecutiveFailures = 0;
  let sentThisRun = 0;

  while (isLive()) {
    const contact = c.contacts.find((x) => x.status === 'pending');
    if (!contact) {
      c.status = 'done';
      c.finishedAt = new Date().toISOString();
      c.nextSendAt = null;
      break;
    }

    const text = render(c.template, contact.fields);
    let attempt = 0;
    let outcome = null; // 'sent' | 'failed' | 'fatal'

    while (isLive() && !outcome) {
      try {
        const r = await sendText(contact.phone, text);
        contact.status = 'sent';
        contact.sentAt = new Date().toISOString();
        contact.msgId = r.msgId;
        contact.text = text;
        contact.error = null;
        outcome = 'sent';
      } catch (e) {
        if (e.status === 429) {
          c.lastError = `Limite de débit atteinte, reprise dans ${e.retryAfter} s.`;
          c.nextSendAt = new Date(Date.now() + e.retryAfter * 1000).toISOString();
          save(false);
          await sleep(e.retryAfter * 1000);
          c.lastError = null;
          continue; // même contact, sans compter comme échec
        }
        if (e.fatal) {
          c.status = 'paused';
          c.lastError = e.message;
          outcome = 'fatal';
          break;
        }
        const transient = !e.status || e.status >= 500;
        if (transient && attempt < MAX_RETRIES) {
          attempt++;
          c.lastError = `Erreur temporaire (${e.message}), nouvel essai ${attempt}/${MAX_RETRIES} dans 30 s.`;
          c.nextSendAt = new Date(Date.now() + 30000).toISOString();
          save(false);
          await sleep(30000);
          continue;
        }
        contact.status = 'failed';
        contact.error = e.message;
        contact.text = text;
        outcome = 'failed';
      }
    }

    if (outcome === 'sent') {
      consecutiveFailures = 0;
      sentThisRun++;
      c.lastError = null;
    } else if (outcome === 'failed') {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        c.status = 'paused';
        c.lastError = `${MAX_CONSECUTIVE_FAILURES} échecs d’affilée : campagne mise en pause par sécurité. Vérifiez que le numéro WhatsApp est toujours connecté dans WasenderAPI. Dernière erreur : ${contact.error}`;
      }
    }
    save(false);

    if (!isLive() || !c.contacts.some((x) => x.status === 'pending')) continue;

    // Pause entre deux messages (aléatoire), et grande pause tous les N messages
    const s = c.settings;
    let waitMs = randInt(s.minDelay * 1000, s.maxDelay * 1000);
    if (s.batchSize > 0 && s.batchPauseMin > 0 && outcome === 'sent' && sentThisRun % s.batchSize === 0) {
      waitMs = randInt(s.batchPauseMin * 60000, s.batchPauseMin * 60000 * 1.5);
    }
    c.nextSendAt = new Date(Date.now() + waitMs).toISOString();
    await sleep(waitMs);
  }

}

module.exports = { load, create, list, get, start, pause, stop, remove, retryFailed, toCsv };
