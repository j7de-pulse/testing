// ER:LC server finder: collects ER:LC Discord servers from listing sites (see ./sources.js),
// checks each invite through Discord's invite API, and lists servers with 300+ members
// grouped by size: 300+, 1,000+, 5,000+ and 10,000+.

const { AttachmentBuilder, MessageFlags, SlashCommandBuilder, escapeMarkdown } = require('discord.js');
const { FinderStore } = require('./store');
const { SOURCES } = require('./sources');

const MIN_MEMBERS = 300;
// Biggest first: a server goes in the first tier it reaches.
const TIERS = [
  { min: 10_000, label: '10,000+' },
  { min: 5_000, label: '5,000+' },
  { min: 1_000, label: '1,000+' },
  { min: 300, label: '300+' },
];
const RESOLVE_INTERVAL_MS = 1_000; // one invite lookup a second; discord.js waits by itself if Discord says slow down
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // refresh member counts / dead invites daily
const SOURCES_EVERY_MS = 6 * 60 * 60 * 1000; // read the listing sites every 6 hours (Melonly only re-reads new pages)
const PAGE_SIZE = 15;
const MAX_TEXT = 3900; // Components V2 messages allow 4,000 characters of text in total
const MAX_ADD = 25;
const PAGE_PREFIX = 'finder_page';
const UNKNOWN_INVITE = 10006;
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([a-z0-9-]{2,32})/gi;

const C = { ACTION_ROW: 1, BUTTON: 2, TEXT: 10, SEPARATOR: 14, CONTAINER: 17 };
const BUTTON_STYLE = { SECONDARY: 2 };

/** Unique invite codes in `text`. Codes are case-sensitive, so they are never lowercased. */
function extractInviteCodes(text) {
  return [...new Set([...String(text ?? '').matchAll(INVITE_RE)].map((m) => m[1]))];
}

const tierOf = (members) => TIERS.find((t) => members >= t.min);

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

function buildCommands() {
  const find = new SlashCommandBuilder()
    .setName('find')
    .setDescription(`Get Discord links to ER:LC servers with ${MIN_MEMBERS}+ members, ${PAGE_SIZE} at a time`)
    .addIntegerOption((o) =>
      o
        .setName('size')
        .setDescription('Only servers at least this big (default: all 300+)')
        .addChoices(...TIERS.map((t) => ({ name: `${t.label} members`, value: t.min }))),
    );
  const finder = new SlashCommandBuilder()
    .setName('finder')
    .setDescription('Manage the ER:LC server finder')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription(`Add ER:LC servers by invite link (up to ${MAX_ADD} at once)`)
        .addStringOption((o) => o.setName('invite').setDescription('One or more links, e.g. discord.gg/abc discord.gg/xyz').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('export').setDescription('Download every server found as CSV'))
    .addSubcommand((sub) => sub.setName('stats').setDescription('Show how many servers have been found'));
  return [find.toJSON(), finder.toJSON()];
}

