import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../index.js"
import {
  applyChanges,
  change,
  incrementChange,
  interpret,
  observation,
  plainContext,
  RawPath,
  readable,
  replaceChange,
  Schema,
  sequenceChange,
  subscribe,
  subscribeNode,
  textChange,
  writable,
} from "../index.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const chatDocSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.annotated("counter"),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.annotated("text"),
    }),
  ),
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

function createSeed() {
  return {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
  }
}

function createChatDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = { ...createSeed(), ...storeOverrides }
  const ctx = plainContext(store)
  const doc = interpret(chatDocSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
  return { store, ctx, doc }
}

const CF_SYM = Symbol.for("kyneta:changefeed")

function getChangefeed(obj: unknown): {
  current: unknown
  subscribe: (cb: (changeset: Changeset) => void) => () => void
  subscribeTree?: (cb: (changeset: Changeset<Op>) => void) => () => void
} {
  return (obj as any)[CF_SYM]
}

// ===========================================================================
// change() — imperative mutation → Op[]
// ===========================================================================

describe("change: basic behavior", () => {
  it("returns Op[] with correct paths and change types", () => {
    const { doc } = createChatDoc()

    const ops = change(doc, d => {
      d.settings.darkMode.set(true)
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]?.path.key).toBe(
      RawPath.empty.field("settings").field("darkMode").key,
    )
    expect(ops[0]?.change).toEqual(replaceChange(true))
  })

  it("captures multiple mutations as multiple Op entries", () => {
    const { doc } = createChatDoc()

    const ops = change(doc, d => {
      d.settings.darkMode.set(true)
      d.settings.fontSize.set(18)
      d.messages.push({ author: "Bob", body: "Hey" })
    })

    expect(ops).toHaveLength(3)
    // First: darkMode set
    expect(ops[0]?.path.key).toBe(
      RawPath.empty.field("settings").field("darkMode").key,
    )
    // Second: fontSize set
    expect(ops[1]?.path.key).toBe(
      RawPath.empty.field("settings").field("fontSize").key,
    )
    // Third: messages push
    expect(ops[2]?.path.key).toBe(RawPath.empty.field("messages").key)
  })

  it("captures text mutations", () => {
    const { doc } = createChatDoc()

    const ops = change(doc, d => {
      d.title.insert(5, " World")
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]?.change).toEqual(
      textChange([{ retain: 5 }, { insert: " World" }]),
    )
  })

  it("captures counter mutations", () => {
    const { doc } = createChatDoc()

    const ops = change(doc, d => {
      d.count.increment(3)
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]?.change).toEqual(incrementChange(3))
  })

  it("applies mutations to the store", () => {
    const { doc, store } = createChatDoc()

    change(doc, d => {
      d.settings.darkMode.set(true)
    })

    expect(store.settings).toEqual({ darkMode: true, fontSize: 14 })
    expect(doc.settings.darkMode()).toBe(true)
  })

  it("throws on non-transactable ref", () => {
    expect(() => change({} as any, () => {})).toThrow("[TRANSACT]")
  })

  it("aborts transaction on error and re-throws", () => {
    const { doc, store } = createChatDoc()

    expect(() =>
      change(doc, d => {
        d.settings.darkMode.set(true)
        throw new Error("oops")
      }),
    ).toThrow("oops")

    // Store should be unchanged — transaction was aborted
    expect(store.settings).toEqual({ darkMode: false, fontSize: 14 })
    expect(doc.settings.darkMode()).toBe(false)
  })
})

// ===========================================================================
// applyChanges() — declarative Op[] → store + notify
// ===========================================================================

