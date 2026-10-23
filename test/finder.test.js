const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adChannelNames, classify, extractInviteCodes, isAdChannelName } = require('../src/finder/classify');
const { createFinder: realCreateFinder } = require('../src/finder');
const { discoverFromRoblox } = require('../src/finder/roblox');

// Tests never reach Roblox; the discovery test below feeds it fake responses.
const createFinder = (opts) => realCreateFinder({ discover: async () => ({ groups: 0, invites: 0 }), ...opts });

test('extracts invite codes from ads', () => {
  const ad = 'Join us! discord.gg/LibertyRP and https://discord.com/invite/AbC-12 (again: discord.gg/LibertyRP)';
  assert.deepStrictEqual(extractInviteCodes(ad), ['libertyrp', 'abc-12']);
});

test('classifies ER:LC roleplay, design and misc servers', () => {
  assert.strictEqual(classify('Florida State Roleplay', 'ER:LC roleplay with daily SSUs, sheriff and fire departments').category, 'roleplay');
  assert.strictEqual(classify('Nova Designs', 'ERLC liveries, uniforms and server setups. Commissions open!').category, 'design');
  assert.strictEqual(classify('ERLC Hub', 'The biggest ER;LC community hub. Partnerships open').category, 'misc');
  assert.strictEqual(classify('𝐄𝐑𝐋𝐂 𝐑𝐨𝐥𝐞𝐩𝐥𝐚𝐲', 'Liberty County sessions').category, 'roleplay');
  assert.strictEqual(classify('Minecraft SMP', 'Survival roleplay server').category, 'unrelated');
});

test('detects servers that take ads / partnerships', () => {
  assert.ok(classify('x', 'ERLC RP, partnerships open').acceptsAds);
  assert.ok(!classify('x', 'ERLC RP, daily sessions').acceptsAds);
});

test('detects servers that sell ads', () => {
  for (const text of ['Paid ads open!', 'Buy an ad for 200 robux', 'Ad prices in #shop', '@everyone ping ads available', 'Sponsored posts', '100 R$ per ad']) {
    assert.ok(classify('ERLC Hub', text).sellsAds, text);
  }
  for (const text of ['Partnerships open', 'ERLC RP with daily sessions', 'Read the ad rules']) {
    assert.ok(!classify('ERLC Hub', text).sellsAds, text);
  }
});

test('spots community / advertisements / paid ads channels', () => {
  const names = ['general', '📢・advertisements', '┃paid-ads', 'community', 'community-chat', 'paid_advertisement', 'ads-rules', 'communityx', 'unpaid'];
  assert.deepStrictEqual(adChannelNames(names), ['📢・advertisements', '┃paid-ads', 'community', 'community-chat', 'paid_advertisement']);
});

