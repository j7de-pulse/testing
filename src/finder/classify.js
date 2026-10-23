// Pure text helpers for the ER:LC server finder: pulling invite codes out of ads and
// deciding whether a server is ER:LC related and whether it is roleplay, design or misc.

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([a-z0-9-]{2,32})/gi;

/** Unique invite codes found in `text`, e.g. "discord.gg/abc" -> ["abc"]. */
function extractInviteCodes(text) {
  const codes = new Set();
  for (const match of normalize(text).matchAll(INVITE_RE)) codes.add(match[1]);
  return [...codes];
}

/** Lowercase, fold fancy Unicode fonts (𝐄𝐑𝐋𝐂 -> erlc) and drop markdown noise. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_~`|>]/g, ' ');
}

// [pattern, weight]. Ad text is noisy, so a category wins on total weight, not on a single hit.
const ERLC_TERMS = [
  [/\ber\s*[:;.\-]?\s*lc\b/, 3], // erlc, er:lc, er;lc, er lc
  [/\bliberty\s+county\b/, 3],
  [/\bemergency\s+response\b/, 2],
  [/\bpolice\s+roleplay\s+community\b/, 2],
  [/\bprc\b/, 1],
];

const CATEGORY_TERMS = {
  roleplay: [
    [/\broleplay(s|ing)?\b|\brp\b/, 3],
    [/\bssu\b|\bssd\b|\bsessions?\b/, 2],
    [/\bsheriff|\bpolice\b|\bpd\b|\bhighway\s+patrol|\bstate\s+troopers?\b/, 1],
    [/\bfire\s+(and|&)?\s*(rescue|department)|\bfd\b|\bems\b|\bdot\b|\bcivilians?\b/, 1],
    [/\bdepartments?\b|\bwhitelist(ed)?\b|\bpriority\b|\bcode\s*3\b/, 1],
  ],
  design: [
    [/\bdesigns?\b|\bdesigners?\b|\bdesigning\b/, 3],
    [/\bliver(y|ies)\b|\buniforms?\b|\bclothing\b|\bels\b/, 3],
    [/\bgraphics?\b|\blogos?\b|\bbanners?\b|\bgfx\b/, 2],
    [/\bcommissions?\b|\bshop\b|\bstore\b|\bmarket(place)?\b|\bproducts?\b/, 2],
    [/\bserver\s+setups?\b|\bdiscord\s+setups?\b|\bbots?\s+(dev|development)\b|\bembeds?\b/, 2],
  ],
  misc: [
    [/\bhub\b|\bcommunity\b|\bnetwork\b/, 1],
    [/\badvertis(ing|ement)\s+server|\bad\s+server\b|\bpartner\s+hub\b/, 2],
    [/\bstaff\s+(hub|training)|\bhelp\s*desk\b|\bnews\b|\bleaks?\b|\bmemes?\b/, 2],
  ],
};

// The server advertises or takes partnerships / ads.
const ADS_RE = /\bpartner(ship)?s?\b|\badvertis\w*|\bads?\b|\bpromo(tion)?s?\b|\bad\s*channel|\bp\s*ping\b|\bpartner\s*ping\b/;

const CATEGORIES = ['roleplay', 'design', 'misc'];

function score(text, terms) {
  return terms.reduce((sum, [re, weight]) => sum + (re.test(text) ? weight : 0), 0);
}

/**
 * Classify a server from its name, description and ad text.
 * Returns { erlc, erlcScore, category, scores, acceptsAds } where category is
 * 'roleplay' | 'design' | 'misc', or 'unrelated' when nothing ties it to ER:LC.
 */
function classify(...parts) {
  const text = normalize(parts.filter(Boolean).join('\n'));
  const erlcScore = score(text, ERLC_TERMS);
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, score(text, CATEGORY_TERMS[c])]));
  const erlc = erlcScore >= 2;

  let category = 'unrelated';
  if (erlc) {
    const { roleplay, design, misc } = scores;
    if (design >= 3 && design >= roleplay) category = 'design';
    else if (roleplay >= 3 && roleplay > misc) category = 'roleplay';
    else category = 'misc';
  }
  return { erlc, erlcScore, category, scores, acceptsAds: ADS_RE.test(text) };
}

module.exports = { CATEGORIES, classify, extractInviteCodes, normalize };
