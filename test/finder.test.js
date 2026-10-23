const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adChannelNames, classify, extractInviteCodes } = require('../src/finder/classify');
const { createFinder } = require('../src/finder');

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
  };
  const client = {
    async fetchInvite(code) {
      const g = guilds[code];
      if (!g) throw Object.assign(new Error('Unknown Invite'), { code: 10006 });
      return { guild: { id: g.id, name: g.name, description: g.description, vanityURLCode: null, iconURL: () => null }, channel: { name: g.channel ?? 'welcome' }, memberCount: g.members, presenceCount: 10 };
    },
  };
  const finder = createFinder({ client, ownerIds: ['owner'], dataPath });
  assert.strictEqual(finder.command.name, 'finder');

  const replies = [];
  const interaction = (sub, values = {}, user = 'owner') => ({
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: 'finder',
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
  for (const content of ['ERLC RP - partnerships open discord.gg/staterp', 'Best ERLC designs discord.gg/nova', 'discord.gg/mc', 'discord.gg/dead']) {
    finder.handleMessage({ guildId: 'home', channelId: 'ads', id: content, content, embeds: [] });
  }
  finder.handleMessage({ guildId: 'home', channelId: 'other', id: 'x', content: 'discord.gg/ignored', embeds: [] });

  // Let the 2s lookup timer work through the 4 queued invites.
  finder.start();
  await new Promise((r) => setTimeout(r, 2_000 * 4 + 500));

  await finder.handleInteraction(interaction('search', { category: 'all' }));
  const text = JSON.stringify(replies.at(-1));
  assert.match(text, /State Roleplay/);
  assert.match(text, /Nova Designs/);
  assert.doesNotMatch(text, /Block SMP/);

  // The invite points at a paid ads channel, so that channel is recorded.
  await finder.handleInteraction(interaction('add', { invite: 'discord.gg/hub' }));
  assert.match(JSON.stringify(replies.at(-1)), /Ad channels:\*\* #💸┃paid-ads/);

  await finder.handleInteraction(interaction('search', { category: 'design' }));
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /State Roleplay/);

  await finder.handleInteraction(interaction('category', { server: 'Nova Designs', category: 'misc' }));
  await finder.handleInteraction(interaction('search', { category: 'misc' }));
  assert.match(JSON.stringify(replies.at(-1)), /Nova Designs/);
});
