CREATE TABLE IF NOT EXISTS user_public_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key_spki TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

UPDATE users SET role = 'vip', updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE username = 'Bob' COLLATE NOCASE;
