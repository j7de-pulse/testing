// Optional source: ER:LC YouTube videos often link the creator's Discord in the description.
// Uses the official YouTube Data API, so it needs YOUTUBE_API_KEY (free from Google Cloud).

const { extractInviteCodes } = require('./classify');

const SEARCH_TERMS = [
  'erlc roleplay discord',
  'erlc server',
  'erlc ssu',
  'erlc designs',
  'erlc livery pack',
  'erlc customs',
  'liberty county roleplay',
  'erlc private server',
];
// Each search costs 100 of the 10,000 free daily units: 8 terms x 2 pages = 1,600 per run, 4 runs a day fits.
const PAGES_PER_TERM = 2;

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`${res.status}${body.error?.message ? ` ${body.error.message}` : ''}`);
  }
  return res.json();
}

/** Search YouTube for ER:LC videos and call onInvite(code, text) for each Discord invite in their descriptions. */
async function discoverFromYouTube({ onInvite, apiKey, fetchImpl = fetch, log = console }) {
  const report = { videos: 0, invites: 0, error: null };
  const ids = new Set();

  for (const term of SEARCH_TERMS) {
    let pageToken = '';
    for (let page = 0; page < PAGES_PER_TERM; page++) {
      try {
        const url =
          'https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=50&order=date' +
          `&q=${encodeURIComponent(term)}&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;
        const result = await getJson(url, fetchImpl);
        for (const item of result.items ?? []) if (item.id?.videoId) ids.add(item.id.videoId);
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      } catch (err) {
        log.warn(`Finder: YouTube search for "${term}" failed: ${err.message}`);
        report.error ??= err.message;
        break;
      }
    }
  }

  // Search results cut descriptions short; videos.list (1 unit per 50 videos) has the full text.
  const all = [...ids];
  for (let i = 0; i < all.length; i += 50) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${all.slice(i, i + 50).join(',')}&key=${apiKey}`;
      const result = await getJson(url, fetchImpl);
      for (const video of result.items ?? []) {
        report.videos++;
        const text = `${video.snippet.title}\n${video.snippet.channelTitle}\n${video.snippet.description}`;
        for (const code of extractInviteCodes(text)) {
          report.invites++;
          onInvite(code, text);
        }
      }
    } catch (err) {
      log.warn(`Finder: YouTube video lookup failed: ${err.message}`);
      report.error ??= err.message;
    }
  }
  return report;
}

module.exports = { discoverFromYouTube };
