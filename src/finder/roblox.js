// Finds ER:LC Discord servers with no setup: searches Roblox's public group search for ER:LC
// communities and reads the Discord links those groups publish (social links and description).

const { extractInviteCodes } = require('./classify');

const SEARCH_TERMS = [
  'erlc',
  'erlc roleplay',
  'erlc rp',
  'erlc state roleplay',
  'erlc designs',
  'erlc customs',
  'erlc liveries',
  'erlc community',
  'erlc ads',
  'erlc advertising',
  'erlc partners',
  'liberty county roleplay',
  'liberty county rp',
  'emergency response liberty county',
];
const PAGES_PER_TERM = 3; // up to 100 groups a page
const REQUEST_GAP_MS = 1_000; // stay polite with Roblox's unauthenticated rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, fetchImpl, cookie) {
  const headers = { accept: 'application/json' };
  // Read-only GETs: the account cookie only lets Roblox show the Discord links it hides from logged-out visitors.
  if (cookie) headers.cookie = `.ROBLOSECURITY=${cookie}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(REQUEST_GAP_MS);
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) {
      await sleep(30_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return res.json();
  }
  throw new Error(`rate limited by ${url}`);
}

/**
 * Search Roblox for ER:LC groups and call onInvite(code, text) for each Discord invite they list.
 * `text` is the group's name and description, used to classify the server.
 */
async function discoverFromRoblox({ onInvite, cookie, fetchImpl = fetch, log = console }) {
  const seen = new Set();
  // Counts reported by /finder stats, so a run that finds nothing shows which step failed.
  const report = { groups: 0, invites: 0, searchErrors: 0, searchError: null, linksOk: 0, linksFailed: 0, linkError: null };

  for (const term of SEARCH_TERMS) {
    let cursor = '';
    for (let page = 0; page < PAGES_PER_TERM; page++) {
      let result;
      try {
        const url = `https://groups.roblox.com/v1/groups/search?keyword=${encodeURIComponent(term)}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
        result = await getJson(url, fetchImpl, cookie);
      } catch (err) {
        log.warn(`Finder: Roblox group search for "${term}" failed: ${err.message}`);
        report.searchErrors++;
        report.searchError ??= err.message;
        break;
      }

      for (const group of result.data ?? []) {
        if (seen.has(group.id)) continue;
        seen.add(group.id);
        report.groups++;
        const text = `${group.name}\n${group.description ?? ''}`;
        const codes = new Set(extractInviteCodes(text));
        try {
          const links = await getJson(`https://groups.roblox.com/v1/groups/${group.id}/social-links`, fetchImpl, cookie);
          report.linksOk++;
          for (const link of links.data ?? []) {
            for (const code of extractInviteCodes(link.url)) codes.add(code);
          }
        } catch (err) {
          // Some groups hide their links; the description may still have one.
          report.linksFailed++;
          report.linkError ??= err.message;
        }
        for (const code of codes) {
          report.invites++;
          onInvite(code, text);
        }
      }

      cursor = result.nextPageCursor;
      if (!cursor) break;
    }
  }
  return report;
}

module.exports = { discoverFromRoblox, SEARCH_TERMS };
