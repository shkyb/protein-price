import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  type TelegramUpdate,
  type InlineKeyboard,
} from "./telegram";
import { computeValuePerGramProtein } from "./calc";
import * as db from "./db";
import type { Env } from "./db";

const CANCEL_KEYBOARD: InlineKeyboard = [[{ text: "❌ Cancel", callback_data: "cancel" }]];
const NAME_STEP_KEYBOARD: InlineKeyboard = [
  [
    { text: "⏭ Skip", callback_data: "skip" },
    { text: "❌ Cancel", callback_data: "cancel" },
  ],
];

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour — abandoned flows get cleared, not saved data.

// Sanity ceilings — generous enough for any real grocery purchase, tight enough
// to reject junk/abuse. Protein's ceiling isn't arbitrary: you can't have more
// than 100g of protein in a 100g portion of food.
const MAX_PRICE = 10_000; // €
const MAX_WEIGHT_GRAMS = 50_000; // 50kg
const MAX_PROTEIN_PER_100G = 100;
const MAX_NAME_LENGTH = 100;
const MAX_ENTRIES_PER_DAY = 100; // per chat_id — plenty for real use, blocks scripted floods
const MAX_LIST_SHOWN = 10; // shared by /history and /cheapest

// Digits with an optional single decimal separator (. or ,) — nothing else.
// Rejects letters, symbols, signs, and scientific notation ("1e2" would
// otherwise parse as 100 under plain Number()).
const NUMBER_PATTERN = /^\d+([.,]\d+)?$/;

type NumberValidation = { ok: true; value: number } | { ok: false; reason: "format" | "range" };

function validateNumber(text: string, max: number): NumberValidation {
  const trimmed = text.trim();
  if (!NUMBER_PATTERN.test(trimmed)) {
    return { ok: false, reason: "format" };
  }
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, value };
}

// Stored as euros/gram (the natural unit for the underlying math), displayed
// as cents/gram: €0.0217 reads as a string of leading zeros, 2.17 cents
// doesn't. Two decimal places of a cent match the precision of four decimal
// places of a euro, so nothing is lost in the conversion.
function formatCentsPerGram(valuePerGram: number): string {
  return `${(valuePerGram * 100).toFixed(2)} cents/g protein`;
}

// With a rank, the rank is the sort key being shown (e.g. /cheapest) so it
// leads the line. Without one, recency is implicit and the date leads instead
// (e.g. /history).
function formatEntryLine(entry: db.Entry, rank?: number): string {
  const date = new Date(entry.created_at).toISOString().slice(0, 10);
  const label = entry.name ?? "(no name)";
  const value = formatCentsPerGram(entry.value_per_gram);
  return rank !== undefined ? `${rank}. ${label} — ${value} (${date})` : `${date}: ${label} — ${value}`;
}

// Shared by the text-based name step and the "Skip" button, so saving an
// entry works identically no matter which path finished it.
async function completeEntry(env: Env, chatId: number, pending: db.Pending, name: string | null): Promise<string> {
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
  return `${label}${formatCentsPerGram(value)}\nSaved ✓`;
}

