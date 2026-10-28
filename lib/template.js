// Rendu des messages :
//   {prenom}            -> remplacé par la colonne "prenom" du contact
//   {Salut|Bonjour|Hey} -> une variante choisie au hasard pour chaque contact
// Les variantes rendent chaque message un peu différent, ce qui limite
// la détection d'envois identiques par WhatsApp.

function normKey(k) {
  return String(k)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_');
}

function normalizeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[normKey(k)] = v === null || v === undefined ? '' : String(v).trim();
  }
  return out;
}

function render(template, fields = {}, rand = Math.random) {
  const f = normalizeFields(fields);
  let text = String(template);
  // Variantes (peuvent contenir des variables, ex: {Salut {prenom}|Bonjour})
  // On traite d'abord les accolades les plus internes contenant un "|".
  let guard = 0;
  const variantRe = /\{([^{}]*\|[^{}]*)\}/;
  // Remplacer d'abord les variables, puis les variantes
  text = text.replace(/\{\s*([^{}|]+?)\s*\}/g, (m, key) => {
    const k = normKey(key);
    return Object.prototype.hasOwnProperty.call(f, k) ? f[k] : '';
  });
  while (variantRe.test(text) && guard++ < 200) {
    text = text.replace(variantRe, (m, inner) => {
      const opts = inner.split('|');
      return opts[Math.floor(rand() * opts.length)];
    });
  }
  // Nettoyage des espaces doubles laissés par une variable vide
  // (on garde l'espace avant ! et ? : typographie française)
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.])/g, '$1').trim();
}

// Liste des variables utilisées dans un modèle (pour avertir si une colonne manque)
function variablesIn(template) {
  const vars = new Set();
  const re = /\{\s*([^{}|]+?)\s*\}/g;
  let m;
  while ((m = re.exec(String(template)))) vars.add(normKey(m[1]));
  return [...vars];
}

module.exports = { render, variablesIn, normalizeFields, normKey };
