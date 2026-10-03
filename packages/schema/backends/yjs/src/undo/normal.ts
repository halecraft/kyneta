// normal — a Yjs record's normal form, and the composition of two records.
//
// A record in normal form names no id it inserts or deletes anywhere but in
// its own `inserted` and `deleted` lists. That is what makes it revert
// correctly, and what keeps its tally honest: an entry naming content the
// record itself destroyed would always count as lost. One rule, over
// identity, with the ids each entry's path passes through and the characters
// or items it covers (a text run's characters are content exactly as a list
// run's items are):
//
// - N1, an id both inserted and deleted: it is neither.
// - N2, an id the record inserts: an entry inside it, or a mark on it, is
//   dropped. Undo deletes the content; the redo restores it as it ended.
// - N3, an id the record deletes: an entry inside it, or a mark on it, is
//   reverted onto that run's content, by the revert planner itself
//   (`planYjsRevert` over `gatherContent`), and dropped. The content is then
//   as it was before the record.
// - N4, adjacent runs: a deleted run anchored on an item another deleted run
//   holds is spliced into that run after that item, so restores at one gap
//   never depend on their order (finding 28).
//
// Value writes merge per path (the first `previous`, the last `wrote`), and
// mark writes per character and key, here; a write that ends where it began
// names nothing. A run deleted without its ids (a list deleted directly on
// the Y.Doc) can be matched by nothing, and is left as it is.
//
// `normalForm` says whether it reached the normal form. It does not when a
// chain of writes breaks (a peer wrote between two of them), when an entry
// lies in a run whose ids or anchors are not known, or when the entries
// inside a run do not revert whole onto its content (a peer changed it
// between): the entries are then left as they were. Two commits compose only into a record
// in normal form.

import {
  applyChange,
  deepClonePlain,
  RawPath,
  type RichTextSpan,
  type StateCell,
  samePlainValue,
} from "@kyneta/schema"
import { charMarks } from "./capture.js"
import {
  contentLength,
  type GatheredContainer,
  planYjsRevert,
  type YjsGathered,
} from "./plan.js"
import {
  type DeletedRun,
  expandRuns,
  type Id,
  type IdRun,
  type InsertedRun,
  idKey,
  type MarkWrite,
  type NestedIds,
  type RunContent,
  type Slot,
  type StablePath,
  type StableSegment,
  samePath,
  toRuns,
  type ValueWrite,
  type YjsRecord,
} from "./record.js"

// ---------------------------------------------------------------------------
// Merging writes
// ---------------------------------------------------------------------------

const sameSlot = (a: Slot, b: Slot): boolean =>
  a === null || b === null ? a === b : samePlainValue(a.value, b.value)

/** Value writes merged per path: the first `previous` and the last `wrote`,
 *  without the writes that end where they began. `chained` is false when a
 *  write's `previous` is not what the write before it wrote. */
function mergeValues(writes: readonly ValueWrite[]): {
  readonly writes: ValueWrite[]
  readonly chained: boolean
} {
  const byPath = new Map<string, ValueWrite>()
  let chained = true
  for (const write of writes) {
    const key = JSON.stringify(write.path)
    const earlier = byPath.get(key)
    if (earlier === undefined) {
      byPath.set(key, write)
      continue
    }
    if (!sameSlot(earlier.wrote, write.previous)) chained = false
    byPath.set(key, { ...write, previous: earlier.previous })
  }
  return {
    writes: [...byPath.values()].filter(w => !sameSlot(w.wrote, w.previous)),
    chained,
  }
}

/** Mark writes merged per character and key, as `mergeValues` merges
 *  values, and grouped again by what each character went from and to. */
