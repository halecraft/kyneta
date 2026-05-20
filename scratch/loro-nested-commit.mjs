// Probe: how does LoroDoc behave when a subscriber re-enters and
// calls doc.commit() while the outer scope has its own pending ops
// that haven't been committed yet? Specifically:
//
//   outer: applyDiff #1
//          (subscriber fires here... but Loro doesn't fire subscribers
//           until commit, so we simulate by manually nesting commits)
//   inner: applyDiff #2 ; setNextCommitMessage("inner") ; commit()
//   outer: setNextCommitMessage("outer") ; commit()
//
// Questions:
// 1. Does the inner commit include outer's pending applyDiff #1?
// 2. Does the outer commit fire an empty doc.subscribe event, or none at all?
// 3. Does the inner commit message override the outer's?
//
// The new plan's runBatch wraps prepare-loop + flush. Subscribers fire
// inside the flush handler (via deliverNotifications). A re-entrant
// change() from a subscriber opens a NEW runBatch. So we need to test
// the case where:
//   - Outer body has called applyDiff but NOT commit yet.
//   - Subscriber is invoked (in the new world, by changefeed's
//     deliverNotifications, which runs inside outer body before commit).
//   - Subscriber's re-entrant runBatch calls applyDiff + commit.
//   - Control returns to outer body, which then calls its own commit.
//
// Replicated below in pure Loro to learn the commit semantics.

import { LoroDoc } from "loro-crdt"

const doc = new LoroDoc()
doc.setPeerId(1n)

// Track all subscribe events to inspect commit-event splitting.
const events = []
doc.subscribe(batch => {
  events.push({
    by: batch.by,
    origin: batch.origin,
    eventCount: batch.events.length,
    eventTargets: batch.events.map(e => `${e.target}:${e.diff.type}`),
  })
})

// Initialize a root map so we have something to mutate.
doc.getMap("data")
doc.commit()
console.log("[init] events after initial commit:", events.length)
events.length = 0

const mapId = doc.getMap("data").id

// --- Test 1: outer applyDiff, then inner commit, then outer commit ---
console.log("\n=== Test 1: nested commit with outer pending ops ===")

// Outer "body" applies a diff.
doc.applyDiff([
  [mapId, { type: "map", updated: { outerKey: "outer-value" } }],
])
console.log("[outer] after outer applyDiff, events fired so far:", events.length)
console.log("[outer] doc.getMap('data').toJSON():", doc.getMap("data").toJSON())

// Simulate the subscriber being invoked here (the "deliverNotifications"
// moment). The subscriber re-enters: it does its own applyDiff + commit.
doc.applyDiff([
  [mapId, { type: "map", updated: { innerKey: "inner-value" } }],
])
console.log("[inner] after inner applyDiff, events fired so far:", events.length)

doc.setNextCommitMessage("inner-commit-message")
doc.commit()
console.log("[inner] after inner commit, events fired so far:", events.length)
console.log("[inner] last event:", events.at(-1))

// Now the outer's commit runs. Are there any pending ops left?
doc.setNextCommitMessage("outer-commit-message")
doc.commit()
console.log("[outer] after outer commit, events fired so far:", events.length)
console.log("[outer] all events:", JSON.stringify(events, null, 2))

// --- Test 2: what does the changeLog say about commit messages? ---
console.log("\n=== Test 2: commit message attribution ===")
const changeLog = doc.getAllChanges()
let changes = []
changeLog.forEach((cs, _peer) => {
  changes = changes.concat(
    cs.map(c => ({ counter: c.counter, len: c.length, message: c.message })),
  )
})
console.log("[changeLog] changes:", JSON.stringify(changes, null, 2))

// --- Test 3: degenerate commit with no pending ops ---
console.log("\n=== Test 3: doc.commit() with no pending ops ===")
const before = events.length
doc.commit()
console.log(
  "[empty-commit] events delta:",
  events.length - before,
  "— commit with no pending ops fired",
  events.length - before,
  "subscribe events",
)
