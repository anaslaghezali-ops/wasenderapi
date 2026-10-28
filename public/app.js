// ---------- utilitaires ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && path !== '/login') showLogin();
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

// Même logique que le serveur (lib/phone.js), pour l'aperçu
function normalizePhone(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (plus) {
  } else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('212')) {
  } else if (d.startsWith('0')) d = '212' + d.slice(1);
  else if (d.length === 9) d = '212' + d;
  else return null;
  if (d.startsWith('212') && d.length !== 12) return null;
  if (d.length < 8 || d.length > 15) return null;
  return '+' + d;
}

const normKey = (k) =>
  String(k).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');

function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')}`;
  if (m) return `${m} min`;
  return `${sec} s`;
}

// ---------- connexion ----------
function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}
async function showApp(dryRun) {
  $('login').hidden = true;
  $('app').hidden = false;
  $('dryBanner').hidden = !dryRun;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/login', { body: { password: $('password').value } });
    const me = await api('/me');
    showApp(me.dryRun);
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});
$('logout').addEventListener('click', async () => {
  await api('/logout', { body: {} }).catch(() => {});
  showLogin();
});

// ---------- onglets ----------
let pollTimer = null;
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)),
);
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $('tab-new').hidden = tab !== 'new';
  $('tab-list').hidden = tab !== 'list';
  clearInterval(pollTimer);
  if (tab === 'list') {
    loadCampaigns();
    pollTimer = setInterval(loadCampaigns, 3000);
  }
}

// ---------- 1. contacts ----------
let contacts = []; // [{phone, prenom, ...}]
let columns = []; // colonnes autres que le téléphone

const PHONE_HEADER = /^(tel|telephone|phone|numero|num|n°|no|mobile|gsm|whatsapp|portable|contact)/;

function rowsToContacts(rows) {
  rows = rows.filter((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) return { list: [], cols: [] };

  const first = rows[0].map((c) => String(c ?? '').trim());
  const looksLikeHeader = !first.some((c) => normalizePhone(c));
  let headers, data;
  if (looksLikeHeader) {
    headers = first.map((h, i) => normKey(h) || 'colonne_' + (i + 1));
    data = rows.slice(1);
  } else {
    headers = first.map((_, i) => (i === 0 ? 'telephone' : i === 1 ? 'prenom' : 'colonne_' + (i + 1)));
    data = rows;
  }

  let phoneIdx = headers.findIndex((h) => PHONE_HEADER.test(h));
  if (phoneIdx < 0) {
    // colonne contenant le plus de numéros valides
    let best = 0;
    headers.forEach((_, i) => {
      const n = data.filter((r) => normalizePhone(r[i])).length;
      if (n > best) (best = n), (phoneIdx = i);
    });
  }
  if (phoneIdx < 0) return { list: [], cols: [] };

  const cols = headers.filter((_, i) => i !== phoneIdx);
  const list = data.map((r) => {
    const o = { phone: String(r[phoneIdx] ?? '').trim() };
    headers.forEach((h, i) => {
      if (i !== phoneIdx) o[h] = String(r[i] ?? '').trim();
    });
    return o;
  });
  return { list, cols };
}

function setContacts(list, cols, source) {
  contacts = list;
  columns = cols;
  const seen = new Set();
  let valid = 0,
    invalid = 0,
    dup = 0;
  const badSamples = [];
  for (const c of list) {
    const p = normalizePhone(c.phone);
    if (!p) {
      invalid++;
      if (badSamples.length < 5) badSamples.push(c.phone || '(vide)');
    } else if (seen.has(p)) dup++;
    else seen.add(p), valid++;
  }
  const info = $('contactsInfo');
  info.hidden = false;
  info.innerHTML =
    `<b>${valid}</b> numéro(s) valide(s) depuis ${esc(source)}` +
    (dup ? ` · ${dup} doublon(s) ignoré(s)` : '') +
    (invalid ? `<br><span class="warn">${invalid} numéro(s) invalide(s) ignoré(s), ex : ${badSamples.map(esc).join(', ')}</span>` : '') +
    (cols.length ? `<br>Colonnes disponibles : ${cols.map((c) => `<code>{${esc(c)}}</code>`).join(' ')}` : '');
  if (valid === 0) info.innerHTML += '<br><span class="warn">Aucun numéro valide trouvé.</span>';
  validCount = valid;
  renderChips();
  updatePreview();
  updateEstimate();
  updateLaunch();
}
let validCount = 0;

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (!window.XLSX) throw new Error('Lecteur Excel non chargé, vérifiez votre connexion.');
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const { list, cols } = rowsToContacts(rows);
    setContacts(list, cols, f.name);
  } catch (err) {
    $('contactsInfo').hidden = false;
    $('contactsInfo').innerHTML = `<span class="warn">Impossible de lire le fichier : ${esc(err.message)}</span>`;
  }
});

