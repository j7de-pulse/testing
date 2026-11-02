// ER:LC server listing sites the finder reads. Each source is { name, url, fetch({ fetchImpl }) }
// and fetch resolves to [{ invite, members? }] where `invite` holds a Discord invite link.
//
// To add: https://www.aderlc.xyz/discovery and https://melonly.com/servers. Their readers are
// written once the pages can be inspected, so the parsing matches how each site actually lists servers.

const SOURCES = [];

module.exports = { SOURCES };
