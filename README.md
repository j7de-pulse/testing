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
Lists ER:LC Discord servers with **300+ members**, grouped by size: **300+**, **1,000+**, **5,000+** and **10,000+**.

Servers come from ER:LC listing sites (`src/finder/sources.js`), read every 6 hours. Every invite is checked
through Discord's invite API, so member counts are Discord's own and expired invites are dropped. Servers are
re-checked daily.

**Commands** (only the users in `FINDER_USER_IDS` can use them; by default `1068719082700029952` and
`737181735846019112`)
- `/find [size]` – just the Discord links, biggest first under size headings, 15 at a time with
  **Next 15** / **Previous 15** buttons. `size` shows only servers of at least 1,000+, 5,000+ or 10,000+ members
- `/finder add invite:<links>` – add up to 25 servers by hand
- `/finder export` – CSV of every server found
- `/finder stats` – servers per size group and what each listing site returned

The list is saved to `FINDER_DATA_PATH` (default `data/finder.json`). On Railway add a **Volume** mounted at `/data`
and set `FINDER_DATA_PATH=/data/finder.json`, otherwise the list is lost on every redeploy.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `STRIPE_SECRET_KEY`.
3. In the Discord Developer Portal, enable the **Message Content** intent (needed for `-usd`).
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. `npm start`

## Deploying on Railway
Railway does not use a `.env` file. Set the variables on the service instead:
1. Open the service -> **Variables** -> **New Variable**.
2. Add `DISCORD_TOKEN`, `STRIPE_SECRET_KEY` and `OWNER_ID` (no quotes needed). Optionally `GUILD_ID`, `FINDER_DATA_PATH` and `FINDER_USER_IDS`.
3. Redeploy. The start command (`npm start`) is set in `railway.json`.
