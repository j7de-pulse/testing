const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFinder, extractInviteCodes } = require('../src/finder');

const tempPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');

/** Fake Discord: invite code "m<members>" is a server with that many members; "dead" doesn't exist. */
const fakeClient = () => ({
  async fetchInvite(code) {
    if (!code.startsWith('m')) throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
    const members = Number(code.slice(1).split('x')[0]);
    return { guild: { id: code, name: `Server ${code}`, vanityURLCode: null }, memberCount: members, presenceCount: 1 };
  },
});

const command = (finder, name, { sub, values = {}, user = 'u' } = {}) => {
  let reply;
  const done = async (r) => (reply = JSON.stringify(r));
  return finder
    .handleInteraction({
      user: { id: user },
      commandName: name,
      isButton: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommand: () => sub, getString: (n) => values[n] ?? null, getInteger: (n) => values[n] ?? null },
      reply: done,
      deferReply: async () => {},
      editReply: done,
    })
    .then(() => reply);
};

const add = (finder, codes) => command(finder, 'finder', { sub: 'add', values: { invite: codes.map((c) => `discord.gg/${c}`).join(' ') } });

test('keeps invite codes case-sensitive', () => {
  assert.deepStrictEqual(extractInviteCodes('discord.gg/AbC-12 https://discord.com/invite/XyZ discord.gg/AbC-12'), ['AbC-12', 'XyZ']);
});

