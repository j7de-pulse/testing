// ER:LC server finder: collects Discord invites from advertisement / partnership channels
// the bot can read (plus manual submissions), looks each one up through Discord's invite API
// and sorts ER:LC servers into roleplay, design and misc.

const {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
} = require('discord.js');
const { CATEGORIES, adChannelNames, classify, extractInviteCodes, isAdChannelName } = require('./classify');
const { FinderStore } = require('./store');
const { discoverFromRoblox } = require('./roblox');

const RESOLVE_INTERVAL_MS = 2_000; // one invite lookup every 2s keeps well under Discord's limits
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // refresh member counts / dead invites daily
const RECHECK_SWEEP_MS = 60 * 60 * 1000;
const DISCOVER_EVERY_MS = 6 * 60 * 60 * 1000; // look for new ER:LC servers on Roblox every 6 hours
const PAGE_SIZE = 15;
const MAX_TEXT = 3900; // Components V2 messages allow 4,000 characters of text in total
const MAX_SCAN = 1000;
const MAX_SOURCES = 25;
const AUTO_SCAN = 500; // messages read from each ad channel the bot finds by itself
const MAX_ADD = 25;
const PAGE_PREFIX = 'finder_page';
const UNKNOWN_INVITE = 10006;

const C = { ACTION_ROW: 1, BUTTON: 2, TEXT: 10, SEPARATOR: 14, CONTAINER: 17 };
const BUTTON_STYLE = { SECONDARY: 2 };

const CATEGORY_LABELS = { roleplay: 'Roleplay', design: 'Design', misc: 'Misc', unrelated: 'Not ER:LC' };
const SORTS = { members: 'Most members', recent: 'Most recently active', ads: 'Most ads seen' };

function textMessage(content, extra = []) {
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [{ type: C.CONTAINER, components: [{ type: C.TEXT, content }, ...extra] }],
  };
}

const ephemeral = (reply) => ({ ...reply, flags: (reply.flags ?? 0) | MessageFlags.Ephemeral });
const notice = (title, body) => ephemeral(textMessage(`### ${title}\n${body}`));
const fmt = (n) => (n ?? 0).toLocaleString('en-US');

/** All text in a message that could hold an ad: content plus embed text (ad bots use embeds). */
function messageText(message) {
  const parts = [message.content];
  for (const embed of message.embeds ?? []) {
    parts.push(embed.title, embed.description, embed.url, embed.author?.name, embed.footer?.text);
    for (const field of embed.fields ?? []) parts.push(field.name, field.value);
  }
  return parts.filter(Boolean).join('\n');
}

