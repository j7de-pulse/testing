// JSON file storage for the server finder. On Railway, put FINDER_DATA_PATH on a volume
// (e.g. /data/finder.json) or the list is wiped on every redeploy.

const fs = require('node:fs');
const path = require('node:path');

// Bump to wipe stored data on the next start (the format or the sources changed).
const VERSION = 2;

class FinderStore {
  constructor(file) {
    this.file = file;
    this.data = { version: VERSION, servers: {}, invites: {}, sources: {}, sourceState: {} };
    this.saveTimer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version === VERSION) this.data = { ...this.data, ...saved };
      else console.log('Finder: stored data is from the old finder, starting fresh');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${file}, starting empty:`, err);
    }
    this.save();
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

  /** What the last run of a listing site returned, for /finder stats. */
  setSourceReport(name, report) {
    this.data.sources[name] = { ...report, at: Date.now() };
    this.save();
  }
}

module.exports = { FinderStore };
