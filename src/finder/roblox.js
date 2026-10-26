// Finds ER:LC Discord servers with no setup: searches Roblox's public group search for ER:LC
// communities, follows their allied groups (ER:LC communities ally each other a lot), and reads
// the Discord links those groups publish (social links and description).

const { classify, extractInviteCodes } = require('./classify');

const SEARCH_TERMS = [
  'erlc',
  'er:lc',
  'erlc roleplay',
  'erlc rp',
  'erlc state roleplay',
  'erlc county roleplay',
  'erlc city roleplay',
  'erlc private server',
  'erlc community',
  'erlc hub',
  'erlc sheriff',
  'erlc police',
  'erlc state police',
  'erlc highway patrol',
  'erlc fire department',
  'erlc dot',
  'erlc designs',
  'erlc design',
  'erlc customs',
  'erlc liveries',
  'erlc livery',
  'erlc uniforms',
  'erlc clothing',
  'erlc graphics',
  'erlc els',
  'erlc services',
  'erlc ads',
  'erlc advertising',
  'erlc partners',
  'erlc partnerships',
  'liberty county',
  'liberty county roleplay',
  'liberty county rp',
  'emergency response liberty county',
  'florida state roleplay',
  'california state roleplay',
  'texas state roleplay',
  'new york state roleplay',
  'georgia state roleplay',
];
const PAGES_PER_TERM = 5; // up to 100 groups a page
const MAX_GROUPS = 4000; // cap on groups checked per run, so one run stays under ~1.5 hours
const ALLY_DEPTH = 2; // follow allies of allies, but no further
const REQUEST_GAP_MS = 1_000; // stay polite with Roblox's rate limits

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

const groupText = (group) => `${group.name}\n${group.description ?? ''}`;

/**
 * Search Roblox for ER:LC groups and call onInvite(code, text) for each Discord invite they list.
 * `text` is the group's name and description, used to classify the server.
 */
async function discoverFromRoblox({ onInvite, cookie, fetchImpl = fetch, log = console }) {
  // Counts reported by /finder stats, so a run that finds nothing shows which step failed.
  const report = {
    groups: 0,
    allies: 0,
    invites: 0,
    searchErrors: 0,
    searchError: null,
    linksOk: 0,
    linksFailed: 0,
    linkError: null,
  };
  const seen = new Set();
  const pending = []; // [group, depth]
  const add = (group, depth) => {
    if (seen.has(group.id) || seen.size >= MAX_GROUPS) return false;
    seen.add(group.id);
    pending.push([group, depth]);
    return true;
  };

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
      for (const group of result.data ?? []) add(group, 0);
      cursor = result.nextPageCursor;
      if (!cursor) break;
    }
  }
  // Bigger groups first: they are the most likely to still have a working Discord.
  pending.sort(([a], [b]) => (b.memberCount ?? 0) - (a.memberCount ?? 0));

  while (pending.length) {
    const [group, depth] = pending.shift();
    report.groups++;
    const text = groupText(group);
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

    // ER:LC groups ally other ER:LC groups (departments, design shops, partner servers): follow them.
    if (depth < ALLY_DEPTH && classify(text).erlc) {
      try {
        const allies = await getJson(
          `https://groups.roblox.com/v1/groups/${group.id}/relationships/allies?model.startRowIndex=0&model.maxRows=100`,
          fetchImpl,
          cookie,
        );
        for (const ally of allies.relatedGroups ?? []) {
          if (add(ally, depth + 1)) report.allies++;
        }
      } catch (err) {
        // Allies are a bonus; a failure here doesn't affect the group's own links.
      }
    }
  }
  return report;
}

module.exports = { discoverFromRoblox, SEARCH_TERMS };