function buildCommands() {
  const categoryChoices = [...CATEGORIES, 'all'].map((c) => ({ name: CATEGORY_LABELS[c] ?? 'All', value: c }));
  const find = new SlashCommandBuilder()
    .setName('find')
    .setDescription(`Get Discord links to ER:LC servers, ${PAGE_SIZE} at a time`)
    .addStringOption((o) => o.setName('category').setDescription('Server type (default: all)').addChoices(...categoryChoices))
    .addStringOption((o) => o.setName('query').setDescription('Name contains...').setMaxLength(40))
    .addIntegerOption((o) => o.setName('min_members').setDescription('Minimum member count').setMinValue(0))
    .addStringOption((o) =>
      o
        .setName('sort')
        .setDescription('Sort order (default: most members)')
        .addChoices(...Object.entries(SORTS).map(([value, name]) => ({ name, value }))),
    );
  const finder = new SlashCommandBuilder()
    .setName('finder')
    .setDescription('Manage the ER:LC server finder')
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Show what the finder knows about a server')
        .addStringOption((o) => o.setName('server').setDescription('Invite link, server ID or name').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription(`Submit servers by invite link (up to ${MAX_ADD} at once)`)
        .addStringOption((o) => o.setName('invite').setDescription('One or more links, e.g. discord.gg/abc discord.gg/xyz').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('watch')
        .setDescription('Collect invites from an ad / partnership channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Ad channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unwatch')
        .setDescription('Stop collecting invites from a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Ad channel').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('scan')
        .setDescription("Collect invites from a channel's past messages")
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Ad channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addIntegerOption((o) => o.setName('limit').setDescription(`Messages to read (default 500, max ${MAX_SCAN})`).setMinValue(1).setMaxValue(MAX_SCAN)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('category')
        .setDescription('Fix a server\'s category by hand')
        .addStringOption((o) => o.setName('server').setDescription('Invite link, server ID or name').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('category')
            .setDescription('New category')
            .setRequired(true)
            .addChoices(...[...CATEGORIES, 'unrelated', 'auto'].map((c) => ({ name: CATEGORY_LABELS[c] ?? 'Automatic', value: c }))),
        ),
    )
    .addSubcommand((sub) => sub.setName('export').setDescription('Download every ER:LC server found as CSV'))
    .addSubcommand((sub) => sub.setName('stats').setDescription('Show how many servers have been found'));
  return [find.toJSON(), finder.toJSON()];
}

function createFinder({ client, dataPath, allowedUserIds = [], discover = discoverFromRoblox, fetchImpl = fetch }) {
  const store = new FinderStore(dataPath);
  const queue = new Map(); // invite code -> sightings waiting for the lookup
  let working = false;


  /** Queue invite codes from an ad. `sighting` is null for a plain re-check. */
  function enqueue(code, sighting) {
    const pending = queue.get(code) ?? [];
    if (sighting) pending.push(sighting);
    queue.set(code, pending);
  }

  function intake(text, source) {
    const codes = extractInviteCodes(text);
    for (const code of codes) enqueue(code, { adText: text.slice(0, 1500), source, at: Date.now() });
    return codes.length;
  }

  function reclassify(server) {
    const result = classify(server.name, server.description, server.adText, server.groupText);
    return {
      erlc: server.manualCategory ? server.manualCategory !== 'unrelated' : result.erlc,
      category: server.manualCategory ?? result.category,
      scores: { erlc: result.erlcScore, ...result.scores },
      acceptsAds: result.acceptsAds,
      sellsAds: result.sellsAds,
    };
  }

  async function resolve(code, sightings) {
    const now = Date.now();
    const cached = store.invite(code);
    let guildId = cached?.guildId;

    if (!cached || now - cached.checkedAt > RECHECK_AFTER_MS || !sightings.length) {
      let invite;
      try {
        invite = await client.fetchInvite(code, { withCounts: true });
      } catch (err) {
        if (err.code !== UNKNOWN_INVITE) throw err;
        store.setInvite(code, null);
        for (const server of store.servers) {
          if (server.inviteCode === code) store.upsertServer(server.guildId, { alive: false, lastChecked: now });
        }
        return;
      }
      if (!invite.guild) {
        store.setInvite(code, null); // group DM invite
        return;
      }
      guildId = invite.guild.id;
      store.setInvite(code, guildId);
      const existing = store.server(guildId);
      // A bot that is in the server sees every channel; otherwise only the invite's own channel is visible.
      const joined = client.guilds?.cache.get(guildId);
      const adChannels = joined
        ? adChannelNames(joined.channels.cache.map((c) => c.name))
        : [...new Set([...(existing?.adChannels ?? []), ...adChannelNames([invite.channel?.name ?? ''])])];
      store.upsertServer(guildId, {
        adChannels,
        name: invite.guild.name,
        description: invite.guild.description ?? '',
        icon: invite.guild.iconURL?.({ size: 128 }) ?? null,
        inviteCode: invite.guild.vanityURLCode || code,
        members: invite.memberCount ?? existing?.members ?? 0,
        online: invite.presenceCount ?? existing?.online ?? 0,
        alive: true,
        firstSeen: existing?.firstSeen ?? now,
        lastChecked: now,
      });
    }
    if (!guildId) return; // invite known to be invalid

    const server = store.server(guildId);
    if (!server) return;
    const updates = {};
    const ads = sightings.filter((s) => s.ad !== false);
    const fromRoblox = sightings.find((s) => s.groupText);
    if (fromRoblox) updates.groupText = fromRoblox.groupText; // the Roblox group that links to this server
    if (ads.length) {
      const latest = ads[ads.length - 1];
      const sources = [...(server.sources ?? [])];
      for (const { source } of ads) {
        if (!sources.some((s) => s.channelId === source.channelId)) sources.push(source);
      }
      Object.assign(updates, {
        adText: latest.adText,
        adSightings: (server.adSightings ?? 0) + ads.length,
        lastAdAt: latest.at,
        sources: sources.slice(-MAX_SOURCES),
      });
    }
    store.upsertServer(guildId, { ...updates, ...reclassify({ ...server, ...updates }) });
  }

  async function work() {
    if (working || !queue.size) return;
    working = true;
    const [code, sightings] = queue.entries().next().value;
    queue.delete(code);
    try {
      await resolve(code, sightings);
    } catch (err) {
      console.error(`Finder: could not look up invite ${code}:`, err.message ?? err);
    } finally {
      working = false;
    }
  }

  function recheckStale() {
    const cutoff = Date.now() - RECHECK_AFTER_MS;
    for (const server of store.servers) {
      if (server.alive !== false && server.inviteCode && (server.lastChecked ?? 0) < cutoff) enqueue(server.inviteCode, null);
    }
  }

  // Auto-watched channels are scanned one at a time so a big server doesn't flood Discord.
  let scanChain = Promise.resolve();

  /** Watch (and read the history of) every ad / partner channel in a server the bot is in. */
  function autoWatch(guild) {
    for (const channel of guild.channels.cache.values()) {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) continue;
      if (!isAdChannelName(channel.name) || store.isIgnored(channel.id)) continue;
      if (!store.isWatched(channel.id)) store.watch(channel.id, guild.id);
      if (store.isScanned(channel.id)) continue;
      scanChain = scanChain.then(async () => {
        try {
          const { read, found } = await scan(channel, AUTO_SCAN);
          store.markScanned(channel.id);
          console.log(`Finder: auto-scanned #${channel.name} in ${guild.name}: ${read} messages, ${found} invites`);
        } catch (err) {
          console.warn(`Finder: can't read #${channel.name} in ${guild.name}: ${err.message}`);
        }
      });
    }
  }

  let discovery = null;

  /** Search Roblox for ER:LC groups and queue every Discord invite they link to. */
  function runDiscovery() {
    if (discovery) return discovery;
    console.log('Finder: searching Roblox for ER:LC servers');
    const onInvite = (code, groupText) => enqueue(code, { groupText, ad: false, source: { type: 'roblox' }, at: Date.now() });
    discovery = discover({ onInvite, fetchImpl })
      .then((report) => {
        // No invites came back (Roblox down or blocking us): try again in 15 minutes instead of 6 hours.
        store.data.lastDiscoveryAt = report.invites ? Date.now() : Date.now() - DISCOVER_EVERY_MS + 15 * 60 * 1000;
        store.data.lastDiscovery = { ...report, at: Date.now() };
        store.save();
        console.log('Finder: Roblox search done', JSON.stringify(report));
      })
      .catch((err) => {
        store.data.lastDiscovery = { error: err.message, at: Date.now() };
        console.error('Finder: Roblox search failed:', err);
      })
      .finally(() => {
        discovery = null;
      });
    return discovery;
  }

  function discoverIfDue() {
    if (Date.now() - (store.data.lastDiscoveryAt ?? 0) > DISCOVER_EVERY_MS) runDiscovery();
  }

  /** What the last Roblox search found, step by step. */
  function robloxStatus() {
    const r = store.data.lastDiscovery;
    if (discovery) return '**Roblox search:** running now';
    if (!r) return '**Roblox search:** has not run yet';
    const when = `<t:${Math.floor(r.at / 1000)}:R>`;
    if (r.error) return `**Roblox search** ${when}: failed — \`${r.error}\``;
    return (
      `**Roblox search** ${when}:\n` +
      `- Groups found: **${fmt(r.groups)}**${r.searchErrors ? ` (${fmt(r.searchErrors)} searches failed: \`${r.searchError}\`)` : ''}\n` +
      `- Discord links read: **${fmt(r.linksOk)}** groups ok, **${fmt(r.linksFailed)}** failed${r.linkError ? ` (\`${r.linkError}\`)` : ''}\n` +
      `- Discord invites found: **${fmt(r.invites)}**`
    );
  }

  function start() {
    discoverIfDue();
    setInterval(discoverIfDue, RECHECK_SWEEP_MS).unref();
    for (const guild of client.guilds.cache.values()) autoWatch(guild);
    client.on('guildCreate', autoWatch);
    client.on('channelCreate', (channel) => channel.guild && autoWatch(channel.guild));
    setInterval(work, RESOLVE_INTERVAL_MS).unref();
    setInterval(recheckStale, RECHECK_SWEEP_MS).unref();
    // Re-score stored servers so rule changes (like the sells-ads check) apply without waiting for a re-check.
    for (const server of store.servers) store.upsertServer(server.guildId, reclassify(server));
    recheckStale();
    console.log(`Finder: ${store.servers.length} servers stored, watching ${Object.keys(store.data.watched).length} channels`);
  }

  /** Feed every message in a watched ad channel (including bot / webhook posts) to the finder. */
  function handleMessage(message) {
    if (!message.guildId || !store.isWatched(message.channelId)) return;
    intake(messageText(message), { guildId: message.guildId, channelId: message.channelId, messageId: message.id });
  }

  // ---- lookup / rendering -------------------------------------------------------------

  function findServer(input) {
    const raw = input.trim();
    const code = extractInviteCodes(raw)[0] ?? raw;
    const viaInvite = store.invite(code)?.guildId;
    if (viaInvite && store.server(viaInvite)) return store.server(viaInvite);
    if (store.server(raw)) return store.server(raw);
    const needle = raw.toLowerCase();
    return store.servers.find((s) => s.name?.toLowerCase() === needle) ?? store.servers.find((s) => s.name?.toLowerCase().includes(needle));
  }

  /** You can buy an ad there: it has an ad channel (community, advertisements, paid ads...) or offers paid ads. */
  const sellsAds = (s) => s.sellsAds || s.adChannels?.length > 0;

  /** ER:LC servers with a live invite; ones you can buy an ad in come first. */
  function search({ category, query, minMembers, sort }) {
    const needle = query?.toLowerCase();
    const sorters = {
      members: (a, b) => (b.members ?? 0) - (a.members ?? 0),
      recent: (a, b) => (b.lastAdAt ?? 0) - (a.lastAdAt ?? 0),
      ads: (a, b) => (b.adSightings ?? 0) - (a.adSightings ?? 0),
    };
    return store.servers
      .filter((s) => s.erlc && s.alive !== false)
      .filter((s) => category === 'all' || s.category === category)
      .filter((s) => !needle || s.name?.toLowerCase().includes(needle))
      .filter((s) => (s.members ?? 0) >= (minMembers ?? 0))
      .sort((a, b) => sellsAds(b) - sellsAds(a) || (sorters[sort] ?? sorters.members)(a, b));
  }

  /** Why /find came back empty, so it's clear whether the finder has no data or everything was filtered out. */
  function emptyHelp(params) {
    if (discovery || queue.size) {
      return (
        `Collecting ER:LC servers right now: **${fmt(store.servers.length)}** looked up, **${fmt(queue.size)}** waiting. ` +
        'Run `/find` again in a few minutes.'
      );
    }
    const filtered = params.category !== 'all' || params.query || params.minMembers;
    return (
      `No ER:LC servers found${filtered ? ' with those filters' : ''} yet ` +
      `(${fmt(store.servers.length)} servers looked up). Run \`/finder stats\` to see what the last search found.`
    );
  }

  function searchMessage(params, page) {
    const results = search(params);
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);
    const label = params.category === 'all' ? 'All' : CATEGORY_LABELS[params.category];
    const collecting = discovery || queue.size ? ' · still collecting more' : '';
    const header = `# ER:LC ${label} Server Links\n-# ${fmt(results.length)} found · ${SORTS[params.sort] ?? SORTS.members} · page ${page + 1}/${pages}${collecting}`;
    let body = results.length
      ? results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => `https://discord.gg/${s.inviteCode}`).join('\n')
      : emptyHelp(params);
    if (header.length + body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT - header.length - 1)}…`;

    const state = [params.category, params.sort ?? 'members', params.minMembers ?? 0, params.query ?? ''].join(':');
    const button = (label, target, disabled) => ({
      type: C.BUTTON,
      style: BUTTON_STYLE.SECONDARY,
      label,
      custom_id: `${PAGE_PREFIX}:${target}:${state}`.slice(0, 100),
      disabled,
    });
    const nav = pages > 1 ? [{ type: C.SEPARATOR }, { type: C.ACTION_ROW, components: [button(`Previous ${PAGE_SIZE}`, page - 1, page === 0), button(`Next ${PAGE_SIZE}`, page + 1, page >= pages - 1)] }] : [];
    return textMessage(`${header}\n\n${body}`, nav);
  }

  function infoMessage(s) {
    const ts = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'never');
    const scores = s.scores ?? {};
    const ad = s.adText ? `\n**Latest ad:**\n>>> ${escapeMarkdown(s.adText.slice(0, 600))}` : '';
    return textMessage(
      `# ${escapeMarkdown(s.name ?? 'Unknown')}\n` +
        `${escapeMarkdown(s.description || 'No description.')}\n\n` +
        `- **Category:** ${CATEGORY_LABELS[s.category]}${s.manualCategory ? ' (set by hand)' : ''}\n` +
        `- **Members:** ${fmt(s.members)} (${fmt(s.online)} online)\n` +
        `- **Invite:** https://discord.gg/${s.inviteCode}${s.alive === false ? ' (expired)' : ''}\n` +
        `- **Sells ads:** ${sellsAds(s) ? 'yes' : 'not that we can see'}${s.sellsAds ? ' (mentions paid ads)' : ''}\n` +
        `- **Ad channels:** ${s.adChannels?.length ? s.adChannels.map((n) => `#${escapeMarkdown(n)}`).join(', ') : 'none seen'}\n` +
        `- **Takes partnerships:** ${s.acceptsAds ? 'yes' : 'not mentioned'}\n` +
        `- **Its own ads:** ${s.adSightings ? `seen ${fmt(s.adSightings)} times, last ${ts(s.lastAdAt)}` : 'none seen'}\n` +
        `- **Scores:** ER:LC ${scores.erlc ?? 0} · roleplay ${scores.roleplay ?? 0} · design ${scores.design ?? 0} · misc ${scores.misc ?? 0}\n` +
        `- **First found:** ${ts(s.firstSeen)} · **Checked:** ${ts(s.lastChecked)}\n` +
        `-# Server ID ${s.guildId}${ad}`,
    );
  }

  function csv() {
    const cols = ['guildId', 'name', 'category', 'members', 'online', 'inviteCode', 'alive', 'sellsAds', 'adChannels', 'acceptsAds', 'adSightings', 'lastAdAt', 'firstSeen', 'description'];
    const cell = (col, value) => {
      if (value == null) return '';
      const str = ['lastAdAt', 'firstSeen'].includes(col) ? new Date(value).toISOString() : [].concat(value).join('; ');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows = store.servers.filter((s) => s.erlc).map((s) => cols.map((col) => cell(col, s[col])).join(','));
    return [cols.join(','), ...rows].join('\n');
  }

  async function scan(channel, limit) {
    let before;
    let read = 0;
    let found = 0;
    while (read < limit) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, limit - read), before });
      if (!batch.size) break;
      for (const message of batch.values()) {
        found += intake(messageText(message), { guildId: channel.guildId, channelId: channel.id, messageId: message.id });
      }
      read += batch.size;
      before = batch.lastKey();
    }
    return { read, found };
  }

  // ---- interactions ---------------------------------------------------------------------

  /** Returns true when the interaction belonged to the finder. */
  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith(`${PAGE_PREFIX}:`)) {
      const [, page, category, sort, minMembers, ...query] = interaction.customId.split(':');
      await interaction.update(searchMessage({ category, sort, minMembers: Number(minMembers), query: query.join(':') || undefined }, Number(page)));
      return true;
    }
    if (!interaction.isChatInputCommand()) return false;
    if (!['find', 'finder'].includes(interaction.commandName)) return false;
    if (allowedUserIds.length && !allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply(notice('Not Allowed', "You don't have access to the server finder."));
      return true;
    }
    const opts = interaction.options;

    if (interaction.commandName === 'find') {
      discoverIfDue();
      const params = {
        category: opts.getString('category') ?? 'all',
        query: opts.getString('query') ?? undefined,
        minMembers: opts.getInteger('min_members') ?? 0,
        sort: opts.getString('sort') ?? 'members',
      };
      await interaction.reply(ephemeral(searchMessage(params, 0)));
      return true;
    }

    const sub = opts.getSubcommand();
    if (sub === 'info') {
      const server = findServer(opts.getString('server', true));
      await interaction.reply(server ? ephemeral(infoMessage(server)) : notice('Not Found', 'The finder has no server matching that.'));
    } else if (sub === 'add') {
      const raw = opts.getString('invite', true);
      const codes = extractInviteCodes(raw);
      if (!codes.length && /^[a-z0-9-]{2,32}$/i.test(raw.trim())) codes.push(raw.trim());
      if (!codes.length) {
        await interaction.reply(notice('Invalid Invite', 'Use Discord invites such as `discord.gg/abc123`.'));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const lines = [];
      for (const code of codes.slice(0, MAX_ADD)) {
        queue.delete(code);
        try {
          await resolve(code, [{ adText: '', source: { guildId: interaction.guildId, channelId: 'manual', userId: interaction.user.id }, at: Date.now() }]);
        } catch (err) {
          console.error(`Finder: manual add of ${code} failed:`, err);
          lines.push(`\`${code}\` — couldn't look it up, try again later`);
          continue;
        }
        const server = store.server(store.invite(code)?.guildId);
        if (!server) lines.push(`\`${code}\` — expired or invalid`);
        else if (!server.erlc) lines.push(`https://discord.gg/${server.inviteCode} — not ER:LC related, skipped`);
        else if (!sellsAds(server)) lines.push(`https://discord.gg/${server.inviteCode} — ER:LC, but no ad selling seen (hidden from /find)`);
        else lines.push(`https://discord.gg/${server.inviteCode} — added (${CATEGORY_LABELS[server.category]})`);
      }
      const extra = codes.length > MAX_ADD ? `\n-# Only the first ${MAX_ADD} links were added.` : '';
      await interaction.editReply(textMessage(`### Added Servers\n${lines.join('\n')}${extra}`.slice(0, MAX_TEXT)));
    } else if (['watch', 'unwatch', 'scan'].includes(sub)) {
      const channel = opts.getChannel('channel', true);
      if (sub === 'watch') {
        store.watch(channel.id, interaction.guildId);
        await interaction.reply(notice('Watching Channel', `Invites posted in <#${channel.id}> will be collected. Use \`/finder scan\` to pick up older ads too.`));
      } else if (sub === 'unwatch') {
        const had = store.unwatch(channel.id);
        await interaction.reply(notice(had ? 'Stopped Watching' : 'Not Watched', `<#${channel.id}> ${had ? 'is no longer read' : 'was not being watched'}.`));
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const { read, found } = await scan(channel, opts.getInteger('limit') ?? 500);
          const eta = Math.ceil((queue.size * RESOLVE_INTERVAL_MS) / 60_000);
          await interaction.editReply(textMessage(`### Scan Done\nRead **${fmt(read)}** messages in <#${channel.id}> and queued **${fmt(found)}** invites. Lookups finish in about ${eta} min.`));
        } catch (err) {
          console.error('Finder: scan failed:', err);
          await interaction.editReply(textMessage("### Something went wrong\nCouldn't read that channel. Check the bot has **View Channel** and **Read Message History** there."));
        }
      }
    } else if (sub === 'category') {
      const server = findServer(opts.getString('server', true));
      if (!server) {
        await interaction.reply(notice('Not Found', 'The finder has no server matching that.'));
        return true;
      }
      const choice = opts.getString('category', true);
      const manualCategory = choice === 'auto' ? undefined : choice;
      const updated = store.upsertServer(server.guildId, { ...reclassify({ ...server, manualCategory }), manualCategory });
      await interaction.reply(notice('Category Updated', `**${escapeMarkdown(updated.name)}** is now **${CATEGORY_LABELS[updated.category]}**.`));
    } else if (sub === 'export') {
      const file = new AttachmentBuilder(Buffer.from(csv()), { name: 'erlc-servers.csv' });
      await interaction.reply({ content: 'Every ER:LC server found so far:', files: [file], flags: MessageFlags.Ephemeral });
    } else if (sub === 'stats') {
      const erlc = store.servers.filter((s) => s.erlc);
      const count = (c) => fmt(erlc.filter((s) => s.category === c && s.alive !== false).length);
      await interaction.reply(
        notice(
          'Finder Stats',
          `- **Roleplay:** ${count('roleplay')}\n- **Design:** ${count('design')}\n- **Misc:** ${count('misc')}\n` +
            `- **Expired invites:** ${fmt(erlc.filter((s) => s.alive === false).length)}\n` +
            `- **Non ER:LC servers skipped:** ${fmt(store.servers.length - erlc.length)}\n` +
            `- **Watched channels here:** ${store.watchedIn(interaction.guildId).map((id) => `<#${id}>`).join(', ') || 'none'}\n` +
            `- **Invites waiting for lookup:** ${fmt(queue.size)}\n` +
            `- **Invites looked up:** ${fmt(Object.keys(store.data.invites).length)} ` +
            `(${fmt(Object.values(store.data.invites).filter((i) => !i.guildId).length)} invalid or expired)\n` +
            robloxStatus(),
        ),
      );
    }
    return true;
  }

  return { commands: buildCommands(), start, handleMessage, handleInteraction };
}

module.exports = { createFinder };
