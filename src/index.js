require('dotenv').config({ quiet: true });

const {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const Stripe = require('stripe');

/** Read the first non-empty env var from `names`, stripping whitespace and wrapping quotes. */
function env(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value) return value;
  }
  return undefined;
}

const DISCORD_TOKEN = env('DISCORD_TOKEN', 'BOT_TOKEN', 'TOKEN');
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY', 'STRIPE_KEY', 'STRIPE_API_KEY');
const GUILD_ID = env('GUILD_ID');
// Discord user IDs allowed to use owner-only commands like -vault (comma-separated)
const OWNER_IDS = (env('OWNER_ID', 'OWNER_IDS') || '').split(',').map((id) => id.trim()).filter(Boolean);
const SUCCESS_URL = env('SUCCESS_URL') || 'https://discord.com/channels/@me';
const CANCEL_URL = env('CANCEL_URL') || 'https://discord.com/channels/@me';

const missing = [
  !DISCORD_TOKEN && 'DISCORD_TOKEN',
  !STRIPE_SECRET_KEY && 'STRIPE_SECRET_KEY',
].filter(Boolean);
if (missing.length) {
  console.error(
    `Missing environment variable(s): ${missing.join(', ')}.\n` +
      'On Railway: open your service -> Variables -> New Variable, add them, then redeploy.\n' +
      'Locally: put them in a .env file (see .env.example).',
  );
  process.exit(1);
}
if (!OWNER_IDS.length) console.warn('OWNER_ID is not set, so nobody can use -vault.');

const stripe = new Stripe(STRIPE_SECRET_KEY);

const PREFIX = '-usd';
const CONVERT_PREFIX = '-convert';
const VAULT_PREFIX = '-vault';
const VAULT_PURCHASE_PREFIX = 'vault_purchase';
const VAULT_MODAL_PREFIX = 'vault_modal';
const ROBUX_PER_7_DOLLARS = 1000; // 1,000 R$ = $7.00
const CONFIRM_PREFIX = 'pay_confirm:';
const MIN_CENTS = 50; // Stripe's minimum charge for USD
const MAX_CENTS = 99_999_999; // Stripe's maximum charge for USD

// Component type ids (Components V2)
const C = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
};
const BUTTON_STYLE = { SECONDARY: 2, SUCCESS: 3, LINK: 5 };

/** Parse "25", "$25", "25.5", "1,000.99" into integer cents, or null if invalid. */
function parseAmountToCents(input, min = MIN_CENTS, max = MAX_CENTS) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < min || cents > max) return null;
  return cents;
}

function formatUsd(cents) {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const formatRobux = (robux) => `${robux.toLocaleString('en-US')}R$`;

/** Price of a Robux amount in cents at 1,000 R$ = $7.00. */
const robuxToCents = (robux) => (robux * 700) / ROBUX_PER_7_DOLLARS;

/** Parse a vault purchase amount: a whole number in steps of 100 (1000, 2200 - not 2025), or null. */
function parseRobuxAmount(input) {
  const cleaned = String(input ?? '').trim().replace(/,/g, '').replace(/r\$$/i, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const robux = Number(cleaned);
  if (!Number.isSafeInteger(robux) || robux < 100 || robux % 100 !== 0) return null;
  if (robuxToCents(robux) > MAX_CENTS) return null;
  return robux;
}

async function createCheckout(cents, requester, { name = `Payment - ${formatUsd(cents)}`, metadata = {} } = {}) {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: { name },
        },
      },
    ],
    // Cards, Apple Pay, Google Pay, Cash App Pay, etc. come from the payment
    // methods enabled in the Stripe dashboard.
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    metadata: {
      discord_user_id: requester.id,
      discord_username: requester.username,
      ...metadata,
    },
  });
}

function paymentMessage(cents, session) {
  const amount = formatUsd(cents);
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      {
        type: C.CONTAINER,
        components: [
          {
            type: C.TEXT,
            content:
              `# Payment Generated - ${amount}\n` +
              `Here is the payment of **${amount}**, you can use the link below to pay online. ` +
              'Payments are done through Stripe, accepting google pay, card, apple pay and many more ' +
              "options including Cash App Pay. Can't use Stripe? Wait for an executive to assist you.\n" +
              '-# Tax is not applied onto this payment yet, GST may be applied at checkout.',
          },
          { type: C.SEPARATOR },
          {
            type: C.ACTION_ROW,
            components: [
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.SUCCESS,
                label: 'Confirm',
                custom_id: `${CONFIRM_PREFIX}${session.id}`,
              },
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.LINK,
                label: `Pay - ${amount}`,
                url: session.url,
              },
            ],
          },
        ],
      },
    ],
  };
}

