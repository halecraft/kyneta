-- @kyneta/postgres-store — canonical schema.
--
-- Run this once before constructing a `PostgresStore`, or include it
-- as a migration step in your application's migration pipeline. The
-- `createPostgresStore` factory validates that these tables exist with
-- the expected columns; it does not auto-DDL.
--
-- Default table names. To use different names, override via the
-- `tables` option and replace the names below to match.

CREATE TABLE IF NOT EXISTS kyneta_meta (
  doc_id TEXT  PRIMARY KEY,
  data   JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS kyneta_records (
  doc_id  TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT,
  blob    BYTEA,
  PRIMARY KEY (doc_id, seq)
);
