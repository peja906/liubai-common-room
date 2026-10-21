-- Local-only schema. Not part of the deployed Sites migration journal.
CREATE TABLE workshop_posts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'proposal')),
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1500),
  reply_to TEXT REFERENCES workshop_posts(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 8192),
  CHECK (reply_to IS NULL OR (length(reply_to) = 64 AND reply_to NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX workshop_posts_created_at ON workshop_posts(created_at);
CREATE INDEX workshop_posts_reply_to ON workshop_posts(reply_to);
