import {
  sendMessage,
  sendMessageWithMenu,
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

// Pressing a persistent-menu button sends its label as plain text, so it's
// aliased to the matching command before any command comparison runs.
const MENU_LABEL_TO_COMMAND: Record<string, string> = {
  "➕ Add": "/add",
  "📊 History": "/history",
  "❌ Cancel": "/cancel",
};

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
const TOTAL_STEPS = 4; // price, weight, protein, name

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

// /history and /cheapest render as a monospace table inside a code block.
// Code block content is shown literally, not re-parsed for other Markdown
// entities, which is actually the *safe* place to put a raw user name
// (unlike the plain-text result message). The one thing that still has to be
// handled: a literal backtick in a name could prematurely close the block,
// so it's stripped before the name ever reaches the table.
const DATE_COL = 10; // "YYYY-MM-DD"
const NAME_COL = 12; // kept narrow — mobile Telegram wraps a code block well under 40 chars

function centsValue(valuePerGram: number): string {
  return (valuePerGram * 100).toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tableNameCell(name: string | null): string {
  const safe = (name ?? "(no name)").replace(/`/g, "'");
  return truncate(safe, NAME_COL).padEnd(NAME_COL);
}

function buildHistoryTable(entries: db.Entry[]): string {
  const header = `${"Date".padEnd(DATE_COL)} ${"Name".padEnd(NAME_COL)} cents/g`;
  const rows = entries.map((e) => {
    const date = new Date(e.created_at).toISOString().slice(0, 10);
    return `${date.padEnd(DATE_COL)} ${tableNameCell(e.name)} ${centsValue(e.value_per_gram).padStart(7)}`;
  });
  return "```\n" + [header, ...rows].join("\n") + "\n```";
}

// No date column here — /history already covers "when", and cramming
// rank + name + value + date into one row is what was pushing this table
// past mobile Telegram's wrap width in the first place.
function buildCheapestTable(entries: db.Entry[]): string {
  const rankCol = 3;
  const header = `${"#".padEnd(rankCol)}${"Name".padEnd(NAME_COL)} cents/g`;
  const rows = entries.map((e, i) => {
    return `${String(i + 1).padEnd(rankCol)}${tableNameCell(e.name)} ${centsValue(e.value_per_gram).padStart(7)}`;
  });
  return "```\n" + [header, ...rows].join("\n") + "\n```";
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
  const nameLine = name ?? "(no name)";
  return `${nameLine}\n${formatCentsPerGram(value)}\nSaved ✓`;
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
    const rawText = message.text.trim();
    const text = MENU_LABEL_TO_COMMAND[rawText] ?? rawText;
    const reply = (msg: string, keyboard?: InlineKeyboard, parseMode?: "Markdown") =>
      sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard, parseMode);
    // Step prompts are entirely bot-authored text, so bolding the counter is
    // safe — unlike the result message, nothing here is raw user input.
    const replyStep = (step: number, question: string, keyboard: InlineKeyboard) =>
      reply(`*Step ${step} of ${TOTAL_STEPS}*\n\n${question}`, keyboard, "Markdown");

    await db.purgeStalePending(env.DB, PENDING_TTL_MS);

    if (text === "/start") {
      await sendMessageWithMenu(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Hi! I calculate how many euros you're paying per gram of protein, so you can tell " +
          "which of your groceries is actually the cheaper protein source.\n\n" +
          "Example: €2.50 for 500g with 23g protein per 100g → 2.17 cents per gram of protein.\n\n" +
          "/add — log a new item\n" +
          "/history — see your last entries\n" +
          "/cheapest — see your cheapest protein sources\n" +
          "/undo — remove your last saved entry\n" +
          "/cancel — cancel the current entry\n" +
          "/deleteme — delete all your saved data\n\n" +
          "No sensitive data is recorded."
      );
      return new Response("OK");
    }

    if (text === "/history") {
      const entries = await db.getRecentEntries(env.DB, chatId, MAX_LIST_SHOWN);
      if (entries.length === 0) {
        await reply("You haven't logged anything yet. Send /add to log your first item.");
        return new Response("OK");
      }
      const heading = `*Your last ${entries.length} ${entries.length === 1 ? "entry" : "entries"}:*`;
      await reply(`${heading}\n\n${buildHistoryTable(entries)}`, undefined, "Markdown");
      return new Response("OK");
    }

    if (text === "/cheapest") {
      const entries = await db.getCheapestEntries(env.DB, chatId, MAX_LIST_SHOWN);
      if (entries.length === 0) {
        await reply("You haven't logged anything yet. Send /add to log your first item.");
        return new Response("OK");
      }
      const heading = entries.length === 1 ? "Your cheapest entry" : `Your ${entries.length} cheapest entries`;
      await reply(`*${heading}, best value first:*\n\n${buildCheapestTable(entries)}`, undefined, "Markdown");
      return new Response("OK");
    }

    if (text === "/undo") {
      const removed = await db.deleteLastEntry(env.DB, chatId);
      if (!removed) {
        await reply("Nothing to undo, you haven't logged anything yet.");
        return new Response("OK");
      }
      const label = removed.name ?? "(no name)";
      await reply(`Removed: ${label} — ${formatCentsPerGram(removed.value_per_gram)}`);
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
      await replyStep(1, "What's the price? (€)", CANCEL_KEYBOARD);
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
      await replyStep(2, "Package weight? (grams)", CANCEL_KEYBOARD);
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
      await replyStep(3, "Protein per 100g?", CANCEL_KEYBOARD);
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
      await replyStep(4, "Product name? (optional — send /skip)", NAME_STEP_KEYBOARD);
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
