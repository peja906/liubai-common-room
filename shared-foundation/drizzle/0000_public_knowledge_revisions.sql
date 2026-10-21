CREATE TABLE `public_knowledge_revisions` (
  `revision_id` text PRIMARY KEY NOT NULL,
  `article_id` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `revision_hash_length` CHECK (length(`revision_id`) = 64 AND length(`payload_sha256`) = 64),
  CONSTRAINT `bounded_public_payload` CHECK (length(CAST(`payload_json` AS BLOB)) <= 32768),
  CONSTRAINT `unique_article_payload` UNIQUE (`article_id`, `payload_sha256`)
);
