# @kyneta/bench

The workloads behind Pineta's report S63 (a value read builds a ref for every
node it reads) and the streaming case, run on every substrate: json, ephemeral,
Loro and Yjs. The documents are shaped like Pineta's session document, a record
of many rows of a few scalars and an opaque payload.

```sh
pnpm build          # at the repo root: the cases import each package's dist
cd tests/bench
pnpm bench          # --rows N (default 10000), --tokens N (default 200)
pnpm bench --group remote-stream   # one group: read, navigate, write,
                                   # local-stream or remote-stream
```

Each group runs in a child process of its own, so heap an earlier group
retained cannot slow a later one.

The benchmarks measure; they assert nothing, so `pnpm verify` checks only
formatting and types. Retained memory is the heap after two full collections,
before and after the work, with its result held.

| group | what it measures |
|---|---|
| read | a whole-record value read: first, again with no write, and again after one write |
| navigate | the memory of refs held after navigating to them: an entry, its scalar and nullable fields, the entry with all six fields, a list item; and the time to create 10,000 entry refs |
| write | one `set` into a wide record |
| local stream | one token written into one row, with and without a whole-record read after it; the record is read once before the first token |
| remote stream | the receiver's cost to merge one token's delta from a peer, with and without a read; the receiver reads the record once before the first token |
| log | the heap objects and bytes a json receiver keeps per merged batch, each batch writing a field of a different row, counted by heap snapshot |

The ephemeral substrate has no text, so it streams string replacements.

## Baseline

At `tuuzrwxl` ("the store completes every value it takes"), Node 24, 10,000
rows, 200 tokens, one process per group:

### read, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| first read | 416 ms | 344 ms | 371 ms | 344 ms |
| first read retained | 300 MiB | 298 MiB | 300 MiB | 298 MiB |
| first read retained per row | 30.8 KiB | 30.5 KiB | 30.7 KiB | 30.5 KiB |
| second read, no write | 0.05 ms | 0.01 ms | 0.05 ms | 0.01 ms |
| re-read after one write | 14.7 ms | 15.3 ms | 16.5 ms | 12.3 ms |
| re-read retained | 411 KiB | 395 KiB | 393 KiB | 390 KiB |

### navigate, 10000 rows

| metric | json |
|---|---:|
| entry ref | 6401 B |
| scalar field ref | 3559 B |

### write, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| record set | 17.5 µs | 18.9 µs | 84.8 µs | 18.2 µs |

### local stream, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| token, no read | 10.5 µs | 9.85 µs | 99.1 µs | 16.5 µs |
| token + record read | 10063 µs | 10894 µs | 12708 µs | 11753 µs |

### remote stream, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| merge, no read | 10.1 µs | 18667 µs | 263522 µs | 10487 µs |
| merge + record read | 12701 µs | 29075 µs | 597705 µs | 21152 µs |

### remote stream, 1000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| merge, no read | 11.4 µs | 2039 µs | 6245 µs | 1450 µs |
| merge + record read | 570 µs | 2650 µs | 39727 µs | 2077 µs |

An earlier baseline ran every group in one process, and the heap the earlier
groups retained inflated the later ones: Yjs "merge, no read" measured
51.8 ms there against 10.5 ms here, and json's record set 40.4 µs against
17.5 µs. Repeated isolated runs of the remote group agree within about 5%.

## After `PLAN-2026-09-30-reads-are-the-store`

