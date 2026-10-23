// JSON file storage for the server finder. On Railway, put FINDER_DATA_PATH on a volume
// (e.g. /data/finder.json) or the list is wiped on every redeploy.

const fs = require('node:fs');
const path = require('node:path');

class FinderStore {
  constructor(file) {
    this.file = file;
    this.data = { servers: {}, invites: {}, watched: {} };
    this.saveTimer = null;
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${file}, starting empty:`, err);
    }
  }

  /** Save at most once a second; writes go to a temp file first so a crash can't corrupt the list. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (err) {
        console.error('Could not save finder data:', err);
      }
    }, 1000);
  }

  get servers() {
    return Object.values(this.data.servers);
  }

  server(guildId) {
    return this.data.servers[guildId];
  }

  upsertServer(guildId, fields) {
    this.data.servers[guildId] = { ...this.data.servers[guildId], ...fields, guildId };
    this.save();
    return this.data.servers[guildId];
  }

  /** Last lookup of an invite code: { guildId, checkedAt } (guildId null = invalid invite). */
  invite(code) {
    return this.data.invites[code];
  }

  setInvite(code, guildId) {
    this.data.invites[code] = { guildId, checkedAt: Date.now() };
    this.save();
  }

  isWatched(channelId) {
    return Boolean(this.data.watched[channelId]);
  }

  watch(channelId, guildId) {
    this.data.watched[channelId] = { guildId, since: Date.now() };
    this.save();
  }

  unwatch(channelId) {
    const had = this.isWatched(channelId);
    delete this.data.watched[channelId];
    this.save();
    return had;
  }

  watchedIn(guildId) {
    return Object.entries(this.data.watched)
      .filter(([, w]) => w.guildId === guildId)
      .map(([channelId]) => channelId);
  }
}

module.exports = { FinderStore };