test('collects ads from watched channels and searches them', async () => {
  const dataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');
  const guilds = {
    staterp: { id: '1', name: 'State Roleplay', description: 'ER:LC roleplay, daily SSU', members: 900 },
    nova: { id: '2', name: 'Nova Designs', description: 'ERLC liveries and uniforms', members: 300 },
    mc: { id: '3', name: 'Block SMP', description: 'Minecraft', members: 5000 },
    hub: { id: '4', name: 'ERLC Central', description: 'ER:LC hub', members: 50, channel: '💸┃paid-ads' },
    partner: { id: '5', name: 'Partner County RP', description: 'ER:LC roleplay', members: 700 },
  };
  const client = {
    guilds: { cache: new Map() },
    on() {},
    async fetchInvite(code) {
      const g = guilds[code];
      if (!g) throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
      return { guild: { id: g.id, name: g.name, description: g.description, vanityURLCode: null, iconURL: () => null }, channel: { name: g.channel ?? 'welcome' }, memberCount: g.members, presenceCount: 10 };
    },
  };
  const finder = createFinder({ client, dataPath });
  assert.deepStrictEqual(finder.commands.map((c) => c.name), ['find', 'finder']);

  const replies = [];
  const interaction = (sub, values = {}, user = 'owner') => ({
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: sub === 'search' ? 'find' : 'finder',
    user: { id: user },
    guildId: 'home',
    memberPermissions: { has: () => false },
    options: {
      getSubcommand: () => sub,
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
      getChannel: (n) => values[n],
    },
    reply: async (r) => replies.push(r),
    deferReply: async () => {},
    editReply: async (r) => replies.push(r),
  });

  await finder.handleInteraction(interaction('watch', { channel: { id: 'ads' } }));
  for (const content of [
    'ERLC RP - paid ads open, 500 robux per ad discord.gg/staterp',
    'Best ERLC designs, buy an ad today discord.gg/nova',
    'ERLC RP, partnerships open discord.gg/partner', // only advertises itself, sells nothing
    'discord.gg/mc',
    'discord.gg/dead',
  ]) {
    finder.handleMessage({ guildId: 'home', channelId: 'ads', id: content, content, embeds: [] });
  }
  finder.handleMessage({ guildId: 'home', channelId: 'other', id: 'x', content: 'discord.gg/ignored', embeds: [] });

  // Let the 2s lookup timer work through the 5 queued invites.
  finder.start();
  await new Promise((r) => setTimeout(r, 2_000 * 5 + 500));

  await finder.handleInteraction(interaction('search'));
  const text = JSON.stringify(replies.at(-1));
  assert.match(text, /discord\.gg\/staterp/);
  assert.match(text, /discord\.gg\/nova/);
  assert.doesNotMatch(text, /discord\.gg\/mc\b/);
  // Servers that don't sell ads are still listed, after the ones you can buy an ad in.
  assert.ok(text.indexOf('discord.gg/partner') > text.indexOf('discord.gg/staterp'));

  // The invite points at a paid ads channel, so that channel is recorded.
  await finder.handleInteraction(interaction('add', { invite: 'discord.gg/hub' }));
  await finder.handleInteraction(interaction('info', { server: 'discord.gg/hub' }));
  assert.match(JSON.stringify(replies.at(-1)), /Ad channels:\*\* #💸┃paid-ads/);

  await finder.handleInteraction(interaction('search', { category: 'design' }));
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /discord\.gg\/staterp/);

  await finder.handleInteraction(interaction('category', { server: 'Nova Designs', category: 'misc' }));
  await finder.handleInteraction(interaction('search', { category: 'misc' }));
  assert.match(JSON.stringify(replies.at(-1)), /discord\.gg\/nova/);
});

test('/find shows 15 servers at a time with a Next 15 button', async () => {
  const dataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');
  const client = {
    async fetchInvite(code) {
      const n = Number(code.slice(1));
      return { guild: { id: String(n), name: `ERLC Roleplay ${n}`, description: 'ER:LC roleplay, paid ads available', vanityURLCode: null, iconURL: () => null }, memberCount: 1000 - n };
    },
  };
  const finder = createFinder({ client, dataPath });
  let reply;
  const base = { user: { id: 'u' }, guildId: 'home', isButton: () => false, isChatInputCommand: () => true };
  for (let n = 1; n <= 20; n++) {
    await finder.handleInteraction({
      ...base,
      commandName: 'finder',
      options: { getSubcommand: () => 'add', getString: () => `discord.gg/s${n}` },
      deferReply: async () => {},
      editReply: async () => {},
    });
  }

  await finder.handleInteraction({ ...base, commandName: 'find', options: { getString: () => null, getInteger: () => null }, reply: async (r) => (reply = r) });
  let text = JSON.stringify(reply);
  assert.match(text, /20 found/);
  assert.match(text, /discord\.gg\/s15\b/);
  assert.doesNotMatch(text, /discord\.gg\/s16\b/);

  const next = reply.components[0].components.at(-1).components[1];
  assert.strictEqual(next.label, 'Next 15');
  await finder.handleInteraction({ isButton: () => true, customId: next.custom_id, update: async (r) => (reply = r) });
  text = JSON.stringify(reply);
  assert.match(text, /discord\.gg\/s16\b/);
  assert.match(text, /discord\.gg\/s20\b/);
  assert.doesNotMatch(text, /discord\.gg\/s15\b/);
});

test('only allowed users can use the finder', async () => {
  const dataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');
  const finder = createFinder({ client: {}, dataPath, allowedUserIds: ['1068719082700029952', '737181735846019112'] });
  const run = async (userId) => {
    let reply;
    await finder.handleInteraction({
      user: { id: userId },
      commandName: 'find',
      isButton: () => false,
      isChatInputCommand: () => true,
      options: { getString: () => null, getInteger: () => null },
      reply: async (r) => (reply = JSON.stringify(r)),
    });
    return reply;
  };
  assert.match(await run('123'), /Not Allowed/);
  assert.match(await run('737181735846019112'), /ER:LC All Server Links/);
  assert.match(await run('1068719082700029952'), /ER:LC All Server Links/);
});

