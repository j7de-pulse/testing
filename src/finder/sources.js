// ER:LC server listing sites the finder reads. Each source is { name, run(ctx) } where run calls
// ctx.onServer({ invite, members }) for every server it finds (`invite` holds a Discord invite link
// or code, `members` is the site's own count or null) and resolves to { listed }.
// ctx also has fetchImpl, a persistent `state` object for the source, and save() to store it.

const USER_AGENT = 'ERLC-Server-Finder/1.0 (Discord bot)';
const PAGE_GAP_MS = 1_500; // one page every 1.5s, gentle on the sites
const MIN_SITE_MEMBERS = 150; // sites' counts can be stale: only skip servers clearly far below 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(fetchImpl, url, options = {}) {
  await sleep(PAGE_GAP_MS);
  const res = await fetchImpl(url, { ...options, headers: { 'user-agent': USER_AGENT, ...options.headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok && !(options.redirect === 'manual' && res.status >= 300 && res.status < 400)) throw new Error(`${res.status} from ${url}`);
  return res;
}

// ---- aderlc.xyz ------------------------------------------------------------------------
// /discovery?page=N lists 12 servers a page (a page past the end repeats the last one).
// The page loads member counts from /api/listings/member-counts, and /discovery/<id>/invite
// redirects to the server's Discord invite.

const ADERLC = 'https://www.aderlc.xyz';

async function runAderlc({ fetchImpl, onServer }) {
  const ids = new Set();
  for (let page = 1; page <= 500; page++) {
    const html = await (await get(fetchImpl, `${ADERLC}/discovery?page=${page}`)).text();
    const before = ids.size;
    for (const [, id] of html.matchAll(/href="\/discovery\/(\d+)"/g)) ids.add(id);
    if (ids.size === before) break;
  }

  const all = [...ids];
  const counts = {};
  for (let i = 0; i < all.length; i += 50) {
    const query = new URLSearchParams({ listing_ids: all.slice(i, i + 50).join(',') });
    const body = await (await get(fetchImpl, `${ADERLC}/api/listings/member-counts?${query}`, { headers: { accept: 'application/json' } })).json();
    Object.assign(counts, body.listings ?? {});
  }

  for (const id of all) {
    const members = counts[id] ?? null;
    if (members != null && members < MIN_SITE_MEMBERS) continue;
    try {
      const res = await get(fetchImpl, `${ADERLC}/discovery/${id}/invite`, { redirect: 'manual' });
      const invite = res.headers.get('location');
      if (invite) onServer({ invite, members });
    } catch (err) {
      console.warn(`Finder: aderlc listing ${id} has no invite: ${err.message}`);
    }
  }
  return { listed: all.length };
}

// ---- melonly.com -----------------------------------------------------------------------
// Server pages embed each server's record: content.socials (type 1 = Discord invite code) and
// content.discordMembers. /servers holds ~80 featured servers; sitemap.xml lists every server page.
// robots.txt disallows /api/, so only public pages are read.

const MELONLY = 'https://melonly.com';
const RECRAWL_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // re-read a server page every 2 weeks

/** Every server record in a Melonly page: [{ slug, invite, members }]. */
function parseMelonly(html) {
  const text = html.replace(/\\"/g, '"');
  const found = [];
  // Listing pages start a record with "content"; a server's own page puts serverId / dates first.
  for (const match of text.matchAll(/"server":\{"id":"\d+",/g)) {
    const chunk = text.slice(match.index, match.index + 20_000);
    const end = chunk.indexOf('"urlValue"');
    const record = end === -1 ? chunk.slice(0, 5_000) : chunk.slice(0, end + 200);
    const discord = record.match(/\{"type":1,"value":"([^"]+)"\}/);
    const members = record.match(/"discordMembers":(\d+)/);
    const slug = record.match(/"urlValue":"([^"]+)"/);
    if (discord) found.push({ slug: slug?.[1], invite: discord[1], members: members ? Number(members[1]) : null });
  }
  return found;
}

async function runMelonly({ fetchImpl, onServer, state, save }) {
  state.crawled ??= {};
  const report = (entries) => {
    for (const { invite, members } of entries) {
      if (members != null && members < MIN_SITE_MEMBERS) continue;
      onServer({ invite: invite.includes('/') ? invite : `https://discord.gg/${invite}`, members });
    }
  };

  // Featured servers first so /find has results within seconds.
  report(parseMelonly(await (await get(fetchImpl, `${MELONLY}/servers`)).text()));

  const sitemap = await (await get(fetchImpl, `${MELONLY}/sitemap.xml`)).text();
  const slugs = [...new Set([...sitemap.matchAll(/<loc>https:\/\/melonly\.com\/servers\/([^<?#/]+)<\/loc>/g)].map((m) => m[1]))];
  const due = slugs.filter((slug) => Date.now() - (state.crawled[slug] ?? 0) > RECRAWL_AFTER_MS);
  console.log(`Finder: melonly lists ${slugs.length} servers, reading ${due.length} pages`);

  for (const slug of due) {
    try {
      const entries = parseMelonly(await (await get(fetchImpl, `${MELONLY}/servers/${slug}`)).text());
      report(entries.filter((e) => e.slug === slug));
      state.crawled[slug] = Date.now();
      save();
    } catch (err) {
      console.warn(`Finder: melonly page ${slug} failed: ${err.message}`);
    }
  }
  return { listed: slugs.length };
}

const SOURCES = [
  { name: 'aderlc.xyz', run: runAderlc },
  { name: 'melonly.com', run: runMelonly },
];

module.exports = { SOURCES, parseMelonly };