describe("applyChanges: basic behavior", () => {
  it("applies replace changes to the store", () => {
    const { doc } = createChatDoc()

    const ops: Op[] = [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
    ]

    applyChanges(doc, ops)

    expect(doc.settings.darkMode()).toBe(true)
  })

  it("applies text changes to the store", () => {
    const { doc } = createChatDoc()

    const ops: Op[] = [
      {
        path: RawPath.empty.field("title"),
        change: textChange([{ retain: 5 }, { insert: " World" }]),
      },
    ]

    applyChanges(doc, ops)

    expect(doc.title()).toBe("Hello World")
  })

  it("applies sequence changes to the store", () => {
    const { doc } = createChatDoc()

    const ops: Op[] = [
      {
        path: RawPath.empty.field("messages"),
        change: sequenceChange([
          { retain: 1 },
          { insert: [{ author: "Bob", body: "Hey" }] },
        ]),
      },
    ]

    applyChanges(doc, ops)

    expect(doc.messages.length).toBe(2)
    expect(doc.messages.at(1)?.author()).toBe("Bob")
  })

  it("applies increment changes to the store", () => {
    const { doc } = createChatDoc()

    const ops: Op[] = [
      {
        path: RawPath.empty.field("count"),
        change: incrementChange(5),
      },
    ]

    applyChanges(doc, ops)

    expect(doc.count()).toBe(5)
  })

  it("applies multiple changes atomically", () => {
    const { doc } = createChatDoc()

    const ops: Op[] = [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
      {
        path: RawPath.empty.field("settings").field("fontSize"),
        change: replaceChange(20),
      },
      {
        path: RawPath.empty.field("title"),
        change: textChange([{ delete: 5 }, { insert: "Goodbye" }]),
      },
    ]

    applyChanges(doc, ops)

    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(20)
    expect(doc.title()).toBe("Goodbye")
  })

  it("returns the ops array (pass-through)", () => {
    const { doc } = createChatDoc()
    const ops: Op[] = [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
    ]

    const result = applyChanges(doc, ops)
    expect(result).toBe(ops)
  })

  it("throws on non-transactable ref", () => {
    expect(() => applyChanges({}, [])).toThrow("[TRANSACT]")
  })

  it("empty ops is a no-op (no subscribers fire)", () => {
    const { doc } = createChatDoc()
    const events: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe(cs => events.push(cs))

    const result = applyChanges(doc, [])

    expect(result).toEqual([])
    expect(events).toHaveLength(0)
  })

  it("throws during active transaction", () => {
    const { doc, ctx } = createChatDoc()
    ctx.beginTransaction()

    expect(() =>
      applyChanges(doc, [
        {
          path: RawPath.empty.field("settings").field("darkMode"),
          change: replaceChange(true),
        },
      ]),
    ).toThrow("active transaction")

    ctx.abort()
  })
})

// ===========================================================================
// Round-trip: change(docA) → applyChanges(docB)
// ===========================================================================