A read is σ's own value, frozen in place, and a write copies only the frozen
nodes on its path. Node 24, 10,000 rows, 200 tokens, one process per group.
"Before" is the parent change ("a remote change re-materializes only what it
touched"), measured on the same machine in the same session.

### read, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| first read | 1.40 ms | 1.22 ms | 1.47 ms | 1.17 ms |
| first read retained | 0.06 MiB | -0.01 MiB | -0.03 MiB | -0.00 MiB |
| first read retained per row | 0.01 KiB | -0.00 KiB | -0.00 KiB | -0.00 KiB |
| second read, no write | 0.08 ms | 0.06 ms | 0.11 ms | 0.06 ms |
| re-read after one write | 1.20 ms | 1.09 ms | 1.18 ms | 1.08 ms |
| re-read retained | 0.46 KiB | 0.72 KiB | 0.27 KiB | 14.6 KiB |

Before: a first read took 339–421 ms and retained 298–300 MiB; a re-read
after one write took 14.2–16.9 ms.

### navigate, 10000 rows

| metric | json |
|---|---:|
| entry ref | 6328 B |
| scalar field ref | 4373 B |

Unchanged in kind: navigating still builds refs, and their cost is the next
plan's.

### write, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| record set | 14.3 µs | 12.8 µs | 69.5 µs | 18.6 µs |

### local stream, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| token, no read | 19.3 µs | 17.8 µs | 69.2 µs | 21.6 µs |
| token + record read | 1927 µs | 1862 µs | 1824 µs | 1831 µs |

### remote stream, 10000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| merge, no read | 16.7 µs | 38.6 µs | 152 µs | 27.7 µs |
| merge + record read | 1890 µs | 1796 µs | 1953 µs | 1927 µs |

### remote stream, 1000 rows

| metric | json | ephemeral | loro | yjs |
|---|---:|---:|---:|---:|
| merge, no read | 12.4 µs | 24.2 µs | 70.0 µs | 30.8 µs |
| merge + record read | 117 µs | 121 µs | 156 µs | 121 µs |

### Against the success criteria

- **First read** retains under 2 MiB on every substrate, from 300 MiB, and is
  about 300× faster.
- **Re-read after one write** takes 1.1–1.2 ms, under 2 ms.
- **Local token + record read** takes 1.8–1.9 ms, under 2 ms, from 6–10 ms.
  The write copies the record a read froze, about 0.9 ms at 10,000 keys, and
  the read freezes the copy, which visits every entry once.
- **Local token and remote merge, no read**, are within 1.2× in steady state
  but not over 200 tokens. Both groups read the whole record once before
  streaming, so the first write after it copies the record, once, and 200
  tokens carry that copy at 4–7 µs each. Over 2,000 tokens, where it is
  amortized, the two builds measure:

  | metric | build | json | ephemeral | loro | yjs |
  |---|---|---:|---:|---:|---:|
  | token, no read | before | 4.4–4.9 µs | 4.8 µs | 43–44 µs | 10–22 µs |
  | token, no read | after | 5.3–5.6 µs | 5.2–5.3 µs | 41–45 µs | 7.9–9.3 µs |
  | merge, no read | before | 5.2 µs | 19.7 µs | 47.4 µs | 28.4 µs |
  | merge, no read | after | 5.8 µs | 19.0 µs | 49.6 µs | 23.6 µs |

  Loro's remote merge varies most between runs at 200 tokens: 77–152 µs after,
  against 65 µs before.

### S63's repro

`kyneta-read-cost.ts` from Pineta's report, 10,000 rows, `json.bind`:

| row shape | report | before | after |
|---|---|---|---|
| `Schema.struct.json` (6 fields) | 466 ms, 300.5 MiB | 398 ms, 300.4 MiB | 1 ms, 0.1 MiB |
| `Schema.struct` (6 fields) | 463 ms, 300.5 MiB | 395 ms, 300.4 MiB | 1 ms, 0.1 MiB |
| `Schema.any()` | 70 ms, 38.5 MiB | 65 ms, 38.5 MiB | 1 ms, 0.1 MiB |

## Before `PLAN-2026-10-01-refs-share-their-behaviour`

The baseline that plan's criteria compare against, at `kszlnxqo` ("undo and
redo by document on one undo stack"), Node 24, 10,000 rows:

### navigate, 10000 rows

| metric | json |
|---|---:|
| entry ref | 6328 B |
| scalar field ref | 4373 B |
| nullable field ref | 5659 B |
| struct with its six fields | 35117 B |
| list item ref | 6381 B |
| create 10000 entry refs | 88.3 ms |

### log, 2000 batches

| metric | json |
|---|---:|
| objects kept per batch | 40.8 |
| bytes kept per batch | 2784 B |

The plan's Background counted 88 objects per batch with a different write;
this group writes one field of a row that already exists, so each batch's op
path reaches below the row.

## After `PLAN-2026-10-01-refs-share-their-behaviour`

A ref is its state, bound to a function on one prototype per schema node,
and lives while something holds it. A coordinate is one object, its address,
and a path is its parent and one segment. Node 24, 10,000 rows:

### navigate, 10000 rows

| metric | before | after | criterion |
|---|---:|---:|---:|
| entry ref | 6328 B | 462 B | ≤ 500 B |
| scalar field ref | 4373 B | 365 B | ≤ 400 B |
| nullable field ref | 5659 B | 401 B | ≤ 1 KB |
| struct with its six fields | 35117 B | 2624 B | ≤ 3 KB |
| list item ref | 6381 B | 462 B | ≤ 500 B |
| create 10000 entry refs | 88.3 ms | 13.7–15.1 ms | ≥ 5× faster |

An entry ref's bytes: its bound function (about 40), its state record (72),
its path (56), its address (80), the address's `WeakRef` to it (32), its
finalization registration (72), and its share of the record's children map.
A field ref has no `WeakRef` and no registration: it and its parent hold each
other, and are collected together.

### log, 2000 batches

| metric | before | after |
|---|---:|---:|
| objects kept per batch | 40.8 | 14.8 |
| bytes kept per batch | 2784 B | 627 B |

No batch leaves a coordinate-trie or subscriber-trie node behind any more
(`op-growth.test.ts` checks it). What a batch keeps is the logged batch (its
array, the op, its change, its path and the path's three segments, the row
key) and the state it wrote (the row's copy, whose number V8 boxes). The log
is the history the json substrate serves to peers (`exportSince`); the
exchange's compaction trims it.

### Every other group

`read`, `write`, `local stream` and `remote stream` are within run-to-run
noise of `kszlnxqo`, by three to five runs of each against a checkout of it:
Loro's "merge, no read", for one, measured 77–95 µs before and 78–84 µs after.