function confirmedMessage(session, confirmer) {
  const robux = session.metadata?.robux ? ` (${formatRobux(Number(session.metadata.robux))})` : '';
  const amount = formatUsd(session.amount_total);
  const paidAt = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      {
        type: C.CONTAINER,
        components: [
          {
            type: C.TEXT,
            content:
              `# Payment Confirmed - ${amount}\n` +
              `The payment of **${amount}**${robux} has been received through Stripe.\n` +
              `Confirmed by <@${confirmer.id}> on ${paidAt}.\n` +
              `-# Reference: \`${session.id.slice(-12)}\``,
          },
          { type: C.SEPARATOR },
          {
            type: C.ACTION_ROW,
            components: [
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.SUCCESS,
                label: 'Confirmed',
                custom_id: `${CONFIRM_PREFIX}done`,
                disabled: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Components V2 container holding a single block of text. */
function textMessage(content) {
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [{ type: C.CONTAINER, components: [{ type: C.TEXT, content }] }],
  };
}

/** The Robux Vault panel posted by -vault. */
function vaultMessage(stock) {
  const robux = formatRobux(stock);
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      {
        type: C.CONTAINER,
        components: [
          {
            type: C.TEXT,
            content:
              '# Robux Vault\n' +
              'Below is all information regarding the **Roblox Vault**, please read all information carefully ' +
              "before you make a decision. All robux is paid via group or Roblox Transfer, you'll receive your " +
              'robux no matter the current circumstances the only delay issue would be pending robux or max ' +
              "transfer limit if you didn't want to wait. If you'd like it via gamepass tax will not be applied.\n\n" +
              `- **Current Stock**: ${robux}\n` +
              '- **Payment Types**: Stripe (card, cashapp pay etc).',
          },
          { type: C.SEPARATOR, spacing: 1, divider: false },
          {
            type: C.ACTION_ROW,
            components: [
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.SUCCESS,
                label: 'Purchase',
                custom_id: `${VAULT_PURCHASE_PREFIX}:${stock}`,
              },
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.SECONDARY,
                label: `Stock: ${robux}`,
                custom_id: 'vault_stock',
                disabled: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Modal shown when someone presses Purchase on the vault panel. */
function vaultPurchaseModal(stock) {
  return {
    custom_id: `${VAULT_MODAL_PREFIX}:${stock ?? ''}`,
    title: 'Purchase Robux',
    components: [
      {
        type: C.ACTION_ROW,
        components: [
          {
            type: 4, // text input
            custom_id: 'robux',
            label: 'How much Robux? (steps of 100)',
            style: 1, // short
            placeholder: 'e.g. 1000 or 2200',
            min_length: 3,
            max_length: 12,
            required: true,
          },
        ],
      },
    ],
  };
}

/** Private payment pop-up for a vault purchase. */
function vaultPaymentMessage(robux, cents, session) {
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      {
        type: C.CONTAINER,
        components: [
          {
            type: C.TEXT,
            content:
              '# Payment\n' +
              `You've decided you want **${formatRobux(robux)}**, here is all the information.\n` +
              `- **Amount:** ${formatUsd(cents)} USD (${formatRobux(robux)})\n`,
          },
          { type: C.SEPARATOR, divider: false },
          {
            type: C.ACTION_ROW,
            components: [
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.SUCCESS,
                label: 'Confirm Payment',
                custom_id: `${CONFIRM_PREFIX}${session.id}`,
              },
              {
                type: C.BUTTON,
                style: BUTTON_STYLE.LINK,
                label: 'Purchase',
                url: session.url,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Small Components V2 container used for the private replies to the Confirm button. */
function noticeMessage(title, body) {
  return textMessage(`### ${title}\n${body}`);
}

const usdCommand = new SlashCommandBuilder()
  .setName('usd')
  .setDescription('Generate a Stripe payment link in USD')
  .addStringOption((opt) =>
    opt.setName('amount').setDescription('Amount in USD, e.g. 25 or 19.99').setRequired(true),
  );

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    if (GUILD_ID) {
      await client.application.commands.set([usdCommand.toJSON()], GUILD_ID);
      console.log(`Registered /usd in guild ${GUILD_ID}`);
    } else {
      await client.application.commands.set([usdCommand.toJSON()]);
      console.log('Registered /usd globally');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

const invalidAmountMessage = (command) =>
  noticeMessage(
    'Invalid Amount',
    `Use the command \`${command} <amount>\`. Please do a valid integer such as \`1\` or \`100\`.`,
  );

// -usd <amount>, -convert <amount>, -vault <stock>
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const [rawCmd, rawAmount] = message.content.trim().split(/\s+/);
  const cmd = rawCmd?.toLowerCase();

  if (cmd === VAULT_PREFIX) {
    if (!OWNER_IDS.includes(message.author.id)) return;
    const cleaned = (rawAmount || '').replace(/,/g, '').replace(/r\$$/i, '');
    if (!/^\d+$/.test(cleaned) || !Number.isSafeInteger(Number(cleaned))) {
      await message.reply(
        noticeMessage('Invalid Stock', `Use the command \`${VAULT_PREFIX} <stock>\`. Please do a valid integer such as \`24\` or \`1000\`.`),
      );
      return;
    }
    await message.channel.send(vaultMessage(Number(cleaned)));
    return;
  }

  if (cmd === CONVERT_PREFIX) {
    const cents = parseAmountToCents(rawAmount, 1, MAX_CENTS);
    if (cents === null) {
      await message.reply(invalidAmountMessage(CONVERT_PREFIX));
      return;
    }
    const robux = Math.floor((cents * ROBUX_PER_7_DOLLARS) / 700);
    await message.channel.send(
      textMessage(`${formatUsd(cents)} USD converts into **${robux.toLocaleString('en-US')}R$**.`),
    );
    return;
  }

  if (cmd !== PREFIX) return;

  const cents = parseAmountToCents(rawAmount);
  if (cents === null) {
    await message.reply(invalidAmountMessage(PREFIX));
    return;
  }

  try {
    const session = await createCheckout(cents, message.author);
    await message.channel.send(paymentMessage(cents, session));
  } catch (err) {
    console.error('Stripe checkout creation failed:', err);
    await message.reply({ content: 'Could not create the payment link. Please try again later.' });
  }
});

client.on('interactionCreate', async (interaction) => {
  // /usd amount
  if (interaction.isChatInputCommand() && interaction.commandName === 'usd') {
    const cents = parseAmountToCents(interaction.options.getString('amount', true));
    if (cents === null) {
      const reply = invalidAmountMessage('/usd');
      await interaction.reply({ ...reply, flags: reply.flags | MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    try {
      const session = await createCheckout(cents, interaction.user);
      await interaction.editReply(paymentMessage(cents, session));
    } catch (err) {
      console.error('Stripe checkout creation failed:', err);
      await interaction.editReply({ content: 'Could not create the payment link. Please try again later.' });
    }
    return;
  }

  // Vault Purchase button: ask how much Robux they want
  if (interaction.isButton() && interaction.customId.split(':')[0] === VAULT_PURCHASE_PREFIX) {
    const stock = interaction.customId.split(':')[1];
    await interaction.showModal(vaultPurchaseModal(stock));
    return;
  }

  // Vault purchase modal: validate the amount and send a private payment pop-up
  if (interaction.isModalSubmit() && interaction.customId.split(':')[0] === VAULT_MODAL_PREFIX) {
    const ephemeralNotice = (title, body) => {
      const reply = noticeMessage(title, body);
      return { ...reply, flags: reply.flags | MessageFlags.Ephemeral };
    };
    const robux = parseRobuxAmount(interaction.fields.getTextInputValue('robux'));
    if (robux === null) {
      await interaction.reply(
        ephemeralNotice(
          'Invalid Amount',
          'Please enter a whole number in steps of 100, such as `1000` or `2200` (not `2025`).',
        ),
      );
      return;
    }
    const stock = Number(interaction.customId.split(':')[1]);
    if (interaction.customId.split(':')[1] && robux > stock) {
      await interaction.reply(
        ephemeralNotice('Not Enough Stock', `There is only **${formatRobux(stock)}** in stock right now.`),
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cents = robuxToCents(robux);
    try {
      const session = await createCheckout(cents, interaction.user, {
        name: `${formatRobux(robux)} - Robux Vault`,
        metadata: { robux: String(robux) },
      });
      await interaction.editReply(vaultPaymentMessage(robux, cents, session));
    } catch (err) {
      console.error('Stripe checkout creation failed:', err);
      await interaction.editReply(
        noticeMessage('Something went wrong', 'Could not create the payment link. Please try again later.'),
      );
    }
    return;
  }

  // Confirm button: verify with Stripe that the checkout session was actually paid.
  // deferUpdate + editReply edits the message the button is on, which also works when
  // that message is ephemeral (the vault payment pop-up); notices go out as follow-ups.
  if (interaction.isButton() && interaction.customId.startsWith(CONFIRM_PREFIX)) {
    const sessionId = interaction.customId.slice(CONFIRM_PREFIX.length);
    await interaction.deferUpdate();
    const notify = (title, body) => {
      const reply = noticeMessage(title, body);
      return interaction.followUp({ ...reply, flags: reply.flags | MessageFlags.Ephemeral });
    };

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      console.error('Stripe session lookup failed:', err);
      await notify('Something went wrong', 'Could not check this payment with Stripe. Please try again.');
      return;
    }

    if (session.payment_status === 'paid') {
      await interaction.editReply(confirmedMessage(session, interaction.user));
      await notify('Payment Confirmed', 'Thank you! Your payment has been received.');
    } else if (session.status === 'expired') {
      await notify('Payment Link Expired', 'This payment link has expired. Please ask for a new one.');
    } else {
      await notify(
        'Payment Not Completed',
        "This payment hasn't been completed yet. Pay using the button, then press Confirm again.",
      );
    }
  }
});

client.login(DISCORD_TOKEN);