async function handleCallbackQuery(
  env: Env,
  cq: NonNullable<TelegramUpdate["callback_query"]>
): Promise<Response> {
  // Must happen regardless of outcome, or the tapped button spins forever on
  // the user's end.
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id);

  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (chatId === undefined || messageId === undefined) {
    return new Response("OK");
  }
  const edit = (text: string) => editMessageText(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text);

  if (cq.data === "cancel") {
    await db.clearPending(env.DB, chatId);
    await edit("Cancelled.");
    return new Response("OK");
  }

  if (cq.data === "skip") {
    const pending = await db.getPending(env.DB, chatId);
    if (!pending || pending.step !== "name") {
      // Flow moved on or expired (1hr TTL) since this button was shown.
      await edit("This entry has expired. Send /add to start again.");
      return new Response("OK");
    }
    const resultText = await completeEntry(env, chatId, pending, null);
    await edit(resultText);
    return new Response("OK");
  }

  return new Response("OK");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("protein-price bot is running", { status: 200 });
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

    if (update.callback_query) {
      return handleCallbackQuery(env, update.callback_query);
    }

    const message = update.message;
    if (!message?.text || !message.chat?.id) {
      return new Response("OK");
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const reply = (msg: string, keyboard?: InlineKeyboard) =>
      sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard);

    await db.purgeStalePending(env.DB, PENDING_TTL_MS);

    if (text === "/start") {
      await reply(
        "Hi! I calculate how many euros you're paying per gram of protein.\n\n" +
          "/add — log a new item\n" +
          "/history — see your last entries\n" +
          "/cheapest — see your cheapest protein sources\n" +
          "/cancel — cancel the current entry\n" +
          "/deleteme — delete all your saved data\n\n" +
          "I only store the numbers you send me and your Telegram chat ID — nothing else."
      );
      return new Response("OK");
    }

    if (text === "/history") {
      const entries = await db.getRecentEntries(env.DB, chatId, MAX_LIST_SHOWN);
      if (entries.length === 0) {
        await reply("You haven't logged anything yet. Send /add to log your first item.");
        return new Response("OK");
      }
      const lines = entries.map((e) => formatEntryLine(e)).join("\n");
      await reply(`Your last ${entries.length} ${entries.length === 1 ? "entry" : "entries"}:\n\n${lines}`);
      return new Response("OK");
    }

    if (text === "/cheapest") {
      const entries = await db.getCheapestEntries(env.DB, chatId, MAX_LIST_SHOWN);
      if (entries.length === 0) {
        await reply("You haven't logged anything yet. Send /add to log your first item.");
        return new Response("OK");
      }
      const lines = entries.map((e, i) => formatEntryLine(e, i + 1)).join("\n");
      const heading = entries.length === 1 ? "Your cheapest entry" : `Your ${entries.length} cheapest entries`;
      await reply(`${heading}, best value first:\n\n${lines}`);
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
      await reply("What's the price? (€)", CANCEL_KEYBOARD);
      return new Response("OK");
    }

    const pending = await db.getPending(env.DB, chatId);
    if (!pending) {
      await reply("Send /add to log a new item.");
      return new Response("OK");
    }

    if (pending.step === "price") {
      const result = validateNumber(text, MAX_PRICE);
      if (!result.ok) {
        await reply(
          result.reason === "format"
            ? "Just the number, please — e.g. 2.50 or 2,50 (no letters, symbols, or currency signs)."
            : `Price has to be more than 0 and no more than €${MAX_PRICE}.`
        );
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, price: result.value, step: "weight", updated_at: Date.now() });
      await reply("Package weight? (grams)", CANCEL_KEYBOARD);
      return new Response("OK");
    }

    if (pending.step === "weight") {
      const result = validateNumber(text, MAX_WEIGHT_GRAMS);
      if (!result.ok) {
        await reply(
          result.reason === "format"
            ? "Just the number of grams, please — e.g. 500 (no letters, symbols, or units like 'g')."
            : `Weight has to be more than 0 and no more than ${MAX_WEIGHT_GRAMS}g.`
        );
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, weight: result.value, step: "protein", updated_at: Date.now() });
      await reply("Protein per 100g?", CANCEL_KEYBOARD);
      return new Response("OK");
    }

    if (pending.step === "protein") {
      const result = validateNumber(text, MAX_PROTEIN_PER_100G);
      if (!result.ok) {
        await reply(
          result.reason === "format"
            ? "Just the number, please — e.g. 23 (no letters or symbols)."
            : `Protein per 100g has to be more than 0 and no more than ${MAX_PROTEIN_PER_100G} — that's the physical max, since it's grams of protein per 100g of food.`
        );
        return new Response("OK");
      }
      await db.setPending(env.DB, { ...pending, protein: result.value, step: "name", updated_at: Date.now() });
      await reply("Product name? (optional — send /skip)", NAME_STEP_KEYBOARD);
      return new Response("OK");
    }

    // step === "name"
    if (text !== "/skip" && text.length > MAX_NAME_LENGTH) {
      await reply(`That name's a bit long — keep it under ${MAX_NAME_LENGTH} characters, or send /skip.`);
      return new Response("OK");
    }
    const name = text === "/skip" ? null : text;
    const resultText = await completeEntry(env, chatId, pending, name);
    await reply(resultText);
    return new Response("OK");
  },
};