function mergeMarks(marks: readonly MarkWrite[]): {
  readonly marks: MarkWrite[]
  readonly chained: boolean
} {
  const chars = new Map<
    string,
    {
      container: StablePath
      key: string
      id: Id
      wrote: unknown
      previous: unknown
    }
  >()
  let chained = true
  for (const mark of marks) {
    for (const id of expandRuns(mark.ids)) {
      const at = JSON.stringify([mark.container, mark.key, idKey(id)])
      const earlier = chars.get(at)
      if (earlier === undefined) {
        chars.set(at, { ...mark, id })
        continue
      }
      if (!samePlainValue(earlier.wrote, mark.previous)) chained = false
      chars.set(at, { ...earlier, wrote: mark.wrote })
    }
  }
  const groups = new Map<
    string,
    {
      container: StablePath
      key: string
      wrote: unknown
      previous: unknown
      ids: Id[]
    }
  >()
  for (const { container, key, id, wrote, previous } of chars.values()) {
    if (samePlainValue(wrote, previous)) continue
    const at = JSON.stringify([container, key, wrote, previous])
    const group = groups.get(at) ?? { container, key, wrote, previous, ids: [] }
    group.ids.push(id)
    groups.set(at, group)
  }
  return {
    marks: [...groups.values()].map(({ ids, ...rest }) => ({
      ...rest,
      ids: toRuns(ids),
    })),
    chained,
  }
}

// ---------------------------------------------------------------------------
// Content, unit by unit
// ---------------------------------------------------------------------------

/** A run's content as one element per unit: a character, a marked
 *  character, or an item. */
function contentUnits(content: RunContent): unknown[] {
  if (content.kind === "text") {
    return Array.from({ length: content.text.length }, (_, i) =>
      content.text.charAt(i),
    )
  }
  if (content.kind === "richtext") {
    const marks = charMarks(content.spans)
    const text = content.spans.map(s => s.text).join("")
    return marks.map((m, i) => ({ char: text.charAt(i), marks: m }))
  }
  return [...content.items]
}

function contentFromUnits(
  kind: RunContent["kind"],
  units: unknown[],
): RunContent {
  if (kind === "text") return { kind, text: units.join("") }
  if (kind === "sequence") return { kind, items: units }
  const spans: RichTextSpan[] = []
  for (const unit of units as { char: string; marks: object }[]) {
    const last = spans.at(-1)
    const marks = Object.keys(unit.marks).length > 0 ? unit.marks : undefined
    if (
      last !== undefined &&
      JSON.stringify(last.marks) === JSON.stringify(marks)
    ) {
      spans[spans.length - 1] = { ...last, text: last.text + unit.char }
    } else {
      spans.push(
        marks === undefined
          ? { text: unit.char }
          : { text: unit.char, marks: marks as RichTextSpan["marks"] },
      )
    }
  }
  return { kind, spans }
}

/** A run's ids, one per unit, or null when they are not known: a run
 *  deleted without its ids. */
function knownIds(run: DeletedRun): Id[] | null {
  const ids = [...expandRuns(run.ids)]
  return ids.length > 0 && ids.length === contentLength(run.content)
    ? ids
    : null
}

/** `run` without the units whose ids `drop` names, and the nested ids of
 *  the items it lost. */
function withoutUnits(
  run: DeletedRun,
  ids: readonly Id[],
  drop: (id: Id) => boolean,
): DeletedRun {
  const kept: number[] = []
  const keptIds: Id[] = []
  ids.forEach((id, i) => {
    if (drop(id)) return
    kept.push(i)
    keptIds.push(id)
  })
  if (kept.length === ids.length) return run
  const units = contentUnits(run.content)
  const renumber = new Map(kept.map((from, to) => [from, to]))
  return {
    ...run,
    ids: toRuns(keptIds),
    content: contentFromUnits(
      run.content.kind,
      kept.map(i => units[i]),
    ),
    nested: run.nested.flatMap(n => {
      const item = renumber.get(n.item)
      return item === undefined ? [] : [{ ...n, item }]
    }),
  }
}

/** `run` with `inserted` spliced in just after the unit at `at`. */
function spliceAfter(
  run: DeletedRun,
  ids: readonly Id[],
  at: number,
  inserted: DeletedRun,
  insertedIds: readonly Id[],
): DeletedRun {
  const units = contentUnits(run.content)
  const next = contentUnits(inserted.content)
  const n = insertedIds.length
  return {
    ...run,
    ids: toRuns([
      ...ids.slice(0, at + 1),
      ...insertedIds,
      ...ids.slice(at + 1),
    ]),
    content: contentFromUnits(run.content.kind, [
      ...units.slice(0, at + 1),
      ...next,
      ...units.slice(at + 1),
    ]),
    nested: [
      ...run.nested.map(m => (m.item > at ? { ...m, item: m.item + n } : m)),
      ...inserted.nested.map(m => ({ ...m, item: m.item + at + 1 })),
    ],
  }
}

