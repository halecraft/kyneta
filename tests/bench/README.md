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
| navigate | the memory of one entry ref and one field ref |
| write | one `set` into a wide record |
| local stream | one token written into one row, with and without a whole-record read after it |
| remote stream | the receiver's cost to merge one token's delta from a peer, with and without a read |

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