describe("round-trip: change → applyChanges", () => {
  it("text + settings mutations round-trip correctly", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const ops = change(docA.doc, d => {
      d.title.insert(5, " World")
      d.settings.darkMode.set(true)
      d.settings.fontSize.set(20)
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
  })

  it("sequence push round-trips correctly", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const ops = change(docA.doc, d => {
      d.messages.push({ author: "Bob", body: "Hey" })
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
  })

  it("counter increment round-trips correctly", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const ops = change(docA.doc, d => {
      d.count.increment(7)
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
  })

  it("mixed mutations across multiple types round-trip correctly", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const ops = change(docA.doc, d => {
      d.title.insert(5, " World")
      d.count.increment(3)
      d.messages.push({ author: "Bob", body: "Hey" })
      d.settings.darkMode.set(true)
      d.metadata.set("color", "red")
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
  })

  it("sequence insert (not append) round-trips correctly", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const ops = change(docA.doc, d => {
      d.messages.insert(0, { author: "Eve", body: "First!" })
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
    expect(docB.doc.messages.at(0)?.author()).toBe("Eve")
    expect(docB.doc.messages.at(1)?.author()).toBe("Alice")
  })

  it("sequence delete round-trips correctly", () => {
    const storeOverrides = {
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
        { author: "Carol", body: "Yo" },
      ],
    }
    const docA = createChatDoc(storeOverrides)
    const docB = createChatDoc(storeOverrides)

    const ops = change(docA.doc, d => {
      d.messages.delete(1, 1)
    })

    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
    expect(docB.doc.messages.length).toBe(2)
    expect(docB.doc.messages.at(0)?.author()).toBe("Alice")
    expect(docB.doc.messages.at(1)?.author()).toBe("Carol")
  })
})

// ===========================================================================
// Batched notification via applyChanges
// ===========================================================================

describe("applyChanges: batched notification", () => {
  it("fires subscribers exactly once with all changes (not once per change)", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.settings).subscribe(cs => changesets.push(cs))

    applyChanges(doc, [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
      {
        path: RawPath.empty.field("settings").field("fontSize"),
        change: replaceChange(20),
      },
    ])

    // Settings subscriber should NOT fire — settings itself didn't change.
    // The children (darkMode, fontSize) changed. Let's check leaf subscribers.
    expect(changesets).toHaveLength(0)

    // Check leaf subscribers
    const dmChangesets: Changeset[] = []
    const fsChangesets: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe(cs => dmChangesets.push(cs))
    getChangefeed(doc.settings.fontSize).subscribe(cs => fsChangesets.push(cs))

    applyChanges(doc, [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(false),
      },
      {
        path: RawPath.empty.field("settings").field("fontSize"),
        change: replaceChange(16),
      },
    ])

    expect(dmChangesets).toHaveLength(1)
    expect(dmChangesets[0]?.changes).toHaveLength(1)
    expect(fsChangesets).toHaveLength(1)
    expect(fsChangesets[0]?.changes).toHaveLength(1)
  })

  it("subscriber sees fully-applied state (not partially-applied)", () => {
    const { doc } = createChatDoc()

    let darkModeAtNotification: boolean | undefined
    let fontSizeAtNotification: number | undefined

    getChangefeed(doc.settings.darkMode).subscribe(() => {
      // When notification fires, BOTH changes should already be applied
      darkModeAtNotification = doc.settings.darkMode()
      fontSizeAtNotification = doc.settings.fontSize()
    })

    applyChanges(doc, [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
      {
        path: RawPath.empty.field("settings").field("fontSize"),
        change: replaceChange(20),
      },
    ])

    expect(darkModeAtNotification).toBe(true)
    expect(fontSizeAtNotification).toBe(20)
  })

  it("batched changes at the same path produce one Changeset with N changes", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.count).subscribe(cs => changesets.push(cs))

    applyChanges(doc, [
      {
        path: RawPath.empty.field("count"),
        change: incrementChange(1),
      },
      {
        path: RawPath.empty.field("count"),
        change: incrementChange(2),
      },
      {
        path: RawPath.empty.field("count"),
        change: incrementChange(3),
      },
    ])

    // One Changeset with 3 changes
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(3)
    expect(doc.count()).toBe(6)
  })
})

// ===========================================================================
// Origin tagging via applyChanges
// ===========================================================================

describe("applyChanges: origin tagging", () => {
  it("attaches origin to emitted Changeset", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe(cs => changesets.push(cs))

    applyChanges(
      doc,
      [
        {
          path: RawPath.empty.field("settings").field("darkMode"),
          change: replaceChange(true),
        },
      ],
      { origin: "sync" },
    )

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBe("sync")
  })

  it("origin is undefined when not specified", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe(cs => changesets.push(cs))

    applyChanges(doc, [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
    ])

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBeUndefined()
  })

  it("tree subscribers receive origin from applyChanges", () => {
    const { doc } = createChatDoc()

    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(doc.settings).subscribeTree?.(cs => treeChangesets.push(cs))

    applyChanges(
      doc,
      [
        {
          path: RawPath.empty.field("settings").field("darkMode"),
          change: replaceChange(true),
        },
      ],
      { origin: "undo" },
    )

    expect(treeChangesets).toHaveLength(1)
    expect(treeChangesets[0]?.origin).toBe("undo")
    expect(treeChangesets[0]?.changes).toHaveLength(1)
    expect(treeChangesets[0]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("darkMode").key,
    )
  })
})