test('recognises ad / partner channels to watch automatically', () => {
  for (const name of ['📢・advertisements', '┃partners', 'partnerships', 'self-promo', 'server-ads', 'paid-ads', 'ads']) assert.ok(isAdChannelName(name), name);
  for (const name of ['general', 'roads', 'admin-chat', 'downloads']) assert.ok(!isAdChannelName(name), name);
});

test('watches and reads ad channels in servers the bot is in', async () => {
  const dataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');
  const messages = new Map([['m1', { id: 'm1', content: 'ERLC Designs | paid ads open https://discord.gg/pulsecustoms', embeds: [] }]]);
  messages.lastKey = () => 'm1';
  const fetched = [];
  const adChannel = {
    id: 'c1', guildId: 'g1', name: '📢・advertisements', type: 0,
    messages: { fetch: async ({ before }) => (fetched.push(before), before ? new Map() : messages) },
  };
  const general = { id: 'c2', guildId: 'g1', name: 'general', type: 0 };
  const guild = { id: 'g1', name: 'Ad Hub', channels: { cache: new Map([['c1', adChannel], ['c2', general]]) } };
  const client = {
    guilds: { cache: new Map([['g1', guild]]) },
    on() {},
    async fetchInvite(code) {
      return { guild: { id: '9', name: 'Pulse Customs', description: 'ER:LC liveries and designs', vanityURLCode: code, iconURL: () => null }, memberCount: 500 };
    },
  };
  const finder = createFinder({ client, dataPath });
  finder.start();
  await new Promise((r) => setTimeout(r, 2_500));

  let reply;
  await finder.handleInteraction({
    user: { id: 'u' }, commandName: 'find', isButton: () => false, isChatInputCommand: () => true,
    options: { getString: () => null, getInteger: () => null }, reply: async (r) => (reply = JSON.stringify(r)),
  });
  assert.match(reply, /https:\/\/discord\.gg\/pulsecustoms/);
});

test('/finder add takes several links at once', async () => {
  const dataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), 'finder.json');
  const guilds = {
    pulsecustoms: { id: '1', name: 'Pulse Customs', description: 'ER:LC designs, paid ads open' },
    staterp: { id: '2', name: 'State RP', description: 'ER:LC roleplay' },
    mc: { id: '3', name: 'Block SMP', description: 'Minecraft' },
  };
  const client = {
    async fetchInvite(code) {
      const g = guilds[code];
      if (!g) throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
      return { guild: { ...g, vanityURLCode: null, iconURL: () => null }, memberCount: 10 };
    },
  };
  const finder = createFinder({ client, dataPath });
  let reply;
  await finder.handleInteraction({
    user: { id: 'u' }, guildId: 'home', commandName: 'finder', isButton: () => false, isChatInputCommand: () => true,
    options: { getSubcommand: () => 'add', getString: () => 'discord.gg/pulsecustoms discord.gg/staterp https://discord.gg/mc discord.gg/gone' },
    deferReply: async () => {},
    editReply: async (r) => (reply = JSON.stringify(r)),
  });
  assert.match(reply, /pulsecustoms — added \(Design\)/);
  assert.match(reply, /staterp — ER:LC, but no ad selling seen/);
  assert.match(reply, /mc — not ER:LC related/);
  assert.match(reply, /gone` — expired or invalid/);
});

test('finds ER:LC Discord links from Roblox groups with no setup', async () => {
  const responses = {
    'groups/search': (url) =>
      url.includes('keyword=erlc&')
        ? { data: [{ id: 1, name: 'Pulse Customs', description: 'ERLC liveries' }, { id: 2, name: 'State RP', description: 'ER:LC RP discord.gg/staterp' }] }
        : { data: [{ id: 1, name: 'Pulse Customs', description: 'ERLC liveries' }] },
    'groups/1/social-links': () => ({ data: [{ type: 'Discord', url: 'https://discord.gg/pulsecustoms' }] }),
    'groups/2/social-links': () => ({ data: [] }),
  };
  const fetchImpl = async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    return { ok: true, status: 200, json: async () => responses[key](url) };
  };
  const found = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => (fn(), 0); // skip the polite delays between requests
  try {
    const result = await discoverFromRoblox({ fetchImpl, onInvite: (code, text) => found.push([code, text]) });
    assert.deepStrictEqual(result, { groups: 2, invites: 2 });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepStrictEqual(found.map(([code]) => code).sort(), ['pulsecustoms', 'staterp']);
  assert.match(found.find(([code]) => code === 'pulsecustoms')[1], /ERLC liveries/);
});