/**
 * N4: each run anchored on an item another run of the same container holds,
 * spliced into that run just after it. Taken last deleted first: of two runs
 * anchored on one item, the one deleted later lies further from it, since
 * the earlier one was already gone between them.
 */
function spliceAdjacent(runs: readonly DeletedRun[]): DeletedRun[] {
  const out = [...runs]
  for (let i = out.length - 1; i >= 0; i--) {
    const run = out[i] as DeletedRun
    const runIds = knownIds(run)
    if (run.after === null || runIds === null) continue
    const anchor = idKey(run.after)
    for (let j = 0; j < out.length; j++) {
      const target = out[j] as DeletedRun
      if (j === i || !samePath(target.container, run.container)) continue
      const ids = knownIds(target)
      const at = ids?.findIndex(id => idKey(id) === anchor) ?? -1
      if (ids === null || at < 0) continue
      out[j] = spliceAfter(target, ids, at, run, runIds)
      out.splice(i, 1)
      break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// N3: entries reverted onto a deleted run's content
// ---------------------------------------------------------------------------

/** One text or list inside a run's content, with its ids as they stand. */
interface ContentList {
  readonly item: number
  readonly path: StableSegment[]
  readonly kind: string
  ids: Id[]
}

const listKey = (item: number, path: readonly StableSegment[]) =>
  `${item}|${JSON.stringify(path)}`

const indexOfId = (ids: readonly Id[], id: Id): number =>
  ids.findIndex(x => x.client === id.client && x.clock === id.clock)

function containerLength(kind: string, value: unknown): number {
  if (kind === "text") return String(value ?? "").length
  if (kind === "richtext") {
    return ((value ?? []) as RichTextSpan[]).reduce(
      (n, span) => n + span.text.length,
      0,
    )
  }
  return ((value ?? []) as unknown[]).length
}

function readSlot(cell: StateCell, path: RawPath): Slot {
  const last = path.segments.at(-1)
  if (last === undefined) return { value: cell.current }
  const parent = (path.slice(0, path.segments.length - 1) as RawPath).read(
    cell.current,
  )
  const key = last.resolve()
  if (parent === null || typeof parent !== "object") return null
  return Object.hasOwn(parent, key as PropertyKey)
    ? { value: (parent as Record<PropertyKey, unknown>)[key as PropertyKey] }
    : null
}

/**
 * What a revert of `sub` decides by, read from `run`'s content as a state
 * cell holds it instead of from the Y.Doc: the containers inside it and
 * their lengths, where each named id sits among the content's nested ids,
 * whether a run is back, what each value holds. Null when something `sub`
 * names cannot be found there.
 */
function gatherContent(
  run: DeletedRun,
  runIds: readonly Id[],
  lists: ReadonlyMap<string, ContentList>,
  cell: StateCell,
  sub: YjsRecord,
): {
  readonly gathered: YjsGathered
  readonly at: ReadonlyMap<string, ContentList>
} | null {
  const root = RawPath.empty.field(
    run.content.kind === "sequence" ? "items" : "spans",
  )
  const containers = new Map<string, GatheredContainer>()
  const at = new Map<string, ContentList>()
  const own: ContentList = {
    item: -1,
    path: [],
    kind: run.content.kind,
    ids: [...runIds],
  }

  /** Where `path` is in the content, or null if it is not. */
  const resolve = (
    path: StablePath,
  ): { raw: RawPath; item: number; rel: StableSegment[] } | null => {
    if (!samePath(path.slice(0, run.container.length), run.container)) {
      return null
    }
    const rest = path.slice(run.container.length)
    if (rest.length === 0) return { raw: root, item: -1, rel: [] }
    const [first, ...inner] = rest
    if (first === undefined || !("item" in first)) return null
    const item = indexOfId(runIds, first.item)
    if (item < 0) return null
    let raw = root.item(item)
    const rel: StableSegment[] = []
    for (const seg of inner) {
      if ("field" in seg) raw = raw.field(seg.field)
      else if ("entry" in seg) raw = raw.entry(seg.entry)
      else {
        const list = lists.get(listKey(item, rel))
        const index = list === undefined ? -1 : indexOfId(list.ids, seg.item)
        if (index < 0) return null
        raw = raw.item(index)
      }
      rel.push(seg)
    }
    return { raw, item, rel }
  }

  /** The container at `path` and its key, noting its kind and length. */
  const container = (
    path: StablePath,
  ): { readonly key: string; readonly list: ContentList } | null => {
    const where = resolve(path)
    if (where === null) return null
    const list =
      where.item < 0 ? own : lists.get(listKey(where.item, where.rel))
    if (list === undefined) return null
    const key = where.raw.key
    if (!containers.has(key)) {
      const value = where.raw.read(cell.current)
      containers.set(key, {
        path: where.raw,
        kind: list.kind,
        length: containerLength(list.kind, value),
        marks:
          list.kind === "richtext" ? charMarks(value as RichTextSpan[]) : [],
      })
      at.set(key, list)
    }
    return { key, list }
  }

  const located = (path: StablePath, ids: readonly IdRun[]) => {
    const found = container(path)
    if (found === null) return null
    const { key, list } = found
    return {
      container: key,
      indices: [...expandRuns(ids)]
        .map(id => indexOfId(list.ids, id))
        .filter(i => i >= 0),
    }
  }

  const inserted: { container: string | null; indices: number[] }[] = []
  for (const r of sub.inserted) {
    const where = located(r.container, r.ids)
    if (where === null) return null
    inserted.push(where)
  }
  const marks: { container: string | null; indices: number[] }[] = []
  for (const m of sub.marks) {
    const where = located(m.container, m.ids)
    if (where === null) return null
    marks.push(where)
  }
  const deleted: { container: string | null; back: boolean; gap: number }[] = []
  for (const r of sub.deleted) {
    const found = container(r.container)
    if (found === null) return null
    const { key, list } = found
    const anchor = r.after === null ? -1 : indexOfId(list.ids, r.after)
    if (r.after !== null && anchor < 0) return null
    deleted.push({
      container: key,
      back: [...expandRuns(r.ids)].some(id => indexOfId(list.ids, id) >= 0),
      gap: anchor + 1,
    })
  }
  const values: { path: RawPath | null; current: Slot }[] = []
  for (const v of sub.values) {
    const where = resolve(v.path)
    if (where === null) return null
    values.push({ path: where.raw, current: readSlot(cell, where.raw) })
  }
  return { gathered: { containers, inserted, deleted, marks, values }, at }
}

/**
 * `run` with `sub`, every entry inside it, reverted onto its content: its
 * content is then as it was before `sub`, and its nested ids name what that
 * content holds. Null when `sub` cannot be reverted there whole.
 */
function revertOnto(run: DeletedRun, sub: YjsRecord): DeletedRun | null {
  const runIds = knownIds(run)
  if (runIds === null || run.content.kind === "text") return null
  const lists = new Map<string, ContentList>(
    run.nested.map(n => [
      listKey(n.item, n.path),
      {
        item: n.item,
        path: [...n.path],
        kind: n.kind,
        ids: [...expandRuns(n.ids)],
      },
    ]),
  )
  const cell: StateCell = {
    current:
      run.content.kind === "sequence"
        ? { items: deepClonePlain(run.content.items) }
        : { spans: deepClonePlain(run.content.spans) },
  }
  const read = gatherContent(run, runIds, lists, cell, sub)
  if (read === null) return null
  const plan = planYjsRevert(sub, read.gathered)
  if (plan.tally.kept !== plan.tally.total) return null
  for (const { path, change } of plan.ops) applyChange(cell, path, change)

  // The ids follow the content: what the revert deleted goes, and each
  // restored run lands where it was placed, with what is inside it.
  sub.inserted.forEach((r, i) => {
    const key = read.gathered.inserted[i]?.container
    const list = key == null ? undefined : read.at.get(key)
    if (list === undefined) return
    const gone = new Set([...expandRuns(r.ids)].map(idKey))
    list.ids = list.ids.filter(id => !gone.has(idKey(id)))
    for (const [k, inner] of lists) {
      const seg = inner.path[list.path.length]
      if (
        inner.item === list.item &&
        samePath(inner.path.slice(0, list.path.length), list.path) &&
        seg !== undefined &&
        "item" in seg &&
        gone.has(idKey(seg.item))
      ) {
        lists.delete(k)
      }
    }
  })
  const placed = [...plan.placed].sort((a, b) => a.at - b.at)
  for (const { container, run: restored, at } of placed) {
    const list = read.at.get(container.key)
    const restoredIds = knownIds(restored)
    if (list === undefined || restoredIds === null) return null
    list.ids.splice(at, 0, ...restoredIds)
    for (const n of restored.nested) {
      const id = restoredIds[n.item]
      if (id === undefined) return null
      const path = [...list.path, { item: id }, ...n.path]
      lists.set(listKey(list.item, path), {
        item: list.item,
        path,
        kind: n.kind,
        ids: [...expandRuns(n.ids)],
      })
    }
  }

  const state = cell.current as {
    items?: unknown[]
    spans?: RichTextSpan[]
  }
  return {
    ...run,
    content:
      run.content.kind === "sequence"
        ? { kind: "sequence", items: state.items ?? [] }
        : { kind: "richtext", spans: state.spans ?? [] },
    nested: [...lists.values()].map(
      (l): NestedIds => ({
        item: l.item,
        path: l.path,
        kind: l.kind,
        ids: toRuns(l.ids),
      }),
    ),
  }
}

// ---------------------------------------------------------------------------
// The normal form
// ---------------------------------------------------------------------------

export interface Normalized {
  readonly record: YjsRecord
  /** Whether `record` is in normal form; see the header. */
  readonly complete: boolean
}

const passesThrough = (path: StablePath, ids: ReadonlySet<string>) =>
  path.some(seg => "item" in seg && ids.has(idKey(seg.item)))

/** `mark` without the characters `ids` names. */
function marksWithout(mark: MarkWrite, ids: ReadonlySet<string>): MarkWrite[] {
  const kept = [...expandRuns(mark.ids)].filter(id => !ids.has(idKey(id)))
  return kept.length === 0 ? [] : [{ ...mark, ids: toRuns(kept) }]
}

/** `record` brought to normal form, as far as it can be. */
export function normalForm(record: YjsRecord): Normalized {
  const values = mergeValues(record.values)
  const merged = mergeMarks(record.marks)
  let complete = values.chained && merged.chained

  // N2: nothing inside, or on, what the record inserts.
  const inserted = new Set(
    record.inserted.flatMap(r => [...expandRuns(r.ids)].map(idKey)),
  )
  let ins: InsertedRun[] = record.inserted.filter(
    r => !passesThrough(r.container, inserted),
  )
  let del: DeletedRun[] = record.deleted.filter(
    r => !passesThrough(r.container, inserted),
  )
  let vals = values.writes.filter(v => !passesThrough(v.path, inserted))
  let marks = merged.marks
    .filter(m => !passesThrough(m.container, inserted))
    .flatMap(m => marksWithout(m, inserted))

  // A run deleted without its ids can be matched by nothing: whatever names
  // its container's items is left as it is.
  const blind = del.filter(r => knownIds(r) === null).map(r => r.container)
  const inBlind = (path: StablePath) =>
    blind.some(
      c =>
        path.length > c.length &&
        samePath(path.slice(0, c.length), c) &&
        "item" in (path[c.length] as StableSegment),
    )
  if (
    ins.some(r => blind.some(c => samePath(c, r.container))) ||
    [
      ...ins.map(r => r.container),
      ...del.map(r => r.container),
      ...vals.map(v => v.path),
      ...marks.map(m => m.container),
    ].some(inBlind)
  ) {
    complete = false
  }

  // N4, then N1: the ids both inserted and deleted are neither.
  del = spliceAdjacent(del)
  const deletedIds = new Set(del.flatMap(r => (knownIds(r) ?? []).map(idKey)))
  const both = new Set([...inserted].filter(k => deletedIds.has(k)))
  if (both.size > 0) {
    ins = ins.flatMap(r => {
      const kept = [...expandRuns(r.ids)].filter(id => !both.has(idKey(id)))
      return kept.length === 0 ? [] : [{ ...r, ids: toRuns(kept) }]
    })
    del = del.flatMap(r => {
      const ids = knownIds(r)
      if (ids === null) return [r]
      const next = withoutUnits(r, ids, id => both.has(idKey(id)))
      return contentLength(next.content) === 0 ? [] : [next]
    })
  }

  // N3: what lies inside, or on, what the record deletes, reverted onto the
  // run that holds it. Each entry goes to the innermost such run, and a run
  // takes its own entries before it is reverted onto the run holding it.
  const runOfId = new Map<string, number>()
  del.forEach((r, i) => {
    for (const id of knownIds(r) ?? []) runOfId.set(idKey(id), i)
  })
  /** The innermost deleted run that holds an item `path` passes through. */
  const runHolding = (path: StablePath): number | undefined => {
    for (let k = path.length - 1; k >= 0; k--) {
      const seg = path[k] as StableSegment
      if ("item" in seg) {
        const run = runOfId.get(idKey(seg.item))
        if (run !== undefined) return run
      }
    }
    return undefined
  }
  /** The entries that lie inside one deleted run. */
  interface Inside {
    inserted: InsertedRun[]
    deleted: number[]
    values: ValueWrite[]
    marks: MarkWrite[]
  }
  const inside = new Map<number, Inside>()
  const insideRun = (run: number): Inside => {
    let entries = inside.get(run)
    if (entries === undefined) {
      entries = { inserted: [], deleted: [], values: [], marks: [] }
      inside.set(run, entries)
    }
    return entries
  }
  const topInserted: InsertedRun[] = []
  for (const r of ins) {
    const run = runHolding(r.container)
    if (run === undefined) topInserted.push(r)
    else insideRun(run).inserted.push(r)
  }
  const topDeleted: number[] = []
  del.forEach((r, i) => {
    const run = runHolding(r.container)
    if (run === undefined) topDeleted.push(i)
    else insideRun(run).deleted.push(i)
  })
  const topValues: ValueWrite[] = []
  for (const v of vals) {
    const run = runHolding(v.path)
    if (run === undefined) topValues.push(v)
    else insideRun(run).values.push(v)
  }
  const topMarks: MarkWrite[] = []
  for (const m of marks) {
    // A mark on characters a deleted text run holds goes to that run, the
    // rest to the run its text lies in, if any.
    const byRun = new Map<number, Id[]>()
    const rest: Id[] = []
    for (const id of expandRuns(m.ids)) {
      const run = runOfId.get(idKey(id))
      if (run === undefined) rest.push(id)
      else byRun.set(run, [...(byRun.get(run) ?? []), id])
    }
    for (const [run, ids] of byRun) {
      insideRun(run).marks.push({ ...m, ids: toRuns(ids) })
    }
    if (rest.length === 0) continue
    const run = runHolding(m.container)
    const left = { ...m, ids: toRuns(rest) }
    if (run === undefined) topMarks.push(left)
    else insideRun(run).marks.push(left)
  }

  /** Run `i` with everything inside it reverted onto it; whatever cannot be
   *  stays an entry of the record. */
  const runs = [...del]
  const foldInto = (i: number): void => {
    const entries = inside.get(i)
    if (entries === undefined) return
    for (const j of entries.deleted) foldInto(j)
    const sub: YjsRecord = {
      inserted: entries.inserted,
      deleted: entries.deleted.map(j => runs[j] as DeletedRun),
      values: entries.values,
      marks: entries.marks,
    }
    const next = revertOnto(runs[i] as DeletedRun, sub)
    if (next === null) {
      complete = false
      topInserted.push(...entries.inserted)
      topDeleted.push(...entries.deleted)
      topValues.push(...entries.values)
      topMarks.push(...entries.marks)
      return
    }
    runs[i] = next
  }
  for (const i of [...topDeleted]) foldInto(i)

  ins = topInserted
  del = runs.filter((_, i) => topDeleted.includes(i))
  vals = topValues
  marks = topMarks
  return {
    record: { inserted: ins, deleted: del, values: vals, marks },
    complete,
  }
}

/** `record` in normal form, as far as it can be brought there. */
export function normalizeYjsRecord(record: YjsRecord): YjsRecord {
  return normalForm(record).record
}

/** `earlier` then `later` as one record, or null when the two do not
 *  compose into a record in normal form: something foreign came between
 *  them on what they touch, or an entry lies where ids are not known. */
export function composeYjsRecords(
  earlier: YjsRecord,
  later: YjsRecord,
): YjsRecord | null {
  const { record, complete } = normalForm({
    inserted: [...earlier.inserted, ...later.inserted],
    deleted: [...earlier.deleted, ...later.deleted],
    values: [...earlier.values, ...later.values],
    marks: [...earlier.marks, ...later.marks],
  })
  return complete ? record : null
}
