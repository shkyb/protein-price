export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

/**
 * Sends a reply, optionally with inline buttons and/or Markdown formatting.
 * Only pass parseMode on text you fully control — any user-supplied text in
 * a Markdown-parsed message risks broken rendering or a rejected call if it
 * contains _, *, `, or [ characters. Failures are logged, not thrown — a
 * failed reply shouldn't turn into a 500 back to Telegram (which would just
 * cause retries).
 */
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  inlineKeyboard?: InlineKeyboard,
  parseMode?: "Markdown"
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, await res.text());
  }
}

const MAIN_MENU_KEYBOARD = {
  keyboard: [[{ text: "➕ Add" }, { text: "📊 History" }, { text: "❌ Cancel" }]],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Sends a message carrying the persistent quick-menu (Add/History/Cancel).
 * Unlike inline keyboards, a reply keyboard isn't tied to one message: once
 * shown, it stays on the user's screen across every later message until
 * something replaces or removes it. So this only needs to be sent once, at
 * the natural onboarding point (/start), not attached to every reply.
 */
export async function sendMessageWithMenu(token: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: MAIN_MENU_KEYBOARD }),
  });
  if (!res.ok) {
    console.error("Telegram sendMessage (with menu) failed:", res.status, await res.text());
  }
}

/**
 * Rewrites an existing message in place (used after a button tap, so the chat
 * shows the outcome instead of a second message plus stale buttons). Passing
 * no keyboard clears whatever buttons were on the message.
 */
export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  inlineKeyboard?: InlineKeyboard,
  parseMode?: "Markdown"
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard ?? [] },
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Telegram editMessageText failed:", res.status, await res.text());
  }
}

/**
 * Required after every callback query, whether or not anything else is done
 * with it — until this is called, Telegram shows a loading spinner on the
 * tapped button.
 */
export async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
  if (!res.ok) {
    console.error("Telegram answerCallbackQuery failed:", res.status, await res.text());
  }
}
