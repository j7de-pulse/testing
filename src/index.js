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

const stripe = new Stripe(STRIPE_SECRET_KEY);

const PREFIX = '-usd';
const CONFIRM_PREFIX = 'pay_confirm:';
const MIN_CENTS = 50; // Stripe's minimum charge for USD
const MAX_CENTS = 99_999_999; // Stripe's maximum charge for USD

// Component type ids (Components V2)
const C = {
  ACTION_ROW: 1,
  BUTTON: 2,
  SECTION: 9,
  TEXT: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
};
const BUTTON_STYLE = { SUCCESS: 3, LINK: 5 };

/** Parse "25", "$25", "25.5", "1,000.99" into integer cents, or null if invalid. */
function parseAmountToCents(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) return null;
  return cents;
}

function formatUsd(cents) {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function createCheckout(cents, requester) {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: { name: `Payment - ${formatUsd(cents)}` },
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
            type: C.SECTION,
            components: [
              {
                type: C.TEXT,
                content:
                  `# Payment Generated - ${amount}\n` +
                  `Here is the payment of **${amount}**, you can use the link below to pay online. ` +
                  'Payments are done through Stripe, accepting google pay, card, apple pay and many more ' +
                  'options including Cash App Pay. \n' +
                  '-# Tax is not applied onto this payment yet, GST may be applied at checkout.',
              },
            ],
            accessory: {
              type: C.BUTTON,
              style: BUTTON_STYLE.LINK,
              label: 'Stripe Checkout',
              url: session.url,
            },
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
  const amount = formatUsd(session.amount_total);
  const paidAt = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      {
        type: C.CONTAINER,
        accent_color: 0x57f287,
        components: [
          {
            type: C.TEXT,
            content:
              `# Payment Confirmed - ${amount}\n` +
              `The payment of **${amount}** has been received through Stripe.\n` +
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

const INVALID_AMOUNT = `Please give a valid amount between ${formatUsd(MIN_CENTS)} and ${formatUsd(MAX_CENTS)}, e.g. \`25\` or \`19.99\`.`;

// -usd <amount>
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const [cmd, rawAmount] = message.content.trim().split(/\s+/);
  if (cmd?.toLowerCase() !== PREFIX) return;

  const cents = parseAmountToCents(rawAmount);
  if (cents === null) {
    await message.reply({ content: `Usage: \`${PREFIX} <amount>\`. ${INVALID_AMOUNT}` });
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
      await interaction.reply({ content: INVALID_AMOUNT, flags: MessageFlags.Ephemeral });
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

  // Confirm button: verify with Stripe that the checkout session was actually paid
  if (interaction.isButton() && interaction.customId.startsWith(CONFIRM_PREFIX)) {
    const sessionId = interaction.customId.slice(CONFIRM_PREFIX.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      console.error('Stripe session lookup failed:', err);
      await interaction.editReply('Could not check this payment with Stripe. Please try again.');
      return;
    }

    if (session.payment_status === 'paid') {
      await interaction.message.edit(confirmedMessage(session, interaction.user));
      await interaction.editReply('Payment confirmed. Thank you!');
    } else if (session.status === 'expired') {
      await interaction.editReply('This payment link has expired. Please ask for a new one.');
    } else {
      await interaction.editReply(
        "This payment hasn't been completed yet. Pay using the button, then press Confirm again.",
      );
    }
  }
});

client.login(DISCORD_TOKEN);