// ===========================================================================
// Surgical cache invalidation via applyChanges
// ===========================================================================

describe("applyChanges: surgical cache invalidation", () => {
  it("invalidates cache at target path, preserves unrelated caches", () => {
    const { doc } = createChatDoc()

    // Populate caches at two unrelated paths
    const msgRef = doc.messages.at(0)
    expect(msgRef?.author()).toBe("Alice")
    expect(doc.settings.darkMode()).toBe(false)

    // Apply change only to settings.darkMode
    applyChanges(doc, [
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        change: replaceChange(true),
      },
    ])

    // Targeted cache invalidated — new value visible
    expect(doc.settings.darkMode()).toBe(true)
    // Unrelated cache preserved — same ref identity
    expect(doc.messages.at(0)).toBe(msgRef)
    expect(doc.messages.at(0)?.author()).toBe("Alice")
  })

  it("invalidates sequence cache on insert (evict)", () => {
    const { doc } = createChatDoc()

    // Populate sequence cache
    const _refAlice = doc.messages.at(0)
    expect(_refAlice?.author()).toBe("Alice")

    // Insert at index 0 via applyChanges
    applyChanges(doc, [
      {
        path: RawPath.empty.field("messages"),
        change: sequenceChange([
          { insert: [{ author: "Eve", body: "First!" }] },
        ]),
      },
    ])

    // All indices evicted and re-created with correct paths
    expect(doc.messages.at(0)?.author()).toBe("Eve")
    expect(doc.messages.at(1)?.author()).toBe("Alice") // semantic correctness
  })
})

// ===========================================================================
// Changeset<Op> ≅ (Op[], origin) round-trip
// ===========================================================================

describe("round-trip: subscribeTree output → applyChanges input", () => {
  it("tree events from docA can reconstruct Op[] for docB", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    // Subscribe to tree events on the root of docA
    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(docA.doc).subscribeTree?.(cs => treeChangesets.push(cs))

    // Mutate docA — two changes at different leaf paths
    change(docA.doc, d => {
      d.settings.darkMode.set(true)
      d.count.increment(5)
    })

    // Tree subscribers receive one Changeset<Op> per affected
    // child path (propagated independently through the tree). Two
    // different paths → two changesets.
    expect(treeChangesets).toHaveLength(2)

    // Reconstruct Op[] from all tree events.
    // Op.path is relative to the subscription point (root in
    // this case), so it's the same as the absolute path.
    const reconstructedOps: Op[] = treeChangesets.flatMap(cs =>
      cs.changes.map(te => ({
        path: te.path,
        change: te.change,
      })),
    )

    // Apply to docB
    applyChanges(docB.doc, reconstructedOps)

    expect(docB.doc()).toEqual(docA.doc())
  })

  it("tree events from a subtree carry relative paths", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    // Subscribe to tree events on docA.settings (subtree)
    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(docA.doc.settings).subscribeTree?.(cs =>
      treeChangesets.push(cs),
    )

    // Mutate settings subtree — two changes at different leaf paths
    change(docA.doc, d => {
      d.settings.darkMode.set(true)
      d.settings.fontSize.set(24)
    })

    // Each leaf child propagates independently → two changesets
    expect(treeChangesets).toHaveLength(2)

    // Each changeset has one Op with a relative path
    expect(treeChangesets[0]?.changes).toHaveLength(1)
    expect(treeChangesets[0]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("darkMode").key,
    )
    expect(treeChangesets[1]?.changes).toHaveLength(1)
    expect(treeChangesets[1]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("fontSize").key,
    )

    // To apply to docB, we need to prepend the "settings" prefix
    const absoluteOps: Op[] = treeChangesets.flatMap(cs =>
      cs.changes.map(te => ({
        path: te.path.root().field("settings").concat(te.path),
        change: te.change,
      })),
    )

    applyChanges(docB.doc, absoluteOps)

    expect(docB.doc.settings.darkMode()).toBe(true)
    expect(docB.doc.settings.fontSize()).toBe(24)
    expect(docB.doc()).toEqual(docA.doc())
  })
})

