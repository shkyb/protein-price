# protein-value

Calculates how many euros you're paying per gram of protein for things you buy — so
"which of these is actually the cheaper protein source" has a real number behind it.

Two front ends share the same idea, built one at a time:

- **`apps/bot`** — a Telegram bot, manual step-by-step entry (price → weight → protein/100g → optional name). Serverless, hosted on Cloudflare Workers + D1. **Built first, see `apps/bot/README.md`.**
- **`apps/pwa`** — a barcode-scanning web app that auto-fills protein data from Open Food Facts. Coming next.

## Design principles this project holds itself to

- **Free to run.** Every piece lives on a generous free tier (Cloudflare Workers + D1). No paid infra required to use or self-host it.
- **Minimal data.** Only what the calculation needs — no names, no usernames, no location, no tracking beyond a Telegram chat ID needed to reply to you. See `apps/bot/README.md` for exactly what's stored.
- **Secrets never in git.** Tokens and webhook secrets are injected via Cloudflare's secret store / local `.dev.vars`, both gitignored. See each app's README for setup.
- **User-deletable.** Anyone using the public bot can wipe their own data on request (`/deleteme`).

## License

MIT — see `LICENSE`.
