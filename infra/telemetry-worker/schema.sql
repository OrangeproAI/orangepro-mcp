-- Run this once: wrangler d1 execute orangepro-telemetry --file=schema.sql

CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  version TEXT,
  lang TEXT,
  file_bucket TEXT,
  os TEXT,
  node_version TEXT,
  ts TEXT,
  received_at TEXT NOT NULL
);

-- Useful indexes for querying
CREATE INDEX IF NOT EXISTS idx_pings_received ON pings(received_at);
CREATE INDEX IF NOT EXISTS idx_pings_lang ON pings(lang);
CREATE INDEX IF NOT EXISTS idx_pings_version ON pings(version);
