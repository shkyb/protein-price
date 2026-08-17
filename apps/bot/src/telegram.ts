export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

/**
 * Sends a plain-text reply. Failures are logged, not thrown — a failed reply
 * shouldn't turn into a 500 back to Telegram (which would just cause retries).
 */
export async function sendMessage(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, await res.text());
  }
}