$('usePaste').addEventListener('click', () => {
  const rows = $('paste')
    .value.split(/\r?\n/)
    .map((l) => l.split(/[;\t,]/).map((x) => x.trim()));
  const { list, cols } = rowsToContacts(rows);
  setContacts(list, cols, 'la liste collée');
});

// ---------- 2. message ----------
function renderChips() {
  const vars = columns.length ? columns : ['prenom'];
  $('varChips').innerHTML =
    vars.map((v) => `<button type="button" class="chip" data-ins="{${esc(v)}}">+ {${esc(v)}}</button>`).join('') +
    `<button type="button" class="chip" data-ins="{Salut|Bonjour|Hello}">+ variantes</button>`;
}
$('varChips').addEventListener('click', (e) => {
  const ins = e.target.dataset?.ins;
  if (!ins) return;
  const t = $('template');
  const a = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, a) + ins + t.value.slice(t.selectionEnd ?? a);
  t.focus();
  t.selectionStart = t.selectionEnd = a + ins.length;
  onTemplateChange();
});
renderChips();

let previewTimer = null;
function onTemplateChange() {
  $('charCount').textContent = `${$('template').value.length} / 4000`;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 300);
  updateLaunch();
}
$('template').addEventListener('input', onTemplateChange);

async function updatePreview() {
  const template = $('template').value;
  if (!template.trim()) return ($('previewBox').hidden = true);
  try {
    const seen = new Set();
    const sample = contacts
      .filter((c) => {
        const p = normalizePhone(c.phone);
        if (!p || seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .slice(0, 3);
    const r = await api('/preview', { body: { template, contacts: sample } });
    const missing = r.variables.filter((v) => contacts.length && !columns.includes(v));
    $('previews').innerHTML =
      (missing.length
        ? `<div class="error small-text">Colonne(s) absente(s) du fichier : ${missing.map((m) => `{${esc(m)}}`).join(', ')} (sera remplacée par du vide)</div>`
        : '') +
      r.previews
        .map((p) => `<div class="bubble">${p.phone ? `<span class="to">${esc(p.phone)}</span>` : ''}${esc(p.text)}</div>`)
        .join('');
    $('previewBox').hidden = false;
  } catch {}
}

// ---------- 3. rythme ----------
function settings() {
  return {
    minDelay: Number($('minDelay').value),
    maxDelay: Number($('maxDelay').value),
    batchSize: Number($('batchSize').value),
    batchPauseMin: Number($('batchPauseMin').value),
  };
}
function updateEstimate() {
  const s = settings();
  const n = validCount;
  if (!n) return ($('estimate').textContent = '');
  const avg = (s.minDelay + Math.max(s.minDelay, s.maxDelay)) / 2 + 1;
  const big = s.batchSize > 0 ? Math.floor((n - 1) / s.batchSize) * s.batchPauseMin * 60 * 1.25 : 0;
  $('estimate').textContent = `Durée estimée pour ${n} messages : environ ${fmtDuration(n * avg + big)}. Laissez le serveur allumé pendant l’envoi (vous pouvez fermer cette page).`;
}
['minDelay', 'maxDelay', 'batchSize', 'batchPauseMin'].forEach((id) => $(id).addEventListener('input', updateEstimate));

// ---------- 4. test ----------
$('sendTest').addEventListener('click', async () => {
  const out = $('testResult');
  out.className = 'small-text';
  out.textContent = 'Envoi…';
  $('sendTest').disabled = true;
  try {
    const first = contacts.find((c) => normalizePhone(c.phone)) || {};
    const { phone, ...fields } = first;
    const r = await api('/test', { body: { phone: $('testPhone').value, template: $('template').value, fields } });
    out.className = 'small-text ok';
    out.textContent = `Envoyé à ${r.to}. Vérifiez votre WhatsApp.`;
  } catch (err) {
    out.className = 'small-text error';
    out.textContent = err.message;
  } finally {
    $('sendTest').disabled = false;
  }
});

// ---------- 5. lancement ----------
function updateLaunch() {
  $('launch').disabled = !(validCount > 0 && $('template').value.trim());
}
$('launch').addEventListener('click', async () => {
  $('launchError').textContent = '';
  if (!confirm(`Envoyer ce message à ${validCount} contact(s) ?`)) return;
  $('launch').disabled = true;
  try {
    const r = await api('/campaigns', {
      body: { name: $('campaignName').value, template: $('template').value, contacts, settings: settings() },
    });
    await api(`/campaigns/${r.campaign.id}/start`, { body: {} });
    // réinitialiser le formulaire
    contacts = [];
    columns = [];
    validCount = 0;
    $('file').value = '';
    $('paste').value = '';
    $('campaignName').value = '';
    $('contactsInfo').hidden = true;
    renderChips();
    switchTab('list');
  } catch (err) {
    $('launchError').textContent = err.message;
  } finally {
    updateLaunch();
  }
});

// ---------- campagnes ----------
const STATUS = { ready: 'Prête', running: 'En cours', paused: 'En pause', done: 'Terminée', stopped: 'Arrêtée' };

async function loadCampaigns() {
  try {
    const list = await api('/campaigns');
    renderCampaigns(list);
  } catch {}
}

function renderCampaigns(list) {
  if (!list.length) {
    $('campaigns').innerHTML = '<div class="empty">Aucune campagne pour l’instant.</div>';
    return;
  }
  $('campaigns').innerHTML = list
    .map((c) => {
      const s = c.stats;
      const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
      let next = '';
      if (c.status === 'running' && c.nextSendAt) {
        const sec = Math.max(0, (new Date(c.nextSendAt) - Date.now()) / 1000);
        next = ` · prochain envoi dans ${fmtDuration(sec)}`;
      }
      const actions = [];
      if (c.status === 'running') actions.push(['pause', 'Pause']);
      if (['ready', 'paused'].includes(c.status) && s.pending) actions.push(['start', c.status === 'ready' ? 'Lancer' : 'Reprendre', 'primary']);
      if (['running', 'paused', 'ready'].includes(c.status)) actions.push(['stop', 'Arrêter', 'danger']);
      if (s.failed && c.status !== 'running') actions.push(['retry-failed', 'Relancer les échecs']);
      actions.push(['detail', 'Détail']);
      actions.push(['export', 'Exporter CSV']);
      if (c.status !== 'running') actions.push(['delete', 'Supprimer', 'danger']);
      return `
      <div class="card camp">
        <div class="row between">
          <h3>${esc(c.name)}</h3>
          <span class="badge ${c.status}">${STATUS[c.status] || c.status}</span>
        </div>
        <div class="progress"><div class="s" style="width:${pct(s.sent)}%"></div><div class="f" style="width:${pct(s.failed)}%"></div></div>
        <div class="counts">
          <span><b>${s.sent}</b> envoyés</span>
          <span><b>${s.failed}</b> échecs</span>
          <span><b>${s.pending}</b> en attente</span>
          <span>sur ${s.total}${next}</span>
        </div>
        ${c.lastError ? `<div class="alert">${esc(c.lastError)}</div>` : ''}
        <div class="row actions">
          ${actions.map(([a, label, cls]) => `<button class="small ${cls || ''}" data-act="${a}" data-id="${c.id}">${label}</button>`).join('')}
        </div>
      </div>`;
    })
    .join('');
}

$('campaigns').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  try {
    if (act === 'detail') return openDetail(id);
    if (act === 'export') return (window.location = `/api/campaigns/${id}/export.csv`);
    if (act === 'delete') {
      if (!confirm('Supprimer cette campagne et son historique ?')) return;
      await api(`/campaigns/${id}`, { method: 'DELETE' });
    } else if (act === 'stop') {
      if (!confirm('Arrêter définitivement cette campagne ? Les messages non envoyés ne partiront pas.')) return;
      await api(`/campaigns/${id}/stop`, { body: {} });
    } else {
      await api(`/campaigns/${id}/${act}`, { body: {} });
    }
    loadCampaigns();
  } catch (err) {
    alert(err.message);
  }
});

let detailData = null;
async function openDetail(id) {
  detailData = await api(`/campaigns/${id}`);
  $('detailTitle').textContent = detailData.name;
  $('detailFilter').value = '';
  renderDetail();
  $('detail').showModal();
}
function renderDetail() {
  const f = $('detailFilter').value;
  const rows = detailData.contacts.filter((c) => !f || c.status === f);
  const label = { sent: 'Envoyé', failed: 'Échec', pending: 'En attente' };
  $('detailTable').innerHTML =
    '<tr><th>Numéro</th><th>Statut</th><th>Heure</th><th>Message / erreur</th></tr>' +
    rows
      .slice(0, 1000)
      .map(
        (c) => `<tr>
          <td>${esc(c.phone)}</td>
          <td>${label[c.status] || c.status}</td>
          <td>${c.sentAt ? new Date(c.sentAt).toLocaleTimeString('fr-FR') : ''}</td>
          <td class="${c.error ? 'err' : 'msg'}">${esc(c.error || c.text || '')}</td>
        </tr>`,
      )
      .join('') +
    (rows.length > 1000 ? `<tr><td colspan="4" class="muted">… ${rows.length - 1000} autres (voir l’export CSV)</td></tr>` : '');
}
$('detailFilter').addEventListener('change', renderDetail);

// ---------- démarrage ----------
(async () => {
  try {
    const me = await api('/me');
    me.authed ? showApp(me.dryRun) : showLogin();
  } catch {
    showLogin();
  }
})();
