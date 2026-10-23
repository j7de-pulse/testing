# Stripe Payment Bot

Discord bot that generates a Stripe Checkout link and lets the payer confirm it.

## Commands (anyone can use them)
- `-usd <amount>` – e.g. `-usd 25`
- `/usd amount:<amount>` – e.g. `/usd 19.99`
- `-convert <amount>` / `/convert amount:<amount>` – converts USD to Robux at 1,000 R$ = $7, e.g. `-convert 300` → 42,857R$
- `-vault <stock>` / `/vault stock:<stock>` – owner only (`OWNER_ID`), posts the Robux Vault panel, e.g. `-vault 24`. **Purchase** opens a form (amounts in steps of 100, 1,000 R$ = $7) and sends a private payment pop-up with **Confirm Payment**. Confirmed purchases are taken off the panel's stock automatically; at 0 the Purchase button is disabled

- `/find` and `/finder ...` – ER:LC server finder, see below

The bot posts a "Payment Generated" card with a **Pay** link and a **Confirm** button.
Pressing **Confirm** checks the Checkout Session with Stripe; only if Stripe reports it as
`paid` does the card change to "Payment Confirmed". Otherwise the user gets a private notice.

## ER:LC Server Finder
Finds ER:LC **roleplay**, **design** and **misc** servers that advertise.

**How servers are found**
1. **Ad channels** – `/finder watch channel:#ads` makes the bot read every new message in an
   advertisement / partnership channel, including ads posted by bots and webhooks in embeds. `/finder scan` reads
   the channel's older messages too (up to 1,000). Add the bot to ER:LC ad / partnership servers and watch their ad
   channels to grow the list.
2. **Submissions** – anyone can run `/finder add invite:discord.gg/...`.

**What happens to each invite**
- It is looked up through Discord's invite API (one every 2 seconds) for the server's name, description,
  member and online counts. Expired invites are marked and hidden; every server is re-checked daily.
- The name, description and ad text are scored for ER:LC words (`ERLC`, `ER:LC`, `Liberty County`, `Emergency Response`...)
  and then for roleplay words (roleplay, SSU, sheriff, departments...), design words (designs, liveries, uniforms,
  graphics, commissions, server setups...) or misc words (hub, community, ad server, news...). Fancy fonts like 𝐄𝐑𝐋𝐂 are understood.
- A server counts as advertising when it was seen in an ad channel, its text mentions ads / partnerships, or it has a
  channel called **community**, **advertisements** or **paid ads** (emoji and dividers like `📢・advertisements` or
  `┃paid-ads` are fine). Discord only shows a server's full channel list to bots in that server; for other servers the
  finder sees just the channel each invite points to.
  Servers with nothing tying them to ER:LC are kept (so they aren't looked up again) but never listed.

**Commands** (only the users in `FINDER_USER_IDS` can use them; by default `1068719082700029952` and
`737181735846019112`)
- `/find [category] [query] [min_members] [sort]` – lists servers 15 at a time with invites; **Next 15** / **Previous 15**
  buttons page through the rest. Category defaults to All
- `/finder info server:<invite, ID or name>` – details, scores and the latest ad
- `/finder add invite:<invite>` – submit a server
- `/finder watch|unwatch|scan channel:<channel>` – choose which channels are read
- `/finder category server:<...> category:<...>` – fixes a wrong category (`Automatic` undoes it)
- `/finder export` – CSV of every ER:LC server found
- `/finder stats` – counts per category

The bot only reads channels in servers it has been added to. It does not use self-bots or scrape listing sites,
both of which break Discord's / those sites' terms.

The list is saved to `FINDER_DATA_PATH` (default `data/finder.json`). On Railway add a **Volume** mounted at `/data`
and set `FINDER_DATA_PATH=/data/finder.json`, otherwise the list is lost on every redeploy.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `STRIPE_SECRET_KEY`.
3. In the Discord Developer Portal, enable the **Message Content** intent (needed for `-usd` and for reading ad channels).
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. `npm start`

## Deploying on Railway
Railway does not use a `.env` file. Set the variables on the service instead:
1. Open the service -> **Variables** -> **New Variable**.
2. Add `DISCORD_TOKEN`, `STRIPE_SECRET_KEY` and `OWNER_ID` (no quotes needed). Optionally `GUILD_ID` and `FINDER_DATA_PATH`.
3. Redeploy. The start command (`npm start`) is set in `railway.json`.
