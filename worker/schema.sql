CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_state (
  event_id TEXT NOT NULL,
  search_id TEXT NOT NULL,
  tickets INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (event_id, search_id)
);

CREATE TABLE IF NOT EXISTS user_prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