// ===========================================================================
// change + applyChanges interplay with changefeed
// ===========================================================================

describe("change: changefeed integration", () => {
  it("change() fires subscribers with batched Changeset", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe(cs => changesets.push(cs))

    change(doc, d => {
      d.settings.darkMode.set(true)
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
  })

  it("change() with multiple mutations to same path batches them", () => {
    const { doc } = createChatDoc()

    const changesets: Changeset[] = []
    getChangefeed(doc.count).subscribe(cs => changesets.push(cs))

    change(doc, d => {
      d.count.increment(1)
      d.count.increment(2)
      d.count.increment(3)
    })

    // One Changeset with 3 changes (transaction commit batches)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(3)
    expect(doc.count()).toBe(6)
  })
})

// ===========================================================================
// Re-entrancy: subscriber-triggered mutations during notification
// ===========================================================================
//
// The flush pipeline clears its pending accumulator BEFORE delivering
// notifications. This means a subscriber can safely trigger new mutations
// (auto-commit, change(), or applyChanges()) without corrupting the
// outer notification cycle. These tests verify that invariant.

describe("re-entrancy: mutation during notification is forbidden", () => {
  it("auto-commit inside subscriber throws flush boundary error", () => {
    const { doc } = createChatDoc()

    getChangefeed(doc.settings.darkMode).subscribe(() => {
      // Re-entrant auto-commit: triggers prepare nested inside
      // the outer flush's deliverNotifications loop.
      doc.settings.fontSize.set(24)
    })

    // The outer change() should propagate the flush boundary error
    expect(() => {
      change(doc, d => {
        d.settings.darkMode.set(true)
      })
    }).toThrow(/notification delivery/)
  })

  it("change() inside subscriber throws flush boundary error", () => {
    const { doc } = createChatDoc()

    getChangefeed(doc.settings.darkMode).subscribe(() => {
      change(doc, d => {
        d.settings.fontSize.set(20)
        d.count.increment(5)
      })
    })

    expect(() => {
      change(doc, d => {
        d.settings.darkMode.set(true)
      })
    }).toThrow(/notification delivery/)
  })

  it("applyChanges() inside subscriber throws flush boundary error", () => {
    const { doc } = createChatDoc()

    getChangefeed(doc.settings.darkMode).subscribe(() => {
      applyChanges(doc, [
        {
          path: RawPath.empty.field("count"),
          change: incrementChange(10),
        },
      ])
    })

    expect(() => {
      change(doc, d => {
        d.settings.darkMode.set(true)
      })
    }).toThrow(/notification delivery/)
  })

  it("chained re-entrancy: subscriber triggers mutation throws flush boundary error", () => {
    const { doc } = createChatDoc()

    // Chain: darkMode notification → fontSize mutation (which would
    // trigger another subscriber). The first re-entrant mutation
    // should throw before reaching the second.
    getChangefeed(doc.settings.darkMode).subscribe(() => {
      doc.settings.fontSize.set(18)
    })

    expect(() => {
      change(doc, d => {
        d.settings.darkMode.set(true)
      })
    }).toThrow(/notification delivery/)
  })

  it("outer mutation is applied even when re-entrant subscriber throws", () => {
    const { doc } = createChatDoc()

    getChangefeed(doc.settings.darkMode).subscribe(() => {
      doc.count.increment(1)
    })

    // The outer change throws because the subscriber tries to mutate
    // during flush, but the outer mutation (darkMode.set) was already
    // applied to the store during the prepare phase.
    expect(() => {
      change(doc, d => {
        d.settings.darkMode.set(true)
      })
    }).toThrow(/notification delivery/)

    // The outer mutation was applied (prepare ran before flush)
    expect(doc.settings.darkMode()).toBe(true)
    // The re-entrant mutation was NOT applied
    expect(doc.count()).toBe(0)
  })
})

// ===========================================================================
// subscribe() — library-level node-level observation
// ===========================================================================

describe("subscribeNode: basic behavior", () => {
  it("fires on leaf mutation with correct Changeset", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []

    subscribeNode(doc.settings.darkMode, cs => changesets.push(cs))
    doc.settings.darkMode.set(true)

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.type).toBe("replace")
  })

  it("composite subscribeNode fires on node-level change only (not child mutations)", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []

    subscribeNode(doc.settings, cs => changesets.push(cs))

    // Child mutation — should NOT fire
    doc.settings.darkMode.set(true)
    expect(changesets).toHaveLength(0)

    // Node-level mutation — should fire
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(changesets).toHaveLength(1)
  })

  it("unsubscribe stops delivery", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []

    const unsub = subscribeNode(doc.settings.darkMode, cs =>
      changesets.push(cs),
    )
    doc.settings.darkMode.set(true)
    expect(changesets).toHaveLength(1)

    unsub()
    doc.settings.darkMode.set(false)
    expect(changesets).toHaveLength(1) // no new notification
  })

  it("throws on non-changefeed ref", () => {
    expect(() => subscribeNode({} as any, () => {})).toThrow("[CHANGEFEED]")
  })
})

