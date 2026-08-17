import { sendMessage, type TelegramUpdate } from "./telegram";
import { computeValuePerGramProtein } from "./calc";
import * as db from "./db";
import type { Env } from "./db";

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour — abandoned flows get cleared, not saved data.

// Sanity ceilings — generous enough for any real grocery purchase, tight enough
// to reject junk/abuse. Protein's ceiling isn't arbitrary: you can't have more
// than 100g of protein in a 100g portion of food.
const MAX_PRICE = 10_000; // €
const MAX_WEIGHT_GRAMS = 50_000; // 50kg
const MAX_PROTEIN_PER_100G = 100;
const MAX_NAME_LENGTH = 100;
const MAX_ENTRIES_PER_DAY = 100; // per chat_id — plenty for real use, blocks scripted floods

function parseBoundedNumber(text: string, max: number): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("protein-value bot is running", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    // Reject anything that isn't genuinely from Telegram. Without this check,
    // anyone who finds the worker URL could POST fake "messages" straight into
    // the database.
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json<TelegramUpdate>();
    const message = update.message;
    if (!message?.text || !message.chat?.id) {
      return new Response("OK");
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const reply = (msg: string) => sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);

    await db.purgeStalePending(env.DB, PENDING_TTL_MS);

    if (text === "/start") {
      await reply(
        "Hi! I calculate how many euros you're paying per gram of protein.\n\n" +
          "/add — log a new item\n" +
          "/cancel — cancel the current entry\n" +
          "/deleteme — delete all your saved data\n\n" +
          "I only store the numbers you send me and your Telegram chat ID — nothing else."
      );
      return new Response("OK");
    }

    if (text === "/deleteme") {
      await db.deleteAllForChat(env.DB, chatId);
      await reply("All your data has been deleted.");
      return new Response("OK");
    }

    if (text === "/cancel") {
      await db.clearPending(env.DB, chatId);
      await reply("Cancelled.");
      return new Response("OK");
    }

    if (text === "/add") {
      const recentCount = await db.countRecentEntries(env.DB, chatId, Date.now() - 24 * 60 * 60 * 1000);
      if (recentCount >= MAX_ENTRIES_PER_DAY) {
        await reply(`You've hit today's limit (${MAX_ENTRIES_PER_DAY} entries/day). Try again tomorrow.`);
        return new Response("OK");
      }
      await db.setPending(env.DB, {
        chat_id: chatId,
        step: "price",
        price: null,
        weight: null,
        protein: null,
        updated_at: Date.now(),
      });
      await reply("What's the price? (€)");
      return new Response("OK");
    }

    const pending = await db.getPending(env.DB, chatId);
    if (!pending) {
      await reply("Send /add to log a new item.");
      return new Response("OK");
    }

    if (pending.step === "price") {
      const price = parseBoundedNumber(text, MAX_PRICE);
      if (price === null) {
        await reply(`That doesn't look like a valid price. Try again, e.g. 2.50 (must be under €${MAX_PRICE})`);
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, price, step: "weight", updated_at: Date.now() });
      await reply("Package weight? (grams)");
      return new Response("OK");
    }

    if (pending.step === "weight") {
      const weight = parseBoundedNumber(text, MAX_WEIGHT_GRAMS);
      if (weight === null) {
        await reply(`That doesn't look like a valid weight. Try again, e.g. 500 (must be under ${MAX_WEIGHT_GRAMS}g)`);
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, weight, step: "protein", updated_at: Date.now() });
      await reply("Protein per 100g?");
      return new Response("OK");
    }

    if (pending.step === "protein") {
      const protein = parseBoundedNumber(text, MAX_PROTEIN_PER_100G);
      if (protein === null) {
        await reply(`That doesn't look like a valid protein amount. Try again, e.g. 23 (max ${MAX_PROTEIN_PER_100G}, since that's grams of protein per 100g of food)`);
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, protein, step: "name", updated_at: Date.now() });
      await reply("Product name? (optional — send /skip)");
      return new Response("OK");
    }

    // step === "name"
    if (text !== "/skip" && text.length > MAX_NAME_LENGTH) {
      await reply(`That name's a bit long — keep it under ${MAX_NAME_LENGTH} characters, or send /skip.`);
      return new Response("OK");
    }
    const name = text === "/skip" ? null : text;
    const { price, weight, protein } = pending;
    const value = computeValuePerGramProtein(price!, weight!, protein!);
    await db.saveEntry(env.DB, {
      chat_id: chatId,
      name,
      price: price!,
      weight: weight!,
      protein: protein!,
      value_per_gram: value,
    });
    await db.clearPending(env.DB, chatId);
    const label = name ? `${name} — ` : "";
    await reply(`${label}€${value.toFixed(4)}/g protein\nSaved ✓`);
    return new Response("OK");
  },
};
