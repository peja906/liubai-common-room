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
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'accepted', 'rejected', 'hidden')),
  review_version INTEGER NOT NULL DEFAULT 1 CHECK (review_version >= 1),
  CHECK (reply_to IS NULL OR (length(reply_to) = 64 AND reply_to NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX workshop_posts_created_at ON workshop_posts(created_at);
CREATE INDEX workshop_posts_reply_to ON workshop_posts(reply_to);
CREATE INDEX workshop_posts_review_state ON workshop_posts(review_state, seq);

CREATE TABLE workshop_reports (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  post_id TEXT NOT NULL REFERENCES workshop_posts(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 8192)
);
CREATE INDEX workshop_reports_created_at ON workshop_reports(created_at);

CREATE TABLE workshop_audit (
  seq INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES workshop_posts(id) ON DELETE RESTRICT,
  review_version INTEGER NOT NULL CHECK (review_version >= 2),
  from_state TEXT NOT NULL CHECK (from_state IN ('pending', 'accepted', 'rejected', 'hidden')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending', 'accepted', 'rejected', 'hidden')),
  action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'hide', 'restore')),
  note TEXT NOT NULL CHECK (length(note) <= 300),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (post_id, review_version)
);
