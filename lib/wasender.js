// Client minimal pour WasenderAPI
// Doc : https://wasenderapi.com/api-docs/messages/send-text-message

const BASE_URL = (process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com').replace(/\/$/, '');
const DRY_RUN = process.env.DRY_RUN === '1';

class SendError extends Error {
  constructor(message, { status = 0, retryAfter = null, fatal = false } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter; // secondes
    this.fatal = fatal; // erreur qui doit mettre la campagne en pause (clé invalide, session déconnectée)
  }
}

async function sendText(to, text) {
  if (DRY_RUN) {
    await new Promise((r) => setTimeout(r, 150));
    if (Math.random() < 0.05) throw new SendError('Simulation : échec aléatoire', { status: 400 });
    return { msgId: 'dry-' + Date.now(), status: 'simulated' };
  }

  const apiKey = process.env.WASENDER_API_KEY;
  if (!apiKey) throw new SendError('WASENDER_API_KEY manquante', { fatal: true });

  let res;
  try {
    res = await fetch(BASE_URL + '/api/send-message', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new SendError('Réseau : ' + (e.message || e), { status: 0 });
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* réponse non JSON */
  }

  if (res.ok && (!body || body.success !== false)) {
    return { msgId: body?.data?.msgId ?? null, status: body?.data?.status ?? 'sent' };
  }

  const msg =
    body?.message ||
    body?.error ||
    (body?.errors ? JSON.stringify(body.errors) : '') ||
    'HTTP ' + res.status;

  if (res.status === 429) {
    const h = Number(res.headers.get('retry-after'));
    const b = Number(body?.retry_after ?? body?.retryAfter);
    const retryAfter = Number.isFinite(h) && h > 0 ? h : Number.isFinite(b) && b > 0 ? b : 60;
    throw new SendError('Limite de débit atteinte (429)', { status: 429, retryAfter });
  }
  if (res.status === 401 || res.status === 403) {
    throw new SendError('Accès refusé (' + res.status + ') : clé API invalide ou session WhatsApp déconnectée. ' + msg, {
      status: res.status,
      fatal: true,
    });
  }
  throw new SendError(msg, { status: res.status });
}

module.exports = { sendText, SendError, DRY_RUN, BASE_URL };
