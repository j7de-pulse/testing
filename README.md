# Stripe Payment Bot

Discord bot that generates a Stripe Checkout link and lets the payer confirm it.

## Commands (anyone can use them)
- `-usd <amount>` – e.g. `-usd 25`
- `/usd amount:<amount>` – e.g. `/usd 19.99`
- `-convert <amount>` / `/convert amount:<amount>` – converts USD to Robux at 1,000 R$ = $7, e.g. `-convert 300` → 42,857R$
- `-vault <stock>` / `/vault stock:<stock>` – owner only (`OWNER_ID`), posts the Robux Vault panel, e.g. `-vault 24`. **Purchase** opens a form (amounts in steps of 100, 1,000 R$ = $7) and sends a private payment pop-up with **Confirm Payment**. Confirmed purchases are taken off the panel's stock automatically; at 0 the Purchase button is disabled

The bot posts a "Payment Generated" card with a **Pay** link and a **Confirm** button.
Pressing **Confirm** checks the Checkout Session with Stripe; only if Stripe reports it as
`paid` does the card change to "Payment Confirmed". Otherwise the user gets a private notice.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `STRIPE_SECRET_KEY`.
3. In the Discord Developer Portal, enable the **Message Content** intent (needed for `-usd`).
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. `npm start`

## Deploying on Railway
Railway does not use a `.env` file. Set the variables on the service instead:
1. Open the service -> **Variables** -> **New Variable**.
2. Add `DISCORD_TOKEN`, `STRIPE_SECRET_KEY` and `OWNER_ID` (no quotes needed). Optionally `GUILD_ID`.
3. Redeploy. The start command (`npm start`) is set in `railway.json`.
