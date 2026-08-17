CREATE TABLE IF NOT EXISTS pending (
  chat_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  price REAL,
  weight REAL,
  protein REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  name TEXT,
  price REAL NOT NULL,
  weight REAL NOT NULL,
  protein REAL NOT NULL,
  value_per_gram REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_chat_id ON entries (chat_id);