// ===========================================================================
// subscribe() — library-level tree-level observation (deep default)
// ===========================================================================

describe("subscribe: basic behavior", () => {
  it("fires on child mutation with relative path", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset<Op>[] = []

    subscribe(doc.settings, cs => changesets.push(cs))
    doc.settings.darkMode.set(true)

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("darkMode").key,
    )
  })

  it("fires on own-path change with path []", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset<Op>[] = []

    subscribe(doc.settings, cs => changesets.push(cs))
    doc.settings.set({ darkMode: true, fontSize: 20 })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.path.key).toBe(RawPath.empty.key)
  })

  it("unsubscribe stops delivery", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset<Op>[] = []

    const unsub = subscribe(doc.settings, cs => changesets.push(cs))
    doc.settings.darkMode.set(true)
    expect(changesets).toHaveLength(1)

    unsub()
    doc.settings.darkMode.set(false)
    expect(changesets).toHaveLength(1) // no new notification
  })

  it("throws on non-changefeed ref", () => {
    expect(() => subscribe({} as any, () => {})).toThrow("[CHANGEFEED]")
  })

  it("throws on leaf ref (no subscribe — use subscribeNode)", () => {
    const { doc } = createChatDoc()
    expect(() => subscribe(doc.settings.darkMode, () => {})).toThrow(
      "composite ref",
    )
  })
})

// ===========================================================================
// Integration: library-only round-trip (no CHANGEFEED symbol access)
// ===========================================================================

describe("integration: library-only round-trip", () => {
  it("subscribe on docA → reconstruct Op[] → applyChanges on docB", () => {
    const docA = createChatDoc()
    const docB = createChatDoc()

    const treeChangesets: Changeset<Op>[] = []
    subscribe(docA.doc, cs => treeChangesets.push(cs))

    // Mutate docA via library-level change()
    change(docA.doc, d => {
      d.settings.darkMode.set(true)
      d.count.increment(5)
    })

    // Reconstruct Op[] from tree events
    const ops: Op[] = treeChangesets.flatMap(cs =>
      cs.changes.map(te => ({
        path: te.path,
        change: te.change,
      })),
    )

    // Apply to docB via library-level applyChanges()
    applyChanges(docB.doc, ops)

    expect(docB.doc()).toEqual(docA.doc())
  })
})
