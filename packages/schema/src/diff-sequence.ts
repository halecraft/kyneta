// diff-sequence — the shortest edit between two sequences, as instructions.
//
// Myers' O((N+M)·D) algorithm: it finds a longest common subsequence and
// emits the items outside it as deletes and inserts. Undo on a history-based
// backend uses it to say what happened to a text or a list between two
// versions by content: text a revert put back is the same text, whatever
// ids it now has.

import type { SequenceInstruction, TextInstruction } from "./change.js"

type Step = "keep" | "delete" | "insert"

/** The edit script turning `a` into `b`, one step per item. */
function script<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (x: T, y: T) => boolean,
): Step[] {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max
  const v = new Array<number>(2 * max + 2).fill(0)
  const trace: number[][] = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push([...v])
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && equal(a[x] as T, b[y] as T)) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) break outer
    }
  }
  // Walk the trace back from the end.
  const steps: Step[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] ?? []
    const k = x - y
    const down =
      k === -d ||
      (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))
    const prevK = down ? k + 1 : k - 1
    const prevX = vd[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      steps.push("keep")
      x--
      y--
    }
    if (d > 0) {
      steps.push(down ? "insert" : "delete")
      if (down) y--
      else x--
    }
  }
  return steps.reverse()
}

function instructions<T, I>(
  steps: readonly Step[],
  after: readonly T[],
  make: {
    retain: (n: number) => I
    delete: (n: number) => I
    insert: (items: T[]) => I
  },
): I[] {
  const out: I[] = []
  let run: { step: Step; count: number; items: T[] } | undefined
  let y = 0
  const flush = () => {
    if (run === undefined) return
    if (run.step === "keep") out.push(make.retain(run.count))
    else if (run.step === "delete") out.push(make.delete(run.count))
    else out.push(make.insert(run.items))
    run = undefined
  }
  for (const step of steps) {
    if (run === undefined || run.step !== step) {
      flush()
      run = { step, count: 0, items: [] }
    }
    run.count++
    if (step === "insert") run.items.push(after[y] as T)
    if (step !== "delete") y++
  }
  // A trailing retain says nothing.
  if (run?.step !== "keep") flush()
  return out
}

/** The shortest edit from `before` to `after`, character by character. */
export function diffString(before: string, after: string): TextInstruction[] {
  const steps = script([...before], [...after], (x, y) => x === y)
  return instructions<string, TextInstruction>(steps, [...after], {
    retain: n => ({ retain: n }),
    delete: n => ({ delete: n }),
    insert: items => ({ insert: items.join("") }),
  })
}

/** The shortest edit from `before` to `after`, item by item. */
export function diffSequence<T>(
  before: readonly T[],
  after: readonly T[],
  equal: (x: T, y: T) => boolean,
): SequenceInstruction<T>[] {
  const steps = script(before, after, equal)
  return instructions<T, SequenceInstruction<T>>(steps, after, {
    retain: n => ({ retain: n }),
    delete: n => ({ delete: n }),
    insert: items => ({ insert: items }),
  })
}
