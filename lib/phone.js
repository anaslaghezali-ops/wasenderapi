// Normalise un numéro de téléphone au format E.164 (+212...).
// Par défaut on considère les numéros sans indicatif comme marocains.

const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY_CODE || '212';

function normalizePhone(raw, country = DEFAULT_COUNTRY) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Excel peut transformer un numéro en nombre scientifique (6.12345678E8)
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);

  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    // déjà international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith(country)) {
    // 2126XXXXXXXX
  } else if (digits.startsWith('0')) {
    digits = country + digits.slice(1); // 06XXXXXXXX -> 2126XXXXXXXX
  } else if (country === '212' && digits.length === 9) {
    digits = country + digits; // 6XXXXXXXX (zéro perdu par Excel)
  } else {
    return null;
  }

  // Le Maroc : 212 + 9 chiffres
  if (digits.startsWith('212') && digits.length !== 12) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

module.exports = { normalizePhone };
