// schema — the canonical DDL, as a function of the table names.
//
// The one source of the schema: `schema.sql` and the README show its
// output for the default names (a test checks `schema.sql` against it), and
// tests create their tables from it. The package never runs it; operators
// do, as a migration step.
//
// `doc_id` is `COLLATE "C"`: document ids are opaque identifiers, compared
// byte by byte, not words. `listDocIds(prefix)` scans the range from the
// prefix up to the prefix with its last code point incremented, which is the
// set of ids starting with the prefix only under code-point order. UTF-8 byte
// order is code-point order, so `"C"` makes the scan exact and keeps it on the
// primary-key index. Under a locale collation such as `en_US.utf8`,
// punctuation is nearly ignored, `'users/alice' < 'users0'` is false, and the
// scan returns nothing. `validateSchema` refuses a `doc_id` without it.

import { resolveTables, type TableNames } from "@kyneta/sql-store-core"

/** The collation every `doc_id` column must have. */
export const DOC_ID_COLLATION = "C"

/**
 * The canonical DDL for these table names (defaults: `kyneta_doc_meta`,
 * `kyneta_records`, `kyneta_store_meta`). Idempotent: every statement is
 * `CREATE TABLE IF NOT EXISTS`.
 */
export function postgresSchema(tables?: Partial<TableNames>): string {
  const { docMeta, records, storeMeta } = resolveTables({ tables })
  return `CREATE TABLE IF NOT EXISTS ${docMeta} (
  doc_id TEXT COLLATE "${DOC_ID_COLLATION}" PRIMARY KEY,
  data   JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS ${records} (
  doc_id  TEXT COLLATE "${DOC_ID_COLLATION}" NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT,
  blob    BYTEA,
  PRIMARY KEY (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS ${storeMeta} (
  key   TEXT  PRIMARY KEY,
  value JSONB NOT NULL
);
`
}
