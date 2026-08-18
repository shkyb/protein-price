export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

export type Step = "price" | "weight" | "protein" | "name";

export interface Pending {
  chat_id: number;
  step: Step;
  price: number | null;
  weight: number | null;
  protein: number | null;
  updated_at: number;
}

export async function getPending(
  db: D1Database,
  chatId: number
): Promise<Pending | null> {
  const row = await db
    .prepare("SELECT * FROM pending WHERE chat_id = ?")
    .bind(chatId)
    .first<Pending>();
  return row ?? null;
}

export async function setPending(db: D1Database, p: Pending): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending (chat_id, step, price, weight, protein, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         step = excluded.step,
         price = excluded.price,
         weight = excluded.weight,
         protein = excluded.protein,
         updated_at = excluded.updated_at`
    )
    .bind(p.chat_id, p.step, p.price, p.weight, p.protein, p.updated_at)
    .run();
}

export async function clearPending(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM pending WHERE chat_id = ?").bind(chatId).run();
}

/** Opportunistic cleanup of abandoned mid-flow conversations. Not user data loss —
 * these rows are never a saved entry, just "what question was I on." */
export async function purgeStalePending(
  db: D1Database,
  olderThanMs: number
): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  await db.prepare("DELETE FROM pending WHERE updated_at < ?").bind(cutoff).run();
}

export async function saveEntry(
  db: D1Database,
  entry: {
    chat_id: number;
    name: string | null;
    price: number;
    weight: number;
    protein: number;
    value_per_gram: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (chat_id, name, price, weight, protein, value_per_gram, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.chat_id,
      entry.name,
      entry.price,
      entry.weight,
      entry.protein,
      entry.value_per_gram,
      Date.now()
    )
    .run();
}

/** Backs the public /deleteme command — full self-serve erasure, no request needed. */
export async function deleteAllForChat(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM entries WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM pending WHERE chat_id = ?").bind(chatId).run();
}

/** Used for the per-chat daily rate limit — counts only *saved* entries, not
 * abandoned/pending flows. */
export async function countRecentEntries(
  db: D1Database,
  chatId: number,
  sinceMs: number
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as count FROM entries WHERE chat_id = ? AND created_at >= ?")
    .bind(chatId, sinceMs)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface Entry {
  id: number;
  chat_id: number;
  name: string | null;
  price: number;
  weight: number;
  protein: number;
  value_per_gram: number;
  created_at: number;
}

/** Backs /history — most recent entries first. */
export async function getRecentEntries(
  db: D1Database,
  chatId: number,
  limit: number
): Promise<Entry[]> {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(chatId, limit)
    .all<Entry>();
  return results;
}

/** Backs /cheapest — cheapest euros-per-gram-of-protein first. */
export async function getCheapestEntries(
  db: D1Database,
  chatId: number,
  limit: number
): Promise<Entry[]> {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE chat_id = ? ORDER BY value_per_gram ASC LIMIT ?")
    .bind(chatId, limit)
    .all<Entry>();
  return results;
}