test('/find lists 300+ servers biggest first under size headings', async () => {
  const finder = createFinder({ client: fakeClient(), dataPath: tempPath(), sources: [] });
  const reply = await add(finder, ['m12000', 'm6000', 'm1500', 'm450', 'm299', 'dead']);
  assert.match(reply, /m299 — only 299 members, hidden/);
  assert.match(reply, /dead` — expired or invalid/);

  const text = await command(finder, 'find');
  const order = ['10,000\\+ members', 'm12000', '5,000\\+ members', 'm6000', '1,000\\+ members', 'm1500', '300\\+ members', 'm450'];
  let at = -1;
  for (const part of order) {
    const next = text.search(new RegExp(part));
    assert.ok(next > at, `${part} should come after the previous item`);
    at = next;
  }
  assert.doesNotMatch(text, /m299/);
  assert.match(text, /4 found/);
});

test('/find size shows only servers at least that big', async () => {
  const finder = createFinder({ client: fakeClient(), dataPath: tempPath(), sources: [] });
  await add(finder, ['m12000', 'm6000', 'm1500', 'm450']);
  const text = await command(finder, 'find', { values: { size: 5000 } });
  assert.match(text, /5,000\+ Members/);
  assert.match(text, /m12000/);
  assert.match(text, /m6000/);
  assert.doesNotMatch(text, /m1500|m450/);
});

test('/find pages 15 at a time', async () => {
  const finder = createFinder({ client: fakeClient(), dataPath: tempPath(), sources: [] });
  await add(finder, Array.from({ length: 20 }, (_, i) => `m${1000 + i}`));
  let reply = JSON.parse(await command(finder, 'find'));
  let text = JSON.stringify(reply);
  assert.match(text, /m1019/);
  assert.doesNotMatch(text, /m1004\b/);

  const next = reply.components[0].components.at(-1).components[1];
  assert.strictEqual(next.label, 'Next 15');
  await finder.handleInteraction({ isButton: () => true, customId: next.custom_id, update: async (r) => (text = JSON.stringify(r)) });
  assert.match(text, /m1004\b/);
  assert.match(text, /m1000\b/);
  assert.doesNotMatch(text, /m1019/);
});

test('reads listing sites and checks every invite on Discord', async () => {
  const source = {
    name: 'Test Site',
    run: async ({ onServer }) => {
      for (const entry of [{ invite: 'https://discord.gg/m2500', members: 2400 }, { invite: 'discord.gg/m50', members: 50 }, { invite: 'discord.gg/dead' }]) onServer(entry);
      return { listed: 3 };
    },
  };
  const finder = createFinder({ client: fakeClient(), dataPath: tempPath(), sources: [source] });
  finder.start();
  await new Promise((r) => setTimeout(r, 2_500));

  assert.match(await command(finder, 'find'), /m2500/);
  const stats = await command(finder, 'finder', { sub: 'stats' });
  assert.match(stats, /Test Site\*\* <t:\d+:R>: 3 servers listed, 2 invites/); // m50 is skipped as clearly too small
  assert.match(stats, /1,000\+:\*\* 1/);
});

test('wipes data saved by the old finder', async () => {
  const dataPath = tempPath();
  fs.writeFileSync(dataPath, JSON.stringify({ servers: { 1: { guildId: '1', inviteCode: 'old', members: 9000 } }, invites: {} }));
  const finder = createFinder({ client: fakeClient(), dataPath, sources: [] });
  assert.doesNotMatch(await command(finder, 'find'), /discord\.gg\/old/);
});

test('only allowed users can use the finder', async () => {
  const finder = createFinder({ client: fakeClient(), dataPath: tempPath(), sources: [], allowedUserIds: ['1068719082700029952'] });
  assert.match(await command(finder, 'find', { user: '123' }), /Not Allowed/);
  assert.match(await command(finder, 'find', { user: '1068719082700029952' }), /ER:LC Servers/);
});

test('reads Melonly server records from listing and server pages', () => {
  const { parseMelonly } = require('../src/finder/sources');
  // Layouts copied from melonly.com: the /servers listing, and a server's own page.
  const listing = String.raw`{"server":{"id":"7135971778748223488","content":{"name":"Jakarta City Roleplay","socials":[{"type":1,"value":"HgK5ASCURB"},{"type":2,"value":"jkc.roleplay.erlc"}],"joinCode":"jkcrp","discordMembers":1938,"erlcPlayercount":0},"createdAt":1,"verified":null,"urlValue":"jakarta-city-roleplay","promoted":false},"rating":4.9},{"server":{"id":"7195145349101522944","content":{"name":"LA","socials":[{"type":4,"value":"32540001/LOSRPC"}],"discordMembers":10},"urlValue":"la"}}`;
  const page = String.raw`["$","$L61",null,{"server":{"id":"7135971778748223488","serverId":"7135603082343223296","createdAt":1,"content":{"name":"Idaho","socials":[{"type":0,"value":"yt"},{"type":1,"value":"idaho"}],"description":"say \"hi\"","discordMembers":8751},"urlValue":"idaho-state-roleplay-5"}}]`;
  assert.deepStrictEqual(parseMelonly(listing), [{ slug: 'jakarta-city-roleplay', invite: 'HgK5ASCURB', members: 1938 }]);
  assert.deepStrictEqual(parseMelonly(page), [{ slug: 'idaho-state-roleplay-5', invite: 'idaho', members: 8751 }]);
});

test('reads aderlc.xyz pages, member counts and invite redirects', async () => {
  const { SOURCES } = require('../src/finder/sources');
  const aderlc = SOURCES.find((s) => s.name === 'aderlc.xyz');
  const pages = { 1: ['8', '268', '943'], 2: ['12'], 3: ['12'] }; // a page past the end repeats the last page
  const counts = { 8: 3789, 268: 390, 943: null, 12: 40 };
  const invites = { 8: 'https://discord.gg/yzd9f97hem', 268: 'https://discord.gg/7X57KSzZAw', 943: 'https://discord.gg/wxrldz', 12: 'https://discord.gg/small' };
  const requested = [];
  const fetchImpl = async (url, opts) => {
    requested.push(url);
    const page = url.match(/discovery\?page=(\d+)/);
    if (page) return new Response((pages[page[1]] ?? pages[3]).map((id) => `<a href="/discovery/${id}" class="x">`).join(''));
    if (url.includes('member-counts')) {
      const ids = new URL(url).searchParams.get('listing_ids').split(',');
      return Response.json({ listings: Object.fromEntries(ids.map((id) => [id, counts[id]])) });
    }
    const id = url.match(/discovery\/(\d+)\/invite/)[1];
    assert.strictEqual(opts.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: invites[id] } });
  };
  const found = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => (fn(), 0); // skip the polite gaps between requests
  let result;
  try {
    result = await aderlc.run({ fetchImpl, onServer: (e) => found.push(e), state: {}, save() {} });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepStrictEqual(result, { listed: 4 });
  assert.deepStrictEqual(found, [
    { invite: 'https://discord.gg/yzd9f97hem', members: 3789 },
    { invite: 'https://discord.gg/7X57KSzZAw', members: 390 },
    { invite: 'https://discord.gg/wxrldz', members: null },
  ]);
  assert.ok(!requested.some((u) => u.includes('/discovery/12/invite')), 'a 40-member server is not followed');
});
