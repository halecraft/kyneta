-- @kyneta/postgres-store — canonical schema.
--
-- Run this once before constructing a `PostgresStore`, or include it
-- as a migration step in your application's migration pipeline. The
-- `createPostgresStore` factory validates that these tables exist with
-- the expected columns; it does not auto-DDL.
--
-- Default table names. To use different names, override via the
-- `tables` option, and generate the DDL for them with
-- `postgresSchema(tables)` from this package: this file is its output for
-- the defaults, and a test keeps the two equal.
--
-- `doc_id` is `COLLATE "C"`: document ids are compared byte by byte, which
-- `listDocIds(prefix)`'s range scan requires. The store refuses a `doc_id`
-- column without it. To migrate an existing deployment:
--
--   ALTER TABLE kyneta_doc_meta ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
--   ALTER TABLE kyneta_records  ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
--
-- `writer` is the seat that writes a serialized document; of the seats
-- sharing one storage, at most one authors each. To migrate:
--
--   ALTER TABLE kyneta_doc_meta ADD COLUMN writer TEXT;

CREATE TABLE IF NOT EXISTS kyneta_doc_meta (
  doc_id TEXT COLLATE "C" PRIMARY KEY,
  data   JSONB NOT NULL,
  writer TEXT
);

CREATE TABLE IF NOT EXISTS kyneta_records (
  doc_id  TEXT COLLATE "C" NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT,
  blob    BYTEA,
  PRIMARY KEY (doc_id, seq)
);

-- Store-global metadata (keyed by an opaque `key`, not a doc_id). Holds the
-- on-disk format version under key 'format'; the store factory stamps and
-- gates it on open. Distinct from kyneta_doc_meta (per-document metadata).
CREATE TABLE IF NOT EXISTS kyneta_store_meta (
  key   TEXT  PRIMARY KEY,
  value JSONB NOT NULL
);