function createFinder({ client, dataPath, allowedUserIds = [], sources = SOURCES, fetchImpl = fetch }) {
  const store = new FinderStore(dataPath);
  const queue = new Map(); // invite code -> { source } waiting for the lookup
  let working = false;
  let reading = null; // the running read of the listing sites

  /** Look an invite up on Discord and store the server with its real member count. */
  async function resolve(code, source) {
    const now = Date.now();
    let invite;
    try {
      invite = await client.fetchInvite(code, { withCounts: true });
    } catch (err) {
      if (err.code !== UNKNOWN_INVITE) throw err;
      store.setInvite(code, null);
      for (const server of store.servers) {
        if (server.inviteCode === code) store.upsertServer(server.guildId, { alive: false, lastChecked: now });
      }
      return null;
    }
    if (!invite.guild) {
      store.setInvite(code, null); // group DM invite
      return null;
    }
    store.setInvite(code, invite.guild.id);
    const existing = store.server(invite.guild.id);
    return store.upsertServer(invite.guild.id, {
      name: invite.guild.name,
      inviteCode: invite.guild.vanityURLCode || code,
      members: invite.memberCount ?? existing?.members ?? 0,
      online: invite.presenceCount ?? existing?.online ?? 0,
      sources: [...new Set([...(existing?.sources ?? []), ...(source ? [source] : [])])],
      alive: true,
      firstSeen: existing?.firstSeen ?? now,
      lastChecked: now,
    });
  }

  async function work() {
    if (working || !queue.size) return;
    working = true;
    const [code, { source }] = queue.entries().next().value;
    queue.delete(code);
    try {
      await resolve(code, source);
    } catch (err) {
      console.error(`Finder: could not look up invite ${code}:`, err.message ?? err);
    } finally {
      working = false;
    }
  }

  /** Queue an invite unless it was checked recently. */
  function enqueue(code, source) {
    const cached = store.invite(code);
    if (cached && Date.now() - cached.checkedAt < RECHECK_AFTER_MS) {
      const server = cached.guildId && store.server(cached.guildId);
      if (server && source && !server.sources?.includes(source)) {
        store.upsertServer(server.guildId, { sources: [...(server.sources ?? []), source] });
      }
      return;
    }
    if (!queue.has(code)) queue.set(code, { source });
  }

  const live = {}; // source name -> invites queued so far by the run in progress

  /** Read every listing site at the same time, queueing invites as they are found. */
  function readSources() {
    if (reading) return reading;
    reading = (async () => {
      // In parallel: a slow site (Melonly takes hours) must not hold up the others.
      await Promise.all(
        sources.map(async (source) => {
          live[source.name] = 0;
          const onServer = ({ invite, members }) => {
            // Sites' member counts can be stale, so they only skip clearly small servers; Discord's count decides.
            if (members != null && members < MIN_MEMBERS / 2) return;
            for (const code of extractInviteCodes(invite)) {
              live[source.name]++;
              enqueue(code, source.name);
            }
          };
          store.data.sourceState[source.name] ??= {};
          try {
            const { listed } = await source.run({ fetchImpl, onServer, state: store.data.sourceState[source.name], save: () => store.save() });
            store.setSourceReport(source.name, { listed, invites: live[source.name] });
            console.log(`Finder: ${source.name} listed ${listed} servers, ${live[source.name]} invites queued`);
          } catch (err) {
            store.setSourceReport(source.name, { error: err.message, invites: live[source.name] });
            console.error(`Finder: reading ${source.name} failed:`, err);
          }
          delete live[source.name];
        }),
      );
      store.data.lastSourcesAt = Date.now();
      store.save();
    })().finally(() => {
      reading = null;
    });
    return reading;
  }

  function readSourcesIfDue() {
    if (Date.now() - (store.data.lastSourcesAt ?? 0) > SOURCES_EVERY_MS) readSources();
  }

  function recheckStale() {
    const cutoff = Date.now() - RECHECK_AFTER_MS;
    for (const server of store.servers) {
      if (server.alive !== false && (server.lastChecked ?? 0) < cutoff) enqueue(server.inviteCode, null);
    }
  }

  function start() {
    readSourcesIfDue();
    recheckStale();
    setInterval(work, RESOLVE_INTERVAL_MS).unref();
    setInterval(() => {
      readSourcesIfDue();
      recheckStale();
    }, 60 * 60 * 1000).unref();
    console.log(`Finder: ${store.servers.length} servers stored, ${sources.length} listing sites`);
  }

  // ---- rendering ----------------------------------------------------------------------

  /** Live servers with at least `minMembers` (and never under 300), biggest first. */
  function search(minMembers) {
    return store.servers
      .filter((s) => s.alive !== false && (s.members ?? 0) >= Math.max(MIN_MEMBERS, minMembers))
      .sort((a, b) => b.members - a.members);
  }

  function findMessage(minMembers, page) {
    const results = search(minMembers);
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);
    const collecting = reading || queue.size ? ' · still collecting more' : '';
    const title = minMembers > MIN_MEMBERS ? `${tierOf(minMembers).label} Members` : `${MIN_MEMBERS}+ Members`;
    const header = `# ER:LC Servers · ${title}\n-# ${fmt(results.length)} found · page ${page + 1}/${pages}${collecting}`;

    let body;
    if (results.length) {
      // Results are sorted biggest first, so each tier is one run: print its heading where it starts.
      const lines = [];
      let tier;
      for (const s of results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        const t = tierOf(s.members);
        if (t !== tier) lines.push(`${lines.length ? '\n' : ''}**${t.label} members**`);
        tier = t;
        lines.push(`https://discord.gg/${s.inviteCode}`);
      }
      body = lines.join('\n');
    } else if (reading || queue.size) {
      body = `Collecting servers right now: **${fmt(queue.size)}** invites waiting to be checked. Run \`/find\` again in a few minutes.`;
    } else {
      body = `No servers found yet. Run \`/finder stats\` to see what the listing sites returned.`;
    }
    if (header.length + body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT - header.length - 1)}…`;

    const button = (label, target, disabled) => ({
      type: C.BUTTON,
      style: BUTTON_STYLE.SECONDARY,
      label,
      custom_id: `${PAGE_PREFIX}:${target}:${minMembers}`,
      disabled,
    });
    const nav =
      pages > 1
        ? [
            { type: C.SEPARATOR },
            {
              type: C.ACTION_ROW,
              components: [button(`Previous ${PAGE_SIZE}`, page - 1, page === 0), button(`Next ${PAGE_SIZE}`, page + 1, page >= pages - 1)],
            },
          ]
        : [];
    return textMessage(`${header}\n\n${body}`, nav);
  }

  function statsMessage() {
    const live = store.servers.filter((s) => s.alive !== false);
    const tierCounts = TIERS.map((t) => `- **${t.label}:** ${fmt(live.filter((s) => tierOf(s.members ?? 0) === t).length)}`).join('\n');
    const sourceLines = sources
      .map(({ name }) => {
        const r = store.data.sources[name];
        if (name in live) return `- **${name}:** reading now, ${fmt(live[name])} invites found so far`;
        if (!r) return `- **${name}:** not read yet`;
        const when = `<t:${Math.floor(r.at / 1000)}:R>`;
        return r.error ? `- **${name}** ${when}: failed — \`${r.error}\`` : `- **${name}** ${when}: ${fmt(r.listed)} servers listed, ${fmt(r.invites)} invites`;
      })
      .join('\n');
    return notice(
      'Finder Stats',
      `${tierCounts}\n` +
        `- **Under ${MIN_MEMBERS} members (hidden):** ${fmt(live.filter((s) => !tierOf(s.members ?? 0)).length)}\n` +
        `- **Expired invites:** ${fmt(store.servers.length - live.length)}\n` +
        `- **Invites waiting to be checked:** ${fmt(queue.size)}${reading ? ' (reading the sites now)' : ''}\n\n` +
        `**Listing sites**\n${sourceLines || '- none set up yet'}`,
    );
  }

  function csv() {
    const cols = ['guildId', 'name', 'members', 'online', 'inviteCode', 'sources', 'firstSeen'];
    const cell = (col, value) => {
      if (value == null) return '';
      const str = col === 'firstSeen' ? new Date(value).toISOString() : [].concat(value).join('; ');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows = search(0).map((s) => cols.map((col) => cell(col, s[col])).join(','));
    return [cols.join(','), ...rows].join('\n');
  }

  // ---- interactions ---------------------------------------------------------------------

  /** Returns true when the interaction belonged to the finder. */
  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith(`${PAGE_PREFIX}:`)) {
      const [, page, minMembers] = interaction.customId.split(':');
      await interaction.update(findMessage(Number(minMembers), Number(page)));
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
      readSourcesIfDue();
      await interaction.reply(ephemeral(findMessage(opts.getInteger('size') ?? MIN_MEMBERS, 0)));
      return true;
    }

    const sub = opts.getSubcommand();
    if (sub === 'add') {
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
        let server;
        try {
          server = await resolve(code, 'added by hand');
        } catch (err) {
          console.error(`Finder: manual add of ${code} failed:`, err);
          lines.push(`\`${code}\` — couldn't look it up, try again later`);
          continue;
        }
        if (!server) lines.push(`\`${code}\` — expired or invalid`);
        else if (!tierOf(server.members)) lines.push(`https://discord.gg/${server.inviteCode} — only ${fmt(server.members)} members, hidden from /find`);
        else lines.push(`https://discord.gg/${server.inviteCode} — added (${escapeMarkdown(server.name)}, ${fmt(server.members)} members)`);
      }
      const extra = codes.length > MAX_ADD ? `\n-# Only the first ${MAX_ADD} links were added.` : '';
      await interaction.editReply(textMessage(`### Added Servers\n${lines.join('\n')}${extra}`.slice(0, MAX_TEXT)));
    } else if (sub === 'export') {
      const file = new AttachmentBuilder(Buffer.from(csv()), { name: 'erlc-servers.csv' });
      await interaction.reply({ content: `Every server with ${MIN_MEMBERS}+ members found so far:`, files: [file], flags: MessageFlags.Ephemeral });
    } else if (sub === 'stats') {
      await interaction.reply(statsMessage());
    }
    return true;
  }

  return { commands: buildCommands(), start, handleInteraction };
}

module.exports = { createFinder, extractInviteCodes, TIERS };
