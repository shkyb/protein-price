# protein-value bot

A Telegram bot that asks four questions — price, package weight, protein per 100g,
optional product name — and returns €/gram of protein. Stateless serverless function
(Cloudflare Workers) + Cloudflare D1 for storage, no server to keep running.

## What's stored

Per saved entry: `chat_id`, `name` (optional), `price`, `weight`, `protein`,
the computed `value_per_gram`, and a timestamp. That's it — no username, no real
name, no location. `chat_id` is the only identifier, needed so the bot can reply to
you and so `/deleteme` knows what to erase. There's also a `pending` table holding
mid-conversation state (which question you're on); rows there older than an hour are
purged automatically since they're not saved data, just an abandoned flow.

## One-time setup

### 1. Create the bot and get a token

Message **[@BotFather](https://t.me/BotFather)** on Telegram → `/newbot` → follow the
prompts (pick a name and a `@username`). It gives you a token that looks like
`123456789:AA...`. Keep it private — it's the credential that controls the bot.

### 2. Install dependencies

```sh
cd apps/bot
npm install
```

### 3. Log in to Cloudflare

```sh
npx wrangler login
```

Opens a browser to authorize — one-time, nothing to paste into any file.

### 4. Create the D1 database

```sh
npx wrangler d1 create protein-value-db
```

This prints a `database_id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_DATABASE_ID`.

### 5. Apply the schema

```sh
npm run db:migrate:local    # for local dev
npm run db:migrate:remote   # for the real deployed database
```

### 6. Set local secrets (for `wrangler dev`)

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in:
- `TELEGRAM_BOT_TOKEN` — from step 1.
- `TELEGRAM_WEBHOOK_SECRET` — any long random string you make up (e.g.
  `openssl rand -hex 32`). This isn't from Telegram — it's a shared secret *you*
  choose, used so the deployed worker can verify a request genuinely came from
  Telegram and not from someone who found the URL and started POSTing to it.

`.dev.vars` is gitignored — it never gets committed.

### 7. Deploy

```sh
npm run deploy
```

Prints your live URL, something like `https://protein-value-bot.<you>.workers.dev`.

### 8. Set the real secrets on Cloudflare

Local `.dev.vars` only affects `wrangler dev`. The deployed worker needs its own
copies, stored in Cloudflare's secret manager (not in any file):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Use the *same* webhook secret value as step 6.

### 9. Register the webhook with Telegram

```sh
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" \
  -d "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>"
```

### 10. Try it

Message your bot `/start`, then `/add`.

## Local development

```sh
npm run dev
```

Runs the worker locally against a local D1 instance. To exercise it without a real
Telegram webhook pointed at your machine, `curl` a fake update at
`http://localhost:8787/webhook` with the `X-Telegram-Bot-Api-Secret-Token` header set
to your `.dev.vars` value.

## Safety notes

- Both secrets live only in `.dev.vars` (gitignored, local) and Cloudflare's secret
  store (`wrangler secret put`, deployed) — never in a committed file.
- The webhook handler rejects any POST that doesn't carry the correct
  `X-Telegram-Bot-Api-Secret-Token` header, so the public URL can't be used to inject
  fake messages into the database.
- If a token ever leaks anyway: regenerate it via `/revoke` in BotFather (bot token)
  or re-run `wrangler secret put` with a new value (webhook secret), then re-run step
  9 with the new value. Old credentials stop working immediately.
