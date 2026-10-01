// cases — the workloads behind S63 and the streaming case, per substrate.
//
// Shapes follow Pineta's session document: a record of many rows, each a
// struct of a few scalars and an opaque `payload`. The streaming shape adds a
// text field, which the ephemeral substrate cannot hold, so there it streams
// string replacements instead.

import { loro } from "@kyneta/loro-schema"
import {
  batch,
  createDoc,
  ephemeral,
  exportEntirety,
  exportSince,
  json,
  merge,
  Schema,
  version,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { KiB, MiB, measure, microsPer, type Result } from "./measure.ts"

// Documents are untyped here, as in the conformance harness: the cases run
// one body over every substrate, and a typed ref per schema would exceed the
// compiler's instantiation depth for no benefit.
type Doc = any
type Bind = (schema: any) => any
const create = createDoc as unknown as (bound: unknown) => Doc

const SUBSTRATES: ReadonlyArray<readonly [string, Bind]> = [
  ["json", s => json.bind(s)],
  ["ephemeral", s => ephemeral.bind(s)],
  ["loro", s => loro.bind(s)],
  ["yjs", s => yjs.bind(s)],
]

const rowFields = {
  id: Schema.string(),
  parentId: Schema.string().nullable(),
  type: Schema.string(),
  timestamp: Schema.number(),
  fromId: Schema.string().nullable(),
  payload: Schema.any(),
}

/** S63's row: six fields, one of them opaque. */
const SessionRows = Schema.struct({
  rows: Schema.record(Schema.struct(rowFields)),
})

const row = (i: number) => ({
  id: `row-${i}`,
  parentId: i === 0 ? null : `row-${i - 1}`,
  type: "message",
  timestamp: i,
  fromId: null,
  payload: {
    message: { role: "user", content: [{ type: "text", text: `text ${i}` }] },
  },
})

function sessionDoc(bind: Bind, rows: number): Doc {
  const doc = create(bind(SessionRows))
  batch(doc, (d: Doc) => {
    for (let i = 0; i < rows; i++) d.rows.set(`row-${i}`, row(i))
  })
  return doc
}

/** A record of rows with one streamed field: text where the substrate has it. */
function streamDoc(name: string, bind: Bind, rows: number): Doc {
  const body = name === "ephemeral" ? Schema.string() : Schema.text()
  const schema = Schema.struct({
    rows: Schema.record(Schema.struct({ body, n: Schema.number() })),
  })
  const doc = create(bind(schema))
  batch(doc, (d: Doc) => {
    for (let i = 0; i < rows; i++) d.rows.set(`r${i}`, { body: "", n: i })
  })
  return doc
}

/** One streamed token into `row`: a text insert, or a string replacement. */
function streamOne(name: string, row: Doc, i: number): void {
  if (name === "ephemeral") row.body.set("x".repeat(i + 1))
  else row.body.insert(i, "x")
}

// ---------------------------------------------------------------------------

/** Value reads of a whole record: first, repeated, and after one write. */
export function reads(rows: number): Result[] {
  const out: Result[] = []
  for (const [name, bind] of SUBSTRATES) {
    const doc = sessionDoc(bind, rows)
    const first = measure(() => doc.rows())
    const group = `read, ${rows} rows`
    out.push(
      {
        group,
        substrate: name,
        metric: "first read",
        value: first.ms,
        unit: "ms",
      },
      {
        group,
        substrate: name,
        metric: "first read retained",
        value: first.retainedBytes / MiB,
        unit: "MiB",
      },
      {
        group,
        substrate: name,
        metric: "first read retained per row",
        value: first.retainedBytes / rows / KiB,
        unit: "KiB",
      },
    )
    const again = measure(() => doc.rows())
    out.push({
      group,
      substrate: name,
      metric: "second read, no write",
      value: again.ms,
      unit: "ms",
    })
    doc.rows.at("row-1").timestamp.set(-1)
    const after = measure(() => doc.rows())
    out.push(
      {
        group,
        substrate: name,
        metric: "re-read after one write",
        value: after.ms,
        unit: "ms",
      },
      {
        group,
        substrate: name,
        metric: "re-read retained",
        value: after.retainedBytes / KiB,
        unit: "KiB",
      },
    )
  }
  return out
}

/** What navigating to one ref costs, on the json substrate. */
export function navigation(rows: number): Result[] {
  const doc = sessionDoc(SUBSTRATES[0][1], rows)
  const group = `navigate, ${rows} rows`
  const entries = measure(() => {
    const held: Doc[] = []
    for (let i = 0; i < rows; i++) held.push(doc.rows.at(`row-${i}`))
    return held
  })
  const fields = measure(() =>
    entries.value.map((entry: Doc) => [entry.id, entry.type, entry.timestamp]),
  )
  return [
    {
      group,
      substrate: "json",
      metric: "entry ref",
      value: entries.retainedBytes / rows,
      unit: "B",
    },
    {
      group,
      substrate: "json",
      metric: "scalar field ref",
      value: fields.retainedBytes / rows / 3,
      unit: "B",
    },
  ]
}

/** One `set` into a wide record. */
export function mapWrites(rows: number): Result[] {
  const out: Result[] = []
  for (const [name, bind] of SUBSTRATES) {
    const doc = sessionDoc(bind, rows)
    out.push({
      group: `write, ${rows} rows`,
      substrate: name,
      metric: "record set",
      value: microsPer(200, i => doc.rows.set(`new-${i}`, row(i))),
      unit: "µs",
    })
  }
  return out
}

/** Local streaming into one row, with and without a whole-record read. */
export function localStreaming(rows: number, tokens: number): Result[] {
  const out: Result[] = []
  for (const [name, bind] of SUBSTRATES) {
    const group = `local stream, ${rows} rows`
    for (const readEach of [false, true]) {
      const doc = streamDoc(name, bind, rows)
      doc.rows()
      const target = doc.rows.at(`r${rows >> 1}`)
      out.push({
        group,
        substrate: name,
        metric: readEach ? "token + record read" : "token, no read",
        value: microsPer(tokens, i => {
          streamOne(name, target, i)
          if (readEach) doc.rows()
        }),
        unit: "µs",
      })
    }
  }
  return out
}

/** A peer streams into one row; the receiver merges each token's delta. */
export function remoteStreaming(rows: number, tokens: number): Result[] {
  const out: Result[] = []
  for (const [name, bind] of SUBSTRATES) {
    const group = `remote stream, ${rows} rows`
    for (const readEach of [false, true]) {
      out.push(remoteStream(name, bind, rows, tokens, readEach, group))
    }
  }
  return out
}

function remoteStream(
  name: string,
  bind: Bind,
  rows: number,
  tokens: number,
  readEach: boolean,
  group: string,
): Result {
  const writer = streamDoc(name, bind, rows)
  const receiver = streamDoc(name, bind, 0)
  merge(receiver, exportEntirety(writer))
  receiver.rows()
  const target = writer.rows.at(`r${rows >> 1}`)
  let mergeMs = 0
  for (let i = 0; i < tokens; i++) {
    const since = version(writer)
    streamOne(name, target, i)
    const delta = exportSince(writer, since)
    if (delta === null) throw new Error(`${name}: no delta to send`)
    const start = performance.now()
    merge(receiver, delta)
    if (readEach) receiver.rows()
    mergeMs += performance.now() - start
  }
  return {
    group,
    substrate: name,
    metric: readEach ? "merge + record read" : "merge, no read",
    value: (mergeMs * 1000) / tokens,
    unit: "µs",
  }
}
